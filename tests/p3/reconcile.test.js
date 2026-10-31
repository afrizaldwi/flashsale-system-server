"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { keysInLine, reconcile } = require("../../scripts/p3/reconcile");
const { writeJson } = require("../../scripts/p3/util");
const id = "p3-11111111-1111-1111-1111-111111111111";
test("ambiguous key extraction accepts only the exact run namespace", () => {
  assert.deepEqual(
    keysInLine(`ambiguous_checkout key=${id}-2-17 foreign=p3-other-1-2`, id),
    [`${id}-2-17`],
  );
  assert.throws(() => keysInLine("anything", "p3-bad';DROP"));
});
test("lost response is reconciled as committed and explains DB order count", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-reconcile-"));
  fs.writeFileSync(
    path.join(dir, "k6.stderr.log"),
    `ambiguous_checkout key=${id}-2-17\n`,
  );
  writeJson(path.join(dir, "k6-summary.json"), {
    metrics: {
      checkout_created_all: { values: { count: 1 } },
      checkout_attempts_all: { values: { count: 2 } },
    },
  });
  const docker = {
    sql: async (_service, sql) =>
      JSON.stringify(
        sql.includes("json_agg")
          ? [{ key: `${id}-2-17`, order_id: 2 }]
          : { orders: 2, outside_run: 0 },
      ),
  };
  const result = await reconcile(docker, dir, id);
  assert.equal(result.committed, 1);
  assert.equal(result.explained, true);
});
test("unexplained or foreign orders fail reconciliation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-reconcile-"));
  const docker = {
    sql: async () => JSON.stringify({ orders: 1, outside_run: 1 }),
  };
  await assert.rejects(() => reconcile(docker, dir, id), /do not match/);
});
