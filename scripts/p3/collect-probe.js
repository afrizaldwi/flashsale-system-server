// Sent on stdin to `node -` inside existing P3 containers. No image rebuild needed.
const http = require("node:http"),
  fs = require("node:fs");
function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: 3001, path, timeout: 2200 },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("probe timeout")));
  });
}
function read(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
Promise.all([get("/metrics"), get("/ready")])
  .then(([metrics, ready]) => {
    console.log(
      JSON.stringify({
        metrics: metrics.body,
        ready: ready.status === 200 && ready.body.ready === true,
        vm: {
          stat: read("/proc/stat"),
          meminfo: read("/proc/meminfo"),
          pressure: {
            cpu: read("/proc/pressure/cpu"),
            memory: read("/proc/pressure/memory"),
            io: read("/proc/pressure/io"),
          },
        },
        cgroup: {
          cpu: read("/sys/fs/cgroup/cpu.stat"),
          cpu_max: read("/sys/fs/cgroup/cpu.max"),
          memory_events: read("/sys/fs/cgroup/memory.events"),
        },
      }),
    );
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
