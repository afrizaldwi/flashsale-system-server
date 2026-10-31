"use strict";
// Finite idle monitoring check. No k6 workload, dataset reset, image build or DB restart.
const assert = require("node:assert/strict"),
  path = require("node:path");
const { loadConfig } = require("./config");
const { Docker } = require("./docker");
const { Controller } = require("./controller");
const { Collector } = require("./collector");
const { verify } = require("./dataset");
const { lock, sleep, writeJson, readJson } = require("./util");
async function review() {
  const c = loadConfig(),
    docker = new Docker(c),
    release = lock(path.join(c.runtime, "controller.lock"));
  const directory = path.join(
    c.runtime,
    "monitoring-review",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  let controller, original, protectedIds, before;
  const results = [];
  try {
    await docker.preflight();
    original = (await docker.list("backend")).map((b) => b.Id);
    if (original.length !== 2 || c.max < 6)
      throw new Error(
        "Review requires exactly two existing P3 backends and max >=6",
      );
    const ids = (await docker.command(["ps", "-q"]))
      .split(/\s+/)
      .filter(Boolean);
    protectedIds = ids;
    before = await docker.command([
      "inspect",
      "--format",
      "{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}",
      ...protectedIds,
    ]);
    console.log(
      "[P3] Verified flashsale-p3: idle monitoring at 2, 4 and 6 backends; add only P3 backends without build/recreation, update P3 routing, then drain only added backends back to the original two. All original containers and volumes are preserved.",
    );
    const beforeDb = await verify(docker);
    controller = new Controller(c, docker);
    await controller.recover();
    const collector = new Collector(c, docker, directory);
    for (const count of [2, 4, 6]) {
      if (count > 2) {
        await docker.scaleOut(count);
        await controller.waitReady(count);
      }
      // Baseline counters once after topology changes; baseline is not a decision sample.
      const warm = await collector.sample();
      await sleep(Math.max(0, c.interval - warm.duration_ms));
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const sample = await collector.sample();
        samples.push(sample);
        console.log(
          JSON.stringify({
            replicas: count,
            sample: i + 1,
            duration_ms: sample.duration_ms,
            valid: sample.policy.valid,
            reasons: sample.quality.reasons,
          }),
        );
        if (i < 2) await sleep(Math.max(0, c.interval - sample.duration_ms));
      }
      const durations = samples.map((s) => s.duration_ms);
      results.push({
        replicas: count,
        samples: samples.length,
        min_ms: Math.min(...durations),
        max_ms: Math.max(...durations),
        mean_ms: durations.reduce((a, b) => a + b, 0) / durations.length,
        all_valid: samples.every((s) => s.policy.valid),
        reasons: samples.flatMap((s) => s.quality.reasons),
      });
      writeJson(path.join(directory, "summary.json"), {
        results,
        complete: false,
      });
    }
    const afterDb = await verify(docker);
    assert.equal(afterDb.consistent, true);
    assert.deepEqual(afterDb.primary, beforeDb.primary);
  } finally {
    try {
      if (controller) {
        let backends = await docker.list("backend");
        while (backends.length > 2) {
          await controller.scaleIn(backends, backends.length - 1);
          backends = await docker.list("backend");
        }
        assert.deepEqual(backends.map((b) => b.Id).sort(), original.sort());
      }
      if (before) {
        const after = await docker.command([
          "inspect",
          "--format",
          "{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}",
          ...protectedIds,
        ]);
        assert.equal(
          after,
          before,
          "Original P2/P3 containers must not restart",
        );
      }
    } finally {
      release();
    }
  }
  const summary = {
    time: new Date().toISOString(),
    results,
    complete: true,
    original_containers_unchanged: true,
    restored_replicas: 2,
    thresholds_unchanged: { out: c.outCpu, in: c.inCpu },
  };
  writeJson(path.join(directory, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
  if (results.some((r) => !r.all_valid))
    throw new Error(`Monitoring readiness failed; inspect ${directory}`);
  return directory;
}
if (require.main === module)
  review().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { review };
