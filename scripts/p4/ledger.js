"use strict";
/**
 * scripts/p4/ledger.js
 * External Transaction Ledger untuk Pengukuran Akurat RPO (Disaster Recovery Plan)
 *
 * Standar DRP Kelompok 1:
 * - Disimpan pada filesystem host (di luar container & volume database Docker).
 * - Bertahan dari kehancuran total container dan volume Docker.
 * - Format append-only JSONL (JSON Lines).
 * - Mencatat setiap transaksi checkout yang telah di-acknowledge:
 *   idempotencyKey, timestamp, productId, qty, status, outcome (CREATED, DUPLICATE, SOLD_OUT, ERROR), orderId.
 * - Tidak mencatat informasi sensitif pengguna.
 * - Menyediakan kalkulasi deterministik RPO dengan membandingkan ledger terhadap database PostgreSQL.
 */

const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const DEFAULT_LEDGER_PATH = path.resolve(
  process.cwd(),
  "backups/p4/ledger/transactions.jsonl",
);

/**
 * Mengklasifikasikan hasil transaksi checkout:
 * - CREATED: HTTP 201 (order baru berhasil dibuat)
 * - DUPLICATE: HTTP 200 dengan idempotency deduplication
 * - SOLD_OUT: HTTP 409 (stok habis)
 * - ERROR: HTTP 5xx, timeout, atau status tak terduga lainnya
 */
function classifyOutcome(status, body) {
  if (status === 201) return "CREATED";
  if (status === 200 && (body?.result === "DUPLICATE" || body?.duplicate))
    return "DUPLICATE";
  if (
    status === 409 &&
    (body?.error === "SOLD_OUT" || body?.message === "Stok tidak mencukupi")
  )
    return "SOLD_OUT";
  if (status >= 500 || status === 0) return "ERROR";
  return "UNKNOWN";
}

/**
 * Mencatat transaksi ke file ledger append-only (JSONL).
 */
function recordTransaction(entry, ledgerPath = DEFAULT_LEDGER_PATH) {
  if (!entry || typeof entry !== "object") {
    throw new Error("Transaction entry wajib berupa objek valid");
  }
  if (!entry.idempotencyKey || typeof entry.idempotencyKey !== "string") {
    throw new Error(
      "Transaction entry wajib memiliki idempotencyKey berupa string",
    );
  }

  const record = {
    idempotencyKey: entry.idempotencyKey,
    timestamp: entry.timestamp || new Date().toISOString(),
    requestTimestamp: entry.requestTimestamp || entry.timestamp || null,
    responseTimestamp: entry.responseTimestamp || entry.timestamp || null,
    productId: entry.productId == null && entry.product_id == null ? null : Number(entry.productId ?? entry.product_id),
    userId: entry.userId == null && entry.user_id == null ? null : Number(entry.userId ?? entry.user_id),
    qty: entry.qty == null ? null : Number(entry.qty),
    status: Number(entry.status || 0),
    outcome: entry.outcome || classifyOutcome(entry.status, entry.body),
    acknowledged:
      entry.status === 201 ||
      (entry.status === 200 &&
        (entry.outcome === "DUPLICATE" ||
          entry.body?.result === "DUPLICATE" ||
          entry.body?.duplicate === true)),
    orderId: entry.orderId || entry.order_id || entry.body?.order?.id || null,
    errorCode: entry.errorCode || entry.body?.error || null,
    failureKind: entry.failureKind || (Number(entry.status) === 0 ? "TRANSPORT_ERROR" :
      (entry.errorCode || entry.body?.error) === "DB_UNAVAILABLE" ? "DB_UNAVAILABLE" :
      Number(entry.status) >= 500 ? "HTTP_FAILURE" : null),
  };

  const dir = path.dirname(ledgerPath);
  fs.mkdirSync(dir, { recursive: true });

  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(ledgerPath, line, "utf8");

  return record;
}

/**
 * Membaca dan mem-parse seluruh record dari file ledger JSONL.
 * Melewati baris kosong dan baris malformed secara aman.
 */
