"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readLedger, acknowledgementAccounting } = require("./ledger");
const { reconcileAcknowledgements, validForensics } = require("./reconciliation");
const { context, dataMount } = require("./p3-dr");
const { recoveryState } = require("../p3/recovery");
const { waitForOperationLock, readJson } = require("../p3/util");
const { assertIsolation, verify } = require("../p3/dataset");
const { sendCheckoutRequest } = require("./workload");

function loadReview(file) {
  const review = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (review.forensic) {
    const f = review.forensic;
    if (!validForensics(f) || !f.exportFile) throw new Error("Verified isolated forensic-copy provenance required");
    const raw = fs.readFileSync(path.resolve(path.dirname(file), f.exportFile));
    if (crypto.createHash("sha256").update(raw).digest("hex") !== f.exportSha256)
      throw new Error("Forensic export checksum mismatch");
    f.orders = JSON.parse(raw.toString("utf8"));
    if (!Array.isArray(f.orders)) throw new Error("Forensic orders must be an array");
  }
  return review;
}
async function runReview(options) {
  if (!options.ledger || !options.output) throw new Error("--ledger and a fresh --output are required");
  const ledger = readLedger(options.ledger);
  if (ledger.malformedCount || !ledger.entries.length) throw new Error("Missing or malformed ledger evidence");
  const review = loadReview(options.review);
  const output = path.resolve(options.output);
  // Reserve a new report. Never rewrite original incident artifacts.
  const fd = fs.openSync(output, "wx", 0o600);
  fs.closeSync(fd);
  let release;
  try {
    let recoveredOrders, checkout, lookup, audit;
    if (options.applyApproved) {
      const { c, docker } = context(options);
      release = await waitForOperationLock(c.runtime);
      const state = recoveryState(c);
      if (!state || !readJson(path.join(c.runtime, "control.json"), {}).paused)
        throw new Error("A verified recovery manifest and paused controller are required");
      if (review.forensic && review.forensic.originalVolume !== state.originalPrimary.volume)
        throw new Error("Forensic source differs from preserved incident volume");
      await docker.preflight({ allowIncompleteRecovery: true });
      await assertIsolation(docker);
      const originalUsers = (await docker.command(["ps", "-q", "--filter", `volume=${state.originalPrimary.volume}`])).trim();
      if (originalUsers) throw new Error("Original primary volume is mounted by a running container; keep it fenced and finish forensic copying before reconciliation");
      const primaries = await docker.list("db-primary");
      if (primaries.length !== 1 || !primaries[0].State.Running ||
          primaries[0].Id !== options.confirmPrimary || dataMount(primaries[0]) !== options.confirmVolume ||
          options.confirmVolume !== state.primaryVolume || options.confirmVolume === state.originalPrimary.volume)
        throw new Error("Explicit current recovery primary ID and fresh volume confirmation required");
      const query = () => docker.sql("db-primary", "SELECT COALESCE(json_agg(o),'[]'::json) FROM (SELECT id,idempotency_key,user_id,product_id,qty,created_at FROM orders) o;");
      recoveredOrders = JSON.parse(await query());
      lookup = async key => JSON.parse(await query()).filter(o => o.idempotency_key === key);
      audit = () => verify(docker);
      const before = await audit();
      if (!before.consistent) throw new Error("Recovery integrity audit failed before reconciliation");
      checkout = (payload, key) => (options.checkout || sendCheckoutRequest)(c.baseUrl, payload, key);
    } else {
      if (!options.recoveredOrders) throw new Error("Offline review requires --recovered-orders JSON export");
      recoveredOrders = JSON.parse(fs.readFileSync(options.recoveredOrders, "utf8"));
    }
    const accounting = acknowledgementAccounting(ledger.entries, recoveredOrders, {
      injectionAt: options.injectionAt, primaryUnavailableAt: options.primaryUnavailableAt,
    });
    const reconciliation = await reconcileAcknowledgements({
      transactions: accounting.allAcknowledgedTransactions.transactions, recoveredOrders,
      forensic: review.forensic, approvals: options.applyApproved ? review.approvals : [],
      compensations: review.compensations, checkout, lookup, audit,
      journalPath: output + ".jsonl",
    });
    const report = { mode: options.applyApproved ? "APPROVED_RECONCILIATION" : "OFFLINE_REVIEW",
      ledgerSha256: crypto.createHash("sha256").update(fs.readFileSync(options.ledger)).digest("hex"),
      originalAccounting: accounting, reconciliation, completedAt: new Date().toISOString(),
      historicalDrResultUnchanged: true, manifestUnchanged: true };
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    fs.writeFileSync(output, JSON.stringify({ result: "FAILED", error: error.message, historicalDrResultUnchanged: true }, null, 2));
    throw error;
  } finally { release?.(); }
}
async function main(args = process.argv.slice(2)) {
  const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  if (args.includes("--execute")) throw new Error("Use a reviewed per-key reconciliation plan; this is not a DR executor");
  return runReview({ ledger: value("--ledger"), output: value("--output"), review: value("--review"),
    recoveredOrders: value("--recovered-orders"), injectionAt: value("--injection-at"),
    primaryUnavailableAt: value("--primary-unavailable-at"), applyApproved: args.includes("--apply-approved"),
    confirmPrimary: value("--confirm-primary"), confirmVolume: value("--confirm-volume") });
}
if (require.main === module) main().then(r => console.log(JSON.stringify({ allResolved: r.reconciliation.allResolved, unresolved: r.reconciliation.unresolved })))
  .catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { loadReview, runReview, main };
