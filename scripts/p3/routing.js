"use strict";
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { sleep, writeJson } = require("./util");
function render(backends, generation) {
  if (
    !/^[a-z0-9-]{1,64}$/.test(generation) ||
    !backends.length ||
    backends.length > 6
  )
    throw new Error("Invalid routing generation or empty/oversized upstream");
  const addresses = backends.map((b) => {
    if (
      !/^(\d{1,3}\.){3}\d{1,3}$/.test(b.ip) ||
      b.ip.split(".").some((n) => Number(n) > 255)
    )
      throw new Error("Invalid backend IPv4");
    return `    server ${b.ip}:3000 max_fails=2 fail_timeout=5s;`;
  });
  return `worker_processes 2;
pid /var/run/nginx.pid;
events { worker_connections 4096; }
http {
  log_format p3 escape=json '{"time":"$time_iso8601","status":$status,"request_time":$request_time,"upstream":"$upstream_addr","upstream_time":"$upstream_response_time","backend":"$upstream_http_x_backend_id"}';
  access_log /var/log/nginx/access.log p3;
  error_log /var/log/nginx/error.log warn;
  upstream api {
${addresses.join("\n")}
    keepalive 32;
  }
  server {
    listen 80;
    keepalive_timeout 5s;
    location = /nginx-health { access_log off; add_header Content-Type application/json; add_header X-Config-Version ${generation}; return 200 '{"generation":"${generation}"}'; }
    location / {
      proxy_pass http://api;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_connect_timeout 2s;
      proxy_read_timeout 60s;
      proxy_send_timeout 60s;
      proxy_buffering off;
      # Never replay checkout implicitly: ambiguous outcomes use explicit idempotent retry tests.
      proxy_next_upstream off;
    }
  }
}
`;
}
class Routing {
  constructor(docker) {
    this.docker = docker;
    this.c = docker.c;
  }
  async nginx() {
    const containers = (await this.docker.list("nginx")).filter(
      (c) => c.State.Running,
    );
    if (containers.length !== 1) throw new Error("Expected one P3 Nginx");
    return containers[0];
  }
  async workers(id) {
    const output = await this.docker.exec(id, "nginx", [
      "sh",
      "-c",
      "master=$(cat /var/run/nginx.pid); cat /proc/$master/task/$master/children",
    ]);
    return output.split(/\s+/).filter((p) => /^\d+$/.test(p));
  }
  async generation(id) {
    const output = await this.docker.exec(id, "nginx", [
      "wget",
      "-qO-",
      "http://127.0.0.1/nginx-health",
    ]);
    try {
      return JSON.parse(output).generation;
    } catch {
      return "bootstrap";
    }
  }
  async apply(backends) {
    const nginx = await this.nginx();
    const generation = randomUUID();
    const config = render(backends, generation);
    const workers = await this.workers(nginx.Id);
    console.log(
      `[P3] Verified ${this.c.project}: validate and reload Nginx ${nginx.Id.slice(0, 12)} with ${backends.length} ready backend(s).`,
    );
    await this.docker.exec(
      nginx.Id,
      "nginx",
      [
        "sh",
        "-c",
        "cat > /etc/nginx/p3/candidate.conf; nginx -t -c /etc/nginx/p3/candidate.conf",
      ],
      { input: config },
    );
    try {
      await this.docker.exec(nginx.Id, "nginx", [
        "sh",
        "-c",
        "cp /etc/nginx/p3/active.conf /etc/nginx/p3/rollback.conf && mv /etc/nginx/p3/candidate.conf /etc/nginx/p3/active.conf && nginx -s reload -c /etc/nginx/p3/active.conf",
      ]);
      let verified = false;
      for (let i = 0; i < 20; i++) {
        if ((await this.generation(nginx.Id)) === generation) {
          verified = true;
          break;
        }
        await sleep(250);
      }
      if (!verified) throw new Error("Nginx generation not activated");
    } catch (error) {
      await this.docker.exec(nginx.Id, "nginx", [
        "sh",
        "-c",
        "cp /etc/nginx/p3/rollback.conf /etc/nginx/p3/active.conf && nginx -t -c /etc/nginx/p3/active.conf && nginx -s reload -c /etc/nginx/p3/active.conf",
      ]);
      throw error;
    }
    const state = { generation, nginx: nginx.Id, backends, time: Date.now() };
    writeJson(path.join(this.c.runtime, "routing.json"), state);
    return { ...state, oldWorkers: workers };
  }
  async workersGone(transaction) {
    if (!transaction.oldWorkers.length) return true;
    const result = await this.docker.exec(transaction.nginx, "nginx", [
      "sh",
      "-c",
      'for p in "$@"; do if kill -0 "$p" 2>/dev/null; then echo alive; fi; done',
      "sh",
      ...transaction.oldWorkers,
    ]);
    return !result;
  }
}
module.exports = { render, Routing };
