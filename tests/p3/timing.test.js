"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { lifecycleTiming } = require("../../scripts/p3/timing");
const { decide, afterAction } = require("../../scripts/p3/policy");
const c = {
  min: 2,
  max: 6,
  interval: 5000,
  inWindow: 180000,
  inCooldown: 120000,
  outCooldown: 60000,
  drainTimeout: 90000,
  terminationTimeout: 100000,
  routingTimeout: 30000,
  stale: 15000,
  inCpu: 25,
  outCpu: 65,
};
test("lifecycle recovery and outer process timeout cover six-to-two policy/drain budgets", () => {
  const timing = lifecycleTiming(c);
  assert.equal(timing.steps, 4);
  assert.equal(timing.low_seconds, 1830);
  assert.throws(() => lifecycleTiming(c, 600), /at least/);
  assert.equal(lifecycleTiming(c, 2000).low_seconds, 2000);
  assert.ok(timing.process_timeout_ms > (timing.total_seconds + 30) * 1000);
});
test("simulated sustained-low workload reaches min under worst-case drain/termination budgets within recovery window", () => {
  let count = 6,
    time = 1000,
    state = {};
  const max = lifecycleTiming(c).low_seconds * 1000;
  while (time < max && count > 2) {
    const d = decide(
      state,
      {
        time,
        valid: true,
        databaseHealthy: true,
        enabled: true,
        cpu: 10,
        count,
        poolWaiting: false,
        hostCpu: 10,
        hostMemory: 10,
      },
      c,
      time,
    );
    state = d.state;
    if (d.action === "in") {
      count--;
      time += c.drainTimeout + c.terminationTimeout + c.routingTimeout;
      state = afterAction(state, "in", c, time);
    }
    time += c.interval;
  }
  assert.equal(count, 2);
  assert.ok(time < max);
});
