"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  findPendingOrders,
  classifyReconcileOutcome,
  getReconcileConfig,
  DockerExecAdapter,
  DRP_STACKS,
} = require("../../scripts/reconcile-old-primary");

test("reconcile: konfigurasi DRP stack P2 menggunakan database P2", () => {
  const p2 = getReconcileConfig(["--stack", "p2"]);

  assert.equal(p2.stack, "p2");
  assert.equal(p2.expectedDb, "flashsale");
  assert.equal(p2.connectionMethod, "tcp");
  assert.equal(p2.oldHost, "127.0.0.1");
  assert.equal(p2.oldPort, 5432);
  assert.equal(p2.newPort, 5433);
});

test("reconcile: konfigurasi DRP stack P3 menggunakan database P3 dan docker_exec", () => {
  const p3 = getReconcileConfig(["--stack", "p3"]);

  assert.equal(p3.stack, "p3");
  assert.equal(p3.expectedDb, "flashsale_p3");
  assert.equal(p3.connectionMethod, "docker_exec");
  assert.equal(p3.oldContainer, "flashsale-p3-db-primary-1");
  assert.equal(p3.newContainer, "flashsale-p3-db-replica-1");
});

test("reconcile: proteksi isolasi mencegah fallback diam-diam dari P3 ke port database P2", () => {
  process.env.OLD_PRIMARY_PORT = "5432";
  try {
    assert.throws(
      () => getReconcileConfig(["--stack", "p3"]),
      /cross-stack contamination/,
    );
  } finally {
    delete process.env.OLD_PRIMARY_PORT;
  }
});

test("reconcile: DockerExecAdapter memvalidasi role database, read-only protection, dan identitas", async () => {
  const cfg = getReconcileConfig(["--stack", "p3"]);

  // 1. Simulasi query error / container mati -> harus melempar error aman
  const mockExecFail = () => {
    const err = new Error("Container flashsale-p3-db-primary-1 is not running");
    err.stderr = "Error response from daemon: Container is not running";
    throw err;
  };
  const adapterFail = new DockerExecAdapter(cfg, mockExecFail);
  await assert.rejects(
    () => adapterFail.validateAndFetch(),
    /Gagal menghubungi old primary container/,
  );

  // 2. Simulasi database identity mismatch (terhubung ke P2 saat seharusnya P3)
  const mockExecMismatch = (cmd) => {
    if (cmd.includes(cfg.oldContainer)) {
      return "flashsale|t|on"; // Database P2 bukannya flashsale_p3
    }
    return "flashsale_p3|f";
  };
  const adapterMismatch = new DockerExecAdapter(cfg, mockExecMismatch);
  await assert.rejects(
    () => adapterMismatch.validateAndFetch(),
    /Database mismatch pada old container/,
  );

  const cfgApply = { ...cfg, apply: true };

  // 3. Old primary masih read-write (bukan standby dan bukan read-only) pada mode --apply -> WAJIB DITOLAK
  const mockExecOldReadWrite = (cmd) => {
    if (cmd.includes(cfg.oldContainer)) {
      return "flashsale_p3|f|off"; // in_recovery=f, read_only=off -> writer!
    }
    return "flashsale_p3|f";
  };
  const adapterOldRw = new DockerExecAdapter(cfgApply, mockExecOldReadWrite);
  await assert.rejects(
    () => adapterOldRw.validateAndFetch(),
    /masih berstatus read-write/,
  );

  // 4. Target new container masih standby (pg_is_in_recovery = t) pada mode --apply -> WAJIB DITOLAK
  const mockExecStillStandby = (cmd) => {
    if (cmd.includes(cfg.oldContainer)) {
      return "flashsale_p3|t|on";
    }
    return "flashsale_p3|t"; // New primary masih standby
  };
  const adapterStandby = new DockerExecAdapter(cfgApply, mockExecStillStandby);
  await assert.rejects(
    () => adapterStandby.validateAndFetch(),
    /masih berstatus standby recovery mode/,
  );

  // 5. Role new primary tidak jelas (bukan 'f' dan bukan 't', misal empty/error) pada mode --apply -> WAJIB DITOLAK
  const mockExecAmbiguousNew = (cmd) => {
    if (cmd.includes(cfg.oldContainer)) {
      return "flashsale_p3|t|on";
    }
    return "flashsale_p3|"; // Nilai kosong/tidak valid
  };
  const adapterAmbiguous = new DockerExecAdapter(cfgApply, mockExecAmbiguousNew);
  await assert.rejects(
    () => adapterAmbiguous.validateAndFetch(),
    /Role target new container tidak dapat dipastikan/,
  );

  // 6. Sukses validasi dan fetch dengan read-only protection terverifikasi
  let readOnlyEnvUsed = false;
  const mockExecSuccess = (cmd) => {
    if (cmd.includes('PGOPTIONS="-c default_transaction_read_only=on"')) {
      readOnlyEnvUsed = true;
    }
    if (cmd.includes(cfg.oldContainer) && cmd.includes("current_database()")) {
      return "flashsale_p3|t|on"; // Old primary standby/read-only
    }
    if (cmd.includes(cfg.newContainer) && cmd.includes("current_database()")) {
      return "flashsale_p3|f"; // New primary writer
    }
    if (cmd.includes("orders ORDER BY")) {
      return JSON.stringify([
        {
          idempotency_key: "key-1",
          user_id: 1,
          product_id: 1,
          qty: 1,
          created_at: "2026-11-01",
        },
        {
          idempotency_key: "key-2",
          user_id: 2,
          product_id: 1,
          qty: 1,
          created_at: "2026-11-01",
        },
      ]);
    }
    if (cmd.includes("SELECT idempotency_key FROM orders")) {
      return JSON.stringify([{ idempotency_key: "key-1" }]);
    }
    return "";
  };
  const adapterSuccess = new DockerExecAdapter(cfg, mockExecSuccess);
  const data = await adapterSuccess.validateAndFetch();
  assert.equal(
    readOnlyEnvUsed,
    true,
    "Query pembacaan old orders harus menggunakan PGOPTIONS read-only",
  );
  assert.equal(data.oldOrders.length, 2);
  assert.equal(data.newOrders.length, 1);
  const pending = findPendingOrders(data.oldOrders, data.newOrders);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].idempotency_key, "key-2");
});

