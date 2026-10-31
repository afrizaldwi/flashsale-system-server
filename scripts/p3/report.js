"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");
const { readJson, writeJson, csvRow } = require("./util");
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
function trend(values) {
  return {
    count: values.length,
    avg: values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null,
    p95: quantile(values, 0.95),
  };
}
async function lines(file, visit) {
  if (!fs.existsSync(file)) return;
  let stream = fs.createReadStream(file);
  if (file.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
  for await (const line of readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  })) {
    if (line.trim()) await visit(JSON.parse(line));
  }
}
function plot(points, key, label, color = "#2563eb") {
  const pairs = points
    .map((p) => [Date.parse(p.time), key(p)])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pairs.length) return `<p>${escape(label)}: no samples</p>`;
  const first = pairs[0][0],
    last = pairs[pairs.length - 1][0],
    max = Math.max(...pairs.map((p) => p[1]), 1);
  const coords = pairs
    .map(
      ([x, y]) =>
        `${50 + ((x - first) / Math.max(last - first, 1)) * 660},${210 - (y / max) * 170}`,
    )
    .join(" ");
  return `<figure><figcaption>${escape(label)}</figcaption><svg viewBox="0 0 740 250" role="img" aria-label="${escape(label)}"><path d="M50 30V210H710" fill="none" stroke="#888"/><polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2"/><text x="5" y="35">${max.toFixed(1)}</text><text x="50" y="235">0 s</text><text x="650" y="235">${((last - first) / 1000).toFixed(0)} s</text></svg></figure>`;
}
async function readRun(directory) {
  const manifest = readJson(path.join(directory, "manifest.json"));
  const totals = {
    attempts: 0,
    success: 0,
    created: 0,
    infra: 0,
    infraN: 0,
    soldout: 0,
    soldoutN: 0,
    invalid: 0,
    invalidN: 0,
    http_5xx: 0,
    timeouts: 0,
    connection_errors: 0,
  };
  const durations = [],
    ttfb = [],
    connecting = [],
    blocked = [],
    groups = {},
    seconds = new Map();
  let raw = path.join(directory, "k6-samples.ndjson.gz");
  if (!fs.existsSync(raw)) raw = path.join(directory, "k6-samples.ndjson");
  await lines(raw, (event) => {
    if (event.type !== "Point") return;
    const { value, tags = {}, time } = event.data;
    if (tags.phase !== "measure") return;
    const bucket = seconds.get(time.slice(0, 19)) || {
      time: time.slice(0, 19) + "Z",
      requests: 0,
      infra: 0,
      durations: [],
    };
    switch (event.metric) {
      case "measured_attempts":
        totals.attempts += value;
        bucket.requests += value;
        break;
      case "successful_requests":
        totals.success += value;
        break;
      case "checkout_created":
        totals.created += value;
        break;
      case "infrastructure_error":
        totals.infra += value;
        totals.infraN++;
        bucket.infra += value;
        break;
      case "business_sold_out":
        totals.soldout += value;
        totals.soldoutN++;
        break;
      case "validation_error":
        totals.invalid += value;
        totals.invalidN++;
        break;
      case "measured_duration":
        durations.push(value);
        bucket.durations.push(value);
        (groups[`${tags.endpoint}/${tags.outcome}`] ||= []).push(value);
        break;
      case "measured_ttfb":
        ttfb.push(value);
        break;
      case "http_5xx_count":
        totals.http_5xx += value;
        break;
      case "timeout_count":
        totals.timeouts += value;
        break;
      case "connection_error_count":
        totals.connection_errors += value;
        break;
      case "http_req_connecting":
        connecting.push(value);
        break;
      case "http_req_blocked":
        blocked.push(value);
        break;
    }
    seconds.set(time.slice(0, 19), bucket);
  });
  const metrics = [];
  await lines(path.join(directory, "metrics.ndjson"), (value) =>
    metrics.push(value),
  );
  const events = [];
  await lines(path.join(directory, "scaling-events.ndjson"), (value) =>
    events.push(value),
  );
  const before = readJson(path.join(directory, "db-before.json"), null),
    after = readJson(path.join(directory, "db-after.json"), null);
  const validation = [];
  const windowStart =
    Date.parse(manifest.workload_started) +
    (manifest.measurement_start_seconds || 0) * 1000;
  const windowEnd = windowStart + manifest.measurement_seconds * 1000;
  const collectorErrors = [];
  await lines(path.join(directory, "collector-errors.ndjson"), (error) => {
    const time = Date.parse(error.time);
    if (!Number.isFinite(windowStart) || (time >= windowStart && time <= windowEnd)) collectorErrors.push(error);
  });
  if (collectorErrors.length) validation.push("Collector source failures in measurement window");
  const relevant = Number.isFinite(windowStart)
    ? metrics.filter(
        (m) =>
          Date.parse(m.time) >= windowStart &&
          Date.parse(m.started_at || m.time) <= windowEnd,
      )
    : metrics;
  if (!relevant.length)
    validation.push("No monitoring samples in measurement window");
  if (manifest.feasibility_only)
    validation.push(
      "Read-only calibration is feasibility evidence, excluded from capacity comparison",
    );
  if (manifest.profile === "lifecycle")
    validation.push("Lifecycle has changing load; excluded from capacity comparison");
  if (manifest.status !== "completed")
    validation.push(manifest.error || "Run did not complete");
  if (!after?.consistent) validation.push("Database consistency not proven");
  if (totals.soldout)
    validation.push("Sold-out invalidates capacity comparison");
  if (totals.invalid) validation.push("Unexpected application responses");
  if (!totals.attempts) validation.push("No measured request samples");
  if (relevant.some((m) => !m.policy.valid))
    validation.push("Missing/stale monitoring samples; inspect timeline");
  if (
    relevant.some(
      (m, i) =>
        i > 0 && Date.parse(m.time) - Date.parse(relevant[i - 1].time) > 15000,
    )
  )
    validation.push("Monitoring gap exceeds 15 seconds");
  const pressure = relevant.filter(
    (m) =>
      m.host.cpu_percent >= 90 ||
      m.host.memory_percent >= 85 ||
      m.resources?.docker_vm?.cpu_percent >= 90 ||
      m.resources?.docker_vm?.memory_percent >= 85,
  );
  let pressureStart = null,
    capacityLimited = false;
  for (const m of relevant) {
    if (pressure.includes(m)) {
      pressureStart ??= Date.parse(m.time);
      if (Date.parse(m.time) - pressureStart >= 30000) capacityLimited = true;
    } else pressureStart = null;
  }
  if (capacityLimited)
    validation.push(
      "Sustained host pressure: generator/server attribution requires review",
    );
  const summary = {
    id: manifest.id,
    profile: manifest.profile,
    workload: manifest.workload,
    mode: manifest.mode,
    vus: manifest.vus,
    repetition: manifest.repetition,
    measurement_seconds: manifest.measurement_seconds,
    comparison_settings: manifest.settings || null,
    status: manifest.status,
    valid_for_comparison: validation.length === 0,
    warnings: validation,
    rps: totals.attempts / manifest.measurement_seconds,
    goodput: totals.success / manifest.measurement_seconds,
    checkout_rps: totals.created / manifest.measurement_seconds,
    latency: trend(durations),
    ttfb: trend(ttfb),
    connection_timing: trend(connecting),
    blocked_timing: trend(blocked),
    outcomes: Object.fromEntries(
      Object.entries(groups).map(([k, v]) => [k, trend(v)]),
    ),
    infrastructure_error_rate: totals.infraN
      ? totals.infra / totals.infraN
      : null,
    sold_out_rate: totals.soldoutN ? totals.soldout / totals.soldoutN : null,
    validation_error_rate: totals.invalidN
      ? totals.invalid / totals.invalidN
      : null,
    totals,
    db_order_delta:
      after && before ? after.primary.orders - before.primary.orders : null,
    scale_outs: events.filter(
      (e) => e.type === "scale-complete" && e.direction === "out",
    ).length,
    scale_ins: events.filter(
      (e) => e.type === "scale-complete" && e.direction === "in",
    ).length,
    host_pressure_samples: pressure.length,
    bottleneck_evidence: {
      lock_wait: metrics.some(
        (m) => m.database["db-primary"]?.lock_waiters > 0,
      ),
      pool_wait: metrics.some((m) => m.policy.poolWaiting),
      host_pressure: capacityLimited,
    },
  };
  const peak = (values) =>
    values.some(Number.isFinite)
      ? Math.max(...values.filter(Number.isFinite))
      : null;
  summary.resource_peaks = {
    windows_host_cpu_percent: peak(
      relevant.map((m) => m.resources?.windows_host?.cpu_percent),
    ),
    docker_vm_cpu_percent: peak(
      relevant.map((m) => m.resources?.docker_vm?.cpu_percent),
    ),
    docker_vm_memory_percent: peak(
      relevant.map((m) => m.resources?.docker_vm?.memory_percent),
    ),
    generator_cpu_cores: peak(
      relevant.flatMap((m) =>
        (m.resources?.k6_generator?.processes || []).map((p) => p.cpu_cores),
      ),
    ),
    generator_cpu_host_capacity_percent: peak(
      relevant.flatMap((m) =>
        (m.resources?.k6_generator?.processes || []).map(
          (p) => p.cpu_percent_host_capacity,
        ),
      ),
    ),
  };
  writeJson(path.join(directory, "analysis.json"), summary);
  const points = [...seconds.values()]
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((b) => ({
      ...b,
      p95: quantile(b.durations, 0.95),
      error_rate: b.requests ? b.infra / b.requests : 0,
    }));
  return { manifest, summary, metrics, points };
}
async function report(root) {
  root = path.resolve(root);
  const directories = fs.existsSync(path.join(root, "manifest.json"))
    ? [root]
    : fs
        .readdirSync(root, { withFileTypes: true })
        .filter(
          (d) =>
            d.isDirectory() &&
            fs.existsSync(path.join(root, d.name, "manifest.json")),
        )
        .map((d) => path.join(root, d.name));
  const runs = [];
  for (const directory of directories) runs.push(await readRun(directory));
  const headers = [
    "id",
    "workload",
    "vus",
    "mode",
    "repetition",
    "valid",
    "rps",
    "checkout_rps",
    "avg_ms",
    "p95_ms",
    "infrastructure_error_rate",
    "sold_out_rate",
    "scale_outs",
    "scale_ins",
  ];
  fs.writeFileSync(
    path.join(root, "comparison.csv"),
    csvRow(headers) +
      runs
        .map(({ summary: s }) =>
          csvRow([
            s.id,
            s.workload,
            s.vus,
            s.mode,
            s.repetition,
            s.valid_for_comparison,
            s.rps,
            s.checkout_rps,
            s.latency.avg,
            s.latency.p95,
            s.infrastructure_error_rate,
            s.sold_out_rate,
            s.scale_outs,
            s.scale_ins,
          ]),
        )
        .join(""),
  );
  const grouped = {};
  for (const { summary: s } of runs)
    if (s.valid_for_comparison)
      (grouped[`${s.profile}/${s.workload}/${s.vus}/${s.mode}/${s.measurement_seconds}/${JSON.stringify(s.comparison_settings)}`] ||= []).push(s);
  const aggregates = Object.entries(grouped).map(([key, values]) => ({
    key,
    repetitions: values.length,
    rps_median: quantile(
      values.map((v) => v.rps),
      0.5,
    ),
    rps_min: Math.min(...values.map((v) => v.rps)),
    rps_max: Math.max(...values.map((v) => v.rps)),
    p95_median: quantile(
      values.map((v) => v.latency.p95),
      0.5,
    ),
  }));
  writeJson(path.join(root, "comparison.json"), {
    runs: runs.map((r) => r.summary),
    aggregates,
  });
  const table = runs
    .map(
      ({ summary: s }) =>
        `<tr>${[s.workload, s.vus, s.mode, s.repetition, s.valid_for_comparison, s.rps.toFixed(2), s.latency.avg?.toFixed(2), s.latency.p95?.toFixed(2), s.infrastructure_error_rate, s.scale_outs, s.scale_ins].map((v) => `<td>${escape(v)}</td>`).join("")}</tr>`,
    )
    .join("");
  const sections = runs
    .map(
      ({ summary: s, metrics, points }) =>
        `<section><h2>${escape(s.id)} — ${escape(s.workload)} / ${s.vus} VU / ${s.mode}</h2><p>${escape(s.warnings.join("; ") || "All automated validity checks passed. Shared-host limitations still apply.")}</p><div class="plots">${plot(points, (p) => p.requests, "Throughput (requests/s)")}${plot(points, (p) => p.p95, "p95 latency (ms)", "#7c3aed")}${plot(points, (p) => p.error_rate * 100, "Infrastructure errors (%)", "#dc2626")}${plot(metrics, (p) => p.policy.count, "Running backend replicas", "#059669")}${plot(metrics, (p) => p.policy.cpu, "Backend CPU / quota (%)")}${plot(metrics, (p) => p.host.cpu_percent, "Windows/native host CPU (%)")}${plot(metrics, (p) => p.resources?.docker_vm?.cpu_percent, "Docker Linux VM CPU (%)")}${plot(metrics, (p) => p.resources?.docker_vm?.memory_percent, "Docker Linux VM memory (%)")}${plot(
          metrics,
          (p) => {
            const processes = p.resources?.k6_generator?.processes || [];
            return processes.some((g) => Number.isFinite(g.cpu_cores))
              ? processes.reduce((sum, g) => sum + (g.cpu_cores || 0), 0)
              : null;
          },
          "k6 generator CPU cores",
        )}</div><pre>${escape(JSON.stringify({ outcomes: s.outcomes, bottleneck_evidence: s.bottleneck_evidence, resource_peaks: s.resource_peaks, db_order_delta: s.db_order_delta, successful_checkout_responses: s.totals.created }, null, 2))}</pre></section>`,
    )
    .join("");
  fs.writeFileSync(
    path.join(root, "report.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>P3 performance report</title><style>body{font:15px system-ui;margin:30px;color:#172033}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #ccd}section{margin-top:40px}.plots{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}svg{width:100%}pre{white-space:pre-wrap}figure{margin:12px}</style><h1>P3 measured results</h1><p>Generated from actual recorded samples. Invalid runs are excluded from aggregates. Percentiles describe each run; median p95 is not a pooled percentile. Request latency excludes connection setup. Outcome-specific latency and database commits must be considered alongside total RPS.</p><table><thead><tr>${["Workload", "VU", "Mode", "Repeat", "Valid", "RPS", "Average ms", "p95 ms", "Infra error", "Out", "In"].map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${table}</tbody></table><h2>Repeated-run aggregates</h2><pre>${escape(JSON.stringify(aggregates, null, 2))}</pre>${sections}</html>`,
  );
  return { runs: runs.length, root };
}
if (require.main === module) {
  if (!process.argv[2]) {
    console.error("Usage: npm run p3:report -- results/p3/<campaign>");
    process.exitCode = 1;
  } else
    report(process.argv[2])
      .then(console.log)
      .catch((e) => {
        console.error(e.message);
        process.exitCode = 1;
      });
}
module.exports = { report, readRun, quantile, trend };
