"use strict";
// Only a temporary filesystem and the fake Docker driver are used in this child.
const fs = require("node:fs");
const path = require("node:path");
const { archive, fakeRuntime } = require("./dr-runtime");
const { executeDisasterRecovery, SPEC } = require("../../../scripts/p4/p3-dr");
const root = process.argv[2];
const c = { root, runtime: path.join(root, ".p3"), envFile: path.join(root, ".env.p3"),
  project: "flashsale-p3", port: 8080, baseUrl: SPEC.baseUrl,
  values: { P3_ID: "00000000-0000-4000-8000-000000000003" }, min: 2, max: 6, poolMax: 10, readyTimeout: 100 };
fs.mkdirSync(c.runtime, { recursive: true });
archive(c);
const runtime = fakeRuntime(c, true), command = runtime.docker.command;
runtime.docker.command = async (args, options) => {
  const result = await command(args, options);
  if (args[0] === "rm" && args[1] === "-f") process.exit(73); // No finally/cleanup runs.
  return result;
};
executeDisasterRecovery({ execute: true, config: c, ...runtime,
  confirmPrimary: "a".repeat(64), confirmVolume: "flashsale-p3_primary" })
  .catch((error) => { process.stderr.write(error.stack); process.exitCode = 1; });
