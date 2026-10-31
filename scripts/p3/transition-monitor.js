"use strict";
// Observe actuator waits without running a second policy loop or overlapping samples.
async function observeTransition(collector, interval, operation, onError) {
  let pending = null;
  const timer = setInterval(() => {
    if (pending) return;
    pending = collector.sample().catch(onError).finally(() => { pending = null; });
  }, interval);
  try { return await operation(); }
  finally { clearInterval(timer); if (pending) await pending; }
}
module.exports = { observeTransition };
