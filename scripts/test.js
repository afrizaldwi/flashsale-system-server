"use strict";
// Explicit discovery works with Node 18+ on both cmd.exe and Bash; excludes k6 entrypoints.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const files = [
  path.join(root, "tests/core.test.js"),
  ...fs
    .readdirSync(path.join(root, "tests/p3"))
    .filter((n) => n.endsWith(".test.js"))
    .map((n) => path.join(root, "tests/p3", n)),
];
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
