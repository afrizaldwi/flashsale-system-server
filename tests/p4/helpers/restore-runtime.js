"use strict";
const fs = require("node:fs");
const path = require("node:path");
function restoreOptions(root) {
  const config = { root, runtime: path.join(root, ".p3"), envFile: path.join(root, ".env.p3"),
    project: "flashsale-p3", port: 8080, values: { P3_ID: "00000000-0000-4000-8000-000000000003" } };
  fs.mkdirSync(config.runtime, { recursive: true });
  const state = { project: config.project, database: "flashsale_p3", identity: config.values.P3_ID,
    runId: "aabbccddeeff", phase: "recovering", originalPrimary: { id: "a".repeat(64), volume: "flashsale-p3_primary" },
    originalReplica: { id: "b".repeat(64), volume: "flashsale-p3_replica" },
    primaryVolume: "flashsale-p3_primary_recovery_aabbccddeeff", replicaVolume: "flashsale-p3_replica_recovery_aabbccddeeff" };
  fs.writeFileSync(path.join(config.runtime, "recovery.json"), JSON.stringify(state));
  fs.writeFileSync(path.join(config.runtime, "control.json"), '{"paused":true}');
  return { config, confirmPrimary: "e".repeat(64), confirmVolume: state.primaryVolume };
}
const restoreInspect = () => JSON.stringify([{ Id: "e".repeat(64), State: { Running: true, Status: "running" },
  Config: { Labels: { "com.docker.compose.project": "flashsale-p3", "com.docker.compose.service": "db-primary", "flashsale.environment": "p3" } },
  Mounts: [{ Type: "volume", Destination: "/var/lib/postgresql/data", Name: "flashsale-p3_primary_recovery_aabbccddeeff" }],
  NetworkSettings: { Networks: { "flashsale-p3_p3": {} } } }]);
module.exports = { restoreOptions, restoreInspect };