test("reconcile: findPendingOrders memfilter order yang belum ada di primary baru", () => {
  const oldOrders = [
    { id: 1, idempotency_key: "key-1", qty: 1, product_id: 1, user_id: 1 },
    { id: 2, idempotency_key: "key-2", qty: 2, product_id: 1, user_id: 2 },
    { id: 3, idempotency_key: "key-3", qty: 1, product_id: 2, user_id: 1 },
  ];
  const newOrders = [
    { id: 10, idempotency_key: "key-1" },
    { id: 11, idempotency_key: "key-3" },
  ];

  const pending = findPendingOrders(oldOrders, newOrders);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].idempotency_key, "key-2");
});

test("reconcile: findPendingOrders menandai order tanpa idempotency key sebagai unidentifiable", () => {
  const oldOrders = [
    { id: 1, idempotency_key: "key-1", qty: 1, product_id: 1, user_id: 1 },
    { id: 2, idempotency_key: null, qty: 2, product_id: 1, user_id: 2 },
    { id: 3, idempotency_key: "", qty: 1, product_id: 2, user_id: 3 },
    { id: 4, idempotency_key: "key-4", qty: 1, product_id: 1, user_id: 4 },
  ];
  const newOrders = [
    { id: 10, idempotency_key: "key-1" },
  ];

  const pending = findPendingOrders(oldOrders, newOrders);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].idempotency_key, "key-4");
  assert.ok(Array.isArray(pending.unidentifiable));
  assert.equal(pending.unidentifiable.length, 2);
  assert.equal(pending.unidentifiable[0].id, 2);
  assert.equal(pending.unidentifiable[1].id, 3);
});

