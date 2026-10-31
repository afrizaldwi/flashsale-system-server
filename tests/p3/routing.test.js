"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { render, Routing } = require("../../scripts/p3/routing");
const { Controller } = require("../../scripts/p3/controller");
test("routing rejects empty upstream and injected IP/generation", () => {
  assert.throws(() => render([], "abc"));
  assert.throws(() => render([{ ip: "1.2.3.4;server evil" }], "abc"));
  assert.throws(() => render([{ ip: "300.2.3.4" }], "abc"));
  assert.throws(() => render([{ ip: "1.2.3.4" }], "bad;"));
  const config = render([{ ip: "172.20.0.5" }], "abc");
  assert.match(config, /proxy_next_upstream off/);
  assert.match(config, /172\.20\.0\.5:3000/);
});
function fakeRouting({ invalid = false, activationFails = false } = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "p3-routing-"));
  const calls = [];
  const docker = {
    c: { runtime, project: "flashsale-p3" },
    list: async () => [{ Id: "a".repeat(64), State: { Running: true } }],
    exec: async (_id, _service, args, options) => {
      const script = args.join(" ");
      calls.push(script);
      if (script.includes("/proc/")) return "10 11";
      if (script.includes("candidate.conf; nginx -t") && invalid)
        throw new Error("invalid config");
      if (script.includes("wget")) {
        if (activationFails) throw new Error("probe failed");
        const candidate = calls.find((c) =>
          c.includes("candidate.conf; nginx -t"),
        );
        assert.ok(candidate);
        return JSON.stringify({ generation: docker.generation });
      }
      if (options?.input)
        docker.generation = options.input.match(
          /X-Config-Version ([a-z0-9-]+)/,
        )[1];
      return "";
    },
  };
  return { routing: new Routing(docker), calls, runtime };
}
test("invalid candidate is never activated", async () => {
  const { routing, calls } = fakeRouting({ invalid: true });
  await assert.rejects(
    () => routing.apply([{ id: "b", ip: "172.20.0.2" }]),
    /invalid/,
  );
  assert.equal(
    calls.some((c) => c.includes("mv /etc")),
    false,
  );
});
test("routing validates before reload and persists only verified generation", async () => {
  const { routing, calls, runtime } = fakeRouting();
  const result = await routing.apply([{ id: "b", ip: "172.20.0.2" }]);
  assert.deepEqual(result.oldWorkers, ["10", "11"]);
  assert.ok(
    calls.findIndex((c) => c.includes("nginx -t")) <
      calls.findIndex((c) => c.includes("nginx -s reload")),
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(runtime, "routing.json"))).generation,
    result.generation,
  );
});
test("activation failure restores previous Nginx configuration", async () => {
  const { routing, calls } = fakeRouting({ activationFails: true });
  await assert.rejects(
    () => routing.apply([{ id: "b", ip: "172.20.0.2" }]),
    /probe/,
  );
  assert.ok(calls.some((c) => c.includes("cp /etc/nginx/p3/rollback.conf")));
});
test("scale-in removes only drained victim after routing and worker completion", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "p3-drain-")),
    events = [];
  const containers = [1, 2, 3].map((n) => ({
    Id: String(n),
    Config: { Labels: { "com.docker.compose.container-number": String(n) } },
  }));
  const docker = {
    c: { runtime, min: 2, drainTimeout: 100 },
    probe: async () => ({
      active_requests: 0,
      pools: { primary: { total: 1, idle: 1, waiting: 0 } },
    }),
    removeBackend: async (id) => events.push(`remove:${id}`),
  };
  const routing = {
    apply: async (members) => {
      events.push(`route:${members.length}`);
      return {};
    },
    workersGone: async () => {
      events.push("workers-gone");
      return true;
    },
  };
  const controller = new Controller(docker.c, docker, routing);
  controller.routed = containers.map((c) => ({ id: c.Id, ip: "172.20.0.2" }));
  await controller.scaleIn(containers, 2);
  assert.deepEqual(events, ["route:2", "workers-gone", "remove:3"]);
  assert.equal(controller.state.desired, 2);
});
test("drain timeout restores original routes without stopping victim", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "p3-drain-")),
    events = [];
  const containers = [1, 2, 3].map((n) => ({
    Id: String(n),
    State: { Running: true },
    Config: { Labels: { "com.docker.compose.container-number": String(n) } },
  }));
  const docker = {
    c: { runtime, min: 2, drainTimeout: 0 },
    list: async () => containers,
    removeBackend: async () => events.push("removed"),
  };
  const routing = {
    apply: async (members) => {
      events.push(members.length);
      return {};
    },
  };
  const controller = new Controller(docker.c, docker, routing);
  controller.routed = containers.map((c) => ({ id: c.Id, ip: "172.20.0.2" }));
  await assert.rejects(
    () => controller.scaleIn(containers, 2),
    /Drain timeout/,
  );
  assert.deepEqual(events, [2, 3]);
});
