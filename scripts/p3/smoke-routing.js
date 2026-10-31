"use strict";
// Short actuator/discovery smoke: NOT a load-triggered autoscaling demonstration.
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadConfig } = require("./config");
const { Docker } = require("./docker");
const { Controller } = require("./controller");
const { verify } = require("./dataset");
const { lock, writeJson } = require("./util");
async function smoke() {
  const c = loadConfig(),
    docker = new Docker(c);
  const release = lock(path.join(c.runtime, "controller.lock"));
  try {
    await docker.preflight();
    const existing = await docker.list("backend");
    if (existing.length !== 2)
      throw new Error(
        "Routing smoke requires exactly two existing P3 backends",
      );
    const before = (await docker.list())
      .filter((b) =>
        b.Config.Labels["com.docker.compose.service"].startsWith("db-"),
      )
      .map((b) => ({ id: b.Id, started: b.State.StartedAt }));
    const beforeData = await verify(docker);
    console.log(
      "[P3] Verified flashsale-p3: short routing smoke adds one P3 backend, sends 18 sequential catalog reads, then safely drains/removes that backend. No DB recreation/reset or P2 operation.",
    );
    const controller = new Controller(c, docker);
    await controller.recover();
    await docker.scaleOut(3);
    try {
      await controller.waitReady(3);
      const served = new Set();
      for (let i = 0; i < 18; i++) {
        const response = await fetch(c.baseUrl + "/products", {
          headers: { Connection: "close" },
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).length, 3);
        served.add(response.headers.get("x-backend-id"));
      }
      assert.equal(
        served.size,
        3,
        "All three ready backend IDs must serve requests",
      );
    } finally {
      const containers = await docker.list("backend");
      if (containers.length === 3) await controller.scaleIn(containers, 2);
    }
    const after = (await docker.list())
      .filter((b) =>
        b.Config.Labels["com.docker.compose.service"].startsWith("db-"),
      )
      .map((b) => ({ id: b.Id, started: b.State.StartedAt }));
    assert.deepEqual(
      after,
      before,
      "P3 PostgreSQL containers must not restart or recreate",
    );
    assert.equal((await docker.list("backend")).length, 2);
    const result = await verify(docker);
    assert.equal(result.consistent, true);
    assert.equal(result.primary.orders, beforeData.primary.orders);
    writeJson(path.join(c.runtime, "routing-smoke.json"), {
      time: new Date().toISOString(),
      passed: true,
      sequence: [2, 3, 2],
      database_containers: after,
      consistent: true,
    });
    console.log(
      "PASS: 2 -> 3 -> 2, all backend IDs routed, drain complete, DB identities/start times unchanged, invariants intact. This tests actuation, not automatic policy triggering.",
    );
  } finally {
    release();
  }
}
if (require.main === module)
  smoke().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { smoke };
