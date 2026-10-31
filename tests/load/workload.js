import http from "k6/http";
import { sleep, check } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";

const base = __ENV.P3_BASE_URL || "http://127.0.0.1:8080";
const runId = __ENV.P3_RUN_ID;
const workload = __ENV.P3_WORKLOAD || "read";
const profile = __ENV.P3_PROFILE || "final";
const vus = Number(__ENV.P3_VUS || 10);
const calibrationSeconds = Number(__ENV.P3_CALIBRATION_SECONDS || 120);
if (
  ["calibration", "stress"].includes(profile) &&
  (workload !== "read" ||
    vus < 1 ||
    vus > (profile === "stress" ? 1000 : 100) ||
    !Number.isInteger(calibrationSeconds) ||
    calibrationSeconds < 30 ||
    calibrationSeconds > 180)
)
  throw new Error(
    "Bounded read-only calibration requires 1–100 VU and 30–180 seconds",
  );
if (
  !/^p3-[a-z0-9-]{1,60}$/.test(runId || "") ||
  !["read", "write", "mixed"].includes(workload)
)
  throw new Error("Invalid run identity/workload");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
  throw new Error("P3 ingress must be local Nginx");
const timing =
  ["calibration", "stress"].includes(profile)
    ? [0, 0, 0, calibrationSeconds, 0]
    : profile === "smoke"
      ? [0, 0, 0, 5, 0]
      : profile === "pilot"
        ? [10, 10, 10, 30, 10]
        : [30, 30, 30, 180, 30];
const start = timing.slice(0, 3).reduce((a, b) => a + b, 0) * 1000;
const end = start + timing[3] * 1000;
export const options = {
  scenarios: {
    workload:
      profile === "smoke" || ["calibration", "stress"].includes(profile)
        ? {
            executor: "constant-vus",
            vus,
            duration: `${timing[3]}s`,
            gracefulStop: "30s",
          }
        : {
            executor: "ramping-vus",
            startVUs: Math.min(10, vus),
            gracefulRampDown: "30s",
            gracefulStop: "30s",
            stages: [
              { duration: `${timing[0]}s`, target: Math.min(10, vus) },
              { duration: `${timing[1]}s`, target: vus },
              { duration: `${timing[2]}s`, target: vus },
              { duration: `${timing[3]}s`, target: vus },
              { duration: `${timing[4]}s`, target: 0 },
            ],
          },
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(95)"],
  thresholds: { "validation_error{phase:measure}": ["rate==0"] },
};
const attempts = new Counter("measured_attempts");
const successes = new Counter("successful_requests");
const checkoutSuccess = new Counter("checkout_created");
const allCreated = new Counter("checkout_created_all");
const allAttempts = new Counter("checkout_attempts_all");
const infra = new Rate("infrastructure_error");
const invalid = new Rate("validation_error");
const soldout = new Rate("business_sold_out");
const latency = new Trend("measured_duration", true);
const waiting = new Trend("measured_ttfb", true);
const http5xx = new Counter("http_5xx_count");
const timeouts = new Counter("timeout_count");
const connectionErrors = new Counter("connection_error_count");
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export default function () {
  const iteration = exec.vu.iterationInScenario;
  const offset = exec.vu.idInTest + iteration;
  const write =
    workload === "write" || (workload === "mixed" && offset % 5 === 0);
  const phase =
    exec.instance.currentTestRunDuration >= start &&
    exec.instance.currentTestRunDuration < end
      ? "measure"
      : "transition";
  const endpoint = write ? "checkout" : "products";
  const tags = { phase, endpoint };
  const key = `${runId}-${exec.vu.idInTest}-${iteration}`;
  const product = offset % 100 < 80 ? 1 : offset % 100 < 95 ? 2 : 3;
  const response = write
    ? http.post(
        `${base}/checkout`,
        JSON.stringify({
          user_id: (offset % 100) + 1,
          product_id: product,
          qty: 1,
        }),
        {
          timeout: "15s",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          tags: { ...tags, name: "POST /checkout" },
        },
      )
    : http.get(`${base}/products`, {
        timeout: "15s",
        tags: { ...tags, name: "GET /products" },
      });
  let body;
  try {
    body = response.json();
  } catch (_) {
    body = null;
  }
  const exhausted =
    write && response.status === 409 && body?.error === "SOLD_OUT";
  const ok = write
    ? response.status === 201 && body?.result === "CREATED" && !!body?.order?.id
    : response.status === 200 && Array.isArray(body) && body.length === 3;
  const infrastructure = response.status === 0 || response.status >= 500;
  const outcome = ok
    ? "success"
    : exhausted
      ? "sold_out"
      : infrastructure
        ? "infrastructure_error"
        : "unexpected";
  const resultTags = { ...tags, outcome };
  invalid.add(!ok && !exhausted && !infrastructure, tags);
  check(
    response,
    {
      "valid business or infrastructure outcome": () =>
        ok || exhausted || infrastructure,
    },
    tags,
  );
  infra.add(infrastructure, tags);
  soldout.add(exhausted, tags);
  allCreated.add(write && ok ? 1 : 0, tags);
  allAttempts.add(write ? 1 : 0, tags);
  if (phase === "measure") {
    attempts.add(1, tags);
    successes.add(ok ? 1 : 0, tags);
    checkoutSuccess.add(write && ok ? 1 : 0, tags);
    http5xx.add(response.status >= 500 ? 1 : 0, tags);
    timeouts.add(response.error_code === 1050 ? 1 : 0, tags);
    connectionErrors.add(
      response.status === 0 && response.error_code !== 1050 ? 1 : 0,
      tags,
    );
    latency.add(response.timings.duration, resultTags);
    waiting.add(response.timings.waiting, resultTags);
  }
  if (write && infrastructure)
    console.warn(
      JSON.stringify({
        type: "ambiguous_checkout",
        key,
        status: response.status,
        error_code: response.error_code,
      }),
    );
  sleep(0.1);
}
export function handleSummary(data) {
  return {
    [__ENV.P3_SUMMARY || "k6-summary.json"]: JSON.stringify(data, null, 2),
  };
}
