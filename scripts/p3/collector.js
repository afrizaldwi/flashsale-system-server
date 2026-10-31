"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { append, csvRow, sleep, execute, readJson } = require("./util");
const {
  procSnapshot,
  cpuDelta,
  processRates,
  quality,
} = require("./resources");
const probe = fs.readFileSync(path.join(__dirname, "collect-probe.js"), "utf8");
const DB_QUERY = `BEGIN READ ONLY;
SELECT json_build_object('standby',pg_is_in_recovery(),'connections',(SELECT COUNT(*) FROM pg_stat_activity),
 'active',(SELECT COUNT(*) FROM pg_stat_activity WHERE state='active'),
 'lock_waiters',(SELECT COUNT(*) FROM pg_stat_activity WHERE wait_event_type='Lock'),
 'long_transactions',(SELECT COUNT(*) FROM pg_stat_activity WHERE xact_start < now()-interval '10 seconds'),
 'max_connections',current_setting('max_connections')::int,
 'streaming',(SELECT COUNT(*) FROM pg_stat_replication WHERE state='streaming'),
 'replay_lsn',pg_last_wal_replay_lsn()::text,
 'lag_bytes',CASE WHEN pg_is_in_recovery() THEN pg_wal_lsn_diff(pg_last_wal_receive_lsn(),pg_last_wal_replay_lsn()) ELSE NULL END);
COMMIT;`;
function cpuTimes() {
  return os.cpus().reduce(
    (a, c) => ({
      idle: a.idle + c.times.idle,
      total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0),
    }),
    { idle: 0, total: 0 },
  );
}
function percentage(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}
class Collector {
  constructor(c, docker, directory = c.runtime) {
    this.c = c;
    this.docker = docker;
    this.directory = directory;
    this.previous = cpuTimes();
    this.processPrevious = [];
    this.processTime = 0;
    this.busy = false;
  }
  // Only read-only collection uses the already validated inventory. Mutations still re-inspect.
  readExec(container, args, options = {}) {
    this.docker.assertContainer(container);
    return this.docker.command(["exec", "-i", container.Id, ...args], {
      timeout: this.c.collectBudget ?? 4000,
      ...options,
    });
  }
  async database(container) {
    if (!container) throw new Error("Database missing");
    return JSON.parse(
      await this.readExec(
        container,
        [
          "sh",
          "-c",
          'export PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=2 PGOPTIONS="-c statement_timeout=2000"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -XAtq -v ON_ERROR_STOP=1',
        ],
        { input: DB_QUERY },
      ),
    );
  }
  async sample() {
    if (this.busy) throw new Error("Collector sample already in progress");
    this.busy = true;
    try {
      return await this.collect();
    } finally {
      this.busy = false;
    }
  }
  async collect() {
    const started = Date.now(),
      budget = this.c.collectBudget ?? 4000;
    const containers = (await this.docker.list()).filter(
      (c) => c.State.Running,
    );
    if (!containers.length) throw new Error("No P3 containers");
    const backendsExpected = containers.filter(
      (c) => c.Config.Labels["com.docker.compose.service"] === "backend",
    );
    const tasks = {
      stats: this.docker.command(
        [
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          ...containers.map((c) => c.Id),
        ],
        { timeout: budget },
      ),
      backend: Promise.allSettled(
        backendsExpected.map(async (c) => ({
          id: c.Id,
          ...JSON.parse(
            await this.readExec(c, ["node", "-"], { input: probe }),
          ),
        })),
      ),
      primary: this.database(
        containers.find(
          (c) => c.Config.Labels["com.docker.compose.service"] === "db-primary",
        ),
      ),
      replica: this.database(
        containers.find(
          (c) => c.Config.Labels["com.docker.compose.service"] === "db-replica",
        ),
      ),
      // Invoke trusted local source on stdin; no machine/user execution-policy change.
      processes:
        process.platform === "win32"
          ? execute(
              "powershell.exe",
              ["-NoProfile", "-NonInteractive", "-Command", "-"],
              {
                input: `& {\n${fs.readFileSync(path.join(__dirname, "host-metrics.ps1"), "utf8")}\n} -GeneratorPid ${this.generatorPid || 0}\n\n`,
                timeout: budget,
              },
            ).then(JSON.parse)
          : Promise.resolve({ k6: [], unsupported: true }),
      engine: this.engineInfo
        ? Promise.resolve(this.engineInfo)
        : this.docker
            .command(["info", "--format", "{{json .}}"], { timeout: budget })
            .then(JSON.parse),
    };
    const names = Object.keys(tasks),
      settled = await Promise.allSettled(Object.values(tasks)),
      result = {},
      errors = {};
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") result[names[i]] = r.value;
      else errors[names[i]] = r.reason.message;
    });
    const after = (await this.docker.list()).filter((c) => c.State.Running);
    const backend = (result.backend || [])
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);
    const rows = (result.stats || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map(JSON.parse);
    const usage = rows.map((row) => {
      const id = row.ID || row.Container;
      const c = containers.find(
        (c) => (id && c.Id.startsWith(id)) || c.Name.slice(1) === row.Name,
      );
      return {
        id: c?.Id,
        service: c?.Config.Labels["com.docker.compose.service"],
        cpu_percent: percentage(row.CPUPerc),
        memory_percent: percentage(row.MemPerc),
        memory: row.MemUsage,
        block_io: row.BlockIO,
        net_io: row.NetIO,
      };
    });
    const now = Date.now(),
      current = cpuTimes(),
      windowsCpu = cpuDelta(this.previous, current);
    this.previous = current;
    const vm = procSnapshot(backend[0]?.vm),
      vmCpu = cpuDelta(this.previousVm, vm);
    const baselineGap = this.previousVmAt ? now - this.previousVmAt : null;
    this.previousVm = vm;
    this.previousVmAt = now;
    if (result.engine)
      this.engineInfo = {
        NCPU: result.engine.NCPU,
        MemTotal: result.engine.MemTotal,
        OperatingSystem: result.engine.OperatingSystem,
      };
    const processes = result.processes?.k6 || [],
      rates = processRates(
        this.processPrevious,
        processes,
        now - this.processTime,
        os.cpus().length,
      );
    this.processPrevious = processes;
    this.processTime = now;
    const windows = {
      source:
        process.platform === "win32"
          ? "Windows os.cpus/os memory"
          : "native host os.cpus/os memory",
      cpu_percent: windowsCpu,
      memory_percent: 100 * (1 - os.freemem() / os.totalmem()),
      total_bytes: os.totalmem(),
      free_bytes: os.freemem(),
      logical_cpus: os.cpus().length,
    };
    const dockerVm = {
      source:
        "Docker Linux VM /proc (shared kernel, not Windows host or all WSL distros)",
      ...vm,
      cpu_percent: vmCpu,
      engine_limits: this.engineInfo || null,
    };
    const generator = {
      source: this.generatorPid ? "tracked k6 PID" : "all local k6 processes",
      pid: this.generatorPid || null,
      processes: rates,
      available: !errors.processes && process.platform === "win32",
      running: rates.length > 0,
      error: errors.processes || null,
    };
    const host = {
      ...windows,
      collector: { ...process.memoryUsage(), cpu: process.cpuUsage() },
      k6: rates,
    };
    const database = {
      "db-primary": result.primary || { error: errors.primary },
      "db-replica": result.replica || { error: errors.replica },
    };
    const databaseHealthy =
      database["db-primary"].standby === false &&
      database["db-primary"].streaming > 0 &&
      database["db-replica"].standby === true;
    const health = quality({
      containers,
      after,
      usage,
      backends: backend,
      duration: now - started,
      budget,
      windowsCpu,
      vmCpu,
    });
    for (const key of Object.keys(errors))
      health.reasons.push(`source-failed:${key}`);
    if (!vm || !this.engineInfo)
      health.reasons.push("docker-vm-resource-data-missing");
    if (baselineGap !== null && baselineGap > this.c.stale)
      health.reasons.push("resource-baseline-gap");
    for (const b of backend) {
      const age = now - Date.parse(b.metrics.time);
      if (!Number.isFinite(age) || age < 0 || age > budget)
        health.reasons.push("backend-metrics-stale");
    }
    health.valid = health.reasons.length === 0;
    const cpuUsage = usage.filter((r) => r.service === "backend");
    const cpu = cpuUsage.length
      ? cpuUsage.reduce((s, r) => s + (r.cpu_percent ?? 0), 0) /
        cpuUsage.length /
        this.c.quota
      : null;
    const state = readJson(path.join(this.c.runtime, "state.json"), {}),
      routing = readJson(path.join(this.c.runtime, "routing.json"), {});
    const replicas = {
      desired: state.desired ?? null,
      running: backendsExpected.length,
      ready: backend.filter((b) => b.ready).length,
      routed: routing.backends?.length ?? 0,
      generation: routing.generation ?? null,
    };
    const sample = {
      schema: 2,
      time: new Date(now).toISOString(),
      started_at: new Date(started).toISOString(),
      duration_ms: now - started,
      quality: health,
      containers: usage,
      backends: backend,
      database,
      host,
      replicas,
      resources: {
        windows_host: windows,
        docker_vm: dockerVm,
        k6_generator: generator,
        wsl_process_proxies: result.processes?.wsl_process_proxies || [],
      },
      policy: {
        time: started,
        valid: health.valid,
        databaseHealthy,
        cpu,
        count: backendsExpected.length,
        poolWaiting: backend.some((b) =>
          Object.values(b.metrics.pools)
            .filter(Boolean)
            .some((p) => p.waiting),
        ),
        hostCpu:
          Number.isFinite(windowsCpu) && Number.isFinite(vmCpu)
            ? Math.max(windowsCpu, vmCpu)
            : null,
        hostMemory: vm
          ? Math.max(windows.memory_percent, vm.memory_percent)
          : null,
        backendIds: backendsExpected.map((c) => c.Id).sort(),
      },
    };
    append(path.join(this.directory, "metrics.ndjson"), sample);
    const csv = path.join(this.directory, "resources-v2.csv");
    fs.mkdirSync(this.directory, { recursive: true });
    if (!fs.existsSync(csv))
      fs.writeFileSync(
        csv,
        csvRow([
          "time",
          "duration_ms",
          "replicas",
          "backend_cpu_quota_percent",
          "windows_cpu_percent",
          "docker_vm_cpu_percent",
          "windows_memory_percent",
          "docker_vm_memory_percent",
          "generator_cpu_cores",
          "valid",
          "reasons",
        ]),
      );
    fs.appendFileSync(
      csv,
      csvRow([
        sample.time,
        sample.duration_ms,
        replicas.running,
        cpu,
        windowsCpu,
        vmCpu,
        windows.memory_percent,
        vm?.memory_percent,
        rates.some((p) => p.cpu_cores !== null)
          ? rates.reduce((s, p) => s + (p.cpu_cores || 0), 0)
          : null,
        health.valid,
        health.reasons.join(";"),
      ]),
    );
    return sample;
  }
  async run(signal) {
    while (!signal.aborted) {
      const start = Date.now();
      try {
        await this.sample();
      } catch (error) {
        append(path.join(this.directory, "collector-errors.ndjson"), {
          time: new Date().toISOString(),
          error: error.message,
        });
      }
      if (!signal.aborted)
        await sleep(Math.max(250, this.c.interval - (Date.now() - start)));
    }
  }
}
module.exports = { Collector, percentage };
