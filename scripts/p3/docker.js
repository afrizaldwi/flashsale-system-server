"use strict";
const { execute, sleep } = require("./util");
class Docker {
  constructor(config, run = execute) {
    this.c = config;
    this.run = run;
  }
  command(args, options = {}) {
    return this.run("docker", args, { cwd: this.c.root, ...options });
  }
  compose(args, options = {}) {
    const env = { ...process.env };
    // Compose shell variables take precedence over --env-file; use only this P3 file's values.
    for (const key of Object.keys(env))
      if (key.startsWith("P3_") || key.startsWith("COMPOSE_")) delete env[key];
    return this.command(
      [
        "compose",
        "--project-name",
        this.c.project,
        "--env-file",
        this.c.envFile,
        "-f",
        "docker-compose.p3.yml",
        ...args,
      ],
      { ...options, env },
    );
  }
  assertContainer(container, service) {
    const labels = container.Config?.Labels || {};
    if (
      labels["com.docker.compose.project"] !== this.c.project ||
      labels["flashsale.environment"] !== "p3" ||
      (service && labels["com.docker.compose.service"] !== service) ||
      !container.NetworkSettings?.Networks?.[`${this.c.project}_p3`]
    )
      throw new Error("Refusing container outside isolated P3 project/network");
    const actualService = labels["com.docker.compose.service"];
    if (actualService === "backend" && this.c.quota !== undefined) {
      const env = Object.fromEntries(
        (container.Config.Env || []).map((value) => {
          const index = value.indexOf("=");
          return [value.slice(0, index), value.slice(index + 1)];
        }),
      );
      if (
        container.HostConfig?.NanoCpus !== Math.round(this.c.quota * 1e9) ||
        Number(env.DB_POOL_MAX) !== this.c.poolMax ||
        env.P3_ID !== this.c.values.P3_ID
      )
        throw new Error(
          "Running P3 backend quota/pool/identity differs from .env.p3; explicit P3-only replacement is required",
        );
    }
    if (actualService === "nginx" && this.c.port !== undefined) {
      const ports = container.HostConfig?.PortBindings?.["80/tcp"];
      if (
        ports?.length !== 1 ||
        ports[0].HostIp !== "127.0.0.1" ||
        Number(ports[0].HostPort) !== this.c.port
      )
        throw new Error(
          "Running P3 ingress differs from configured loopback port",
        );
    }
    return container;
  }
  async inspect(id, service) {
    if (!/^[a-f0-9]{12,64}$/.test(id))
      throw new Error("Expected immutable container ID");
    const [container] = JSON.parse(await this.command(["inspect", id]));
    return this.assertContainer(container, service);
  }
  async list(service) {
    const args = [
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${this.c.project}`,
    ];
    if (service)
      args.push("--filter", `label=com.docker.compose.service=${service}`);
    const ids = (await this.command(args)).split(/\s+/).filter(Boolean);
    if (!ids.length) return [];
    return JSON.parse(await this.command(["inspect", ...ids])).map((c) =>
      this.assertContainer(c, service),
    );
  }
  async preflight() {
    const model = JSON.parse(
      await this.compose(["config", "--format", "json"]),
    );
    if (
      model.name !== this.c.project ||
      Object.keys(model.services).sort().join() !==
        "backend,db-primary,db-replica,nginx"
    )
      throw new Error("Unexpected P3 Compose model");
    for (const [name, value] of Object.entries(model.services)) {
      if (value.container_name || (value.ports?.length && name !== "nginx"))
        throw new Error("Unexpected fixed name or host ports");
      if (
        name === "nginx" &&
        value.ports.some(
          (p) =>
            p.host_ip !== "127.0.0.1" || Number(p.published) !== this.c.port,
        )
      )
        throw new Error("P3 ingress must bind loopback only");
    }
    const volumes = JSON.parse(
      await this.command(["volume", "ls", "--format", "json"]).then(
        (s) => `[${s.split(/\r?\n/).filter(Boolean).join(",")}]`,
      ),
    );
    for (const suffix of ["primary", "replica"]) {
      const name = `${this.c.project}_${suffix}`;
      if (volumes.some((v) => v.Name === name)) {
        const [volume] = JSON.parse(
          await this.command(["volume", "inspect", name]),
        );
        if (
          volume.Labels?.["com.docker.compose.project"] !== this.c.project ||
          volume.Labels?.["flashsale.environment"] !== "p3"
        )
          throw new Error(`Foreign volume: ${name}`);
      }
      if (
        model.volumes[suffix]?.name !== name ||
        model.volumes[suffix]?.external
      )
        throw new Error("Unsafe volume mapping");
    }
    await this.list();
    return model;
  }
  async exec(id, service, args, options = {}) {
    await this.inspect(id, service);
    return this.command(["exec", "-i", id, ...args], options);
  }
  async probe(container, route = "/metrics") {
    return JSON.parse(
      await this.exec(
        container.Id,
        "backend",
        ["node", "scripts/p3/probe.js", route],
        { timeout: 8000 },
      ),
    );
  }
  async sql(service, sql) {
    const matches = (await this.list(service)).filter((c) => c.State.Running);
    if (matches.length !== 1)
      throw new Error(`Expected one running P3 ${service}`);
    return this.exec(
      matches[0].Id,
      service,
      [
        "sh",
        "-c",
        'export PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=3 PGOPTIONS="-c statement_timeout=10000"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -XAtq -v ON_ERROR_STOP=1',
      ],
      { input: sql, timeout: 20000 },
    );
  }
  async scaleOut(target) {
    if (!Number.isInteger(target) || target < this.c.min || target > this.c.max)
      throw new Error("Unsafe target");
    await this.preflight();
    if ((await this.list("backend")).length > target)
      throw new Error(
        "Refusing Compose shrink on scale-out; reconcile stopped/orphaned backends explicitly",
      );
    console.log(
      `[P3] Verified ${this.c.project}: backend-only scale to ${target}; --no-deps --no-recreate leaves PostgreSQL unchanged.`,
    );
    return this.compose(
      [
        "up",
        "-d",
        "--no-deps",
        "--no-recreate",
        "--no-build",
        "--scale",
        `backend=${target}`,
        "backend",
      ],
      { timeout: 120000 },
    );
  }
  async removeBackend(id) {
    await this.inspect(id, "backend");
    console.log(
      `[P3] Verified ${this.c.project}: gracefully stop and remove drained backend ${id.slice(0, 12)}; no volumes removed.`,
    );
    // Docker stop has a SIGKILL fallback. Send only SIGTERM; never escalate a live transaction.
    await this.command(["kill", "--signal", "SIGTERM", id]);
    const deadline = Date.now() + (this.c.terminationTimeout ?? 100000);
    let exited = false;
    while (Date.now() < deadline) {
      if (!(await this.inspect(id, "backend")).State.Running) {
        exited = true;
        break;
      }
      await sleep(250);
    }
    if (!exited)
      throw new Error(
        "Graceful termination timeout; backend left running, no SIGKILL or forced removal",
      );
    await this.removeExitedBackend(id);
  }
  async removeExitedBackend(id) {
    const container = await this.inspect(id, "backend");
    if (container.State.Running)
      throw new Error("Refusing removal of a running backend");
    console.log(
      `[P3] Verified ${this.c.project}: remove exited backend ${id.slice(0, 12)} without volumes.`,
    );
    await this.command(["rm", id]);
  }
}
module.exports = { Docker };
