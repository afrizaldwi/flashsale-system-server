"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  quality,
  cpuDelta,
  procSnapshot,
  processRates,
} = require("../../scripts/p3/resources");
const { decide } = require("../../scripts/p3/policy");
const c = {
  min: 2,
  max: 6,
  stale: 15000,
  outCpu: 65,
  inCpu: 25,
  outWindow: 30000,
  inWindow: 180000,
};
function input() {
  const containers = ["a", "b"].map((Id) => ({
    Id,
    Config: { Labels: { "com.docker.compose.service": "backend" } },
  }));
  return {
    containers,
    after: containers,
    usage: [
      { id: "a", cpu_percent: 20 },
      { id: "b", cpu_percent: 30 },
    ],
    backends: ["a", "b"].map((id) => ({
      id,
      ready: true,
      metrics: { draining: false },
    })),
    duration: 2000,
    budget: 4000,
    windowsCpu: 10,
    vmCpu: 20,
  };
}
test("metrics reject duplicate identities, equal-count membership changes and collection overruns", () => {
  assert.equal(quality(input()).valid, true);
  const duplicate = input();
  duplicate.usage[1].id = "a";
  assert.equal(quality(duplicate).valid, false);
  const changed = input();
  changed.after = [changed.after[0], { Id: "c" }];
  assert.equal(quality(changed).valid, false);
  const slow = input();
  slow.duration = 4001;
  assert.equal(quality(slow).valid, false);
  const partial = input();
  partial.backends.pop();
  assert.equal(quality(partial).valid, false);
});
test("missing VM CPU baseline, NaN CPU and unavailable readiness cannot drive decisions", () => {
  const first = input();
  first.vmCpu = null;
  assert.equal(quality(first).valid, false);
  const bad = input();
  bad.usage[0].cpu_percent = NaN;
  assert.equal(quality(bad).valid, false);
  const ready = input();
  ready.backends[0].ready = false;
  assert.equal(quality(ready).valid, false);
  const sample = {
    valid: true,
    time: 40000,
    databaseHealthy: true,
    enabled: true,
    cpu: 80,
    count: 2,
    hostCpu: 10,
    hostMemory: 20,
  };
  for (const delta of [
    { cpu: NaN },
    { hostCpu: null },
    { hostMemory: NaN },
    { time: undefined },
    { count: NaN },
  ])
    assert.equal(
      decide({ highSince: 0 }, { ...sample, ...delta }, c, 40000).action,
      "hold",
    );
  assert.equal(
    decide({ highSince: 1, lastSample: 40000 }, sample, c, 40000).reason,
    "duplicate-or-out-of-order-sample",
  );
});
test("Docker VM counters exclude guest double counting and distinguish first/reset CPU samples", () => {
  const snapshot = procSnapshot({
    stat: "cpu  10 0 5 80 5 0 0 0 3 0\ncpu0 1 1 1 1\n",
    meminfo: "MemTotal: 1000 kB\nMemAvailable: 400 kB\n",
  });
  assert.equal(snapshot.total, 100);
  assert.equal(snapshot.memory_percent, 60);
  assert.equal(snapshot.logical_cpus, 1);
  assert.equal(cpuDelta(null, snapshot), null);
  assert.equal(
    cpuDelta({ total: 100, idle: 80 }, { total: 200, idle: 150 }),
    30.000000000000004,
  );
  assert.equal(
    cpuDelta({ total: 200, idle: 150 }, { total: 100, idle: 80 }),
    null,
  );
});
test("generator process rates are based on PID and start time with explicit CPU denominators", () => {
  const before = [{ pid: 1, started: "one", cpu_seconds: 2 }];
  const rate = processRates(
    before,
    [{ pid: 1, started: "one", cpu_seconds: 3 }],
    1000,
    12,
  )[0];
  assert.equal(rate.cpu_cores, 1);
  assert.equal(rate.cpu_percent_one_core, 100);
  assert.equal(rate.cpu_percent_host_capacity, 100 / 12);
  assert.equal(
    processRates(
      before,
      [{ pid: 1, started: "two", cpu_seconds: 3 }],
      1000,
      12,
    )[0].cpu_cores,
    null,
  );
});
