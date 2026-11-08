"use strict";
// A transport failure is only an outage candidate until the host timeline
// places its response after the explicit injection request.
function responseAccepted(entry, outageRequestedAt = null) {
  if (entry.status === 201) return true;
  if (entry.status === 200 && entry.outcome === "DUPLICATE") return true;
  if (entry.status === 409 && entry.outcome === "SOLD_OUT") return true;
  const at = Date.parse(entry.responseTimestamp || entry.timestamp);
  const start = Date.parse(outageRequestedAt);
  const inOutage = Number.isFinite(at) && Number.isFinite(start) && at >= start;
  return inOutage && (entry.status === 0 ||
    (entry.status === 503 && entry.errorCode === "DB_UNAVAILABLE"));
}
module.exports = { responseAccepted };