function readLedger(ledgerPath = DEFAULT_LEDGER_PATH) {
  if (!fs.existsSync(ledgerPath)) {
    return { entries: [], validCount: 0, malformedCount: 0, path: ledgerPath };
  }

  const content = fs.readFileSync(ledgerPath, "utf8");
  const lines = content.split(/\r?\n/);
  const entries = [];
  let malformedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.idempotencyKey) {
        entries.push(parsed);
      } else {
        malformedCount++;
      }
    } catch {
      malformedCount++;
    }
  }

  return {
    entries,
    validCount: entries.length,
    malformedCount,
    path: ledgerPath,
  };
}

/**
 * Membandingkan transaksi pada external ledger dengan data orders di database PostgreSQL
 * menggunakan pencocokan berbasis Idempotency-Key.
 *
 * Standar DRP Kelompok 1:
 * - Hanya menghitung transaksi yang berhasil di-acknowledge oleh klien (HTTP 201 CREATED atau 200 DUPLICATE)
 *   sebagai ekspektasi transaksi yang dapat dipulihkan (recoverable logical transactions).
 * - Transaksi error, timeout, atau stok habis (HTTP 409 SOLD_OUT) tidak dihitung sebagai pesanan recoverable.
 * - Membandingkan setiap Idempotency-Key pada ledger terhadap database orders.
 * - Melaporkan:
 *   1. Acknowledged transactions
 *   2. Restored transactions
 *   3. Missing acknowledged transactions
 *   4. Duplicate transactions (pada database)
 *   5. Last recoverable acknowledged transaction
 *   6. Actual RPO relative to failure timestamp
 */
