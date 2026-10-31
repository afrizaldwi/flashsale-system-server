"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { observeTransition } = require("../../scripts/p3/transition-monitor");
const { storagePlan, checkStorage } = require("../../scripts/p3/storage");
const { parse } = require("../../scripts/p3/run");
const { sleep } = require("../../scripts/p3/util");
test("transition monitoring is serial, reports failures, and stops before returning", async () => {
  let active = 0, maximum = 0, calls = 0, errors = 0;
  await observeTransition({ sample: async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    try { await sleep(8); throw new Error("source failed"); } finally { active--; }
  } }, 2, () => sleep(40), () => { errors++; });
  const ended = calls;
  await sleep(15);
  assert.ok(calls > 0); assert.equal(calls, ended); assert.equal(maximum, 1);
  assert.equal(active, 0); assert.equal(errors, calls);
});
test("transition failure still joins collection and propagates actuator error", async () => {
  await assert.rejects(observeTransition({ sample: async () => {} }, 2,
    async () => { await sleep(10); throw new Error("routing failed"); }, () => {}), /routing failed/);
});
test("storage preflight refuses impossible capacity and scales estimate with workload", () => {
  assert.equal(storagePlan(1000, 120).estimated_raw_bytes, storagePlan(100, 120).estimated_raw_bytes * 10);
  assert.throws(() => checkStorage(process.cwd(), { required_free_bytes: Number.MAX_SAFE_INTEGER }), /Insufficient disk/);
});
test("single stress runs stay bounded and read-only without requiring a matrix", () => {
  assert.equal(parse(["--campaign", "stress", "--vus", "1000", "--seconds", "120"]).execute, false);
  assert.throws(() => parse(["--campaign", "stress", "--vus", "1001"]));
  assert.throws(() => parse(["--campaign", "stress", "--workload", "write"]));
});
