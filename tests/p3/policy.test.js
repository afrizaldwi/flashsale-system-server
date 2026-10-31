"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { decide, afterAction } = require("../../scripts/p3/policy");
const c = {
  min: 2,
  max: 6,
  stale: 15000,
  outCpu: 65,
  inCpu: 25,
  outWindow: 30000,
  inWindow: 180000,
  outCooldown: 60000,
  inCooldown: 120000,
};
const sample = (time, extra = {}) => ({
  time,
  valid: true,
  databaseHealthy: true,
  enabled: true,
  cpu: 80,
  count: 2,
  poolWaiting: false,
  hostCpu: 20,
  hostMemory: 30,
  ...extra,
});
function advance(cpu, count, until, extra = {}) {
  let state = {};
  let result;
  for (let t = 1000; t <= until; t += 5000) {
    result = decide(state, sample(t, { cpu, count, ...extra }), c, t);
    state = result.state;
  }
  return result;
}
test("scale out only after a continuous high-CPU window", () => {
  assert.equal(advance(80, 2, 26000).action, "hold");
  assert.equal(advance(80, 2, 31000).action, "out");
});
test("scale in waits for hysteresis window and projects remaining capacity", () => {
  assert.equal(advance(20, 3, 176000).action, "hold");
  assert.equal(advance(20, 3, 181000).action, "in");
  assert.equal(advance(30, 3, 181000).action, "hold");
  assert.equal(advance(20, 2, 181000).action, "hold");
});
test("bounds, fixed mode, host capacity and pool waits suppress unsafe actions", () => {
  assert.equal(advance(90, 6, 31000).reason, "maximum-replicas");
  assert.equal(advance(90, 2, 31000, { enabled: false }).reason, "fixed-mode");
  assert.equal(advance(90, 2, 31000, { hostCpu: 95 }).reason, "host-capacity");
  assert.equal(advance(10, 3, 181000, { poolWaiting: true }).action, "hold");
});
test("stale, missing or database-failed samples reset accumulated windows", () => {
  for (const change of [
    { valid: false },
    { databaseHealthy: false },
    { time: 1 },
  ]) {
    const r = decide(
      { highSince: 1000, lowSince: 1000 },
      sample(40000, change),
      c,
      40000,
    );
    assert.equal(r.action, "hold");
    assert.equal(r.state.highSince, null);
    assert.equal(r.state.lowSince, null);
  }
});
test("sample gaps and cooldown prevent flapping", () => {
  const state = afterAction({ highSince: 1 }, "out", c, 1000);
  assert.equal(decide(state, sample(2000), c, 2000).reason, "cooldown");
  const gap = decide(
    { highSince: 1, lastSample: 1000 },
    sample(40000),
    c,
    40000,
  );
  assert.equal(gap.action, "hold");
  assert.equal(gap.state.highSince, 40000);
});
