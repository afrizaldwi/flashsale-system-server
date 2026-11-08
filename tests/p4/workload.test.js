"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startK6Workload } = require("../../scripts/p4/workload");
const {
  readLedger,
  parseLedgerLineFromStdout,
} = require("../../scripts/p4/ledger");

function runner(t, code, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-workload-"));
  const ledgerPath = path.join(dir, "ledger.jsonl");
  const control = startK6Workload({
    ledgerPath,
    ...options,
    spawn:
      options.spawn ||
      ((_cmd, _args, opts) => spawn(process.execPath, ["-e", code], opts)),
  });
  t.after(async () => {
    await control.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ...control, ledgerPath: options.ledgerPath || ledgerPath };
}
const entry = (vu) => ({
  idempotencyKey: `test-vu${vu}-iter0`,
  status: 201,
  outcome: "CREATED",
  productId: 2,
  userId: 3,
  qty: 1,
});
const line = (vu) =>
  JSON.stringify({
    level: "info",
    msg: `[LEDGER] ${JSON.stringify(entry(vu))}`,
    source: "console",
  });

for (const stream of ["stdout", "stderr"]) {
  test(`p4 workload: handshake via ${stream} and ordinary stderr is not fatal`, async (t) => {
    const r = runner(
      t,
      `process.stderr.write('diagnostic warning\\n'); process.${stream}.write(${JSON.stringify("[K6_HANDSHAKE] started\n")}); setTimeout(() => {}, 300);`,
    );
    assert.equal((await r.waitForHandshake(3000)).ok, true);
    const result = await r.promise;
    assert.equal(result.ok, true);
    assert.match(result.stderr, /diagnostic warning/);
  });
  test(`p4 workload: ledger via ${stream}, fragmented lines, multiple VUs and final unterminated line`, async (t) => {
    const output = line(1) + "\n" + line(2);
    const cut = Math.floor(line(1).length / 2);
    const r = runner(
      t,
      `process.stdout.write('[K6_HANDSHAKE] start\\n'); process.${stream}.write(${JSON.stringify(output.slice(0, cut))}); setTimeout(() => { process.${stream}.write(${JSON.stringify(output.slice(cut))}); }, 30); setTimeout(() => {}, 300);`,
    );
    await r.waitForHandshake(3000);
    // VU 2 has no newline: it becomes visible when the stream drains at close.
    const result = await r.promise;
    assert.equal(result.ok, true);
    assert.equal(result.observedVUsCount, 2);
    assert.equal(readLedger(r.ledgerPath).validCount, 2);
    assert.match(result[stream], /LEDGER/);
  });
}

test("p4 workload: split handshake and 100 distinct VUs detected while child is alive", async (t) => {
  const r = runner(
    t,
    `process.stderr.write('[K6_HAND'); setTimeout(() => { process.stderr.write('SHAKE] started\\n'); for (let vu=1; vu<=100; vu++) process.stdout.write('[LEDGER] '+JSON.stringify({idempotencyKey:'run-vu'+vu+'-iter0',status:201})+'\\n'); }, 20); setTimeout(() => {}, 500);`,
  );
  await r.waitForHandshake(3000);
  const evidence = await r.waitForObservedVUs(100, 3000);
  assert.equal(evidence.observedVUsCount, 100);
  assert.equal(evidence.concurrentActivityAtInjectionProven, false);
  assert.equal(r.isAlive(), true);
  const result = await r.promise;
  assert.equal(result.ok, true);
  assert.equal(result.activeVUsCount, undefined);
  assert.match(result.vuEvidence, /not concurrent/);
});

test("p4 workload: identical ledger event on both pipes is persisted once", async (t) => {
  const reordered = {
    ...Object.fromEntries(Object.entries(entry(1)).reverse()),
  };
  const r = runner(
    t,
    `process.stdout.write('[K6_HANDSHAKE] started\\n'); process.stdout.write(${JSON.stringify(line(1) + "\n")}); process.stderr.write(${JSON.stringify("[LEDGER] " + JSON.stringify(reordered) + "\n")});`,
  );
  assert.equal((await r.promise).ok, true);
  assert.equal(readLedger(r.ledgerPath).validCount, 1);
});

test("p4 workload: real ledger write failure stops child and is surfaced", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-ledger-fail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = runner(
    t,
    `process.stderr.write(${JSON.stringify(line(1) + "\n")}); setInterval(() => {}, 1000);`,
    { ledgerPath: dir },
  );
  const result = await r.promise;
  assert.equal(result.ok, false);
  assert.match(result.error, /ledger\/output failure/);
  assert.equal(r.isAlive(), false);
});

test("p4 workload: premature exit before handshake includes drained diagnostics", async (t) => {
  const r = runner(
    t,
    "process.stderr.write('startup failed'); process.exitCode=2;",
  );
  await assert.rejects(r.waitForHandshake(3000), /startup failed/);
  assert.equal((await r.promise).code, 2);
});

test("p4 workload: exit zero without handshake is a startup failure", async (t) => {
  const r = runner(t, "process.stderr.write('no setup ran');");
  await assert.rejects(r.waitForHandshake(3000), /before startup handshake/);
  assert.equal((await r.promise).ok, false);
  assert.equal((await r.promise).code, 0);
});

