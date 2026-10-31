"use strict";
// Pure policy: elapsed-time windows, not a count of successful polling calls.
function decide(state, sample, c, now) {
  const next = { ...state };
  const hold = (reason) => ({ action: "hold", reason, state: next });
  if (
    !sample.valid ||
    !Number.isFinite(sample.time) ||
    !Number.isFinite(sample.cpu) ||
    !Number.isFinite(sample.hostCpu) ||
    !Number.isFinite(sample.hostMemory) ||
    !Number.isInteger(sample.count) ||
    sample.count < c.min ||
    sample.count > c.max ||
    now - sample.time > c.stale ||
    sample.time > now ||
    !sample.databaseHealthy
  ) {
    next.highSince = null;
    next.lowSince = null;
    return hold("missing-stale-metrics-or-database-unhealthy");
  }
  if (Number.isFinite(state.lastSample) && sample.time <= state.lastSample) {
    next.highSince = null;
    next.lowSince = null;
    return hold("duplicate-or-out-of-order-sample");
  }
  if (state.lastSample && sample.time - state.lastSample > c.stale) {
    next.highSince = null;
    next.lowSince = null;
  }
  next.lastSample = sample.time;
  if (sample.cpu >= c.outCpu) {
    next.highSince ??= now;
    next.lowSince = null;
  } else if (sample.cpu < c.inCpu && !sample.poolWaiting) {
    next.lowSince ??= now;
    next.highSince = null;
  } else {
    next.lowSince = null;
    next.highSince = null;
  }
  if (!sample.enabled) {
    next.highSince = null;
    next.lowSince = null;
    return hold("fixed-mode");
  }
  if (now < (state.cooldownUntil || 0)) return hold("cooldown");
  if (
    next.highSince !== null &&
    next.highSince !== undefined &&
    now - next.highSince >= c.outWindow
  ) {
    if (sample.count >= c.max) return hold("maximum-replicas");
    if (sample.hostCpu >= 90 || sample.hostMemory >= 85)
      return hold("host-capacity");
    return {
      action: "out",
      target: sample.count + 1,
      reason: "sustained-high-cpu",
      state: next,
    };
  }
  if (
    next.lowSince !== null &&
    next.lowSince !== undefined &&
    now - next.lowSince >= c.inWindow &&
    sample.count > c.min
  ) {
    if ((sample.cpu * sample.count) / (sample.count - 1) >= 50)
      return hold("projected-utilization");
    return {
      action: "in",
      target: sample.count - 1,
      reason: "sustained-low-cpu",
      state: next,
    };
  }
  return hold("observation-window");
}
function afterAction(state, direction, c, now) {
  return {
    ...state,
    highSince: null,
    lowSince: null,
    cooldownUntil: now + (direction === "in" ? c.inCooldown : c.outCooldown),
  };
}
module.exports = { decide, afterAction };
