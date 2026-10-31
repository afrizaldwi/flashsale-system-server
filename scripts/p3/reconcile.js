"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { jsonSQL } = require("./dataset");
const { append, readJson, writeJson } = require("./util");
function keysInLine(line, runId) {
  if (!/^p3-[a-f0-9-]{36}$/.test(runId))
    throw new Error("Invalid reconciliation run ID");
  return line.match(new RegExp(`${runId}-[0-9]+-[0-9]+`, "g")) || [];
}
async function reconcile(docker, directory, runId) {
  keysInLine("", runId);
  const keys = new Set(),
    file = path.join(directory, "k6.stderr.log");
  if (fs.existsSync(file))
    for await (const line of readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    }))
      if (line.includes("ambiguous_checkout"))
        for (const key of keysInLine(line, runId)) keys.add(key);
  let committed = 0,
    notCommitted = 0;
  const all = [...keys];
  for (let offset = 0; offset < all.length; offset += 1000) {
    const batch = all.slice(offset, offset + 1000);
    // Keys are restricted to the verified UUID namespace and numeric VU/iteration suffixes.
    const rows = await jsonSQL(
      docker,
      "db-primary",
      `SELECT COALESCE(json_agg(r),'[]'::json) FROM (
SELECT k.key,o.id AS order_id FROM (VALUES ${batch.map((k) => `('${k}')`).join(",")}) k(key)
LEFT JOIN orders o ON o.idempotency_key=k.key) r;`,
    );
    for (const row of rows) {
      if (row.order_id) committed++;
      else notCommitted++;
      append(path.join(directory, "ambiguous-checkouts.ndjson"), row);
    }
  }
  const namespace = await jsonSQL(
    docker,
    "db-primary",
    `SELECT json_build_object('orders',COUNT(*),'outside_run',COUNT(*) FILTER(WHERE idempotency_key NOT LIKE '${runId}-%')) FROM orders;`,
  );
  const summary = readJson(path.join(directory, "k6-summary.json"), {});
  const confirmed = summary.metrics?.checkout_created_all?.values?.count;
  const attempts = summary.metrics?.checkout_attempts_all?.values?.count;
  const result = {
    ambiguous: keys.size,
    committed,
    not_committed: notCommitted,
    confirmed_created: confirmed ?? null,
    checkout_attempts: attempts ?? null,
    database_orders: namespace.orders,
    outside_run: namespace.outside_run,
    explained:
      confirmed === undefined
        ? null
        : namespace.orders === confirmed + committed &&
          namespace.orders <= (attempts ?? 0),
  };
  writeJson(path.join(directory, "reconciliation.json"), result);
  if (namespace.outside_run !== 0 || result.explained === false)
    throw new Error(
      "Orders do not match this run and reconciled checkout outcomes",
    );
  return result;
}
module.exports = { keysInLine, reconcile };
