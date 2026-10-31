"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Controller } = require("../../scripts/p3/controller");
const { writeJson } = require("../../scripts/p3/util");
function fixture(count, prior) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "p3-recovery-"));
  const c = {
    runtime,
    project: "flashsale-p3",
    min: 2,
    max: 6,
    poolMax: 10,
    outCooldown: 60000,
    values: { P3_ID: "11111111-1111-1111-1111-111111111111" },
  };
  writeJson(path.join(runtime, "state.json"), prior);
  const docker = {
    c,
    preflight: async () => {},
    list: async (service) =>
      service === "backend"
        ? Array.from({ length: count }, (_, n) => ({
            Id: String(n),
            State: { Running: true },
          }))
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
  };
  const controller = new Controller(c, docker, {});
  let ready;
  controller.waitReady = async (target) => {
    ready = target;
  };
  return { controller, getReady: () => ready };
}
test("recovery adopts actual membership after interrupted scale-out instead of deleting new backend", async () => {
  const { controller, getReady } = fixture(3, {
    desired: 2,
    pending: { action: "out", target: 3 },
    failures: 3,
  });
  await controller.recover();
  assert.equal(controller.state.desired, 3);
  assert.equal(getReady(), 3);
  assert.equal(controller.state.pending, null);
  assert.equal(controller.state.failures, 0);
});
test("recovery does not resurrect already removed victim after interrupted scale-in", async () => {
  const { controller, getReady } = fixture(2, {
    desired: 3,
    pending: { action: "in", target: 2 },
    failures: 0,
  });
  await controller.recover();
  assert.equal(controller.state.desired, 2);
  assert.equal(getReady(), 2);
});
test("recovery refuses membership beyond maximum without deleting containers", async () => {
  const { controller } = fixture(7, { desired: 2, failures: 0 });
  await assert.rejects(() => controller.recover(), /Too many/);
});