function compareLedgerWithDatabase(
  ledgerEntries = [],
  dbOrders = [],
  options = {},
) {
  const failureTimestamp = options.failureTimestamp || null;

  // 1. Filter transaksi yang berhasil di-acknowledge oleh server
  // Yaitu status 201 (CREATED) atau status 200 dengan idempotency duplicate
  const acknowledgedMap = new Map();
  for (const entry of ledgerEntries) {
    const isAck =
      entry.status === 201 ||
      (entry.status === 200 &&
        (entry.outcome === "DUPLICATE" || entry.body?.result === "DUPLICATE"));

    const ackMs = Date.parse(entry.responseTimestamp || entry.timestamp);
    if (failureTimestamp && !Number.isFinite(ackMs))
      throw new Error("Invalid acknowledged transaction timestamp");
    if (
      isAck &&
      entry.idempotencyKey &&
      (!failureTimestamp || ackMs <= Date.parse(failureTimestamp))
    ) {
      const key = String(entry.idempotencyKey).trim();
      // Simpan entry acknowledged pertama per idempotency key (deduplikasi logikal klien)
      if (!acknowledgedMap.has(key)) {
        acknowledgedMap.set(key, entry);
      }
    }
  }

  const acknowledgedList = Array.from(acknowledgedMap.values());

  // 2. Analisis database orders: mapping keys & deteksi anomali duplikasi
  const dbOrderKeys = [];
  const dbKeyCounts = new Map();
  const dbOrdersByKey = new Map();

  for (const order of dbOrders) {
    const key = String(
      order.idempotency_key || order.idempotencyKey || "",
    ).trim();
    if (key) {
      dbOrderKeys.push(key);
      dbKeyCounts.set(key, (dbKeyCounts.get(key) || 0) + 1);
      if (!dbOrdersByKey.has(key)) {
        dbOrdersByKey.set(key, order);
      }
    }
  }

  const duplicateKeys = [];
  for (const [key, count] of dbKeyCounts.entries()) {
    if (count > 1) {
      duplicateKeys.push({ key, count });
    }
  }
  const lateAcknowledgements = failureTimestamp
    ? ledgerEntries
        .filter(
          (entry) =>
            (entry.status === 201 ||
              (entry.status === 200 && entry.outcome === "DUPLICATE")) &&
            Date.parse(entry.responseTimestamp || entry.timestamp) >
              Date.parse(failureTimestamp),
        )
        .map((entry) => ({
          ...entry,
          classification: dbOrdersByKey.has(entry.idempotencyKey)
            ? "PRESENT"
            : "LOST_COMPENSATION_REQUIRED",
        }))
    : [];
  const lateAckKeys = new Set(
    lateAcknowledgements.map((entry) => entry.idempotencyKey),
  );

  // 3. Pencocokan transaksi tingkat baris (transaction-level comparison via Idempotency-Key)
  const matched = [];
  const missing = [];

  for (const tx of acknowledgedList) {
    if (dbOrdersByKey.has(tx.idempotencyKey)) {
      matched.push({
        ...tx,
        dbOrder: dbOrdersByKey.get(tx.idempotencyKey),
      });
    } else {
      missing.push(tx);
    }
  }

  // Urutkan transaksi acknowledged berdasarkan timestamp
  const sortedAcknowledged = [...acknowledgedList].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const lastAcknowledged =
    sortedAcknowledged.length > 0
      ? sortedAcknowledged[sortedAcknowledged.length - 1]
      : null;

  // Urutkan transaksi yang berhasil dipulihkan
  const sortedMatched = [...matched].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const lastRecoverable =
    sortedMatched.length > 0 ? sortedMatched[sortedMatched.length - 1] : null;

  // 4. Kalkulasi RPO aktual relatif terhadap failure timestamp (atau last acknowledged)
  let actualRpoSeconds = 0;
  const failureTimeMs = failureTimestamp
    ? new Date(failureTimestamp).getTime()
    : null;

  const sortedMissing = [...missing].sort(
    (a, b) =>
      Date.parse(a.responseTimestamp || a.timestamp) -
      Date.parse(b.responseTimestamp || b.timestamp),
  );
  const newestLost = sortedMissing.at(-1) || null;
  if (failureTimestamp && !Number.isFinite(failureTimeMs))
    throw new Error("Invalid disaster timestamp");
  if (failureTimestamp && acknowledgedList.length === 0) {
    actualRpoSeconds = null; // No evidence must not become a claim of zero data loss.
  } else if (missing.length === 0) {
    // Tidak ada transaksi acknowledged yang hilang! RPO = 0
    actualRpoSeconds = 0;
  } else if (failureTimeMs && !isNaN(failureTimeMs)) {
    // RPO dihitung relatif terhadap waktu injeksi kegagalan primary
    actualRpoSeconds = Math.max(
      0,
      (failureTimeMs -
        Date.parse(newestLost.responseTimestamp || newestLost.timestamp)) /
        1000,
    );
  } else {
    // Fallback: perbandingan waktu last acknowledged vs last restored
    if (lastAcknowledged && lastRecoverable) {
      const lastAckTime = new Date(lastAcknowledged.timestamp).getTime();
      const lastRecTime = new Date(lastRecoverable.timestamp).getTime();
      actualRpoSeconds = Math.max(
        0,
        Math.round((lastAckTime - lastRecTime) / 1000),
      );
    } else if (lastAcknowledged && !lastRecoverable) {
      actualRpoSeconds = Math.round(
        (new Date(lastAcknowledged.timestamp).getTime() -
          new Date(sortedAcknowledged[0].timestamp).getTime()) /
          1000,
      );
    }
  }

  // Kumpulkan transaksi dengan hasil ambiguous (503, 500, timeout saat failure)
  const ambiguousMap = new Map();
  for (const entry of ledgerEntries) {
    const isAmbiguous =
      entry.status === 503 ||
      entry.status === 500 ||
      entry.status === 0 ||
      entry.outcome === "ERROR";
    if (isAmbiguous && entry.idempotencyKey) {
      const key = String(entry.idempotencyKey).trim();
      // Hanya jika belum tercatat sebagai acknowledged
      if (
        !acknowledgedMap.has(key) &&
        !lateAckKeys.has(key) &&
        !ambiguousMap.has(key)
      ) {
        ambiguousMap.set(key, entry);
      }
    }
  }
  const ambiguousList = Array.from(ambiguousMap.values());

  // Restore-point age
  let restorePointAgeSeconds = 0;
  if (options.backupTimestamp && failureTimeMs) {
    const backupMs = new Date(options.backupTimestamp).getTime();
    restorePointAgeSeconds = Math.max(
      0,
      Math.round((failureTimeMs - backupMs) / 1000),
    );
  } else if (failureTimeMs && lastRecoverable) {
    const lastRecMs = new Date(lastRecoverable.timestamp).getTime();
    restorePointAgeSeconds = Math.max(
      0,
      Math.round((failureTimeMs - lastRecMs) / 1000),
    );
  }

  return {
    // Laporan spesifik DRP
    acknowledgedTransactions: {
      count: acknowledgedList.length,
      keys: acknowledgedList.map((t) => t.idempotencyKey),
    },
    restoredTransactions: {
      count: matched.length,
      keys: matched.map((t) => t.idempotencyKey),
    },
    missingAcknowledgedTransactions: {
      count: missing.length,
      transactions: missing.map((t) => ({ ...t })),
    },
    duplicateTransactions: {
      count: duplicateKeys.length,
      keys: duplicateKeys,
    },
    ambiguousTransactions: {
      count: ambiguousList.length,
      transactions: ambiguousList.map((t) => ({
        productId: t.productId,
        qty: t.qty,
        userId: t.userId,
        idempotencyKey: t.idempotencyKey,
        timestamp: t.timestamp,
        status: t.status,
        outcome: t.outcome,
      })),
    },
    lastRecoverableAcknowledgedTransaction: lastRecoverable
      ? {
          idempotencyKey: lastRecoverable.idempotencyKey,
          timestamp: lastRecoverable.timestamp,
          productId: lastRecoverable.productId,
          qty: lastRecoverable.qty,
        }
      : null,
    actualRpoSeconds,
    newestLostAcknowledgedTransaction: newestLost,
    lateAcknowledgements,
    ...acknowledgementAccounting(ledgerEntries, dbOrders, {
      injectionAt: options.failureInjectionRequestedAt || failureTimestamp,
      primaryUnavailableAt: options.primaryUnavailableAt,
    }),
    measurementConvention: failureTimestamp
      ? "disaster minus newest lost pre-disaster acknowledgement"
      : "legacy comparison without disaster timestamp; not an official DR measurement",
    restorePointAgeSeconds,
    failureTimestamp: failureTimestamp
      ? new Date(failureTimestamp).toISOString()
      : null,

    // Kompatibilitas dengan pembaca sebelumnya
    totalAcknowledged: acknowledgedList.length,
    totalRestored: dbOrders.length,
    matchedCount: matched.length,
    lostCount: missing.length,
    lostTransactions: missing,
    duplicateCount: duplicateKeys.length,
    lastAcknowledged: lastAcknowledged ? lastAcknowledged.idempotencyKey : null,
    lastAcknowledgedTime: lastAcknowledged ? lastAcknowledged.timestamp : null,
    lastRecovered: lastRecoverable ? lastRecoverable.idempotencyKey : null,
    lastRecoveredTime: lastRecoverable ? lastRecoverable.timestamp : null,
    rpoSeconds: actualRpoSeconds,
  };
}

