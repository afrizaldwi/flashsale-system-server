"use strict";
const { restoreOptions, restoreInspect } = require("./helpers/restore-runtime");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { applyRetentionPolicy } = require("../../scripts/p4/common");
const { performRestore } = require("../../scripts/p4/restore");
const { performBackup } = require("../../scripts/p4/backup");
const { acquireOwnedLock, acquireArchiveLock, acquireRestoreSession, ownsLock } = require("../../scripts/p4/locks");

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-archive-safety-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function backup(dir, ordinal) {
  const file = `flashsale_p3_20261108_1000${String(ordinal).padStart(2, "0")}.dump`;
  const full = path.join(dir, file), data = Buffer.from(`PGDMP fixture ${ordinal}`);
  fs.writeFileSync(full, data);
  const meta = { file, database: "flashsale_p3", status: "VALIDATED", sizeBytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"), durationMs: 0, tocEntries: 1,
    startTime: new Date(Date.UTC(2026, 10, 8, 10, 0, ordinal)).toISOString(),
    endTime: new Date(Date.UTC(2026, 10, 8, 10, 0, ordinal)).toISOString() };
  fs.writeFileSync(full + ".sha256", `${meta.sha256}  ${file}\n`);
  fs.writeFileSync(full + ".meta.json", JSON.stringify(meta));
  return { full, meta };
}
function toc(cmd, options) {
  assert.match(cmd, /docker exec -i .* pg_restore --list$/);
  assert.match(options.input.toString(), /^PGDMP fixture/);
  return "1; TABLE public orders\n";
}
const retain = (dir, count = 10) => applyRetentionPolicy(dir, count, { execFn: toc });

