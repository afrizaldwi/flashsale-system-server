"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { Docker } = require("../../scripts/p3/docker");
const c = {
  project: "flashsale-p3",
  quota: 0.5,
  poolMax: 10,
  values: { P3_ID: "11111111-1111-1111-1111-111111111111" },
};
test("configured CPU quota and pool must match actual backend settings", () => {
  const d = new Docker(c);
  const container = {
    Config: {
      Env: ["DB_POOL_MAX=10", `P3_ID=${c.values.P3_ID}`],
      Labels: {
        "com.docker.compose.project": c.project,
        "flashsale.environment": "p3",
        "com.docker.compose.service": "backend",
      },
    },
    HostConfig: { NanoCpus: 500000000 },
    NetworkSettings: { Networks: { "flashsale-p3_p3": {} } },
  };
  assert.equal(d.assertContainer(container), container);
  container.HostConfig.NanoCpus = 1000000000;
  assert.throws(() => d.assertContainer(container), /differs/);
});
test("published ingress must match the configured loopback binding", () => {
  const d = new Docker({ ...c, port: 8080 });
  const container = {
    Config: {
      Labels: {
        "com.docker.compose.project": c.project,
        "flashsale.environment": "p3",
        "com.docker.compose.service": "nginx",
      },
    },
    HostConfig: {
      PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] },
    },
    NetworkSettings: { Networks: { "flashsale-p3_p3": {} } },
  };
  assert.equal(d.assertContainer(container), container);
  container.HostConfig.PortBindings["80/tcp"][0].HostIp = "0.0.0.0";
  assert.throws(() => d.assertContainer(container), /differs/);
});
