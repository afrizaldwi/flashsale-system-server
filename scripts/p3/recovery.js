"use strict";
const path = require("node:path");
const { readJson } = require("./util");

// Persist only volume identities; credentials continue to come from .env.p3.
function recoveryState(c) {
  const state = readJson(path.join(c.runtime, "recovery.json"), null);
  if (!state) return null;
  if (
    c.project !== "flashsale-p3" ||
    state.project !== "flashsale-p3" ||
    state.database !== "flashsale_p3" ||
    state.identity !== c.values.P3_ID ||
    !/^[a-f0-9]{12}$/.test(state.runId || "") ||
    state.primaryVolume !== `flashsale-p3_primary_recovery_${state.runId}` ||
    state.replicaVolume !== `flashsale-p3_replica_recovery_${state.runId}` ||
    !/^[a-f0-9]{64}$/.test(state.originalPrimary?.id || "") ||
    !/^flashsale-p3_primary(?:_recovery_[a-f0-9]{12})?$/.test(state.originalPrimary?.volume || "") ||
    state.originalPrimary.volume === state.primaryVolume ||
    !["recovering", "validated"].includes(state.phase)
  ) {
    throw new Error(
      "Invalid P3 recovery manifest; refusing volume substitution",
    );
  }
  return state;
}
function assertRecoveryComplete(c) {
  if (recoveryState(c)?.phase === "recovering") throw new Error("Incomplete P4 recovery: P3 start/scale/resume is blocked");
}
function databaseVolume(c, suffix) {
  return recoveryState(c)?.[`${suffix}Volume`] || `${c.project}_${suffix}`;
}
module.exports = { recoveryState, databaseVolume, assertRecoveryComplete };
