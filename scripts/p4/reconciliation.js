"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");

const keyOf = o => o.idempotency_key || o.idempotencyKey;
function payloadMatches(tx, order) {
  return order && [
    [tx.userId, order.user_id ?? order.userId],
    [tx.productId, order.product_id ?? order.productId],
    [tx.qty, order.qty],
  ].every(([a, b]) => Number.isSafeInteger(Number(a)) && Number(a) > 0 && Number(a) === Number(b));
}
function validForensics(evidence) {
  return evidence?.isolated === true && evidence?.originalMountedReadOnly === true &&
    evidence?.copyVolume && evidence?.originalVolume && evidence.copyVolume !== evidence.originalVolume &&
    /^[a-f0-9]{64}$/.test(evidence?.exportSha256 || "") &&
    evidence?.verifiedBy && Number.isFinite(Date.parse(evidence?.exportedAt));
}
function appendEvidence(file, record) {
  if (!file) throw new Error("Reconciliation journal path required");
  const fd = fs.openSync(file, "a", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

// Explicit per-key approvals are required before any API replay. No SQL writes,
// stock adjustments, financial operations, or access to the old volume occur here.
async function reconcileAcknowledgements({ transactions, recoveredOrders, forensic = null,
  approvals = [], compensations = [], checkout, lookup, audit, journalPath,
  now = () => new Date().toISOString() }) {
  const rows = [], seen = new Set();
  const index = new Map();
  for (const order of recoveredOrders) {
    const key = keyOf(order);
    const list = index.get(key) || []; list.push(order); index.set(key, list);
  }
  for (const tx of transactions) {
    if (seen.has(tx.idempotencyKey)) continue;
    seen.add(tx.idempotencyKey);
    const original = structuredClone(tx);
    const recovered = index.get(tx.idempotencyKey) || [];
    const old = validForensics(forensic) ? (forensic.orders || []).filter(o => keyOf(o) === tx.idempotencyKey) : [];
    const row = { idempotencyKey: tx.idempotencyKey, original,
      originalStatus: tx.status, originalOrderId: tx.orderId ?? null,
      forensicEvidence: forensic ? { ...forensic, orders: undefined, matches: old } : null,
      recoveredDatabaseMatch: recovered, action: "REVIEW", result: "UNRESOLVED",
      compensationStatus: "NONE", timestamp: now(), reason: "Missing acknowledgement requires operator review" };
    if (recovered.length === 1 && payloadMatches(tx, recovered[0])) {
      row.result = "PRESENT_IN_RECOVERED"; row.reason = null;
    } else if (recovered.length) {
      row.reason = "Duplicate key or recovered payload mismatch";
    } else {
      const approval = approvals.find(a => a.idempotencyKey === tx.idempotencyKey);
      const compensation = compensations.find(c => c.idempotencyKey === tx.idempotencyKey);
      const safeOriginal = old.length === 1 && payloadMatches(tx, old[0]) &&
        Number.isFinite(Date.parse(old[0].created_at)) &&
        Date.parse(old[0].created_at) <= Date.parse(tx.responseTimestamp || tx.timestamp) &&
        (tx.orderId == null || String(tx.orderId) === String(old[0].id));
      if (approval?.action === "REPLAY" && approval.approvedBy && approval.reason &&
          payloadMatches(tx, approval) && checkout && lookup && audit &&
          (safeOriginal || (old.length === 0 && approval.allowLedgerOnly === true))) {
        row.action = "REPLAY_ORIGINAL_KEY";
        row.approval = approval;
        // Persist immutable loss evidence and intent BEFORE a potentially ambiguous write.
        appendEvidence(journalPath, { ...row, stage: "INTENT" });
        try {
          const first = await checkout({ user_id: tx.userId, product_id: tx.productId, qty: tx.qty }, tx.idempotencyKey);
          row.response = first;
          if (first.status === 409 && first.body?.error === "SOLD_OUT") {
            row.result = "BUSINESS_COMPENSATION_REQUIRED";
            row.compensationStatus = "PENDING"; row.reason = "SOLD_OUT; no automatic retry";
          } else if ([200, 201].includes(first.status) && first.body?.order?.id != null) {
            const matches = await lookup(tx.idempotencyKey);
            const check = await audit();
            if (matches.length === 1 && payloadMatches(tx, matches[0]) &&
                String(matches[0].id) === String(first.body.order.id) && check.consistent === true) {
              row.result = safeOriginal ? "RECOVERED_FROM_OLD_PRIMARY" : "REPLAYED_IDEMPOTENTLY";
              row.recoveredDatabaseMatch = matches; row.integrityAudit = check; row.reason = null;
            } else row.reason = "Reconstruction could not prove unique order and stock conservation";
          } else row.reason = "Replay failed or ambiguous; review database using original key";
        } catch (error) { row.reason = `Reconciliation error: ${error.message}`; }
      }
      if (["UNRESOLVED", "BUSINESS_COMPENSATION_REQUIRED"].includes(row.result) && compensation) {
        row.result = "BUSINESS_COMPENSATION_REQUIRED";
        row.compensation = compensation;
        row.compensationStatus = compensation.status === "COMPLETED" && compensation.approvedBy &&
          compensation.reference && compensation.resolution && Number.isFinite(Date.parse(compensation.completedAt))
          ? "COMPLETED" : "PENDING";
        row.reason = row.compensationStatus === "COMPLETED" ? null : "Explicit completed business compensation record required";
      }
    }
    appendEvidence(journalPath, { ...row, stage: "OUTCOME" });
    rows.push(row);
  }
  const resolved = r => ["PRESENT_IN_RECOVERED", "RECOVERED_FROM_OLD_PRIMARY", "REPLAYED_IDEMPOTENTLY"].includes(r.result) ||
    (r.result === "BUSINESS_COMPENSATION_REQUIRED" && r.compensationStatus === "COMPLETED");
  return { transactions: rows, total: rows.length, unresolved: rows.filter(r => !resolved(r)).length,
    allResolved: rows.every(resolved), originalMissingCount: transactions.filter(t =>
      !index.has(t.idempotencyKey)).length,
    evidenceSha256: crypto.createHash("sha256").update(JSON.stringify(transactions)).digest("hex") };
}
module.exports = { reconcileAcknowledgements, payloadMatches, validForensics, appendEvidence };
