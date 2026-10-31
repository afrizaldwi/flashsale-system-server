"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { writeJson } = require("../../scripts/p3/util");
const { readRun } = require("../../scripts/p3/report");
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-windows-"));
  writeJson(path.join(dir, "manifest.json"), {
    id: "p3-fixture",
    status: "completed",
    workload_started: "2026-10-31T00:00:00Z",
    measurement_seconds: 5,
  });
  writeJson(path.join(dir, "db-after.json"), {
    consistent: true,
    primary: { orders: 0 },
  });
  const metric = {
    time: "2026-10-31T00:00:03Z",
    policy: { valid: true, count: 2, cpu: 10 },
    host: { cpu_percent: 12, memory_percent: 30 },
    database: { "db-primary": {} },
    resources: {
      windows_host: { cpu_percent: 12 },
      docker_vm: { cpu_percent: 55, memory_percent: 40 },
      k6_generator: {
        processes: [{ cpu_cores: 0.5, cpu_percent_host_capacity: 4.17 }],
      },
    },
  };
  fs.writeFileSync(
    path.join(dir, "metrics.ndjson"),
    [
      JSON.stringify({
        ...metric,
        time: "2026-10-30T23:59:55Z",
        policy: { valid: false },
      }),
      JSON.stringify(metric),
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "k6-samples.ndjson"),
    JSON.stringify({
      type: "Point",
      metric: "measured_attempts",
      data: { value: 1, time: metric.time, tags: { phase: "measure" } },
    }),
  );
  return dir;
}
test("initial CPU baseline outside measurement does not invalidate later complete samples", async () => {
  const run = await readRun(fixture());
  assert.equal(run.summary.valid_for_comparison, true);
  assert.deepEqual(run.summary.resource_peaks, {
    windows_host_cpu_percent: 12,
    docker_vm_cpu_percent: 55,
    docker_vm_memory_percent: 40,
    generator_cpu_cores: 0.5,
    generator_cpu_host_capacity_percent: 4.17,
  });
});
test("invalid metrics inside measurement are rejected and calibration is excluded from comparison", async () => {
  const dir = fixture();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
  manifest.feasibility_only = true;
  writeJson(path.join(dir, "manifest.json"), manifest);
  const rows = fs
    .readFileSync(path.join(dir, "metrics.ndjson"), "utf8")
    .split("\n")
    .map(JSON.parse);
  rows[1].policy.valid = false;
  fs.writeFileSync(
    path.join(dir, "metrics.ndjson"),
    rows.map(JSON.stringify).join("\n"),
  );
  const run = await readRun(dir);
  assert.equal(run.summary.valid_for_comparison, false);
  assert.ok(run.summary.warnings.some((w) => w.includes("calibration")));
  assert.ok(run.summary.warnings.some((w) => w.includes("stale")));
});
