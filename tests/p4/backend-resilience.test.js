"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");

for (const scenario of [
  { action: "fault", message: "read ECONNRESET", code: "ECONNRESET" },
  { action: "fault", message: "Connection terminated unexpectedly" },
  { action: "idle" },
]) {
  test(`backend survives ${scenario.message || "idle pooled client error"}, serves replica and recovers without restart`, async t => {
    const child = fork(path.join(__dirname, "helpers/backend-resilience.js"), [], { silent: true });
    let logs = "";
    child.stderr.on("data", c => logs += c);
    t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } });
    const [{ port }] = await once(child, "message");
    async function command(message) {
      const reply = once(child, "message"); child.send(message); return (await reply)[0];
    }
    const base = `http://127.0.0.1:${port}`;
    const checkout = () => fetch(base + "/checkout", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "test-key" }, body: JSON.stringify({ user_id: 1, product_id: 1, qty: 1 }) });
    assert.equal((await fetch(base + "/health")).status, 200);
    await command(scenario);
    const failed = await checkout();
    assert.equal(failed.status, 503, logs);
    assert.equal((await failed.json()).error, "DB_UNAVAILABLE");
    assert.equal(child.exitCode, null, logs);
    assert.equal((await fetch(base + "/live")).status, 200);
    assert.equal((await fetch(base + "/health")).status, 503);
    assert.equal((await fetch(base + "/ready")).status, 503);
    const catalog = await fetch(base + "/products");
    assert.equal(catalog.status, 200); assert.equal(catalog.headers.get("x-read-from"), "replica");
    const recovered = await command({ action: "recover" });
    assert.ok(recovered.releases >= 1); assert.equal(recovered.checkedOut, 0); assert.equal(recovered.waiting, 0);
    assert.equal((await checkout()).status, 201, logs);
    assert.equal((await fetch(base + "/health")).status, 200);
    assert.equal((await fetch(base + "/ready")).status, 200);
    assert.equal(child.exitCode, null);
    const exit = once(child, "exit"); child.send({ action: "close" });
    assert.equal((await exit)[0], 0, logs);
  });
}
