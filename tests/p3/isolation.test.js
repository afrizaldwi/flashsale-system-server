"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Docker } = require("../../scripts/p3/docker");
const { assertIsolation, reset } = require("../../scripts/p3/dataset");
const c = {
  project: "flashsale-p3",
  root: ".",
  envFile: ".env.p3",
  min: 2,
  max: 6,
  poolMax: 10,
  values: { P3_ID: "11111111-1111-1111-1111-111111111111" },
};
test("Docker operations reject P2 labels, wrong service and wrong network", () => {
  const d = new Docker(c);
  const container = {
    Config: {
      Labels: {
        "com.docker.compose.project": "flashsale",
        "flashsale.environment": "p3",
        "com.docker.compose.service": "backend",
      },
    },
    NetworkSettings: { Networks: { "flashsale-p3_p3": {} } },
  };
  assert.throws(() => d.assertContainer(container, "backend"), /outside/);
  container.Config.Labels["com.docker.compose.project"] = "flashsale-p3";
  assert.equal(d.assertContainer(container, "backend"), container);
  assert.throws(() => d.assertContainer(container, "db-primary"), /outside/);
  container.NetworkSettings.Networks = {};
  assert.throws(() => d.assertContainer(container), /outside/);
});
test("scale-out command targets backend only and disables dependency recreation", async () => {
  const d = new Docker(c);
  d.preflight = async () => {};
  d.list = async () => [];
  let args;
  d.compose = async (a) => {
    args = a;
  };
  await d.scaleOut(3);
  assert.deepEqual(args, [
    "up",
    "-d",
    "--no-deps",
    "--no-recreate",
    "--no-build",
    "--scale",
    "backend=3",
    "backend",
  ]);
  await assert.rejects(() => d.scaleOut(7), /Unsafe/);
});
function databaseFake(change = {}) {
  return {
    c: {
      ...c,
      runtime: fs.mkdtempSync(path.join(os.tmpdir(), "p3-isolation-")),
    },
    list: async (service) => [
      {
        Mounts: [
          {
            Destination: "/var/lib/postgresql/data",
            Type: "volume",
            Name: `flashsale-p3_${service === "db-primary" ? "primary" : "replica"}`,
          },
        ],
      },
    ],
    sql: async (service) =>
      JSON.stringify({
        database: "flashsale_p3",
        identity: c.values.P3_ID,
        standby: service === "db-replica",
        max_connections: 100,
        ...change,
      }),
  };
}
test("database identity, role and pool budget are required", async () => {
  assert.equal(await assertIsolation(databaseFake()), true);
  for (const change of [
    { database: "flashsale" },
    { identity: "foreign" },
    { standby: true },
    { max_connections: 50 },
  ])
    await assert.rejects(() => assertIsolation(databaseFake(change)));
});
test("foreign volume is rejected before SQL access", async () => {
  const d = databaseFake();
  d.list = async () => [
    {
      Mounts: [
        {
          Destination: "/var/lib/postgresql/data",
          Type: "volume",
          Name: "flashsale-pgdata-primary",
        },
      ],
    },
  ];
  let queried = false;
  d.sql = async () => {
    queried = true;
  };
  await assert.rejects(() => assertIsolation(d), /foreign/);
  assert.equal(queried, false);
});
test("reset requires explicit flag, valid run identity and paused control", async () => {
  const d = databaseFake();
  await assert.rejects(() => reset(d), /authorization/);
  await assert.rejects(
    () => reset(d, { allowReset: true, runId: "p3-unit" }),
    /Pause/,
  );
});
