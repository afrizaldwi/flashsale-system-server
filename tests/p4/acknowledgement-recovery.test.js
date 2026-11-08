"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { acknowledgementAccounting, compareLedgerWithDatabase, recordTransaction } = require("../../scripts/p4/ledger");
const { reconcileAcknowledgements } = require("../../scripts/p4/reconciliation");
const { evaluateSuccess } = require("../../scripts/p4/success");
const { observePrimaryUnavailable } = require("../../scripts/p4/lifecycle");
const { loadReview, runReview } = require("../../scripts/p4/reconcile-acknowledged");

const tx = (idempotencyKey = "key", timestamp = "2026-11-08T09:38:57.150Z") => ({
  idempotencyKey, timestamp, requestTimestamp: "2026-11-08T09:38:57.100Z", responseTimestamp: timestamp,
  status: 201, outcome: "CREATED", userId: 2, productId: 1, qty: 2, orderId: 11,
});
const order = (key = "key") => ({ id: 11, idempotency_key: key, user_id: 2, product_id: 1, qty: 2, created_at: "2026-11-08T09:38:57.120Z" });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function forensic() {
  return { isolated: true, originalMountedReadOnly: true, copyVolume: "forensic-copy", originalVolume: "flashsale-p3_primary",
    exportSha256: "a".repeat(64), verifiedBy: "operator", exportedAt: "2026-11-08T10:00:00Z", orders: [order()] };
}
function args(t) { return { transactions: [tx()], recoveredOrders: [], journalPath: path.join(fixture(t), "journal.jsonl") }; }
const approval = { idempotencyKey: "key", action: "REPLAY", approvedBy: "operator", reason: "Reviewed original payload", userId: 2, productId: 1, qty: 2 };

