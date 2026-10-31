"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Controller } = require("../../scripts/p3/controller");
const { Collector } = require("../../scripts/p3/collector");
const { parse } = require("../../scripts/p3/run");
test("collector refuses overlapping samples rather than reusing in-flight data", async () => {
  const collector = new Collector({}, {});
  let finish;
  collector.collect = () =>
    new Promise((r) => {
      finish = r;
    });
  const first = collector.sample();
  await assert.rejects(() => collector.sample(), /already in progress/);
  finish({ ok: true });
  assert.deepEqual(await first, { ok: true });
});
test("calibration remains bounded, read-only and dry-run until explicitly executed", () => {
  const args = parse([
    "--campaign",
    "calibration",
    "--mode",
    "auto",
    "--vus",
    "100",
    "--seconds",
    "120",
  ]);
  assert.equal(args.execute, false);
  assert.equal(args.vus, 100);
  assert.throws(() =>
    parse(["--campaign", "calibration", "--workload", "write"]),
  );
  assert.throws(() => parse(["--campaign", "calibration", "--vus", "1000"]));
  assert.throws(() => parse(["--campaign", "calibration", "--seconds", "600"]));
});
test("recovery waits for an interrupted terminating backend without resending signals or killing transactions", async () => {
  const c = {
    runtime: fs.mkdtempSync(path.join(os.tmpdir(), "p3-pending-")),
    project: "flashsale-p3",
    min: 2,
    max: 6,
    poolMax: 10,
    terminationTimeout: 0,
    values: { P3_ID: "11111111-1111-1111-1111-111111111111" },
  };
  const docker = {
    c,
    preflight: async () => {},
    list: async (service) =>
      service === "backend"
        ? [{ Id: "victim", State: { Running: true } }]
        : [
            {
              Mounts: [
                {
                  Type: "volume",
                  Name: `flashsale-p3_${service === "db-primary" ? "primary" : "replica"}`,
                  Destination: "/var/lib/postgresql/data",
                },
              ],
            },
          ],
    sql: async (service) =>
      JSON.stringify({
        database: "flashsale_p3",
        identity: c.values.P3_ID,
        standby: service === "db-replica",
        max_connections: 100,
      }),
    removeExitedBackend: async () =>
      assert.fail("Must not remove running victim"),
  };
  const controller = new Controller(c, docker, {});
  controller.state.pending = {
    action: "in",
    phase: "terminating",
    id: "victim",
    target: 2,
  };
  await assert.rejects(() => controller.recover(), /preserved without SIGKILL/);
  assert.equal(controller.state.pending.id, "victim");
});
test("CPU evidence with a changed membership is discarded immediately before actuation", async () => {
  const c = {
    runtime: fs.mkdtempSync(path.join(os.tmpdir(), "p3-fresh-")),
    project: "flashsale-p3",
    min: 2,
    max: 6,
    poolMax: 10,
    stale: 15000,
    outCpu: 65,
    inCpu: 25,
    outWindow: 30000,
    values: { P3_ID: "11111111-1111-1111-1111-111111111111" },
  };
  const members = [1, 2].map((n) => ({
    Id: String(n),
    State: { Running: true },
  }));
  let called = 0;
  const docker = {
    c,
    list: async (service) =>
      service === "backend"
        ? members
        : [
            {
              Mounts: [
                {
                  Type: "volume",
                  Name: `flashsale-p3_${service === "db-primary" ? "primary" : "replica"}`,
                  Destination: "/var/lib/postgresql/data",
                },
              ],
            },
          ],
    sql: async (service) =>
      JSON.stringify({
        database: "flashsale_p3",
        identity: c.values.P3_ID,
        standby: service === "db-replica",
        max_connections: 100,
      }),
    scaleOut: async () => called++,
  };
  const controller = new Controller(c, docker, {});
  controller.state.desired = 2;
  controller.state.policy = { highSince: Date.now() - 40000 };
  controller.syncRouting = async () => {};
  controller.collector.sample = async () => ({
    policy: {
      valid: true,
      time: Date.now(),
      cpu: 80,
      count: 2,
      databaseHealthy: true,
      hostCpu: 10,
      hostMemory: 10,
      backendIds: ["1", "replaced"],
    },
  });
  await controller.tick();
  assert.equal(called, 0);
  assert.deepEqual(controller.state.policy, {});
});