test("reconcile: classifyReconcileOutcome mengklasifikasikan respons HTTP rekonsiliasi dengan aman", () => {
  // 1. HTTP 201 -> RECOVERED (transaksi berhasil dicatat di primary baru)
  const o201 = classifyReconcileOutcome(201, {
    result: "CREATED",
    order: { id: 10 },
  });
  assert.equal(o201.action, "RECOVERED");
  assert.equal(o201.needsCompensation, false);
  assert.equal(o201.needsInvestigation, false);

  // 2. HTTP 200 DUPLICATE -> ALREADY_COMMITTED (sudah ada, tidak menduplikasi order)
  const o200 = classifyReconcileOutcome(200, {
    result: "DUPLICATE",
    order: { id: 10 },
  });
  assert.equal(o200.action, "ALREADY_COMMITTED");
  assert.equal(o200.needsCompensation, false);
  assert.equal(o200.needsInvestigation, false);

  // 3. HTTP 409 SOLD_OUT -> STOCK_EXHAUSTED (butuh kompensasi manual, bukan duplicate order)
  const o409 = classifyReconcileOutcome(409, {
    error: "SOLD_OUT",
    message: "Stok tidak mencukupi.",
  });
  assert.equal(o409.action, "STOCK_EXHAUSTED");
  assert.equal(o409.needsCompensation, true);
  assert.equal(o409.needsInvestigation, false);

  // 4. HTTP 500 / unhandled -> UNKNOWN_OUTCOME (investigasi manual)
  const o500 = classifyReconcileOutcome(500, { error: "INTERNAL" });
  assert.equal(o500.action, "UNKNOWN_OUTCOME");
  assert.equal(o500.needsCompensation, false);
  assert.equal(o500.needsInvestigation, true);

  // 5. Network timeout / status 0 -> UNKNOWN_OUTCOME
  const o0 = classifyReconcileOutcome(0, { error: "ETIMEDOUT" });
  assert.equal(o0.action, "UNKNOWN_OUTCOME");
  assert.equal(o0.needsCompensation, false);
  assert.equal(o0.needsInvestigation, true);
});

test("reconcile: TcpClientAdapter memvalidasi status read-write, fencing, dan database identity P2", async () => {
  const { TcpClientAdapter } = require("../../scripts/reconcile-old-primary");

  // Helper untuk membuat mock client
  const createMockTcpAdapter = (cfg, oldDbRow, newDbRow) => {
    const adapter = new TcpClientAdapter(cfg);
    adapter.old = {
      connect: async () => {},
      query: async (sql) => {
        if (sql.includes("current_database()")) return { rows: [oldDbRow] };
        if (sql.includes("SET default_transaction_read_only")) return {};
        if (sql.includes("SHOW transaction_read_only"))
          return { rows: [{ transaction_read_only: "on" }] };
        if (sql.includes("BEGIN TRANSACTION READ ONLY")) return {};
        if (sql.includes("COMMIT")) return {};
        if (sql.includes("orders ORDER BY"))
          return {
            rows: [
              { idempotency_key: "k1", user_id: 1, product_id: 1, qty: 1 },
            ],
          };
        return { rows: [] };
      },
      end: async () => {},
    };
    adapter.current = {
      connect: async () => {},
      query: async (sql) => {
        if (sql.includes("current_database()")) return { rows: [newDbRow] };
        if (sql.includes("SELECT idempotency_key FROM orders"))
          return { rows: [] };
        return { rows: [] };
      },
      end: async () => {},
    };
    return adapter;
  };

  const cfgP2 = getReconcileConfig(["--stack", "p2"]);
  const cfgP2Apply = { ...cfgP2, apply: true };

  // 1. Old primary masih read-write (in_recovery=false, read_only=off, fencedProof=false) pada mode --apply -> WAJIB DITOLAK
  const rwAdapter = createMockTcpAdapter(
    cfgP2Apply,
    { db: "flashsale", in_recovery: false, read_only: "off" },
    { db: "flashsale", in_recovery: false },
  );
  await assert.rejects(
    () => rwAdapter.validateAndFetch(),
    /masih berstatus read-write/,
  );

  // 1b. Mode dry-run mengizinkan pembacaan audit dengan sesi transaksi read-only
  const rwDryAdapter = createMockTcpAdapter(
    cfgP2,
    { db: "flashsale", in_recovery: false, read_only: "off" },
    { db: "flashsale", in_recovery: false },
  );
  const rwDryData = await rwDryAdapter.validateAndFetch();
  assert.equal(rwDryData.oldOrders.length, 1);

  // 2. Old primary terbukti fenced via fencedProof: true pada mode --apply -> DITERIMA
  const fencedCfg = { ...cfgP2Apply, fencedProof: true };
  const fencedAdapter = createMockTcpAdapter(
    fencedCfg,
    { db: "flashsale", in_recovery: false, read_only: "off" },
    { db: "flashsale", in_recovery: false },
  );
  const fencedData = await fencedAdapter.validateAndFetch();
  assert.equal(fencedData.oldOrders.length, 1);
  assert.equal(fencedData.oldDb, "flashsale");

  // 3. Target new primary masih standby pada mode --apply -> WAJIB DITOLAK
  const standbyNewAdapter = createMockTcpAdapter(
    cfgP2Apply,
    { db: "flashsale", in_recovery: true, read_only: "on" },
    { db: "flashsale", in_recovery: true },
  );
  await assert.rejects(
    () => standbyNewAdapter.validateAndFetch(),
    /masih dalam mode standby/,
  );

  // 4. Old primary standby (in_recovery=true) -> DITERIMA (intrinsically read-only)
  const standbyAdapter = createMockTcpAdapter(
    cfgP2,
    { db: "flashsale", in_recovery: true, read_only: "off" },
    { db: "flashsale", in_recovery: false },
  );
  const standbyData = await standbyAdapter.validateAndFetch();
  assert.equal(standbyData.oldOrders.length, 1);

  // 5. Database identity mismatch (old menunjuk flashsale_p3 bukannya flashsale) -> WAJIB DITOLAK
  const mismatchAdapter = createMockTcpAdapter(
    cfgP2,
    { db: "flashsale_p3", in_recovery: true, read_only: "on" },
    { db: "flashsale", in_recovery: false },
  );
  await assert.rejects(
    () => mismatchAdapter.validateAndFetch(),
    /Database identity mismatch/,
  );
});

