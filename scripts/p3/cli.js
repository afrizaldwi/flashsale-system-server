"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { ROOT, loadConfig } = require("./config");
const { Docker } = require("./docker");
const { readJson, writeJson, lock } = require("./util");
async function main(args = process.argv.slice(2)) {
  const [command, option] = args;
  if (command === "init") {
    const target = path.join(ROOT, ".env.p3");
    const text = fs
      .readFileSync(path.join(ROOT, ".env.p3.example"), "utf8")
      .replace("P3_ID=GENERATE_WITH_P3_INIT", `P3_ID=${randomUUID()}`)
      .replace(
        "P3_DB_PASSWORD=GENERATE_WITH_P3_INIT",
        `P3_DB_PASSWORD=${randomBytes(24).toString("hex")}`,
      )
      .replace(
        "P3_REPLICATION_PASSWORD=GENERATE_WITH_P3_INIT",
        `P3_REPLICATION_PASSWORD=${randomBytes(24).toString("hex")}`,
      );
    fs.writeFileSync(target, text, { flag: "wx", mode: 0o600 });
    console.log(
      "Created .env.p3; credentials were not printed. Existing files/volumes are never overwritten.",
    );
    return;
  }
  const c = loadConfig(),
    docker = new Docker(c);
  const controlFile = path.join(c.runtime, "control.json");
  if (command === "config") {
    await docker.preflight();
    console.log("P3 configuration and existing object isolation validated.");
    return;
  }
  if (command === "start") {
    const release = lock(path.join(c.runtime, "controller.lock"));
    try {
      await docker.preflight();
      const existing = await docker.list("backend");
      const target = Math.max(c.min, existing.length);
      if (target > c.max) throw new Error("Too many existing P3 backends");
      console.log(
        `[P3] Verified project ${c.project}, loopback port ${c.port}, project-only volumes/network. Start/build P3 services without recreating existing containers; P2 is not targeted.`,
      );
      await docker.compose(
        [
          "up",
          "-d",
          "--build",
          "--no-recreate",
          "--wait",
          "--wait-timeout",
          "150",
          "--scale",
          `backend=${target}`,
        ],
        { timeout: 300000 },
      );
      const { Controller } = require("./controller");
      await new Controller(c, docker).recover();
      console.log(
        `Ready: ${c.baseUrl}. Start npm run p3:controller in a separate terminal for automatic scaling.`,
      );
    } finally {
      release();
    }
    return;
  }
  if (["pause", "resume", "fixed", "auto"].includes(command)) {
    const control = readJson(controlFile, { enabled: true });
    if (command === "pause" || command === "resume")
      control.paused = command === "pause";
    else {
      control.enabled = command === "auto";
      control.resetToMin = command === "fixed";
    }
    writeJson(controlFile, control);
    console.log(JSON.stringify(control));
    return;
  }
  if (command === "controller") {
    const { Controller } = require("./controller");
    return new Controller(c, docker).run();
  }
  if (command === "status") {
    const containers = await docker.list();
    console.log(
      JSON.stringify(
        {
          project: c.project,
          containers: containers.map((b) => ({
            id: b.Id,
            name: b.Name,
            status: b.State.Status,
            health: b.State.Health?.Status,
          })),
          state: readJson(path.join(c.runtime, "state.json"), null),
          control: readJson(controlFile, { enabled: true }),
          routing: readJson(path.join(c.runtime, "routing.json"), null),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "verify") {
    const result = await require("./dataset").verify(docker);
    console.log(JSON.stringify(result, null, 2));
    if (!result.consistent) throw new Error("P3 invariants failed");
    return;
  }
  if (command === "dataset") {
    if (option !== "--reset-p3-only")
      throw new Error(
        "Use dataset --reset-p3-only after pause; affects only marked P3 fixture tables",
      );
    const result = await require("./dataset").reset(docker, {
      allowReset: true,
      runId: `p3-${randomUUID()}`,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "collect") {
    const signal = new AbortController();
    process.once("SIGINT", () => signal.abort());
    process.once("SIGTERM", () => signal.abort());
    return new (require("./collector").Collector)(
      c,
      docker,
      option ? path.resolve(option) : c.runtime,
    ).run(signal.signal);
  }
  if (command === "sample") {
    const collector = new (require("./collector").Collector)(c, docker);
    const baseline = await collector.sample();
    await require("./util").sleep(
      Math.max(0, c.interval - baseline.duration_ms),
    );
    const sample = await collector.sample();
    console.log(
      JSON.stringify(
        {
          valid: sample.policy.valid,
          quality: sample.quality,
          replicas: sample.replicas,
          duration_ms: sample.duration_ms,
          resources: sample.resources,
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(
    "Commands: init | config | start | controller | status | pause | resume | fixed | auto | verify | dataset --reset-p3-only | collect [directory]",
  );
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
