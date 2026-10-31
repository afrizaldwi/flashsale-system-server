"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { writeJson } = require("../../scripts/p3/util");
const { report, readRun } = require("../../scripts/p3/report");
function fixture(soldout = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-report-"));
  writeJson(path.join(dir, "manifest.json"), {
    id: "p3-fixture",
    profile: "smoke",
    mode: "fixed",
    workload: "read",
    vus: 2,
    repetition: 1,
    status: "completed",
    measurement_seconds: 5,
  });
  for (const name of ["db-before", "db-after"])
    writeJson(path.join(dir, `${name}.json`), {
      consistent: true,
      primary: { orders: 0 },
    });
  fs.writeFileSync(
    path.join(dir, "metrics.ndjson"),
    JSON.stringify({
      time: "2026-10-31T00:00:00Z",
      policy: { valid: true, count: 2, cpu: 10, poolWaiting: false },
      host: { cpu_percent: 10, memory_percent: 20 },
      database: { "db-primary": { lock_waiters: 0 } },
    }) + "\n",
  );
  const values = [
    ["measured_attempts", 1],
    ["successful_requests", 1],
    ["measured_duration", 10],
    ["infrastructure_error", 0],
    ["business_sold_out", soldout ? 1 : 0],
    ["validation_error", 0],
  ];
  fs.writeFileSync(
    path.join(dir, "k6-samples.ndjson"),
    values
      .map(([metric, value]) =>
        JSON.stringify({
          type: "Point",
          metric,
          data: {
            value,
            time: "2026-10-31T00:00:00Z",
            tags: {
              phase: "measure",
              endpoint: "products",
              outcome: "success",
            },
          },
        }),
      )
      .join("\n"),
  );
  return dir;
}
test("report produces structured outputs and escaped standalone HTML from samples", async () => {
  const dir = fixture();
  await report(dir);
  const result = JSON.parse(fs.readFileSync(path.join(dir, "comparison.json")));
  assert.equal(result.runs[0].rps, 0.2);
  assert.equal(result.runs[0].latency.p95, 10);
  assert.equal(fs.existsSync(path.join(dir, "comparison.csv")), true);
  assert.match(fs.readFileSync(path.join(dir, "report.html"), "utf8"), /<svg/);
});
test("sold-out results are excluded from capacity comparison instead of marked infra failures", async () => {
  const result = await readRun(fixture(true));
  assert.equal(result.summary.valid_for_comparison, false);
  assert.equal(result.summary.infrastructure_error_rate, 0);
  assert.equal(result.summary.sold_out_rate, 1);
});

test("lossless compressed raw samples preserve report counts and percentile", async () => {
  const dir = fixture();
  const raw = path.join(dir, "k6-samples.ndjson");
  fs.writeFileSync(raw + ".gz", require("node:zlib").gzipSync(fs.readFileSync(raw)));
  // The compressed reader must work without an uncompressed fallback.
  fs.unlinkSync(raw);
  const { summary } = await readRun(dir);
  assert.equal(summary.totals.attempts, 1);
  assert.equal(summary.latency.p95, 10);
});
