"use strict";
const { payloadMatches } = require("./reconciliation");

// Opt-in recovery from the external ACK ledger. Original loss stays in the report.
// Each write is journaled by reconcileAcknowledgements; all reads hit the primary.
async function approvedLedgerReplay({ transactions, approval, baseUrl, http, checkout }) {
  if (typeof approval !== "string" || !approval.trim()) throw new Error("Explicit ACK replay approval is required");
  const seen = new Set();
  for (const tx of transactions) {
    if (!tx.idempotencyKey || seen.has(tx.idempotencyKey) || ![200, 201].includes(tx.status) ||
        ![tx.userId, tx.productId, tx.qty].every(n => Number.isSafeInteger(n) && n > 0) ||
        !Number.isFinite(Date.parse(tx.responseTimestamp || tx.timestamp)))
      throw new Error("Invalid or duplicate acknowledged ledger payload");
    seen.add(tx.idempotencyKey);
  }
  const baseline = await http(baseUrl, "/stats");
  if (baseline.status !== 200 || baseline.body?.consistent !== true) throw new Error("ACK replay baseline audit failed");
  const initial = baseline.body;
  if (![initial.total_orders, initial.total_qty_sold].every(n => Number.isSafeInteger(n) && n >= 0) ||
      !Array.isArray(initial.products) || !initial.products.length ||
      initial.products.some(p => !Number.isSafeInteger(p.id) || !Number.isSafeInteger(p.stock) || p.stock < 0) ||
      new Set(initial.products.map(p => p.id)).size !== initial.products.length)
    throw new Error("Malformed ACK replay baseline");
  const expectedStock = new Map(initial.products.map(p => [p.id, p.stock]));
  let added = 0, quantity = 0, halted = false;
  const ids = new Map();
  const stop = message => { halted = true; throw new Error(message); };
  return {
    approvals: transactions.map(tx => ({ idempotencyKey: tx.idempotencyKey, userId: tx.userId,
      productId: tx.productId, qty: tx.qty, action: "REPLAY", allowLedgerOnly: true,
      approvedBy: "Explicit operator ACK replay option", reason: approval.trim() })),
    checkout: async (payload, key) => {
      if (halted) throw new Error("ACK replay halted after an earlier failure");
      const tx = transactions.find(t => t.idempotencyKey === key);
      if (!tx || !payloadMatches(tx, payload)) return stop("Unapproved ACK payload");
      const first = await checkout(baseUrl, payload, key);
      if (![200, 201].includes(first.status) || !payloadMatches(tx, first.body?.order) || first.body?.order?.idempotency_key !== key)
        return stop("ACK replay returned an invalid or ambiguous order");
      const repeated = await checkout(baseUrl, payload, key);
      if (repeated.status !== 200 || repeated.body?.result !== "DUPLICATE" ||
          repeated.body?.order?.id !== first.body.order.id || !payloadMatches(tx, repeated.body.order) || repeated.body.order.idempotency_key !== key)
        return stop("ACK replay duplicate retry failed");
      ids.set(key, first.body.order.id);
      if (first.status === 201) {
        added++; quantity += tx.qty;
        expectedStock.set(tx.productId, expectedStock.get(tx.productId) - tx.qty);
      }
      return first;
    },
    lookup: async key => {
      if (!ids.has(key)) return [];
      const r = await http(baseUrl, `/orders/${ids.get(key)}`);
      if (r.status !== 200 || r.body?.idempotency_key !== key) return stop("Independent primary order lookup failed");
      const { id, idempotency_key, user_id, product_id, qty, created_at, status } = r.body;
      return [{ id, idempotency_key, user_id, product_id, qty, created_at, status }];
    },
    audit: async () => {
      const r = await http(baseUrl, "/stats");
      const consistent = r.status === 200 && r.body?.consistent === true &&
        r.body.total_orders === initial.total_orders + added && r.body.total_qty_sold === initial.total_qty_sold + quantity &&
        r.body.products.length === expectedStock.size && r.body.products.every(p => p.stock === expectedStock.get(p.id));
      if (!consistent) return stop("Per-ACK stock conservation audit failed");
      return { ...r.body, consistent, scope: "Fresh primary snapshot via /stats; final independent SQL and standby audit follows" };
    },
  };
}
function auditAcknowledgedOrders(transactions, orders) {
  const index = new Map();
  for (const order of orders) {
    const rows = index.get(order.idempotency_key) || [];
    rows.push(order); index.set(order.idempotency_key, rows);
  }
  const unresolved = transactions.filter(tx => {
    const rows = index.get(tx.idempotencyKey) || [];
    return rows.length !== 1 || !payloadMatches(tx, rows[0]);
  }).length;
  return { total: transactions.length, unresolved, allResolved: unresolved === 0 };
}
module.exports = { approvedLedgerReplay, auditAcknowledgedOrders };
