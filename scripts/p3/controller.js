"use strict";
const path = require("node:path");
const { loadConfig } = require("./config");
const { Docker } = require("./docker");
const { Routing } = require("./routing");
const { Collector } = require("./collector");
const { decide, afterAction } = require("./policy");
const { assertIsolation } = require("./dataset");
const { sleep, writeJson, readJson, append, lock } = require("./util");
const { observeTransition } = require("./transition-monitor");
function ordinal(container) {
  return Number(container.Config.Labels["com.docker.compose.container-number"]);
}
function backendAddress(container, c) {
  return {
    id: container.Id,
    ip: container.NetworkSettings.Networks[`${c.project}_p3`].IPAddress,
  };
}
function idle(metrics) {
  return (
    metrics.active_requests === 0 &&
    Object.values(metrics.pools)
      .filter(Boolean)
      .every((p) => p.waiting === 0 && p.total === p.idle)
  );
}
class Controller {
  constructor(c, docker = new Docker(c), routing = new Routing(docker)) {
    this.c = c;
    this.docker = docker;
    this.routing = routing;
    this.file = path.join(c.runtime, "state.json");
    this.state = readJson(this.file, {
      desired: c.min,
      failures: 0,
      policy: {},
    });
    this.collector = new Collector(c, docker);
  }
  event(type, detail = {}) {
    append(path.join(this.c.runtime, "scaling-events.ndjson"), {
      time: new Date().toISOString(),
      type,
      ...detail,
    });
  }
  save() {
    writeJson(this.file, this.state);
  }
  async eligible(containers, initial = false) {
    const result = await Promise.all(
      containers
        .filter((c) => c.State.Running)
        .map(async (container) => {
          try {
            const metrics = await this.docker.probe(container);
            if (metrics.draining) return null;
            // Existing routes survive shared DB outages. New members require readiness twice.
            if (this.routed?.some((b) => b.id === container.Id) && !initial)
              return backendAddress(container, this.c);
            if (!(await this.docker.probe(container, "/ready")).ready)
              return null;
            await sleep(250);
            if ((await this.docker.probe(container, "/ready")).ready)
              return backendAddress(container, this.c);
          } catch {
            /* Retry next reconciliation; never add an unready member. */
          }
          return null;
        }),
    );
    return result.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
  }
  async syncRouting(containers, force = false) {
    const eligible = await this.eligible(containers);
    if (!eligible.length)
      throw new Error(
        "No eligible backend; preserving last Nginx configuration",
      );
    const nginx = await this.routing.nginx();
    const active = await this.routing.generation(nginx.Id);
    const persisted = readJson(path.join(this.c.runtime, "routing.json"), {});
    const changed =
      JSON.stringify(eligible) !== JSON.stringify(this.routed) ||
      persisted.nginx !== nginx.Id ||
      active !== persisted.generation;
    if (changed || force) {
      await this.routing.apply(eligible);
      this.routed = eligible;
      this.event("routing", { count: eligible.length });
    }
  }
  async waitReady(target) {
    const deadline = Date.now() + this.c.readyTimeout;
    while (Date.now() < deadline) {
      const containers = await this.docker.list("backend");
      const ready = await this.eligible(containers, true);
      if (ready.length >= target) {
        await this.syncRouting(containers);
        return;
      }
      await sleep(1000);
    }
    throw new Error("Backend readiness timeout; original routes preserved");
  }
  async scaleIn(containers, target) {
    const candidate = [...containers].sort(
      (a, b) => ordinal(b) - ordinal(a),
    )[0];
    const original = this.routed;
    const remaining = original.filter((b) => b.id !== candidate.Id);
    if (remaining.length < target || remaining.length < this.c.min)
      throw new Error("Unsafe drain membership");
    // Intent precedes routing mutation; recovery re-adds the still-running victim if interrupted.
    this.state.pending = { action: "in", id: candidate.Id, target };
    this.save();
    let terminationStarted = false;
    try {
      if (this.cancelled?.())
        throw new Error("Scale-in interrupted before routing change");
      const transaction = await this.routing.apply(remaining);
      this.routed = remaining;
      const deadline = Date.now() + this.c.drainTimeout;
      let drained = false;
      while (Date.now() < deadline) {
        if (this.cancelled?.())
          throw new Error(
            "Scale-in interrupted; preserving backend and active transactions",
          );
        if (
          (await this.routing.workersGone(transaction)) &&
          idle(await this.docker.probe(candidate))
        ) {
          drained = true;
          break;
        }
        await sleep(500);
      }
      if (!drained) throw new Error("Drain timeout");
      if (this.cancelled?.())
        throw new Error("Scale-in interrupted before termination");
      terminationStarted = true;
      this.state.pending.phase = "terminating";
      this.save();
      await this.docker.removeBackend(candidate.Id);
      this.state.desired = target;
      this.state.pending = null;
    } catch (error) {
      const existing = await this.docker.list("backend");
      const restore = original.filter(
        (b) =>
          (!terminationStarted || b.id !== candidate.Id) &&
          existing.some((c) => c.Id === b.id && c.State.Running),
      );
      if (restore.length) {
        await this.routing.apply(restore);
        this.routed = restore;
      }
      if (!terminationStarted) this.state.pending = null;
      throw error;
    } finally {
      this.save();
    }
  }
  async recover() {
    await this.docker.preflight();
    await assertIsolation(this.docker);
    if (
      this.state.pending?.action === "in" &&
      this.state.pending.phase === "terminating"
    ) {
      const pending = this.state.pending;
      const end = Date.now() + (this.c.terminationTimeout ?? 100000);
      while (true) {
        const victim = (await this.docker.list("backend")).find(
          (c) => c.Id === pending.id,
        );
        if (!victim) break;
        if (!victim.State.Running) {
          await this.docker.removeExitedBackend(victim.Id);
          break;
        }
        if (Date.now() >= end)
          throw new Error(
            "Interrupted scale-in backend still terminating; preserved without SIGKILL",
          );
        await sleep(250);
      }
    }
    const containers = await this.docker.list("backend");
    const count = containers.filter((c) => c.State.Running).length;
    // Actual Engine membership is authoritative after a crash, including an interrupted scale-out.
    this.state.desired = Math.max(this.c.min, Math.min(this.c.max, count));
    if (count > this.c.max)
      throw new Error("Too many backends; refusing automatic deletion");
    this.state.pending = null;
    this.state.policy = {
      highSince: null,
      lowSince: null,
      cooldownUntil: Date.now() + this.c.outCooldown,
    };
    this.state.failures = 0;
    if (count < this.c.min) await this.docker.scaleOut(this.c.min);
    await this.waitReady(this.state.desired);
    this.save();
    this.event("recovered", { desired: this.state.desired });
  }
  async tick() {
    const control = readJson(path.join(this.c.runtime, "control.json"), {
      enabled: true,
    });
    if (control.paused || this.state.failures >= 3) return;
    if (this.state.pending?.phase === "terminating")
      throw new Error(
        "Pending graceful termination requires controller recovery; no forced removal",
      );
    let containers = await this.docker.list("backend");
    const running = containers.filter((c) => c.State.Running);
    if (containers.length > this.c.max)
      throw new Error("Unexpected membership above maximum");
    if (running.length > this.state.desired) {
      this.state.desired = running.length;
      this.state.pending = null;
      this.save();
    }
    if (running.length < this.state.desired) {
      await assertIsolation(this.docker);
      await this.docker.scaleOut(this.state.desired);
      await this.waitReady(this.state.desired);
      containers = await this.docker.list("backend");
    }
    // Reconcile additions, crashes, new IPs, and Nginx restarts independently of the scaling mode.
    await this.syncRouting(containers);
    if (control.resetToMin && containers.length > this.c.min) {
      await this.scaleIn(containers, containers.length - 1);
      return;
    }
    const snapshot = await this.collector.sample();
    snapshot.policy.enabled = control.enabled !== false;
    const decision = decide(
      this.state.policy,
      snapshot.policy,
      this.c,
      Date.now(),
    );
    this.state.policy = decision.state;
    this.event("decision", {
      action: decision.action,
      reason: decision.reason,
      cpu: snapshot.policy.cpu,
      count: snapshot.policy.count,
    });
    if (decision.action !== "hold") {
      await assertIsolation(this.docker);
      const current = (await this.docker.list("backend"))
        .filter((c) => c.State.Running)
        .map((c) => c.Id)
        .sort();
      if (
        Date.now() - snapshot.policy.time > this.c.stale ||
        JSON.stringify(current) !== JSON.stringify(snapshot.policy.backendIds)
      ) {
        this.state.policy = {};
        this.save();
        this.event("decision-discarded", {
          reason: "stale-or-membership-changed-before-action",
        });
        return;
      }
      this.event("scale-start", {
        source: "policy",
        direction: decision.action,
        target: decision.target,
      });
      await observeTransition(this.collector, this.c.interval, async () => {
      if (decision.action === "out") {
        this.state.pending = { action: "out", target: decision.target };
        this.save();
        await this.docker.scaleOut(decision.target);
        await this.waitReady(decision.target);
        this.state.desired = decision.target;
        this.state.pending = null;
      } else await this.scaleIn(containers, decision.target);
      }, (error) => {
        const failure = { time: new Date().toISOString(), error: error.message };
        append(path.join(this.collector.directory, "collector-errors.ndjson"), failure);
        this.event("monitoring-error", { message: error.message });
      });
      this.state.policy = afterAction(
        this.state.policy,
        decision.action,
        this.c,
        Date.now(),
      );
      this.event("scale-complete", {
        source: "policy",
        direction: decision.action,
        target: decision.target,
      });
    }
    this.state.failures = 0;
    this.save();
  }
  async run({ signal, onReady } = {}) {
    const release = lock(path.join(this.c.runtime, "controller.lock"));
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    this.cancelled = () => stopping || signal?.aborted;
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      await this.recover();
      onReady?.();
      while (!stopping && !signal?.aborted) {
        const start = Date.now();
        try {
          const releaseOperation = lock(
            path.join(this.c.runtime, "operation.lock"),
          );
          try {
            await this.tick();
          } finally {
            releaseOperation();
          }
        } catch (error) {
          if (error.code !== "P3_LOCKED") {
            this.state.failures++;
            this.state.policy = {};
            this.save();
            this.event("failure", {
              message: error.message,
              failures: this.state.failures,
            });
            console.error(error.message);
          }
        }
        if (this.state.failures >= 3) {
          this.event("degraded");
          throw new Error(
            "Controller degraded after three failures; fix cause and restart controller to reconcile",
          );
        }
        if (!stopping && !signal?.aborted)
          await sleep(Math.max(50, this.c.interval - (Date.now() - start)));
      }
    } finally {
      release();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}
if (require.main === module)
  new Controller(loadConfig()).run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { Controller, idle, backendAddress };
