"use strict";
// Real Express application, real pg.Pool, real ResilientClient error listener;
// only the PostgreSQL wire transport is simulated. Never contacts a database.
const pg = require("pg");
const { ResilientClient } = require("../../../src/db-client");
const RealPool = pg.Pool;
let up = true, fault = null, releases = 0;
class WireClient extends ResilientClient {
  connect(callback) { process.nextTick(callback); }
  end(callback) { process.nextTick(() => { this.emit("end"); callback?.(); }); }
  query(sql, params, callback) {
    if (this.connectionFailure) return super.query(sql, params, callback);
    if (typeof params === "function") callback = params;
    const replica = this.connectionParameters.host === "replica";
    let error;
    if (!replica && fault && sql === "BEGIN") {
      error = fault; fault = null; up = false;
      this.emit("error", error); // Checked out: pg.Pool's idle listener is absent.
    } else if (!replica && !up) error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    let rows = [];
    if (/in_recovery/.test(sql)) rows = [{ in_recovery: replica, ready: !replica, database: "flashsale_p3", lag_s: 0 }];
    else if (/FROM products ORDER/.test(sql)) rows = [{ id: 1, stock: 10 }];
    else if (/INSERT INTO orders/.test(sql)) rows = [{ id: 1, idempotency_key: params?.[3] }];
    const result = { rows, rowCount: /UPDATE products/.test(sql) ? 1 : rows.length };
    if (callback) { process.nextTick(() => callback(error, result)); return; }
    return error ? Promise.reject(error) : Promise.resolve(result);
  }
}
pg.Pool = class extends RealPool {
  constructor(options) {
    super({ ...options, Client: WireClient });
    this.on("remove", () => releases++);
  }
};
process.env.DB_HOST = "primary";
process.env.DB_REPLICA_HOST = "replica";
process.env.P3_OBSERVABILITY = "1";
const app = require("../../../src/server");
const db = require("../../../src/db");
const server = app.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
process.on("message", async msg => {
  try {
    if (msg.action === "fault") fault = Object.assign(new Error(msg.message), { code: msg.code });
    if (msg.action === "idle") {
      await db.primary.query("SELECT 1"); up = false;
      db.primary._clients[0].emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    }
    if (msg.action === "recover") up = true;
    if (msg.action === "close") {
      await db.close(); server.close(() => process.exit(0)); return;
    }
    process.send({ action: msg.action, releases, waiting: db.primary.waitingCount, checkedOut: db.primary.totalCount - db.primary.idleCount });
  } catch (error) { process.send({ error: error.message }); }
});
