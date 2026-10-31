"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { Docker } = require("../../scripts/p3/docker");
test("scale-out cannot accidentally use Compose to remove containers from an oversized inventory", async () => {
  const docker = new Docker({ min: 2, max: 6 });
  docker.preflight = async () => {};
  docker.list = async () => [1, 2, 3, 4];
  docker.compose = async () =>
    assert.fail("Compose must not shrink this inventory");
  await assert.rejects(() => docker.scaleOut(3), /Refusing Compose shrink/);
});
