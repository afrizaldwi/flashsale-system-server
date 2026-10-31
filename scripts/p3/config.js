"use strict";
const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const ROOT = path.resolve(__dirname, "../..");
const PROJECT = "flashsale-p3";
function loadConfig() {
  const envFile = path.join(ROOT, ".env.p3");
  if (!fs.existsSync(envFile)) throw new Error("Run npm run p3:init first.");
  const values = dotenv.parse(fs.readFileSync(envFile));
  if (
    !/^[a-f0-9-]{36}$/i.test(values.P3_ID || "") ||
    !/^[a-f0-9]{48}$/.test(values.P3_DB_PASSWORD || "") ||
    !/^[a-f0-9]{48}$/.test(values.P3_REPLICATION_PASSWORD || "")
  )
    throw new Error("Invalid P3 credentials/identity; use p3:init.");
  const number = (key, fallback) => {
    const n = Number(values[key] ?? fallback);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${key}`);
    return n;
  };
  const config = {
    root: ROOT,
    project: PROJECT,
    envFile,
    values,
    runtime: path.join(ROOT, ".p3"),
    port: number("P3_PORT", 8080),
    quota: number("P3_BACKEND_CPUS", 0.5),
    poolMax: number("P3_POOL_MAX", 10),
    min: number("P3_MIN_REPLICAS", 2),
    max: number("P3_MAX_REPLICAS", 6),
    interval: number("P3_INTERVAL_MS", 5000),
    outCpu: number("P3_SCALE_OUT_CPU", 65),
    inCpu: number("P3_SCALE_IN_CPU", 25),
    outWindow: number("P3_SCALE_OUT_WINDOW_MS", 30000),
    inWindow: number("P3_SCALE_IN_WINDOW_MS", 180000),
    outCooldown: number("P3_SCALE_OUT_COOLDOWN_MS", 60000),
    inCooldown: number("P3_SCALE_IN_COOLDOWN_MS", 120000),
    readyTimeout: number("P3_READY_TIMEOUT_MS", 90000),
    drainTimeout: number("P3_DRAIN_TIMEOUT_MS", 90000),
    stale: 15000,
    collectBudget: number("P3_COLLECT_BUDGET_MS", 4000),
    terminationTimeout: number("P3_TERMINATION_TIMEOUT_MS", 100000),
    routingTimeout: 30000,
  };
  for (const key of ["port", "poolMax", "min", "max"])
    if (!Number.isInteger(config[key])) throw new Error(`Noninteger ${key}`);
  if (
    config.min < 2 ||
    config.max < config.min ||
    config.max > 6 ||
    config.port > 65535 ||
    config.inCpu >= config.outCpu ||
    config.outCpu > 100 ||
    config.interval > config.stale ||
    config.quota > 1
  )
    throw new Error("Unsafe P3 configuration");
  if (config.max * (config.poolMax + 1) + 1 + 20 > 100)
    throw new Error("Connection budget exceeds 100 with 20 reserved");
  config.baseUrl = `http://127.0.0.1:${config.port}`;
  if (
    config.collectBudget >= config.interval ||
    config.collectBudget >= config.stale
  )
    throw new Error(
      "Collector budget must be below polling interval and stale deadline",
    );
  config.lifecycle = require("./timing").lifecycleTiming(
    config,
    values.P3_LIFECYCLE_LOW_SECONDS,
  );
  return config;
}
module.exports = { loadConfig, ROOT, PROJECT };
