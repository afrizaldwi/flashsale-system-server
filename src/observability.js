"use strict";
const http = require("node:http");
const os = require("node:os");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const bounds = [
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  15000,
  Infinity,
];
function createObservability(poolStats) {
  const started = Date.now();
  const id = os.hostname();
  const routes = {};
  let active = 0,
    draining = false;
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  function middleware(req, res, next) {
    const start = process.hrtime.bigint();
    active++;
    res.setHeader("X-Backend-Id", id);
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      active--;
      const route =
        req.route?.path ||
        (req.path.startsWith("/orders/") ? "/orders/:id" : "other");
      const key = `${req.method} ${route} ${res.writableFinished ? res.statusCode : "aborted"}`;
      const value = (routes[key] ||= {
        count: 0,
        sum_ms: 0,
        buckets: bounds.map(() => 0),
      });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      value.count++;
      value.sum_ms += ms;
      value.buckets[bounds.findIndex((bound) => ms <= bound)]++;
    }
    res.once("finish", finish);
    res.once("close", finish);
    next();
  }
  function snapshot() {
    return {
      id,
      time: new Date().toISOString(),
      uptime_ms: Date.now() - started,
      draining,
      active_requests: active,
      routes,
      histogram_bounds_ms: bounds.map((b) => (b === Infinity ? null : b)),
      event_loop_p95_ms: delay.percentile(95) / 1e6,
      pools: poolStats(),
      memory: process.memoryUsage(),
    };
  }
  function listen(readiness, port = 3001) {
    const server = http.createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      try {
        if (req.url === "/live")
          return res.end(JSON.stringify({ live: true, draining }));
        if (req.url === "/metrics") return res.end(JSON.stringify(snapshot()));
        if (req.url === "/ready") {
          const state = await readiness();
          const ready = !draining && state.ready;
          res.statusCode = ready ? 200 : 503;
          return res.end(JSON.stringify({ ...state, ready, draining, id }));
        }
        res.statusCode = 404;
        res.end("{}");
      } catch (_error) {
        res.statusCode = 503;
        res.end(JSON.stringify({ ready: false }));
      }
    });
    return server.listen(port, "127.0.0.1");
  }
  return {
    middleware,
    snapshot,
    listen,
    drain: () => {
      draining = true;
    },
    close: () => delay.disable(),
  };
}
module.exports = { createObservability };
