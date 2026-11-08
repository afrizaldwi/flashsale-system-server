"use strict";
// P4 has no P3 routing controller: explicitly activate its verified backend pool.
const { execFileSync } = require("node:child_process");
const { render } = require("../p3/routing");

function configureP4Ingress(
  run = (args, input) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      input,
      timeout: 30000,
      windowsHide: true,
    }),
) {
  const project = "flashsale-p4-dr";
  const ids = run([
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    "label=com.docker.compose.service=backend",
  ])
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length !== 2)
    throw new Error("P4 ingress requires exactly two running backends");
  const nginx = "flashsale-p4-dr-nginx-1";
  const containers = JSON.parse(run(["inspect", nginx, ...ids]));
  if (!Array.isArray(containers) || containers.length !== 3)
    throw new Error("Incomplete P4 ingress inspection");
  for (const [i, c] of containers.entries()) {
    const labels = c.Config?.Labels || {};
    if (
      labels["com.docker.compose.project"] !== project ||
      labels["flashsale.environment"] !== "p4-dr" ||
      labels["com.docker.compose.service"] !==
        (i === 0 ? "nginx" : "backend") ||
      !c.State?.Running ||
      c.State?.Health?.Status !== "healthy" ||
      !c.NetworkSettings?.Networks?.[project]?.IPAddress
    ) {
      throw new Error(
        "P4 ingress identity, health or network validation failed",
      );
    }
  }
  const backends = containers
    .slice(1)
    .map((c) => ({ ip: c.NetworkSettings.Networks[project].IPAddress }));
  const config = render(backends, "p4-dr");
  run(
    [
      "exec",
      "-i",
      nginx,
      "sh",
      "-c",
      "cat > /etc/nginx/p3/candidate.conf && nginx -t -c /etc/nginx/p3/candidate.conf",
    ],
    config,
  );
  try {
    run([
      "exec",
      nginx,
      "sh",
      "-c",
      "cp /etc/nginx/p3/active.conf /etc/nginx/p3/rollback.conf && cp /etc/nginx/p3/candidate.conf /etc/nginx/p3/active.conf && nginx -s reload -c /etc/nginx/p3/active.conf",
    ]);
  } catch (err) {
    run([
      "exec",
      nginx,
      "sh",
      "-c",
      "cp /etc/nginx/p3/rollback.conf /etc/nginx/p3/active.conf && nginx -s reload -c /etc/nginx/p3/active.conf",
    ]);
    throw err;
  }
  return { generation: "p4-dr", backends };
}

if (require.main === module)
  console.log(JSON.stringify(configureP4Ingress(), null, 2));
module.exports = { configureP4Ingress };
