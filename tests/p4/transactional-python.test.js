"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
test("transactional Python regressions (all HTTP/Docker/DB operations mocked)", t => {
  const candidates = process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
  const python = candidates.find(([bin, ...args]) => spawnSync(bin, [...args, "--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 }).status === 0);
  if (!python) { t.skip("Python 3 is not installed; Python runtime regressions were not executed"); return; }
  const [bin, ...args] = python;
  const result = spawnSync(bin, [...args, "-B", path.join(__dirname, "transactional_python_test.py")], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
