"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// No automatic stale-lock reclamation: an incomplete restore needs operator review.
function acquireOwnedLock(file, metadata = {}, pid = process.pid) {
  const absolute = path.resolve(file);
  const token = randomUUID();
  const payload = { ...metadata, pid, token, createdAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(absolute, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(payload));
    fs.fsyncSync(fd);
  } catch (error) {
    // A partially written file is intentionally retained and blocks other operations.
    const failure = new Error(`Archive lock unavailable (${path.basename(absolute)}): ${error.message}`);
    failure.code = "P4_LOCKED";
    failure.cause = error;
    throw failure;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  const lease = { path: absolute, pid, token };
  lease.release = () => {
    try {
      if (!ownsLock(lease)) return false;
      fs.unlinkSync(absolute);
      return true;
    } catch { return false; }
  };
  return lease;
}
function ownsLock(lease) {
  if (!lease?.path || !lease.token || !Number.isInteger(lease.pid)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(lease.path, "utf8"));
    return data.pid === lease.pid && data.token === lease.token;
  } catch { return false; }
}
function restoreLockPresent(dir) {
  try { fs.lstatSync(path.join(dir, ".restore.lock")); return true; }
  catch (error) { return error.code !== "ENOENT"; }
}
function acquireArchiveLock(dir) {
  const lease = acquireOwnedLock(path.join(dir, ".backup-job.lock"), { operation: "archive" });
  if (restoreLockPresent(dir)) {
    lease.release();
    throw new Error("Restore lock present or unreadable; archive operations suspended");
  }
  return lease;
}
function assertArchiveLock(dir, lease) {
  if (lease?.path !== path.resolve(dir, ".backup-job.lock") || !ownsLock(lease))
    throw new Error("Archive mutex ownership lost");
}
function acquireRestoreSession(dir, metadata = {}) {
  const archiveLock = acquireArchiveLock(dir);
  let restoreLock;
  try { restoreLock = acquireOwnedLock(path.join(dir, ".restore.lock"), { ...metadata, operation: "restore" }); }
  catch (error) { archiveLock.release(); throw error; }
  return { archiveLock, restoreLock, release() {
    const restored = restoreLock.release();
    const archived = archiveLock.release();
    if (!restored || !archived) throw new Error("Restore lock ownership changed or cleanup failed; inspect retained lock files");
  } };
}
module.exports = { acquireOwnedLock, ownsLock, restoreLockPresent, acquireArchiveLock, assertArchiveLock, acquireRestoreSession };
