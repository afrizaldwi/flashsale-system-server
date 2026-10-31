"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { parse, matrix } = require("../../scripts/p3/run");
const { quantile } = require("../../scripts/p3/report");
test("runner is dry-run by default and campaigns require explicit execution", () => {
  assert.equal(parse([]).execute, false);
  assert.equal(parse(["--campaign", "final"]).execute, false);
  assert.equal(parse(["--campaign", "pilot", "--execute"]).execute, true);
  assert.throws(
    () => parse(["--campaign", "smoke", "--workload", "write"]),
    /read-only/,
  );
});
test("pilot and final matrix counts and repetition order are reproducible", () => {
  assert.equal(matrix("pilot").length, 24);
  assert.equal(matrix("final").length, 72);
  assert.equal(matrix("final")[0].mode, "fixed");
  assert.equal(matrix("final")[24].mode, "auto");
});
test("report computes percentile from samples, not averages of quantiles", () => {
  assert.equal(quantile([1, 2, 3, 4, 100], 0.95), 100);
  assert.equal(quantile([], 0.95), null);
});
