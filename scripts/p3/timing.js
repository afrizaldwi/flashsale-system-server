"use strict";
function lifecycleTiming(c, requestedSeconds) {
  const steps = c.max - c.min;
  // Each removal resets the low window. Cooldown overlaps the next window.
  // Reserve full drain, SIGTERM wait, routing and polling budgets at every step.
  const perStep =
    Math.max(c.inWindow, c.inCooldown) +
    c.drainTimeout +
    (c.terminationTimeout ?? 100000) +
    (c.routingTimeout ?? 30000) +
    4 * c.interval;
  const minimum = Math.ceil(
    (Math.max(c.outCooldown, c.inCooldown) + steps * perStep + 30000) / 1000,
  );
  const lowSeconds =
    requestedSeconds === undefined || requestedSeconds === ""
      ? minimum
      : Number(requestedSeconds);
  if (!Number.isSafeInteger(lowSeconds) || lowSeconds < minimum)
    throw new Error(
      `Lifecycle low phase must be at least ${minimum}s for this policy (${steps} possible removals)`,
    );
  return {
    steps,
    minimum_low_seconds: minimum,
    low_seconds: lowSeconds,
    total_seconds: 60 + 30 + 300 + 30 + lowSeconds,
    process_timeout_ms: (60 + 30 + 300 + 30 + lowSeconds + 120) * 1000,
  };
}
module.exports = { lifecycleTiming };
