"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
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
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), {
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
  return () => {
    if (readJson(file, {})?.pid === process.pid) fs.unlinkSync(file);
  };
}
function csvRow(values) {
  return (
    values.map((v) => `"${String(v ?? "").replaceAll('"', '""')}"`).join(",") +
    "\n"
  );
}
module.exports = { execute, sleep, writeJson, readJson, append, lock, csvRow };