test("reconcile: verifyTargetApi memvalidasi identitas database dan role writer endpoint API", async () => {
  const { verifyTargetApi } = require("../../scripts/reconcile-old-primary");

  // 1. Target API database mismatch (mengarah ke P2 database saat stack P3) -> DITOLAK
  const mockFetchWrongDb = async () => ({
    status: 200,
    json: async () => ({
      status: "ok",
      db: "up",
      database: "flashsale",
      in_recovery: false,
    }),
  });
  await assert.rejects(
    () =>
      verifyTargetApi(
        "http://127.0.0.1:8080",
        "flashsale_p3",
        mockFetchWrongDb,
      ),
    /API destination database mismatch/,
  );

  // 2. Target API terhubung ke standby database (in_recovery=true) -> DITOLAK
  const mockFetchStandby = async () => ({
    status: 200,
    json: async () => ({
      status: "ok",
      db: "up",
      database: "flashsale_p3",
      in_recovery: true,
    }),
  });
  await assert.rejects(
    () =>
      verifyTargetApi(
        "http://127.0.0.1:8080",
        "flashsale_p3",
        mockFetchStandby,
      ),
    /terhubung ke database standby/,
  );

  // 3. Target API status degraded / db down -> DITOLAK
  const mockFetchDown = async () => ({
    status: 503,
    json: async () => ({
      status: "degraded",
      db: "down",
      database: "flashsale_p3",
      in_recovery: null,
    }),
  });
  await assert.rejects(
    () =>
      verifyTargetApi("http://127.0.0.1:8080", "flashsale_p3", mockFetchDown),
    /Preflight API destination gagal/,
  );

  // 4. Target API valid writer (database=flashsale_p3, in_recovery=false) -> DITERIMA
  const mockFetchValid = async () => ({
    status: 200,
    json: async () => ({
      status: "ok",
      db: "up",
      database: "flashsale_p3",
      in_recovery: false,
      db_server_ip: "172.20.0.2",
    }),
  });
  const res = await verifyTargetApi(
    "http://127.0.0.1:8080",
    "flashsale_p3",
    mockFetchValid,
  );
  assert.equal(res.ok, true);
  assert.equal(res.database, "flashsale_p3");
  assert.equal(res.in_recovery, false);
});