function acknowledgementAccounting(entries, orders, options = {}) {
  const injection = options.injectionAt ? Date.parse(options.injectionAt) : null;
  const unavailable = options.primaryUnavailableAt ? Date.parse(options.primaryUnavailableAt) : null;
  if ((injection !== null && !Number.isFinite(injection)) ||
      (unavailable !== null && (!Number.isFinite(unavailable) || injection === null || unavailable < injection)))
    throw new Error("Invalid injection/unavailability timeline");
  const byKey = new Map();
  for (const entry of entries) {
    if (!(entry.status === 201 || (entry.status === 200 && entry.outcome === "DUPLICATE"))) continue;
    const at = Date.parse(entry.responseTimestamp || entry.timestamp);
    if (!Number.isFinite(at) || !entry.idempotencyKey) throw new Error("Invalid acknowledgement evidence");
    const previous = byKey.get(entry.idempotencyKey);
    if (!previous || at < Date.parse(previous.responseTimestamp || previous.timestamp)) byKey.set(entry.idempotencyKey, entry);
  }
  const keys = new Set(orders.map(o => o.idempotency_key || o.idempotencyKey));
  const transactions = [...byKey.values()].map(tx => {
    const at = Date.parse(tx.responseTimestamp || tx.timestamp);
    const timing = injection === null ? "TIMING_UNRESOLVED" : at <= injection ? "BEFORE_INJECTION" :
      unavailable === null ? "AFTER_INJECTION_UNAVAILABILITY_UNKNOWN" :
      at < unavailable ? "INJECTION_WINDOW" : "AFTER_PRIMARY_UNAVAILABLE";
    return { ...tx, timing, recoveryPresence: keys.has(tx.idempotencyKey) ? "PRESENT_IN_RECOVERED" : "MISSING_FROM_RECOVERED" };
  });
  const count = (timing, missingOnly = false) => transactions.filter(t => t.timing === timing && (!missingOnly || t.recoveryPresence === "MISSING_FROM_RECOVERED")).length;
  return { allAcknowledgedTransactions: { count: transactions.length, transactions },
    acknowledgementLoss: {
      preInjection: count("BEFORE_INJECTION", true),
      injectionWindow: count("INJECTION_WINDOW", true),
      postPrimaryUnavailability: count("AFTER_PRIMARY_UNAVAILABLE", true),
      postPrimaryUnavailabilityAcknowledgements: count("AFTER_PRIMARY_UNAVAILABLE"),
      unavailabilityUnknown: count("AFTER_INJECTION_UNAVAILABILITY_UNKNOWN", true),
      totalMissing: transactions.filter(t => t.recoveryPresence === "MISSING_FROM_RECOVERED").length,
    } };
}