test("ACK timing: before injection, shutdown window and after verified unavailability, present and missing, deduplicated by original key", () => {
  const entries = [tx("before"), tx("window", "2026-11-08T09:38:57.214Z"), tx("after", "2026-11-08T09:38:57.400Z"), tx("before", "2026-11-08T09:38:57.500Z")];
  const r = acknowledgementAccounting(entries, [order("before")], {
    injectionAt: "2026-11-08T09:38:57.187Z", primaryUnavailableAt: "2026-11-08T09:38:57.300Z",
  });
  assert.deepEqual(r.allAcknowledgedTransactions.transactions.map(t => t.timing), ["BEFORE_INJECTION", "INJECTION_WINDOW", "AFTER_PRIMARY_UNAVAILABLE"]);
  assert.equal(r.acknowledgementLoss.preInjection, 0);
  assert.equal(r.acknowledgementLoss.injectionWindow, 1);
  assert.equal(r.acknowledgementLoss.postPrimaryUnavailabilityAcknowledgements, 1);
  assert.equal(r.acknowledgementLoss.totalMissing, 2);
});
test("unknown unavailability never asserts the primary was already stopped; legacy RPO and late loss remain separate", () => {
  const r = compareLedgerWithDatabase([tx(), tx("late", "2026-11-08T09:38:57.214Z")], [], { failureTimestamp: "2026-11-08T09:38:57.187Z" });
  assert.equal(r.actualRpoSeconds, 0.037); assert.equal(r.acknowledgementLoss.totalMissing, 2);
  assert.equal(r.acknowledgementLoss.unavailabilityUnknown, 1); assert.equal(r.acknowledgementLoss.injectionWindow, 0);
});
test("ledger distinguishes DB_UNAVAILABLE from unrelated HTTP 503 and preserves missing payload as unknown", t => {
  const file = path.join(fixture(t), "ledger.jsonl");
  const db = recordTransaction({ ...tx(), status: 503, outcome: "ERROR", body: { error: "DB_UNAVAILABLE" } }, file);
  const http = recordTransaction({ idempotencyKey: "http", status: 503, body: { error: "MAINTENANCE" } }, file);
  assert.equal(db.failureKind, "DB_UNAVAILABLE"); assert.equal(http.failureKind, "HTTP_FAILURE");
  assert.equal(http.userId, null); assert.equal(http.productId, null); assert.equal(http.qty, null);
});
test("Docker lifecycle: death event plus absence establishes unavailability after request, not command start", async () => {
  const id = "a".repeat(64), at = "2026-11-08T09:38:57.300Z";
  const r = await observePrimaryUnavailable({ command: async args => {
    if (args[0] === "inspect") throw new Error("No such object");
    return JSON.stringify({ Actor: { ID: id }, Action: "die", timeNano: String(BigInt(Date.parse(at)) * 1000000n) });
  } }, id, "2026-11-08T09:38:57.187Z", () => "2026-11-08T09:38:57.500Z");
  assert.equal(r.verified, true); assert.equal(r.primaryUnavailableAt, at);
});
for (const mode of ["no-death-evidence", "still-running", "inspect-denied", "foreign-event"]) {
  test(`Docker lifecycle fails closed: ${mode}`, async () => {
    const id = "a".repeat(64);
    const r = await observePrimaryUnavailable({ command: async a => {
      if (a[0] === "events") return mode === "no-death-evidence" ? "" : JSON.stringify({ Actor: { ID: mode === "foreign-event" ? "b".repeat(64) : id }, Action: "die", timeNano: String(BigInt(Date.parse("2026-11-08T09:38:57.300Z")) * 1000000n) });
      if (mode === "still-running") return JSON.stringify([{ Id: id, State: { Running: true } }]);
      throw new Error(mode === "inspect-denied" ? "permission denied" : "No such container");
    } }, id, "2026-11-08T09:38:57.187Z", () => "2026-11-08T09:38:57.500Z");
    assert.equal(r.verified, false); assert.equal(r.primaryUnavailableAt, undefined);
  });
}
test("ACK present in recovery requires matching user, product, quantity and unique key", async t => {
  const a = args(t);
  assert.equal((await reconcileAcknowledgements({ ...a, recoveredOrders: [order()] })).allResolved, true);
  for (const recoveredOrders of [[{ ...order(), qty: 3 }], [order(), order()]])
    assert.equal((await reconcileAcknowledgements({ ...a, recoveredOrders })).unresolved, 1);
});
test("old-primary-only ACK stays unresolved without approval; absent from both also stays unresolved", async t => {
  const a = args(t);
  assert.equal((await reconcileAcknowledgements({ ...a, forensic: forensic() })).unresolved, 1);
  assert.equal((await reconcileAcknowledgements(a)).unresolved, 1);
});
test("approved reconstruction uses original key once, prevents duplicates and verifies conservation; evidence preserves original loss", async t => {
  const a = args(t), orders = [], stock = { initial: 10, remaining: 10 }; let calls = 0;
  const checkout = async (payload, key) => {
    calls++; assert.equal(key, "key"); assert.deepEqual(payload, { user_id: 2, product_id: 1, qty: 2 });
    const existing = orders.find(o => o.idempotency_key === key);
    if (existing) return { status: 200, body: { order: existing } };
    const created = order(); orders.push(created); stock.remaining -= payload.qty;
    return { status: 201, body: { order: created } };
  };
  const input = { ...a, forensic: forensic(), approvals: [approval], checkout,
    lookup: async () => orders, audit: async () => ({ consistent: stock.initial - stock.remaining === orders.reduce((s,o) => s + o.qty, 0) }) };
  const r = await reconcileAcknowledgements(input);
  assert.equal(r.transactions[0].result, "RECOVERED_FROM_OLD_PRIMARY"); assert.equal(r.allResolved, true);
  const repeat = await reconcileAcknowledgements({ ...input, recoveredOrders: orders });
  assert.equal(repeat.transactions[0].result, "PRESENT_IN_RECOVERED"); assert.equal(calls, 1); assert.equal(orders.length, 1); assert.equal(stock.remaining, 8);
  const journal = fs.readFileSync(a.journalPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(journal[0].stage, "INTENT"); assert.deepEqual(journal[0].original, a.transactions[0]);
  assert.equal(journal[0].recoveredDatabaseMatch.length, 0);
});
test("ledger-only replay requires explicit authorization and verifies stock conservation", async t => {
  const a = args(t), common = { ...a, checkout: async () => ({ status: 201, body: { order: order() } }), lookup: async () => [order()], audit: async () => ({ consistent: true }) };
  assert.equal((await reconcileAcknowledgements({ ...common, approvals: [approval] })).unresolved, 1);
  const r = await reconcileAcknowledgements({ ...common, approvals: [{ ...approval, allowLedgerOnly: true }] });
  assert.equal(r.transactions[0].result, "REPLAYED_IDEMPOTENTLY");
  assert.equal((await reconcileAcknowledgements({ ...common, forensic: forensic(), approvals: [approval], audit: async () => ({ consistent: false }) })).unresolved, 1);
});
test("SOLD_OUT requires explicit compensation and never loops; pending compensation is unresolved", async t => {
  const a = args(t); let calls = 0;
  const r = await reconcileAcknowledgements({ ...a, forensic: forensic(), approvals: [approval], lookup: async () => [], audit: async () => ({ consistent: true }),
    checkout: async () => { calls++; return { status: 409, body: { error: "SOLD_OUT" } }; } });
  assert.equal(calls, 1); assert.equal(r.transactions[0].result, "BUSINESS_COMPENSATION_REQUIRED"); assert.equal(r.unresolved, 1);
  const completed = await reconcileAcknowledgements({ ...a, compensations: [{ idempotencyKey: "key", status: "COMPLETED", approvedBy: "business-owner", reference: "CASE-1", resolution: "Customer notified and replacement fulfilment agreed", completedAt: "2026-11-08T11:00:00Z" }] });
  assert.equal(completed.allResolved, true);
  assert.equal((await reconcileAcknowledgements({ ...a, compensations: [{ idempotencyKey: "key", status: "COMPLETED" }] })).unresolved, 1);
});
test("journal failure prevents replay; malformed forensic provenance cannot authorize old-primary reconstruction", async t => {
  const a = args(t); let writes = 0;
  const input = { ...a, approvals: [approval], forensic: forensic(), checkout: async () => { writes++; }, lookup: async () => [], audit: async () => ({ consistent: true }) };
  await assert.rejects(reconcileAcknowledgements({ ...input, journalPath: path.dirname(a.journalPath) }));
  assert.equal(writes, 0);
  assert.equal((await reconcileAcknowledgements({ ...input, forensic: { ...forensic(), copyVolume: "flashsale-p3_primary" } })).unresolved, 1);
});
function goodReport() {
  return { k6Result: { ok: true }, detection: { samples: [{ status: 503, at: "2026-11-08T09:59:59.750Z" }, { status: 503, at: "2026-11-08T10:00:00Z" }] }, timestamps: { t0: "2026-11-08T10:00:00Z", failureDetectionAt: "2026-11-08T10:00:00Z", primaryUnavailableAt: "2026-11-08T09:59:59Z", firstSuccessfulRecoveryCheckoutAt: "2026-11-08T10:00:20Z", integrityAuditCompletedAt: "2026-11-08T10:00:30Z" }, primaryUnavailability: { verified: true }, rto: { seconds: 30 }, rpo: { seconds: 0.037 }, outage: { backendLiveness: [{ live: true, processSurvived: true }, { live: true, processSurvived: true }], checkoutStatus: 503, checkoutError: "DB_UNAVAILABLE", productsStatus: 200, readFrom: "replica" }, roles: { writablePrimaries: 1, standbys: 1 }, integrity: { consistent: true }, applicationAudit: { consistent: true }, primaryAudit: { negative_stock: 0, duplicate_orders: 0, mismatches: 0 }, acknowledgementReconciliation: { allResolved: true, unresolved: 0, total: 409 }, reconciliation: { allAcknowledgedTransactions: { count: 409 }, ambiguousTransactions: { count: 1 } }, replays: [{ classification: "RECONCILED" }] };
}
for (const missing of [390, 19, 409]) {
  test(`${missing} missing ACKs fail DR despite RPO 0.037 and successful ambiguous replay`, () => {
    const r = goodReport(); r.acknowledgementReconciliation = { allResolved: false, unresolved: missing, total: 409 };
    assert.equal(evaluateSuccess(r).success, false); assert.ok(evaluateSuccess(r).failures.includes("acknowledged"));
  });
}
test("complete reconciliation can pass; pending compensation, missing replay evidence, restarted backend or bad roles fail", () => {
  assert.equal(evaluateSuccess(goodReport()).success, true);
  for (const mutate of [r => r.acknowledgementReconciliation.allResolved = false, r => r.replays = [], r => r.outage.backendLiveness[0].processSurvived = false, r => r.roles.writablePrimaries = 2, r => r.replays[0].classification = "SOLD_OUT_COMPENSATION_REQUIRED", r => r.rto.seconds = null]) {
    const r = goodReport(); mutate(r); assert.equal(evaluateSuccess(r).success, false);
  }
});
test("offline forensic review checks export hash, never contacts Docker/API, and refuses report overwrite", async t => {
  const dir = fixture(t), ledger = path.join(dir, "ledger.jsonl"), exported = path.join(dir, "old.json"), review = path.join(dir, "review.json"), recoveredOrders = path.join(dir, "recovered.json"), output = path.join(dir, "report.json");
  recordTransaction(tx(), ledger); fs.writeFileSync(exported, JSON.stringify([order()])); fs.writeFileSync(recoveredOrders, "[]");
  const f = { ...forensic(), exportFile: "old.json", exportSha256: crypto.createHash("sha256").update(fs.readFileSync(exported)).digest("hex") };
  fs.writeFileSync(review, JSON.stringify({ forensic: f, approvals: [approval] }));
  const r = await runReview({ ledger, recoveredOrders, review, output, checkout: () => assert.fail("Offline review must not write") });
  assert.equal(r.reconciliation.unresolved, 1); assert.equal(r.historicalDrResultUnchanged, true);
  await assert.rejects(runReview({ ledger, recoveredOrders, output }), /EEXIST/);
  fs.appendFileSync(exported, " "); assert.throws(() => loadReview(review), /checksum/);
});

for (const mode of ["approved", "original-volume-running", "wrong-confirmation"]) {
  test(`standalone approved reconciliation: ${mode}, all infrastructure calls mocked`, async t => {
    const root = fixture(t), runtime = path.join(root, ".p3"); fs.mkdirSync(runtime);
    const c = { root, runtime, project: "flashsale-p3", port: 8080, baseUrl: "http://127.0.0.1:8080", envFile: path.join(root, ".env.p3"),
      max: 6, poolMax: 10, values: { P3_ID: "00000000-0000-4000-8000-000000000003" } };
    const state = { project: c.project, database: "flashsale_p3", identity: c.values.P3_ID, runId: "aabbccddeeff", phase: "recovering",
      originalPrimary: { id: "a".repeat(64), volume: "flashsale-p3_primary" },
      primaryVolume: "flashsale-p3_primary_recovery_aabbccddeeff", replicaVolume: "flashsale-p3_replica_recovery_aabbccddeeff" };
    fs.writeFileSync(path.join(runtime, "recovery.json"), JSON.stringify(state)); fs.writeFileSync(path.join(runtime, "control.json"), '{"paused":true}');
    const ledger = path.join(root, "ledger.jsonl"), review = path.join(root, "review.json"), output = path.join(root, "review-result.json");
    recordTransaction(tx(), ledger); fs.writeFileSync(review, JSON.stringify({ approvals: [{ ...approval, allowLedgerOnly: true }] }));
    const orders = [], calls = [];
    const docker = { c, preflight: async options => assert.equal(options.allowIncompleteRecovery, true),
      command: async a => { calls.push(a); assert.equal(a[0], "ps"); return mode === "original-volume-running" ? "old-container" : ""; },
      list: async service => [{ Id: "e".repeat(64), State: { Running: true }, Mounts: [{ Destination: "/var/lib/postgresql/data", Type: "volume", Name: service === "db-primary" ? state.primaryVolume : state.replicaVolume }] }],
      sql: async (service, sql) => {
        if (sql.includes("'identity'")) return JSON.stringify({ database: "flashsale_p3", identity: c.values.P3_ID, standby: service === "db-replica", max_connections: 100 });
        if (sql.includes("pg_current_wal_lsn")) return "0/123";
        if (sql.includes("pg_last_wal_replay_lsn")) return "t";
        if (sql.includes("json_agg(o)")) return JSON.stringify(orders);
        return JSON.stringify({ negative_stock: 0, duplicate_orders: 0, foreign_orders: 0, products: [{ id: 1, selisih: 0 }], orders: orders.length, qty: orders.length * 2 });
      } };
    let writes = 0;
    const run = () => runReview({ ledger, review, output, applyApproved: true, config: c, docker,
      confirmPrimary: mode === "wrong-confirmation" ? "f".repeat(64) : "e".repeat(64), confirmVolume: state.primaryVolume,
      checkout: async (base, payload, key) => { writes++; assert.equal(key, "key"); assert.equal(payload.qty, 2); orders.push(order()); return { status: 201, body: { order: order() } }; } });
    if (mode === "approved") { assert.equal((await run()).reconciliation.allResolved, true); assert.equal(writes, 1); }
    else { await assert.rejects(run(), /Original primary volume|confirmation required/); assert.equal(writes, 0); }
    assert.ok(calls.every(a => a[0] === "ps"));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, "recovery.json"))), state);
    assert.equal(fs.existsSync(path.join(runtime, "operation.lock")), false);
  });
}
