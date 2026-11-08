import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";
const unexpectedResponses = new Counter("unexpected_responses");

const base = __ENV.P4_BASE_URL || __ENV.P3_BASE_URL || "http://127.0.0.1:8080";
const runId = __ENV.P4_RUN_ID || `dr-${Date.now()}`;
const vus = Number(__ENV.P4_VUS || 100);
const duration = __ENV.P4_DURATION || "30s";

export const options = {
  scenarios: {
    dr_checkout: {
      executor: "constant-vus",
      vus,
      duration,
      gracefulStop: "5s",
    },
  },
  thresholds: {
    checks: ["rate==1"],
    unexpected_responses: ["count==0"],
  },
};

export function setup() {
  console.log(`[K6_HANDSHAKE] started vus=${vus} base=${base} runId=${runId}`);
  return { startedAt: new Date().toISOString(), vus, base, runId };
}

// Each VU stops writes after an outage candidate OR unexpected response, then
// remains alive so K6 can finish and export its threshold result normally.
let writesStopped = false;

export default function () {
  if (writesStopped) {
    sleep(0.1);
    return;
  }
  const iteration = exec.vu.iterationInScenario;
  const vuId = exec.vu.idInTest;
  const key = `${runId}-vu${vuId}-iter${iteration}`;
  const productId = Number(__ENV.P4_PRODUCT_ID || 1);
  const qty = 1;
  const userId = ((vuId + iteration) % 100) + 1;

  const payload = JSON.stringify({
    user_id: userId,
    product_id: productId,
    qty,
  });
  const requestTimestamp = new Date().toISOString();

  const response = http.post(`${base}/checkout`, payload, {
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    timeout: "10s",
  });

  let body = null;
  try {
    body = response.json();
  } catch (_) {}

  let outcome = "ERROR";
  let orderId = null;

  if (response.status === 201) {
    outcome = "CREATED";
    orderId = body?.order?.id || null;
  } else if (
    response.status === 200 &&
    (body?.result === "DUPLICATE" || body?.duplicate)
  ) {
    outcome = "DUPLICATE";
    orderId = body?.order?.id || null;
  } else if (
    response.status === 409 &&
    (body?.error === "SOLD_OUT" || body?.message === "Stok tidak mencukupi")
  ) {
    outcome = "SOLD_OUT";
  } else if (response.status >= 500 || response.status === 0) {
    outcome = "ERROR";
  }

  // K6 console logs may use stderr; the host runner consumes both pipes.
  console.log(
    `[LEDGER] ${JSON.stringify({
      idempotencyKey: key,
      timestamp: new Date().toISOString(),
      requestTimestamp,
      responseTimestamp: new Date().toISOString(),
      acknowledged: outcome === "CREATED" || outcome === "DUPLICATE",
      productId,
      userId,
      qty,
      status: response.status,
      outcome,
      orderId,
      errorCode: body?.error || null,
      failureKind: response.status === 0 ? "TRANSPORT_ERROR" : body?.error === "DB_UNAVAILABLE" ? "DB_UNAVAILABLE" : response.status >= 500 ? "HTTP_FAILURE" : null,
    })}`,
  );

  const businessResponse = response.status === 201 ||
    (response.status === 200 && outcome === "DUPLICATE") ||
    (response.status === 409 && outcome === "SOLD_OUT");
  // These are candidates: the host runner must also verify the injection
  // timeline. K6 exit zero by itself is never evidence of expected outage.
  const outageCandidate = __ENV.P4_STOP_AFTER_OUTAGE === "1" &&
    (response.status === 0 || (response.status === 503 && body?.error === "DB_UNAVAILABLE"));
  const accepted = businessResponse || outageCandidate;
  unexpectedResponses.add(accepted ? 0 : 1);
  check(response, { "business response or classified outage candidate": () => accepted });

  if (
    __ENV.P4_STOP_AFTER_OUTAGE === "1" &&
    (outageCandidate || !accepted)
  )
    writesStopped = true;

  sleep(0.05);
}
