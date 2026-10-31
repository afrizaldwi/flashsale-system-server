"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  http = require("node:http");
const { EventEmitter } = require("node:events");
const { installLifecycle } = require("../../src/lifecycle");
const { createObservability } = require("../../src/observability");
test("graceful shutdown completes in-flight response before closing database and is idempotent", async () => {
  const events = [];
  let resolveStarted;
  const started = new Promise((r) => (resolveStarted = r));
  const server = http.createServer((_req, res) => {
    resolveStarted();
    setTimeout(() => {
      events.push("response");
      res.end("complete");
    }, 50);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const signals = new EventEmitter();
  const lifecycle = installLifecycle(server, {
    signals,
    onDrain: () => events.push("drain"),
    close: async () => events.push("database-close"),
  });
  const response = fetch(`http://127.0.0.1:${server.address().port}`);
  await started;
  const shutdown = lifecycle.shutdown();
  assert.equal(lifecycle.shutdown(), shutdown);
  assert.equal(await (await response).text(), "complete");
  await shutdown;
  assert.deepEqual(events, ["drain", "response", "database-close"]);
  assert.equal(server.listening, false);
  lifecycle.detach();
});
test("management binds loopback and readiness becomes unavailable while draining", async () => {
  const obs = createObservability(() => ({})),
    server = obs.listen(async () => ({ ready: true }), 0);
  await new Promise((r) => server.once("listening", r));
  assert.equal(server.address().address, "127.0.0.1");
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url + "/ready")).status, 200);
  obs.drain();
  assert.equal((await fetch(url + "/ready")).status, 503);
  assert.equal((await fetch(url + "/live")).status, 200);
  const { closeServer } = require("../../src/lifecycle");
  await closeServer(server);
  obs.close();
});