test("p4 workload: non-zero exit after handshake stays a workload failure", async (t) => {
  const r = runner(
    t,
    "process.stderr.write('[K6_HANDSHAKE] start\\n'); setTimeout(() => { process.stderr.write('threshold failed'); process.exitCode=99; }, 300);",
  );
  await r.waitForHandshake(3000);
  const result = await r.promise;
  assert.equal(result.handshakeReceived, true);
  assert.equal(result.code, 99);
  assert.equal(result.ok, false);
});

for (const wait of ["waitForHandshake", "waitForObservedVUs"]) {
  test(`p4 workload: ${wait} timeout stops and awaits child`, async (t) => {
    const r = runner(
      t,
      "process.stdout.write('still running\\n'); setInterval(() => {}, 1000);",
    );
    await assert.rejects(
      wait === "waitForHandshake" ? r[wait](100) : r[wait](100, 100),
      /Timeout/,
    );
    assert.equal(r.isAlive(), false);
    assert.notEqual(
      r.proc.exitCode === null && r.proc.signalCode === null,
      true,
    );
    assert.equal((await r.promise).ok, false);
  });
}

test("p4 workload: spawn error resolves failed result without unhandled rejection", async (t) => {
  const r = runner(t, "", {
    spawn: () =>
      spawn(path.join(os.tmpdir(), "missing-p4-k6-executable"), [], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
  });
  await assert.rejects(r.waitForHandshake(3000), /ENOENT/);
  assert.equal((await r.promise).ok, false);
});

test("p4 ledger: parses K6 escaped logfmt and JSON console messages", () => {
  assert.deepEqual(
    parseLedgerLineFromStdout(
      `time=now level=info msg=${JSON.stringify("[LEDGER] " + JSON.stringify(entry(1)))} source=console`,
    ),
    entry(1),
  );
  assert.deepEqual(parseLedgerLineFromStdout(line(2)), entry(2));
});

test("p4 workload: abnormal exit retains previously persisted ledger and separate timestamps", async t => {
  const e = { ...entry(1), requestTimestamp: "2026-11-08T09:38:57.100Z", responseTimestamp: "2026-11-08T09:38:57.214Z", timestamp: "2026-11-08T09:38:57.214Z" };
  const r = runner(t, `process.stderr.write('[K6_HANDSHAKE] started\\n'); process.stderr.write(${JSON.stringify("[LEDGER] " + JSON.stringify(e) + "\n")}); process.exitCode=99;`);
  assert.equal((await r.promise).ok, false);
  const [saved] = readLedger(r.ledgerPath).entries;
  assert.equal(saved.requestTimestamp, e.requestTimestamp); assert.equal(saved.responseTimestamp, e.responseTimestamp);
  assert.equal(saved.userId, 3); assert.equal(saved.orderId, null);
});

for (const status of [500, 502, 504, 503]) {
  test(`p4 workload: child exit zero cannot conceal unexpected HTTP ${status}`, async t => {
    const e = { ...entry(1), status, outcome: "ERROR", errorCode: "MAINTENANCE", timestamp: new Date().toISOString() };
    const r = runner(t, `process.stdout.write('[K6_HANDSHAKE] started\\n'); process.stdout.write(${JSON.stringify("[LEDGER] " + JSON.stringify(e) + "\n")});`);
    const result = await r.promise;
    assert.equal(result.code, 0); assert.equal(result.ok, false);
    assert.equal(result.unexpectedResponseCount, 1);
    assert.equal(readLedger(r.ledgerPath).entries.length, 1);
  });
}
for (const status of [0, 503]) {
  test(`p4 workload: ${status} before injection is unexpected even if K6 exits zero`, async t => {
    const e = { ...entry(1), status, outcome: "ERROR", errorCode: "DB_UNAVAILABLE", timestamp: "2026-11-08T09:38:57.100Z" };
    const r = runner(t, `process.stdout.write('[K6_HANDSHAKE] started\\n'); process.stdout.write(${JSON.stringify("[LEDGER] " + JSON.stringify(e) + "\n")});`, { stopAfterOutage: true });
    r.markOutageRequested("2026-11-08T09:38:57.187Z");
    const result = await r.promise;
    assert.equal(result.code, 0); assert.equal(result.ok, false);
  });
  test(`p4 workload: classified ${status} after injection is an accepted outage response`, async t => {
    const e = { ...entry(1), status, outcome: "ERROR", errorCode: "DB_UNAVAILABLE", timestamp: "2026-11-08T09:38:57.214Z" };
    const r = runner(t, `process.stdout.write('[K6_HANDSHAKE] started\\n'); process.stdout.write(${JSON.stringify("[LEDGER] " + JSON.stringify(e) + "\n")});`, { stopAfterOutage: true });
    r.markOutageRequested("2026-11-08T09:38:57.187Z");
    const result = await r.promise;
    assert.equal(result.code, 0); assert.equal(result.ok, true);
    assert.equal(result.unexpectedResponseCount, 0);
  });
}
