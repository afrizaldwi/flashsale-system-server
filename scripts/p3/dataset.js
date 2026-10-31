"use strict";
const path = require("node:path");
const { sleep, readJson, lock } = require("./util");
const { perProduct } = require("../../src/queries");
async function jsonSQL(docker, service, sql) {
  return JSON.parse(await docker.sql(service, sql));
}
async function assertIsolation(docker) {
  for (const service of ["db-primary", "db-replica"]) {
    const containers = await docker.list(service);
    if (containers.length !== 1)
      throw new Error(`Invalid ${service} membership`);
    const container = containers[0];
    const suffix = service === "db-primary" ? "primary" : "replica";
    const mount = container.Mounts?.find(
      (m) => m.Destination === "/var/lib/postgresql/data",
    );
    if (
      mount?.Type !== "volume" ||
      mount.Name !== `${docker.c.project}_${suffix}`
    )
      throw new Error("Refusing foreign database volume");
    const data = await jsonSQL(
      docker,
      service,
      `BEGIN READ ONLY;
SELECT json_build_object('database',current_database(),'standby',pg_is_in_recovery(),
 'identity',(SELECT id::text FROM p3_environment WHERE project='flashsale-p3'),
 'max_connections',current_setting('max_connections')::int);
COMMIT;`,
    );
    if (
      data.database !== "flashsale_p3" ||
      data.identity !== docker.c.values.P3_ID ||
      data.standby !== (service === "db-replica")
    )
      throw new Error("P3 database identity/role mismatch");
    if (docker.c.max * (docker.c.poolMax + 1) + 1 + 20 > data.max_connections)
      throw new Error("Database connection budget exceeded");
  }
  return true;
}
async function waitReplay(docker, timeout = 60000) {
  const lsn = await docker.sql("db-primary", "SELECT pg_current_wal_lsn();");
  if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(lsn))
    throw new Error("Invalid WAL checkpoint");
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (
      (await docker.sql(
        "db-replica",
        `SELECT COALESCE(pg_last_wal_replay_lsn() >= '${lsn}'::pg_lsn,false);`,
      )) === "t"
    )
      return lsn;
    await sleep(500);
  }
  throw new Error("Replica replay timeout");
}
async function snapshot(docker, service = "db-primary") {
  return jsonSQL(
    docker,
    service,
    `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object('database',current_database(),'standby',pg_is_in_recovery(),
 'products',(SELECT json_agg(p ORDER BY p.id) FROM (${perProduct}) p),
 'orders',(SELECT COUNT(*) FROM orders),'qty',(SELECT COALESCE(SUM(qty),0) FROM orders),
 'negative_stock',(SELECT COUNT(*) FROM products WHERE stock<0),
 'duplicate_orders',(SELECT COUNT(*) FROM (SELECT idempotency_key FROM orders GROUP BY 1 HAVING COUNT(*)>1) d),
 'foreign_orders',(SELECT COUNT(*) FROM orders WHERE idempotency_key NOT LIKE 'p3-%'));
COMMIT;`,
  );
}
async function verify(docker) {
  await assertIsolation(docker);
  const checkpoint = await waitReplay(docker);
  const primary = await snapshot(docker),
    replica = await snapshot(docker, "db-replica");
  const consistent =
    primary.negative_stock === 0 &&
    primary.duplicate_orders === 0 &&
    primary.foreign_orders === 0 &&
    primary.products.every((p) => p.selisih === 0) &&
    JSON.stringify(primary.products) === JSON.stringify(replica.products) &&
    primary.orders === replica.orders &&
    primary.qty === replica.qty;
  return {
    time: new Date().toISOString(),
    checkpoint,
    consistent,
    primary,
    replica,
  };
}
async function reset(
  docker,
  { stock = 10000000, runId, allowReset = false } = {},
) {
  if (
    !allowReset ||
    !/^p3-[a-z0-9-]{1,60}$/.test(runId || "") ||
    !Number.isSafeInteger(stock) ||
    stock < 1 ||
    stock > 10000000
  )
    throw new Error(
      "Explicit P3 reset authorization and valid run ID/stock required",
    );
  if (!readJson(path.join(docker.c.runtime, "control.json"), {}).paused)
    throw new Error("Pause controller before resetting P3 dataset");
  const release = lock(path.join(docker.c.runtime, "operation.lock"));
  try {
    await docker.preflight();
    await assertIsolation(docker);
    for (const backend of (await docker.list("backend")).filter(
      (c) => c.State.Running,
    )) {
      const metrics = await docker.probe(backend);
      if (
        metrics.active_requests ||
        [metrics.pools.primary, metrics.pools.replica]
          .filter(Boolean)
          .some((p) => p.waiting || p.total !== p.idle)
      )
        throw new Error("Backend still has active requests/transactions");
    }
    // The identity check is repeated inside the same DB transaction as the reset.
    await docker.sql(
      "db-primary",
      `BEGIN;
SELECT pg_advisory_xact_lock(337003);
DO $$ BEGIN
 IF current_database()<>'flashsale_p3' OR NOT EXISTS (SELECT 1 FROM p3_environment WHERE id='${docker.c.values.P3_ID}'::uuid AND project='flashsale-p3') THEN
  RAISE EXCEPTION 'Refusing reset outside marked P3 database';
 END IF;
END $$;
TRUNCATE orders,products,users RESTART IDENTITY;
INSERT INTO users(name) SELECT 'P3 User ' || g FROM generate_series(1,100) g;
INSERT INTO products(name,price,initial_stock,stock) VALUES
('P3 Hot Product',2999000,${stock},${stock}),('P3 Secondary',199000,${stock},${stock}),('P3 Third',499000,${stock},${stock});
COMMIT;
ANALYZE users; ANALYZE products; ANALYZE orders;`,
    );
    await waitReplay(docker);
    return verify(docker);
  } finally {
    release();
  }
}
module.exports = {
  assertIsolation,
  waitReplay,
  snapshot,
  verify,
  reset,
  jsonSQL,
};
