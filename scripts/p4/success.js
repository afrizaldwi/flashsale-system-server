"use strict";
function evaluateSuccess(report) {
  const finiteWithin = (n, limit) => Number.isFinite(n) && n >= 0 && n <= limit;
  const samples = report.detection?.samples || [];
  const last = samples.at(-1), prior = samples.at(-2);
  const checks = {
    workload: report.k6Result?.ok === true,
    detection: !!report.timestamps?.t0 && report.timestamps.t0 === report.timestamps.failureDetectionAt &&
      last?.status === 503 && prior?.status === 503 && last.at === report.timestamps.t0,
    primaryLifecycle: !!report.timestamps?.primaryUnavailableAt && report.primaryUnavailability?.verified === true,
    rto: finiteWithin(report.rto?.seconds, 300),
    rpo: finiteWithin(report.rpo?.seconds, 60),
    backendSurvival: report.outage?.backendLiveness?.length >= 2 && report.outage.backendLiveness.every(b => b.live && b.processSurvived),
    checkout: report.outage?.checkoutStatus === 503 && report.outage.checkoutError === "DB_UNAVAILABLE",
    replicaReads: report.outage?.productsStatus === 200 && report.outage.readFrom === "replica",
    roles: report.roles?.writablePrimaries === 1 && report.roles?.standbys === 1,
    integrity: report.integrity?.consistent === true && report.applicationAudit?.consistent === true &&
      report.primaryAudit?.negative_stock === 0 && report.primaryAudit?.duplicate_orders === 0 && report.primaryAudit?.mismatches === 0,
    acknowledged: report.acknowledgementReconciliation?.allResolved === true &&
      report.acknowledgementReconciliation?.unresolved === 0 &&
      report.acknowledgementReconciliation?.total === report.reconciliation?.allAcknowledgedTransactions?.count &&
      report.reconciliation?.allAcknowledgedTransactions?.count > 0,
    ambiguous: Array.isArray(report.replays) && report.replays.length === report.reconciliation?.ambiguousTransactions?.count &&
      report.replays.every(r => r.classification === "RECONCILED" ||
        (r.classification === "SOLD_OUT_COMPENSATION_REQUIRED" && r.compensationStatus === "COMPLETED")),
    auditCompleted: !!report.timestamps?.integrityAuditCompletedAt && !!report.timestamps?.firstSuccessfulRecoveryCheckoutAt,
  };
  return { success: Object.values(checks).every(Boolean), checks,
    failures: Object.keys(checks).filter(k => !checks[k]) };
}
module.exports = { evaluateSuccess };
