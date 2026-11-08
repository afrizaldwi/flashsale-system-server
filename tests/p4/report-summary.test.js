"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { summarizeDisasterRecovery } = require("../../scripts/p4/p3-dr");

test("DR console summary stays bounded while preserving failed gates and evidence paths", () => {
  const transactions = Array.from({ length: 1000 }, (_, i) => ({ idempotencyKey: `key-${i}`, payload: "x".repeat(100) }));
  const report = {
    runId: "9463e0eb4291", result: "PARTIAL", success: false, requiresManualRecovery: true,
    k6Result: { ok: true, code: 0, unexpectedResponseCount: 0, stdout: "x".repeat(1_000_000), stderr: "y".repeat(1_000_000) },
    reconciliation: { allAcknowledgedTransactions: { count: 379, transactions } },
    acknowledgementReconciliation: { unresolved: 379, transactions },
    lostTransactions: transactions,
    replays: [{ classification: "RECONCILED" }, { classification: "UNRESOLVED" }],
    rto: { seconds: null, elapsedUntilIntegrityAuditSeconds: 81.369 },
    rpo: { seconds: 0.005 }, validation: { checks: { acknowledged: false }, failures: ["acknowledged"] },
  };
  const before = JSON.stringify(report);
  const summary = summarizeDisasterRecovery(report, path.resolve("example"));
  assert.ok(JSON.stringify(summary).length < 2500);
  assert.equal(summary.success, false);
  assert.equal(summary.result, "PARTIAL");
  assert.equal(summary.acknowledgements.unresolved, 379);
  assert.equal(summary.ambiguous.unresolved, 1);
  assert.equal(summary.rto.seconds, null);
  assert.deepEqual(summary.failures, ["acknowledged"]);
  assert.equal(summary.checks.acknowledged, false);
  assert.equal(summary.evidence.report, path.resolve("example/results/p4/9463e0eb4291/report.json"));
  assert.match(summary.nextAction, /forensic/);
  assert.equal(JSON.stringify(report), before);
});

test("DR dry-run retains target confirmations and blockers", () => {
  const plan = { dryRun: true, status: "BLOCKED", blockers: ["replica unhealthy"], target: { primaryId: "immutable-id", primaryVolume: "volume" } };
  assert.equal(summarizeDisasterRecovery(plan), plan);
});

test("successful DR summary preserves success without requesting ACK remediation", () => {
  const summary = summarizeDisasterRecovery({ runId: "123456abcdef", result: "PASSED", success: true, acknowledgementReconciliation: { unresolved: 0 }, validation: { failures: [] } });
  assert.equal(summary.success, true);
  assert.equal(summary.nextAction, undefined);
});
