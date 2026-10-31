// Long lifecycle verification is explicit and is never part of a smoke run.
import http from "k6/http";
import { sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import exec from "k6/execution";
const attempts = new Counter("measured_attempts");
const successes = new Counter("successful_requests");
const errors = new Rate("infrastructure_error");
const invalid = new Rate("validation_error");
const latency = new Trend("measured_duration", true);
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(__ENV.P3_BASE_URL || ""))
  throw new Error("Local P3 ingress required");
const lowSeconds = Number(__ENV.P3_LIFECYCLE_LOW_SECONDS);
if (!Number.isSafeInteger(lowSeconds) || lowSeconds <= 0)
  throw new Error(
    "Use the P3 runner to calculate P3_LIFECYCLE_LOW_SECONDS from the active policy",
  );
export const options = {
  scenarios: {
    lifecycle: {
      executor: "ramping-vus",
      startVUs: 10,
      stages: [
        { duration: "60s", target: 10 },
        { duration: "30s", target: 1000 },
        { duration: "300s", target: 1000 },
        { duration: "30s", target: 10 },
        { duration: `${lowSeconds}s`, target: 10 },
      ],
      gracefulStop: "30s",
    },
  },
};
export default function () {
  const response = http.get(`${__ENV.P3_BASE_URL}/products`, {
    timeout: "15s",
    tags: { name: "GET /products", phase: "measure" },
  });
  if (exec.instance.currentTestRunDuration > (420 + lowSeconds) * 1000) return;
  const tags = { phase: "measure", endpoint: "products", outcome: response.status === 200 ? "success" : "error" };
  attempts.add(1, tags);
  successes.add(response.status === 200 ? 1 : 0, tags);
  errors.add(response.status === 0 || response.status >= 500, tags);
  invalid.add(response.status !== 200 && response.status > 0 && response.status < 500, tags);
  latency.add(response.timings.duration, tags);
  sleep(0.1);
}

export function handleSummary(data) { return { [__ENV.P3_SUMMARY || "k6-summary.json"]: JSON.stringify(data, null, 2) }; }
