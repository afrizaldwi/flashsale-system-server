"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { Docker } = require("../../scripts/p3/docker");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
test("scale-out cannot accidentally use Compose to remove containers from an oversized inventory", async (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "p3-scaleout-"));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const docker = new Docker({ min: 2, max: 6, runtime });
  docker.preflight = async () => {};
  docker.list = async () => [1, 2, 3, 4];
  docker.compose = async () =>
    assert.fail("Compose must not shrink this inventory");
  await assert.rejects(() => docker.scaleOut(3), /Refusing Compose shrink/);
});
