"use strict";
// Invoked inside a backend container; never exposes management on the host.
const http = require("node:http");
const path = process.argv[2] || "/metrics";
if (!["/live", "/ready", "/metrics"].includes(path))
  throw new Error("Unknown probe");
http
  .get({ host: "127.0.0.1", port: 3001, path, timeout: 3000 }, (res) => {
    res.pipe(process.stdout);
    res.on("end", () => {
      if (res.statusCode !== 200) process.exitCode = 1;
    });
  })
  .on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .on("timeout", function () {
    this.destroy(new Error("Management probe timeout"));
  });