for (const defect of ["missing-metadata", "corrupt-metadata", "incorrect-metadata-checksum", "not-validated", "invalid-size", "missing-checksum", "missing-dump"]) {
  test(`retention: ${defect} cannot displace the last valid backup`, (t) => {
    const dir = directory(t), good = backup(dir, 1), bad = backup(dir, 2);
    if (defect === "missing-metadata") fs.unlinkSync(bad.full + ".meta.json");
    else if (defect === "corrupt-metadata") fs.writeFileSync(bad.full + ".meta.json", "{");
    else if (defect === "missing-checksum") fs.unlinkSync(bad.full + ".sha256");
    else if (defect === "missing-dump") fs.unlinkSync(bad.full);
    else {
      if (defect === "incorrect-metadata-checksum") bad.meta.sha256 = "0".repeat(64);
      if (defect === "not-validated") bad.meta.status = "FAILED";
      if (defect === "invalid-size") bad.meta.sizeBytes++;
      fs.writeFileSync(bad.full + ".meta.json", JSON.stringify(bad.meta));
    }
    const result = retain(dir, 1);
    assert.deepEqual(result.kept, [path.basename(good.full)]);
    assert.equal(result.pruned.length, 0);
    assert.ok(fs.existsSync(good.full));
  });
}
test("retention: matching SHA and metadata still require a successful archive TOC", (t) => {
  const dir = directory(t), good = backup(dir, 1), bad = backup(dir, 2);
  const result = applyRetentionPolicy(dir, 1, { execFn: (cmd, options) => {
    if (options.input.toString().endsWith("2")) throw new Error("corrupt archive");
    return toc(cmd, options);
  } });
  assert.deepEqual(result.kept, [path.basename(good.full)]);
  assert.ok(fs.existsSync(bad.full));
});
test("retention: empty successful process output is not a valid archive TOC", (t) => {
  const dir = directory(t), good = backup(dir, 1);
  const result = applyRetentionPolicy(dir, 1, { execFn: () => "; no archive entries\n" });
  assert.deepEqual(result.kept, []);
  assert.equal(result.pruned.length, 0);
  assert.ok(fs.existsSync(good.full));
});
test("retention: newest ten complete valid sets are retained and unrelated files remain", (t) => {
  const dir = directory(t), sets = Array.from({ length: 12 }, (_, i) => backup(dir, i + 1));
  fs.writeFileSync(path.join(dir, "unrelated.dump"), "keep me");
  fs.writeFileSync(path.join(dir, "flashsale_p3_pending.dump.tmp"), "incomplete");
  const result = retain(dir, 99);
  assert.equal(result.kept.length, 10);
  assert.deepEqual(result.pruned.map((p) => p.file), [path.basename(sets[1].full), path.basename(sets[0].full)]);
  assert.ok(fs.existsSync(path.join(dir, "unrelated.dump")));
  assert.ok(fs.existsSync(path.join(dir, "flashsale_p3_pending.dump.tmp")));
});
for (const kind of ["active", "malformed", "unreadable"]) {
  test(`retention: ${kind} restore lock suspends the entire pruning operation`, (t) => {
    const dir = directory(t), sets = Array.from({ length: 12 }, (_, i) => backup(dir, i + 1));
    const file = path.join(dir, ".restore.lock");
    if (kind === "unreadable") fs.mkdirSync(file); // readFileSync fails on Windows and Linux.
    else fs.writeFileSync(file, kind === "malformed" ? "{" : JSON.stringify({ pid: process.pid, token: randomUUID() }));
    const result = applyRetentionPolicy(dir, 10, { validateArchive: () => assert.fail("must suspend before archive reads") });
    assert.equal(result.suspended, true);
    assert.equal(result.pruned.length, 0);
    for (const set of sets) assert.ok(fs.existsSync(set.full));
  });
}
test("owned locks: exclusivity and token prevent another owner with the same PID from releasing a lock", (t) => {
  const dir = directory(t), file = path.join(dir, ".restore.lock");
  const lease = acquireOwnedLock(file);
  assert.equal(ownsLock(lease), true);
  assert.throws(() => acquireOwnedLock(file), /lock unavailable/);
  const replacement = JSON.stringify({ pid: process.pid, token: randomUUID() });
  fs.writeFileSync(file, replacement);
  assert.equal(lease.release(), false);
  assert.equal(fs.readFileSync(file, "utf8"), replacement);
});
test("owned locks: malformed ownership data is never removed automatically", (t) => {
  const dir = directory(t), file = path.join(dir, ".restore.lock"), lease = acquireOwnedLock(file);
  fs.writeFileSync(file, "not-json");
  assert.equal(lease.release(), false);
  assert.throws(() => acquireOwnedLock(file), /lock unavailable/);
  assert.equal(fs.readFileSync(file, "utf8"), "not-json");
});
test("restore: active foreign lock is preserved and acquisition fails before database commands", async (t) => {
  const dir = directory(t), file = path.join(dir, ".restore.lock");
  const content = JSON.stringify({ pid: process.pid, token: randomUUID() });
  fs.writeFileSync(file, content);
  await assert.rejects(performRestore({ ...restoreOptions(dir), execute: true, backupDir: dir }, () => assert.fail("no Docker call allowed")), /Restore lock present/);
  assert.equal(fs.readFileSync(file, "utf8"), content);
  assert.equal(fs.existsSync(path.join(dir, ".backup-job.lock")), false);
});
test("restore: validation failure cleans up only its own restore and archive locks", async (t) => {
  const dir = directory(t);
  await assert.rejects(performRestore({ ...restoreOptions(dir), execute: true, backupDir: dir, file: path.join(dir, "missing.dump") }, cmd => {
    assert.match(cmd, /^docker inspect /); return restoreInspect();
  }), /File backup tidak ditemukan/);
  assert.equal(fs.existsSync(path.join(dir, ".restore.lock")), false);
  assert.equal(fs.existsSync(path.join(dir, ".backup-job.lock")), false);
});
for (const fails of [false, true]) {
  test(`restore: owned locks are present through restore and cleaned after ${fails ? "failure" : "success"}`, async (t) => {
    const dir = directory(t), set = backup(dir, 1);
    let token;
    const exec = (cmd) => {
      const owner = JSON.parse(fs.readFileSync(path.join(dir, ".restore.lock"), "utf8"));
      token ||= owner.token;
      assert.equal(owner.token, token);
      assert.equal(owner.pid, process.pid);
      assert.ok(fs.existsSync(path.join(dir, ".backup-job.lock")));
      if (cmd.includes("docker inspect")) return restoreInspect();
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      if (cmd.includes("pg_stat_activity")) return "0";
      if (cmd.includes("--clean") && fails) throw new Error("restore failed");
      if (cmd.includes("orders_count")) return "1|1|1";
      return "";
    };
    const result = performRestore({ ...restoreOptions(dir), execute: true, backupDir: dir, file: set.full }, exec);
    if (fails) await assert.rejects(result, /pg_restore gagal/);
    else assert.equal((await result).status, "SUCCESS");
    assert.equal(fs.existsSync(path.join(dir, ".restore.lock")), false);
    assert.equal(fs.existsSync(path.join(dir, ".backup-job.lock")), false);
  });
}
test("archive coordination: restore in one process blocks backup in a second process", (t) => {
  const dir = directory(t), session = acquireRestoreSession(dir), original = fs.readFileSync(session.restoreLock.path, "utf8");
  try {
    const modulePath = path.resolve(__dirname, "../../scripts/p4/backup.js");
    const code = `require(${JSON.stringify(modulePath)}).performBackup({backupDir:process.argv[1]},()=>{throw Error('UNSAFE Docker call')}).then(()=>process.exitCode=1).catch(e=>{if(e.code!=='P4_LOCKED')throw e;});`;
    const result = spawnSync(process.execPath, ["-e", code, dir], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(session.restoreLock.path, "utf8"), original);
    assert.equal(retain(dir).suspended, true);
  } finally { session.release(); }
});
test("archive coordination: an active backup mutex blocks restore and retention, without lock stealing", async (t) => {
  const dir = directory(t); backup(dir, 1);
  const lease = acquireArchiveLock(dir);
  try {
    await assert.rejects(performRestore({ ...restoreOptions(dir), execute: true, backupDir: dir }, () => assert.fail("no database calls")), /lock unavailable/);
    assert.equal(retain(dir).suspended, true);
    assert.equal(ownsLock(lease), true);
    await assert.rejects(performBackup({ backupDir: dir }, () => assert.fail()), /lock unavailable/);
  } finally { assert.equal(lease.release(), true); }
});
