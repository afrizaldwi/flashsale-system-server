/**
 * tests/load/cdn-assets.js  — k6 stress test untuk Pertemuan 5
 *
 * Skenario 1 (before_cdn): Aset statis diambil langsung dari backend Node.js
 *   URL: http://127.0.0.1:8080/images/products/product-1.svg  (via express.static)
 *
 * Skenario 2 (after_cdn): Aset statis diambil dari CDN Edge (Nginx + cache MinIO)
 *   URL: http://127.0.0.1:8081/assets/products/product-1.svg
 *
 * Jalankan:
 *   k6 run tests/load/cdn-assets.js -e SCENARIO=before_cdn
 *   k6 run tests/load/cdn-assets.js -e SCENARIO=after_cdn
 *
 * Atau via npm:
 *   npm run p5:stress-before
 *   npm run p5:stress-after
 */
import http from "k6/http";
import { sleep, check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// ── Konfigurasi ─────────────────────────────────────────────────────────────
const SCENARIO   = __ENV.SCENARIO   || "after_cdn";   // before_cdn | after_cdn
const VUS        = Number(__ENV.VUS || 100);
const DURATION   = __ENV.DURATION   || "60s";

const BACKEND_BASE = __ENV.BACKEND_BASE || "http://127.0.0.1:8080";
const CDN_BASE     = __ENV.CDN_BASE     || "http://127.0.0.1:8081";

const PRODUCTS = [1, 2, 3, 4, 5];

// URL berdasarkan skenario
function assetUrl(productId) {
  if (SCENARIO === "before_cdn") {
    // Backend Node.js melayani file dari frontend/images/
    return `${BACKEND_BASE}/images/products/product-${productId}.svg`;
  } else {
    // CDN Edge (Nginx cache → MinIO)
    return `${CDN_BASE}/assets/products/product-${productId}.svg`;
  }
}

// ── Metrics kustom ───────────────────────────────────────────────────────────
const hits        = new Counter("asset_requests_total");
const cacheHits   = new Counter("cdn_cache_hits");
const cacheMisses = new Counter("cdn_cache_misses");
const errors      = new Rate("asset_error_rate");
const duration_ms = new Trend("asset_response_time_ms", true);

// ── k6 options ───────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    asset_load: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      gracefulStop: "10s",
    },
  },
  thresholds: {
    asset_error_rate:        ["rate<0.01"],   // error < 1%
    asset_response_time_ms:  ["p(95)<500"],   // p95 < 500ms
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

// ── VU function ──────────────────────────────────────────────────────────────
export default function () {
  const productId = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
  const url       = assetUrl(productId);

  const res = http.get(url, {
    tags:    { scenario: SCENARIO, asset: `product-${productId}` },
    timeout: "5s",
  });

  const ok = check(res, {
    "status 200":       (r) => r.status === 200,
    "content SVG/img":  (r) => r.status === 200 && r.body.length > 100,
  });

  hits.add(1);
  errors.add(!ok ? 1 : 0);
  if (res.status === 200) duration_ms.add(res.timings.duration);

  // Hitung cache hit dari header X-Cache-Status (hanya berlaku untuk CDN scenario)
  if (SCENARIO === "after_cdn") {
    const cacheHeader = (res.headers["X-Cache-Status"] || "").toUpperCase();
    if (cacheHeader === "HIT")  cacheHits.add(1);
    else                         cacheMisses.add(1);
  }

  sleep(0.1 + Math.random() * 0.2); // think time 100–300ms
}

export function handleSummary(data) {
  const rps     = data.metrics.asset_requests_total?.values?.count /
                  (data.state.testRunDurationMs / 1000) || 0;
  const p95     = data.metrics.asset_response_time_ms?.values?.["p(95)"] || 0;
  const avg     = data.metrics.asset_response_time_ms?.values?.avg || 0;
  const errRate = (data.metrics.asset_error_rate?.values?.rate || 0) * 100;
  const chits   = data.metrics.cdn_cache_hits?.values?.count   || 0;
  const cmisses = data.metrics.cdn_cache_misses?.values?.count || 0;
  const hitRate = chits + cmisses > 0
    ? ((chits / (chits + cmisses)) * 100).toFixed(1)
    : "N/A";

  const label = SCENARIO === "before_cdn" ? "SEBELUM CDN (Node.js static)" : "SETELAH CDN (Nginx+MinIO)";

  const report = `
========================================================
  Laporan Stress Test Aset Statis — ${label}
========================================================
  Skenario  : ${SCENARIO}
  VUs       : ${VUS}
  Durasi    : ${DURATION}
--------------------------------------------------------
  Throughput       : ${rps.toFixed(1)} req/s
  Avg Response     : ${avg.toFixed(1)} ms
  p(95) Response   : ${p95.toFixed(1)} ms
  Error Rate       : ${errRate.toFixed(2)} %
${SCENARIO === "after_cdn" ? `  Cache Hit Rate   : ${hitRate} %
  Cache Hits       : ${chits}
  Cache Misses     : ${cmisses}` : ""}
========================================================
`;

  console.log(report);

  return {
    stdout: report,
    [`results/p5-${SCENARIO}-summary.txt`]: report,
  };
}
