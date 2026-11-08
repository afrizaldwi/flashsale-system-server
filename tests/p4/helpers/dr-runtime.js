"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { recoveryState } = require("../../../scripts/p3/recovery");
const { recordTransaction } = require("../../../scripts/p4/ledger");
function archive(
  c,
  name = "flashsale_p3_20261108_120000.dump",
  time = "2026-11-08T12:00:00Z",
) {
  const dir = path.join(c.root, "backups/p3");
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name),
    data = Buffer.from("PGDMP-example");
  fs.writeFileSync(full, data);
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  fs.writeFileSync(full + ".sha256", sha256 + "  " + name);
  fs.writeFileSync(
    full + ".meta.json",
    JSON.stringify({
      database: "flashsale_p3",
      status: "VALIDATED",
      sha256,
      file: name, sizeBytes: data.length, durationMs: 0, tocEntries: 1,
      startTime: time,
      endTime: time,
    }),
  );
  return full;
}
function fakeRuntime(c, workloadOk = false, { ordersPresent = false } = {}) {
  const ledgerOrders = [];
  let removedAt;
  const calls = [];
  let injected = false,
    restored = false,
    finishWorkload;
  const container = (service, id, volume) => ({
    Id: id.repeat(64),
    State: { Running: true, Status: "running", StartedAt: "2026-11-08T12:00:00Z", OOMKilled: false },
    RestartCount: 0,
    Config: {
      Labels: {
        "com.docker.compose.project": "flashsale-p3",
        "com.docker.compose.service": service,
        "flashsale.environment": "p3",
      },
    },
    Mounts: volume
      ? [
          {
            Destination: "/var/lib/postgresql/data",
            Type: "volume",
            Name: volume,
          },
        ]
      : [],
    NetworkSettings: {
      Networks: { "flashsale-p3_p3": { IPAddress: "172.20.0.5" } },
    },
  });
  let primary = container("db-primary", "a", "flashsale-p3_primary"),
    replica = container("db-replica", "b", "flashsale-p3_replica");
  const backends = [container("backend", "c"), container("backend", "d")];
  const volumes = new Map([
    [
      "flashsale-p3_primary",
      {
        Name: "flashsale-p3_primary",
        Labels: {
          "com.docker.compose.project": "flashsale-p3",
          "flashsale.environment": "p3",
        },
      },
    ],
  ]);
  const docker = {
    c,
    preflight: async () => {},
    list: async (service) =>
      service === "db-primary"
        ? primary
          ? [primary]
          : []
        : service === "db-replica"
          ? [replica]
          : backends,
    inspect: async (id) =>
      [primary, replica, ...backends].find((v) => v?.Id === id),
    command: async (args) => {
      calls.push(args);
      if (args[0] === "events") return JSON.stringify({ Actor: { ID: "a".repeat(64) }, Action: "die", timeNano: String(BigInt(removedAt) * 1000000n) });
      if (args[0] === "inspect") throw new Error("No such container");
      if (args[0] === "volume" && args[1] === "ls")
        return Array.from(volumes.keys()).join("\n");
      if (args[0] === "volume" && args[1] === "inspect")
        return JSON.stringify([volumes.get(args[2])]);
      if (args[0] === "volume" && args[1] === "create") {
        const labels = {};
        for (let i = 0; i < args.length; i++)
          if (args[i] === "--label") {
            const [key, value] = args[++i].split("=");
            labels[key] = value;
          }
        const name = args.at(-1);
        volumes.set(name, { Name: name, Labels: labels });
        return name;
      }
      if (args[0] === "rm" && args[1] === "-f") {
        removedAt = Date.now();
        injected = true;
        primary = null;
        finishWorkload?.();
      }
      return "";
    },
    compose: async (args) => {
      calls.push(["compose", ...args]);
      const state = recoveryState(c);
      if (args.at(-1) === "db-primary") {
        primary = container("db-primary", "e", state.primaryVolume);
        restored = true;
      }
      if (args.at(-1) === "db-replica")
        replica = container("db-replica", "f", state.replicaVolume);
      return "";
    },
    exec: async (_id, _service, args) => {
      calls.push(["exec", ...args]);
      if (args[0] === "pg_restore" && args[1] === "--list")
        return "1; TABLE public orders";
      if (args[0] === "psql")
        return JSON.stringify(
          args.at(-1).includes("'identity'")
            ? {
                negative_stock: 0,
                duplicate_orders: 0,
                mismatches: 0,
                orders: 1,
                products: 3,
                identity: c.values.P3_ID,
              }
            : { negative_stock: 0, duplicate_orders: 0, mismatches: 0 },
        );
      return "";
    },
    probe: async () => ({ ready: true, live: true }),
    sql: async (service, sql) => {
      if (sql.includes("'identity'"))
        return JSON.stringify({
          database: "flashsale_p3",
          identity: c.values.P3_ID,
          standby: service === "db-replica",
          max_connections: 100,
        });
      if (sql.includes("current_database() ||")) return "flashsale_p3|false";
      if (sql.includes("pg_current_wal_lsn")) return "0/123";
      if (sql.includes("pg_last_wal_replay_lsn")) return "t";
      if (sql.includes("json_agg(o)")) return JSON.stringify(ordersPresent ? ledgerOrders : []);
      return JSON.stringify({
        negative_stock: 0,
        duplicate_orders: 0,
        foreign_orders: 0,
        products: [{ id: 1, selisih: 0 }],
        orders: 1,
        qty: 1,
      });
    },
  };
  const http = async (_base, route) =>
    route === "/health"
      ? {
          status: injected && !restored ? 503 : 200,
          body: { db: "up", replica: "up", replica_read_only: true },
        }
      : route === "/stats"
        ? { status: 200, body: { consistent: true } }
        : {
            status: 200,
            body: [{ id: 1, stock: 1000 }],
            headers: { "x-read-from": "replica" },
          };
  const workload = (options) => {
    const promise = new Promise((resolve) => {
      finishWorkload = () =>
        resolve({
          ok: workloadOk,
          code: workloadOk ? 0 : 99,
          handshakeReceived: true,
          error: workloadOk ? null : "threshold failed",
        });
    });
    return {
      waitForHandshake: async () => {},
      waitForObservedVUs: async () => {
        for (let vu = 1; vu <= 100; vu++) {
          ledgerOrders.push({ id: vu, idempotency_key: `p3-dr-test-vu${vu}-iter0`, user_id: 1, product_id: 1, qty: 1, created_at: new Date().toISOString() });
          recordTransaction(
            {
              idempotencyKey: `p3-dr-test-vu${vu}-iter0`,
              status: 201,
              outcome: "CREATED",
              timestamp: new Date().toISOString(),
              productId: 1,
              userId: 1,
              qty: 1,
            },
            options.ledgerPath,
          );
        }
      },
      markOutageRequested: () => {},
      isAlive: () => !injected,
      promise,
      stop: () => {
        finishWorkload();
        return promise;
      },
    };
  };
  return {
    docker,
    http,
    workload,
    calls,
    checkout: async () => ({
      status: injected && !restored ? 503 : 201,
      body:
        injected && !restored
          ? { error: "DB_UNAVAILABLE" }
          : { order: { id: 1 } },
    }),
    pause: async () => {},
    applyRouting: async () => {
      calls.push(["routing-verified"]);
    },
  };
}

module.exports = { archive, fakeRuntime };
