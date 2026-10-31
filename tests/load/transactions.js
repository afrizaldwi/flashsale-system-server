// Explicit short correctness checks; use only the marked, reset P3 database.
import http from "k6/http";
import { check } from "k6";
const run = __ENV.P3_RUN_ID;
const base = __ENV.P3_BASE_URL;
if (
  !/^p3-[a-z0-9-]+$/.test(run || "") ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(base || "")
)
  throw new Error("P3 identity required");
const duplicate = __ENV.P3_TRANSACTION_TEST === "idempotency";
export const options = {
  scenarios: {
    transactions: {
      executor: "shared-iterations",
      vus: duplicate ? 20 : 100,
      iterations: duplicate ? 20 : 500,
      maxDuration: "30s",
    },
  },
  thresholds: { checks: ["rate==1"] },
};
export default function () {
  const key = duplicate ? `${run}-same` : `${run}-${__VU}-${__ITER}`;
  const response = http.post(
    `${base}/checkout`,
    JSON.stringify({ user_id: 1, product_id: 1, qty: 1 }),
    {
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      timeout: "15s",
    },
  );
  let body;
  try {
    body = response.json();
  } catch (_) {}
  check(response, {
    "transaction outcome": () =>
      duplicate
        ? [200, 201].includes(response.status) && !!body?.order?.id
        : response.status === 201 ||
          (response.status === 409 && body?.error === "SOLD_OUT"),
  });
}