/**
 * Mem-parse baris stdout K6 berlabel [LEDGER]
 */
function parseLedgerLineFromStdout(line) {
  if (typeof line !== "string") return null;
  line = decodeK6Line(line);
  const match = line.match(/\[LEDGER\]\s*(\{.*\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Menghubungkan stream stdout/stderr untuk mencatat entri [LEDGER] secara real-time
 */
function decodeK6Line(line) {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed.msg === "string") return parsed.msg;
  } catch {}
  const msg = line.match(/\bmsg=("(?:\\.|[^"\\])*")/);
  if (msg) {
    try {
      return JSON.parse(msg[1]);
    } catch {}
  }
  return line;
}

function attachLedgerStream(
  stream,
  ledgerPath = DEFAULT_LEDGER_PATH,
  options = {},
) {
  if (!stream || typeof stream.on !== "function") return;
  let buffer = "";
  let flushed = false;
  const decoder = new StringDecoder("utf8");
  const seen = options.seen || new Set();
  function processLine(line) {
    try {
      options.onLine?.(decodeK6Line(line));
      const entry = parseLedgerLineFromStdout(line);
      if (!entry) {
        if (line.includes("[LEDGER]"))
          throw new Error("Malformed K6 ledger record");
        return;
      }
      // Deduplicate identical output events, preserving distinct retry outcomes.
      const signature = JSON.stringify([
        entry.idempotencyKey,
        entry.timestamp,
        entry.status,
        entry.outcome,
        entry.orderId,
        entry.productId,
        entry.qty,
        entry.userId,
        entry.requestTimestamp,
        entry.responseTimestamp,
        entry.errorCode,
        entry.failureKind,
      ]);
      if (seen.has(signature)) return;
      (options.write || recordTransaction)(entry, ledgerPath);
      seen.add(signature);
      options.onEntry?.(entry);
    } catch (err) {
      if (options.onError) options.onError(err);
      else throw err;
    }
  }

  stream.on("data", (chunk) => {
    options.onChunk?.(chunk.toString("utf8"));
    buffer += decoder.write(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    );
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      processLine(line);
    }
  });
  function flush() {
    if (flushed) return;
    flushed = true;
    buffer += decoder.end();
    if (buffer) processLine(buffer);
    buffer = "";
  }
  stream.on("end", flush);
  stream.on("close", flush);
  stream.on("error", (err) => {
    if (options.onError) options.onError(err);
    else throw err;
  });
  return { flush };
}

module.exports = {
  DEFAULT_LEDGER_PATH,
  classifyOutcome,
  recordTransaction,
  readLedger,
  compareLedgerWithDatabase,
  acknowledgementAccounting,
  parseLedgerLineFromStdout,
  attachLedgerStream,
};
