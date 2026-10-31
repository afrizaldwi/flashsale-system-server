"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Controller } = require("../../scripts/p3/controller");
const { Docker } = require("../../scripts/p3/docker");
test("shutdown waits for transaction-pool completion even with no active HTTP connection", async () => {
  const server = require("node:http").createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let commit,
    closed = false,
    closing = false;
  const completed = new Promise((r) => {
    commit = r;
  });
  const lifecycle = require("../../src/lifecycle").installLifecycle(server, {
    signals: new (require("node:events").EventEmitter)(),
    close: async () => {
      closing = true;
      await completed;
    },
    onClosed: () => {
      closed = true;
    },
  });
  const shutdown = lifecycle.shutdown();
  await new Promise((r) => setImmediate(r));
  assert.equal(closing, true);
  assert.equal(closed, false);
  commit();
  await shutdown;
  assert.equal(closed, true);
  lifecycle.detach();
});
function fixture() {
  const containers = [1, 2, 3].map((n) => ({
    Id: String(n),
    State: { Running: true },
    Config: { Labels: { "com.docker.compose.container-number": String(n) } },
  }));
  const actions = [];
  const docker = {
    c: {
      runtime: fs.mkdtempSync(path.join(os.tmpdir(), "p3-tx-")),
      min: 2,
      drainTimeout: 2000,
    },
    list: async () => containers,
    probe: async () => ({
      active_requests: 0,
      pools: { primary: { total: 1, idle: 0, waiting: 0 } },
    }),
    removeBackend: async () => actions.push("remove"),
  };
  const routing = {
    apply: async (list) => {
      actions.push(`routes:${list.length}`);
      return {};
    },
    workersGone: async () => true,
  };
  const controller = new Controller(docker.c, docker, routing);
  controller.routed = containers.map((c) => ({ id: c.Id, ip: "172.20.0.2" }));
  return { controller, docker, actions, containers };
}
test("zero HTTP requests does not allow removal while a transaction client is leased", async () => {
  const f = fixture();
  let probes = 0;
  f.docker.probe = async () => {
    probes++;
    if (probes === 2) f.actions.push("commit-and-release");
    return {
      active_requests: 0,
      pools: { primary: { total: 1, idle: probes >= 2 ? 1 : 0, waiting: 0 } },
    };
  };
  await f.controller.scaleIn(f.containers, 2);
  assert.deepEqual(f.actions, ["routes:2", "commit-and-release", "remove"]);
});
test("interrupted scale-in restores routes without signaling a backend holding a transaction", async () => {
  const f = fixture();
  let checks = 0;
  f.controller.cancelled = () => ++checks > 1;
  await assert.rejects(
    () => f.controller.scaleIn(f.containers, 2),
    /interrupted/,
  );
  assert.deepEqual(f.actions, ["routes:2", "routes:3"]);
});
test("routing failure and rollback failure never reach backend termination", async () => {
  const f = fixture();
  f.controller.routing.apply = async () => {
    throw new Error("routing broken");
  };
  await assert.rejects(
    () => f.controller.scaleIn(f.containers, 2),
    /routing broken/,
  );
  assert.deepEqual(f.actions, []);
  assert.ok(f.controller.state.pending);
});
test("graceful termination timeout leaves backend running without SIGKILL, stop or forced rm", async () => {
  const commands = [],
    d = new Docker({ project: "flashsale-p3", terminationTimeout: 0 });
  d.inspect = async () => ({ State: { Running: true } });
  d.command = async (args) => {
    commands.push(args);
    return "";
  };
  await assert.rejects(() => d.removeBackend("a".repeat(64)), /left running/);
  assert.deepEqual(commands, [["kill", "--signal", "SIGTERM", "a".repeat(64)]]);
  await assert.rejects(() => d.removeExitedBackend("a".repeat(64)), /running/);
});
