"use strict";
/**
 * tests/p4/ledger.test.js
 * Unit Test Suite untuk External Transaction Ledger P4
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  classifyOutcome,
  recordTransaction,
  readLedger,
  compareLedgerWithDatabase,
  parseLedgerLineFromStdout,
  attachLedgerStream,
} = require("../../scripts/p4/ledger");

const TEST_LEDGER_DIR = path.resolve(__dirname, "../../tmp-test-ledger");
const TEST_LEDGER_FILE = path.join(TEST_LEDGER_DIR, "transactions.jsonl");

function setupTestDir() {
  if (fs.existsSync(TEST_LEDGER_DIR)) {
    fs.rmSync(TEST_LEDGER_DIR, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
  fs.mkdirSync(TEST_LEDGER_DIR, { recursive: true });
}

function cleanTestDir() {
  if (fs.existsSync(TEST_LEDGER_DIR)) {
    try {
      fs.rmSync(TEST_LEDGER_DIR, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    } catch {}
  }
}

test("p4 ledger: classifyOutcome mengklasifikasikan status dan body secara akurat", () => {
  assert.equal(classifyOutcome(201, { result: "CREATED" }), "CREATED");
  assert.equal(classifyOutcome(200, { result: "DUPLICATE" }), "DUPLICATE");
  assert.equal(classifyOutcome(200, { duplicate: true }), "DUPLICATE");
  assert.equal(classifyOutcome(409, { error: "SOLD_OUT" }), "SOLD_OUT");
  assert.equal(classifyOutcome(500, {}), "ERROR");
  assert.equal(classifyOutcome(502, {}), "ERROR");
  assert.equal(classifyOutcome(0, {}), "ERROR");
});

test("p4 ledger: recordTransaction mencatat transaksi sukses, duplikat, dan gagal dengan persistensi append-only", () => {
  setupTestDir();
  try {
    // 1. Transaksi sukses (CREATED)
    const tx1 = recordTransaction(
      {
        idempotencyKey: "p4-dr-user1-iter1",
        productId: 1,
        qty: 1,
        status: 201,
        body: { result: "CREATED", order: { id: 101 } },
      },
      TEST_LEDGER_FILE,
    );
    assert.equal(tx1.outcome, "CREATED");
    assert.equal(tx1.orderId, 101);

    // 2. Transaksi duplikat (DUPLICATE)
    const tx2 = recordTransaction(
      {
        idempotencyKey: "p4-dr-user1-iter1",
        productId: 1,
        qty: 1,
        status: 200,
        body: { result: "DUPLICATE", order: { id: 101 } },
      },
      TEST_LEDGER_FILE,
    );
    assert.equal(tx2.outcome, "DUPLICATE");

    // 3. Transaksi gagal stok habis (SOLD_OUT)
    const tx3 = recordTransaction(
      {
        idempotencyKey: "p4-dr-user2-iter1",
        productId: 1,
        qty: 1,
        status: 409,
        body: { error: "SOLD_OUT" },
      },
      TEST_LEDGER_FILE,
    );
    assert.equal(tx3.outcome, "SOLD_OUT");

    // 4. Transaksi error infrastruktur (HTTP 502)
    const tx4 = recordTransaction(
      {
        idempotencyKey: "p4-dr-user3-iter1",
        productId: 1,
        qty: 1,
        status: 502,
        body: null,
      },
      TEST_LEDGER_FILE,
    );
    assert.equal(tx4.outcome, "ERROR");

    // Verifikasi persistensi file
    assert.ok(fs.existsSync(TEST_LEDGER_FILE));
    const lines = fs.readFileSync(TEST_LEDGER_FILE, "utf8").trim().split("\n");
    assert.equal(
      lines.length,
      4,
      "Wajib ada 4 baris JSONL yang tersimpan secara append-only",
    );
  } finally {
    cleanTestDir();
  }
});

test("p4 ledger: readLedger membaca record dan melewati baris kosong atau malformed tanpa crash", () => {
  setupTestDir();
  try {
    const rawContent =
      [
        JSON.stringify({
          idempotencyKey: "tx-valid-1",
          timestamp: "2026-11-08T10:00:00Z",
          outcome: "CREATED",
          status: 201,
        }),
        "", // Baris kosong
        "MALFORMED_NON_JSON_CORRUPTED_LINE",
        "   ", // Spasi kosong
        JSON.stringify({
          idempotencyKey: "tx-valid-2",
          timestamp: "2026-11-08T10:00:05Z",
          outcome: "CREATED",
          status: 201,
        }),
        JSON.stringify({ missingKey: true }), // JSON tapi tanpa idempotencyKey
      ].join("\n") + "\n";

    fs.writeFileSync(TEST_LEDGER_FILE, rawContent, "utf8");

    const result = readLedger(TEST_LEDGER_FILE);
    assert.equal(result.validCount, 2);
    assert.equal(result.malformedCount, 2);
    assert.equal(result.entries[0].idempotencyKey, "tx-valid-1");
    assert.equal(result.entries[1].idempotencyKey, "tx-valid-2");
  } finally {
    cleanTestDir();
  }
});

test("p4 ledger: compareLedgerWithDatabase menghitung matched, lost, dan RPO dalam detik secara deterministik", () => {
  const ledgerEntries = [
    {
      idempotencyKey: "k-1",
      timestamp: "2026-11-08T10:00:00.000Z",
      status: 201,
      outcome: "CREATED",
    },
    {
      idempotencyKey: "k-2",
      timestamp: "2026-11-08T10:00:10.000Z",
      status: 201,
      outcome: "CREATED",
    },
    {
      idempotencyKey: "k-3",
      timestamp: "2026-11-08T10:00:20.000Z",
      status: 201,
      outcome: "CREATED",
    },
    {
      idempotencyKey: "k-4",
      timestamp: "2026-11-08T10:00:30.000Z",
      status: 201,
      outcome: "CREATED",
    },
    {
      idempotencyKey: "k-5",
      timestamp: "2026-11-08T10:00:45.000Z",
      status: 201,
      outcome: "CREATED",
    },
    {
      idempotencyKey: "k-fail",
      timestamp: "2026-11-08T10:00:46.000Z",
      status: 409,
      outcome: "SOLD_OUT",
    },
  ];

  // Kasus 1: Database pulih dengan k-1, k-2, k-3 (k-4 dan k-5 hilang karena bencana)
  const dbOrders = [
    { id: 1, idempotency_key: "k-1" },
    { id: 2, idempotency_key: "k-2" },
    { id: 3, idempotency_key: "k-3" },
  ];

  const res = compareLedgerWithDatabase(ledgerEntries, dbOrders);

  assert.equal(res.totalAcknowledged, 5); // Hanya CREATED (k-fail diabaikan)
  assert.equal(res.totalRestored, 3);
  assert.equal(res.matchedCount, 3);
  assert.equal(res.lostCount, 2);
  assert.equal(res.lastAcknowledged, "k-5");
  assert.equal(res.lastRecovered, "k-3");

  // RPO = selisih k-5 (10:00:45) dan k-3 (10:00:20) = 25 detik
  assert.equal(res.rpoSeconds, 25);

  // Kasus 2: 100% pulih tanpa kehilangan transaksi
  const dbOrdersFull = [
    { id: 1, idempotency_key: "k-1" },
    { id: 2, idempotency_key: "k-2" },
    { id: 3, idempotency_key: "k-3" },
    { id: 4, idempotency_key: "k-4" },
    { id: 5, idempotency_key: "k-5" },
  ];
  const resFull = compareLedgerWithDatabase(ledgerEntries, dbOrdersFull);
  assert.equal(resFull.lostCount, 0);
  assert.equal(
    resFull.rpoSeconds,
    0,
    "RPO harus 0 jika seluruh transaksi pulih",
  );
});

test("p4 ledger: attachLedgerStream mem-parse dan mencatat output stdout K6 secara streaming", () => {
  setupTestDir();
  try {
    const fakeStream = new EventEmitter();
    attachLedgerStream(fakeStream, TEST_LEDGER_FILE);

    // Kirim chunk stdout campuran teks biasa dan baris [LEDGER]
    fakeStream.emit(
      "data",
      Buffer.from(
        'running k6 test...\n[LEDGER] {"idempotencyKey":"stream-tx-1","status":201,"outcome":"CREATED"}\n',
      ),
    );
    fakeStream.emit(
      "data",
      Buffer.from(
        'progress 50%\n[LEDGER] {"idempotencyKey":"stream-tx-2","status":200,"outcome":"DUPLICATE"}\nfinished\n',
      ),
    );

    const result = readLedger(TEST_LEDGER_FILE);
    assert.equal(result.validCount, 2);
    assert.equal(result.entries[0].idempotencyKey, "stream-tx-1");
    assert.equal(result.entries[1].idempotencyKey, "stream-tx-2");
  } finally {
    cleanTestDir();
  }
});
