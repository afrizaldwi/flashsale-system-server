"use strict";
// Explicit discovery works with Node 18+ on both cmd.exe and Bash; excludes k6 entrypoints.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");

const p1Dir = path.join(root, "tests/p1");
const p1Files = fs.existsSync(p1Dir)
  ? fs
      .readdirSync(p1Dir)
      .filter((n) => n.endsWith(".test.js"))
      .map((n) => path.join(p1Dir, n))
  : [];

const p3Dir = path.join(root, "tests/p3");
const p3Files = fs.existsSync(p3Dir)
  ? fs
      .readdirSync(p3Dir)
      .filter((n) => n.endsWith(".test.js"))
      .map((n) => path.join(p3Dir, n))
  : [];

const p4Dir = path.join(root, "tests/p4");
const p4Files = fs.existsSync(p4Dir)
  ? fs
      .readdirSync(p4Dir)
      .filter((n) => n.endsWith(".test.js"))
      .map((n) => path.join(p4Dir, n))
  : [];

const files = [
  path.join(root, "tests/core.test.js"),
  ...p1Files,
  ...p3Files,
  ...p4Files,
];

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
