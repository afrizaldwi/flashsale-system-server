"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { responseAccepted } = require("../../scripts/p4/workload-policy");
const { performRestore } = require("../../scripts/p4/restore");
const { lock } = require("../../scripts/p3/util");
const { restoreOptions, restoreInspect } = require("./helpers/restore-runtime");

function k6Harness(status, body, expectedOutage = true) {
  const source = fs.readFileSync(path.join(__dirname, "../load/p4-dr-workload.js"), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export const options", "const options")
    .replace("export function setup", "function setup").replace("export default function ()", "function iteration()") +
    "\nglobalThis.runIteration=iteration; globalThis.settings=options;";
  const checks = [], counters = [], requests = [];
  const c = vm.createContext({ __ENV: { P4_STOP_AFTER_OUTAGE: expectedOutage ? "1" : "0" },
    Counter: class { add(n) { counters.push(n); } },
    check: (_response, predicates) => checks.push(...Object.values(predicates).map(f => f())), sleep: () => {},
    http: { post: (...args) => { requests.push(args); return { status, json: () => body }; } },
    exec: { vu: { iterationInScenario: 0, idInTest: 1 } }, console: { log: () => {} } });
  vm.runInContext(source, c);
  c.runIteration(); c.runIteration();
  return { checks, counters, requests, settings: c.settings };
}
for (const status of [500, 502, 504]) {
  test(`actual K6 script rejects ${status} and stops that VU from repeating writes`, () => {
    const r = k6Harness(status, {});
    assert.deepEqual(r.checks, [false]); assert.deepEqual(r.counters, [1]); assert.equal(r.requests.length, 1);
    assert.equal(r.settings.thresholds.checks[0], "rate==1");
    assert.equal(r.settings.thresholds.unexpected_responses[0], "count==0");
  });
}
test("actual K6 script accepts business responses and classified outage candidates, rejects unrelated 503", () => {
  for (const [status, body] of [[201, { order: { id: 1 } }], [200, { result: "DUPLICATE" }], [409, { error: "SOLD_OUT" }], [503, { error: "DB_UNAVAILABLE" }], [0, null]])
    assert.ok(k6Harness(status, body).checks.every(Boolean));
  assert.deepEqual(k6Harness(503, { error: "MAINTENANCE" }).checks, [false]);
  assert.ok(k6Harness(503, { error: "DB_UNAVAILABLE" }, false).checks.every(v => !v));
});
test("host policy accepts transport/DB outage only after the explicit marker; gateway/internal errors always fail", () => {
  const at = "2026-11-08T09:38:57.187Z";
  for (const status of [0, 503]) {
    const entry = { status, errorCode: "DB_UNAVAILABLE", responseTimestamp: "2026-11-08T09:38:57.214Z" };
    assert.equal(responseAccepted(entry, at), true); assert.equal(responseAccepted(entry), false);
    assert.equal(responseAccepted({ ...entry, responseTimestamp: "2026-11-08T09:38:57.150Z" }, at), false);
  }
  for (const status of [500, 502, 504]) assert.equal(responseAccepted({ status, responseTimestamp: "2026-11-08T09:38:58Z" }, at), false);
  assert.equal(responseAccepted({ status: 503, errorCode: "MAINTENANCE", responseTimestamp: "2026-11-08T09:38:58Z" }, at), false);
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-api-safety-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, options: restoreOptions(dir) };
}
for (const mode of ["no-manifest", "validated", "malformed", "unpaused", "no-confirmation", "wrong-id", "original-primary", "original-replica", "foreign-project", "operation-busy"]) {
  test(`programmatic restore blocks ${mode} before any DB or container mutation`, async t => {
    const { dir, options } = fixture(t), manifest = path.join(options.config.runtime, "recovery.json");
    const state = JSON.parse(fs.readFileSync(manifest));
    const inspect = JSON.parse(restoreInspect());
    if (mode === "no-manifest") fs.unlinkSync(manifest);
    if (mode === "validated") fs.writeFileSync(manifest, JSON.stringify({ ...state, phase: "validated" }));
    if (mode === "malformed") fs.writeFileSync(manifest, "{");
    if (mode === "unpaused") fs.writeFileSync(path.join(options.config.runtime, "control.json"), '{"paused":false}');
    if (mode === "no-confirmation") delete options.confirmPrimary;
    if (mode === "wrong-id") options.confirmPrimary = "f".repeat(64);
    if (mode === "original-primary") inspect[0].Mounts[0].Name = state.originalPrimary.volume;
    if (mode === "original-replica") inspect[0].Mounts[0].Name = state.originalReplica.volume;
    if (mode === "foreign-project") inspect[0].Config.Labels["com.docker.compose.project"] = "flashsale-p4-dr";
    const release = mode === "operation-busy" ? lock(path.join(options.config.runtime, "operation.lock")) : () => {};
    try {
      let mutations = 0;
      await assert.rejects(performRestore({ ...options, backupDir: dir, execute: true }, cmd => {
        if (cmd.startsWith("docker inspect ")) return JSON.stringify(inspect);
        mutations++; throw new Error("Unexpected mutation");
      }));
      assert.equal(mutations, 0);
      assert.equal(fs.existsSync(path.join(dir, ".restore.lock")), false);
      assert.equal(fs.existsSync(path.join(dir, ".backup-job.lock")), false);
    } finally { release(); }
  });
}
