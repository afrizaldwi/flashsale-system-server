"use strict";
function procSnapshot(raw) {
  if (!raw?.stat || !raw?.meminfo) return null;
  const cpu = raw.stat
    .split("\n")
    .find((line) => line.startsWith("cpu "))
    ?.trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const mem = Object.fromEntries(
    raw.meminfo
      .split("\n")
      .map((line) => line.match(/^(\w+):\s+(\d+)/))
      .filter(Boolean)
      .map((m) => [m[1], Number(m[2]) * 1024]),
  );
  if (
    !cpu ||
    cpu.length < 4 ||
    cpu.some((v) => !Number.isFinite(v)) ||
    !mem.MemTotal ||
    !Number.isFinite(mem.MemAvailable)
  )
    return null;
  return {
    total: cpu.slice(0, 8).reduce((a, b) => a + b, 0),
    idle: cpu[3] + (cpu[4] || 0),
    logical_cpus: raw.stat.split("\n").filter((l) => /^cpu\d+ /.test(l)).length,
    memory_total_bytes: mem.MemTotal,
    memory_available_bytes: mem.MemAvailable,
    memory_percent: 100 * (1 - mem.MemAvailable / mem.MemTotal),
    pressure: raw.pressure,
  };
}
function cpuDelta(before, after) {
  if (
    !before ||
    !after ||
    after.total <= before.total ||
    after.idle < before.idle
  )
    return null;
  return 100 * (1 - (after.idle - before.idle) / (after.total - before.total));
}
function processRates(previous, current, elapsedMs, logicalCpus) {
  return current.map((p) => {
    const prior = previous.find(
      (q) => q.pid === p.pid && q.started === p.started,
    );
    const cores =
      prior &&
      elapsedMs > 0 &&
      Number.isFinite(p.cpu_seconds) &&
      Number.isFinite(prior.cpu_seconds) &&
      p.cpu_seconds >= prior.cpu_seconds
        ? (p.cpu_seconds - prior.cpu_seconds) / (elapsedMs / 1000)
        : null;
    return {
      ...p,
      cpu_cores: cores,
      cpu_percent_one_core: cores === null ? null : cores * 100,
      cpu_percent_host_capacity:
        cores === null ? null : (cores * 100) / logicalCpus,
    };
  });
}
function sameIds(expected, actual) {
  return (
    expected.length === actual.length &&
    new Set(actual).size === actual.length &&
    expected.every((id) => actual.includes(id))
  );
}
function quality({
  containers,
  after,
  usage,
  backends,
  duration,
  budget,
  windowsCpu,
  vmCpu,
}) {
  const ids = containers.map((c) => c.Id),
    backendIds = containers
      .filter(
        (c) => c.Config.Labels["com.docker.compose.service"] === "backend",
      )
      .map((c) => c.Id);
  const reasons = [];
  if (duration > budget) reasons.push("collection-budget-exceeded");
  if (
    !sameIds(
      ids,
      after.map((c) => c.Id),
    )
  )
    reasons.push("membership-changed");
  if (
    !sameIds(
      ids,
      usage.map((r) => r.id),
    )
  )
    reasons.push("incomplete-or-duplicate-container-stats");
  if (
    !sameIds(
      backendIds,
      backends.map((b) => b.id),
    )
  )
    reasons.push("incomplete-backend-metrics");
  if (usage.some((r) => !Number.isFinite(r.cpu_percent)))
    reasons.push("invalid-container-cpu");
  if (!Number.isFinite(windowsCpu) || !Number.isFinite(vmCpu))
    reasons.push("resource-cpu-baseline-missing");
  if (backends.some((b) => !b.ready || b.metrics.draining))
    reasons.push("backend-not-ready");
  return { valid: reasons.length === 0, reasons };
}
module.exports = { procSnapshot, cpuDelta, processRates, sameIds, quality };
