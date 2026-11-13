#!/usr/bin/env node
/**
 * scripts/p5/cli.js — CLI untuk Pertemuan 5 (MinIO + CDN)
 *
 * Perintah:
 *   node scripts/p5/cli.js start          → mulai MinIO + CDN (docker-compose.p5.yml)
 *   node scripts/p5/cli.js stop           → hentikan service P5
 *   node scripts/p5/cli.js status         → cek status service P5
 *   node scripts/p5/cli.js upload         → seed gambar ke MinIO
 *   node scripts/p5/cli.js stress-before  → k6 test SEBELUM CDN (via backend)
 *   node scripts/p5/cli.js stress-after   → k6 test SETELAH CDN (via cdn-edge)
 */
"use strict";

const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

const ROOT    = path.join(__dirname, "..", "..");
const COMPOSE = path.join(ROOT, "docker-compose.p5.yml");
const K6_BIN  = process.env.K6_BIN || "k6";
const K6_TEST = path.join(ROOT, "tests", "load", "cdn-assets.js");

const cmd = process.argv[2] || "help";

function run(command, opts = {}) {
  console.log(`\n[p5] $ ${command}`);
  try {
    execSync(command, { stdio: "inherit", cwd: ROOT, ...opts });
  } catch (e) {
    if (!opts.ignoreError) process.exit(e.status || 1);
  }
}

function ensureResultsDir() {
  const d = path.join(ROOT, "results");
  if (!fs.existsSync(d)) fs.mkdirSync(d);
}

switch (cmd) {
  case "start":
    console.log("[p5] Memulai MinIO + CDN Edge...");
    run(`docker compose -f "${COMPOSE}" up -d --remove-orphans`);
    console.log("\n[p5] Service P5 berjalan:");
    console.log("  MinIO Console : http://127.0.0.1:9001  (minioadmin / minioadmin123)");
    console.log("  MinIO S3 API  : http://127.0.0.1:9000");
    console.log("  CDN Edge      : http://127.0.0.1:8081/assets/");
    break;

  case "stop":
    console.log("[p5] Menghentikan service P5...");
    run(`docker compose -f "${COMPOSE}" down`);
    break;

  case "status":
    run(`docker compose -f "${COMPOSE}" ps`);
    break;

  case "upload":
    console.log("[p5] Upload aset ke MinIO...");
    run(`node "${path.join(__dirname, "upload-assets.js")}"`);
    break;

  case "stress-before":
    ensureResultsDir();
    console.log("[p5] Stress test SEBELUM CDN (via Node.js express.static)...");
    run(`"${K6_BIN}" run -e SCENARIO=before_cdn -e VUS=100 -e DURATION=60s "${K6_TEST}"`);
    break;

  case "stress-after":
    ensureResultsDir();
    console.log("[p5] Stress test SETELAH CDN (via Nginx cache + MinIO)...");
    run(`"${K6_BIN}" run -e SCENARIO=after_cdn -e VUS=100 -e DURATION=60s "${K6_TEST}"`);
    break;

  case "stress-compare": {
    ensureResultsDir();
    console.log("[p5] ======== BEFORE CDN ========");
    run(`"${K6_BIN}" run -e SCENARIO=before_cdn -e VUS=100 -e DURATION=60s "${K6_TEST}"`, { ignoreError: true });
    console.log("\n[p5] Jeda 10 detik antara skenario...\n");
    run(`node -e "setTimeout(()=>{},10000)"`, { ignoreError: true });
    console.log("[p5] ======== AFTER CDN =========");
    run(`"${K6_BIN}" run -e SCENARIO=after_cdn -e VUS=100 -e DURATION=60s "${K6_TEST}"`, { ignoreError: true });
    console.log("\n[p5] Lihat hasil di: results/p5-before_cdn-summary.txt & results/p5-after_cdn-summary.txt");
    break;
  }

  default:
    console.log(`
Pertemuan 5 — CLI

  node scripts/p5/cli.js start          Mulai MinIO + CDN Edge
  node scripts/p5/cli.js stop           Hentikan service P5
  node scripts/p5/cli.js status         Status service P5
  node scripts/p5/cli.js upload         Upload gambar sample ke MinIO
  node scripts/p5/cli.js stress-before  k6 stress test SEBELUM CDN
  node scripts/p5/cli.js stress-after   k6 stress test SETELAH CDN
  node scripts/p5/cli.js stress-compare Jalankan keduanya berurutan
`);
}