test("reconcile: runReconciliation membedakan mode dry-run dan exit code parsial/sukses pada --apply", async () => {
  const {
    runReconciliation,
    DbAdapter,
  } = require("../../scripts/reconcile-old-primary");

  // Mock DbAdapter
  const origCreate = DbAdapter.create;
  DbAdapter.create = () => ({
    validateAndFetch: async () => ({
      oldOrders: [
        { idempotency_key: "tx-1", user_id: 1, product_id: 1, qty: 1 },
        { idempotency_key: "tx-2", user_id: 2, product_id: 1, qty: 1 },
      ],
      newOrders: [],
      oldDb: "flashsale_p3",
      newDb: "flashsale_p3",
    }),
    close: async () => {},
  });

  try {
    const mockHealthFetch = async (url) => {
      if (url.includes("/health")) {
        return {
          status: 200,
          json: async () => ({
            status: "ok",
            db: "up",
            database: "flashsale_p3",
            in_recovery: false,
          }),
        };
      }
      return { status: 200, json: async () => ({}) };
    };

    // Skenario 1: Dry-Run Mode -> exitCode 0, finalStatus COMPLETE, tidak mengklaim order recovered
    const dryCfg = {
      stack: "p3",
      reportOnly: true,
      apply: false,
      expectedDb: "flashsale_p3",
      connectionMethod: "docker_exec",
      apiBase: "http://127.0.0.1:8080",
      fetchFn: mockHealthFetch,
    };
    const dryRes = await runReconciliation(dryCfg);
    assert.equal(dryRes.finalStatus, "COMPLETE");
    assert.equal(dryRes.exitCode, 0);
    assert.equal(dryRes.applied.length, 0); // Di dry-run tidak ada yang di-apply
    assert.equal(dryRes.pending.length, 2);

    // Skenario 2: Apply Mode dengan hasil PARTIAL (misal satu recovered, satu stock exhausted) -> exitCode 1
    const mockCheckoutPartial = async (url, opts) => {
      if (url.includes("/health")) {
        return {
          status: 200,
          json: async () => ({
            status: "ok",
            db: "up",
            database: "flashsale_p3",
            in_recovery: false,
          }),
        };
      }
      if (opts.headers["Idempotency-Key"] === "tx-1") {
        return {
          status: 201,
          json: async () => ({ result: "CREATED", order: { id: 101 } }),
        };
      }
      return {
        status: 409,
        json: async () => ({ error: "SOLD_OUT", message: "Stok habis" }),
      };
    };

    const applyPartialCfg = {
      stack: "p3",
      reportOnly: false,
      apply: true,
      reviewed: true,
      expectedDb: "flashsale_p3",
      connectionMethod: "docker_exec",
      apiBase: "http://127.0.0.1:8080",
      fetchFn: mockCheckoutPartial,
    };
    const partialRes = await runReconciliation(applyPartialCfg);
    assert.equal(partialRes.finalStatus, "PARTIAL");
    assert.equal(partialRes.exitCode, 1);
    assert.equal(partialRes.counts.recovered, 1);
    assert.equal(partialRes.counts.stock_exhausted, 1);

    // Skenario 3: Apply Mode SUKSES PENUH (seluruh order recovered) -> exitCode 0
    const mockCheckoutAllSuccess = async (url) => {
      if (url.includes("/health")) {
        return {
          status: 200,
          json: async () => ({
            status: "ok",
            db: "up",
            database: "flashsale_p3",
            in_recovery: false,
          }),
        };
      }
      return {
        status: 201,
        json: async () => ({ result: "CREATED", order: { id: 100 } }),
      };
    };
    const applySuccessCfg = {
      ...applyPartialCfg,
      fetchFn: mockCheckoutAllSuccess,
    };
    const successRes = await runReconciliation(applySuccessCfg);
    assert.equal(successRes.finalStatus, "COMPLETE");
    assert.equal(successRes.exitCode, 0);
    assert.equal(successRes.counts.recovered, 2);
  } finally {
    DbAdapter.create = origCreate;
  }
});
