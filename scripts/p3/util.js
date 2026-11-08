"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const operationContext = new AsyncLocalStorage();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function execute(
  command,
  args,
  {
    input,
    timeout = 30000,
    env = process.env,
    cwd,
    onSpawn,
    stdoutFile,
    stderrFile,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    onSpawn?.(child);
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeout)
      : null;
    child.stdout.on("data", (data) => {
      if (stdoutFile) fs.appendFileSync(stdoutFile, data);
      else stdout += data;
    });
    child.stderr.on("data", (data) => {
      if (stderrFile) fs.appendFileSync(stderrFile, data);
      else stderr += data;
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve(stdout.trim());
      else {
        const error = new Error(
          `${command} failed (${timedOut ? "timeout" : code}): ${stderr.slice(-2000)}`,
        );
        error.code = code;
        error.stdout = stdout;
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
function append(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}
function lock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), {
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const old = readJson(file);
    let alive = true;
    try {
      process.kill(old.pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") alive = false;
    }
    if (alive) {
      const busy = new Error(
        `Already running: PID ${old.pid} (${path.basename(file)})`,
      );
      busy.code = "P3_LOCKED";
      throw busy;
    }
    fs.unlinkSync(file);
    return lock(file);
  }
  const release = () => {
    const owner = readJson(file, {});
    if (owner?.pid === process.pid && owner.token === token) fs.unlinkSync(file);
  };
  Object.assign(release, { path: path.resolve(file), token, pid: process.pid });
  return release;
}
function csvRow(values) {
  return (
    values.map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",") +
    "\n"
  );
}
async function waitForOperationLock(runtime, { timeoutMs = 90000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { return lock(path.join(runtime, "operation.lock")); }
    catch (error) {
      if (error.code !== "P3_LOCKED" || Date.now() >= deadline) throw error;
      await sleep(intervalMs);
    }
  }
}
async function withOperationLock(runtime, action, { wait = false } = {}) {
  const file = path.resolve(runtime, "operation.lock");
  const inherited = operationContext.getStore();
  if (inherited?.path === file) {
    const owner = readJson(file, {});
    if (owner.pid !== inherited.pid || owner.token !== inherited.token) throw new Error("P3 operation lock ownership changed");
    return action();
  }
  const release = wait ? await waitForOperationLock(runtime) : lock(file);
  try { return await operationContext.run(release, action); }
  finally { release(); }
}
module.exports = { execute, sleep, writeJson, readJson, append, lock, csvRow };
module.exports.waitForOperationLock = waitForOperationLock;
module.exports.withOperationLock = withOperationLock;
