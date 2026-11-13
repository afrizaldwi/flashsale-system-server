#!/usr/bin/env node
/**
 * scripts/p5/upload-assets.js
 * Seed sample product images ke MinIO bucket "flashsale"
 * Usage: node scripts/p5/upload-assets.js [--minio-url http://127.0.0.1:9000]
 */
"use strict";

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const { execSync } = require("child_process");

const MINIO_URL  = process.argv.includes("--minio-url")
  ? process.argv[process.argv.indexOf("--minio-url") + 1]
  : "http://127.0.0.1:9000";
const BUCKET     = "flashsale";
const ACCESS_KEY = "minioadmin";
const SECRET_KEY = "minioadmin123";

// ── Tiny S3-compatible PUT via pre-signed URL ────────────────────────────────
// Kita gunakan mc (MinIO Client) yang sudah ada di docker, atau fallback ke
// HTTP PUT langsung dengan anonymous bucket (policy: download).

const ASSETS_DIR = path.join(__dirname, "..", "..", "frontend", "images");

/** Buat direktori frontend/images jika belum ada */
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

// ── Generate placeholder SVG images untuk 5 produk ──────────────────────────
const PRODUCTS = [
  { id: 1, name: "Laptop Gaming RTX 4090", color: "#4f46e5" },
  { id: 2, name: "Smartphone Galaxy Ultra",  color: "#0891b2" },
  { id: 3, name: "Smart TV OLED 65\"",        color: "#059669" },
  { id: 4, name: "Headphone ANC Pro",         color: "#dc2626" },
  { id: 5, name: "Kamera Mirrorless 50MP",    color: "#d97706" },
];

function makeSvg(name, color) {
  const lines = name.split(" ").reduce((acc, word) => {
    const last = acc[acc.length - 1];
    if (last && last.length + word.length < 16) acc[acc.length - 1] += " " + word;
    else acc.push(word);
    return acc;
  }, []);
  const textY = 50 - (lines.length - 1) * 10;
  const tspans = lines.map((l, i) =>
    `<tspan x="50" dy="${i === 0 ? 0 : 20}">${l}</tspan>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <rect width="200" height="100" rx="8" fill="${color}"/>
  <rect x="10" y="10" width="180" height="80" rx="4" fill="rgba(255,255,255,0.15)"/>
  <text x="50" y="${textY}" font-family="Arial,sans-serif" font-size="11"
        font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">
    ${tspans}
  </text>
  <text x="150" y="50" font-family="Arial,sans-serif" font-size="30"
        fill="rgba(255,255,255,0.4)" text-anchor="middle" dominant-baseline="middle">🛒</text>
</svg>`;
}

// Simpan SVG ke frontend/images/
const files = [];
for (const p of PRODUCTS) {
  const filename = `product-${p.id}.svg`;
  const filepath  = path.join(ASSETS_DIR, filename);
  fs.writeFileSync(filepath, makeSvg(p.name, p.color), "utf8");
  files.push({ filename, filepath, contentType: "image/svg+xml" });
  console.log(`[p5] Generated ${filepath}`);
}

// ── Upload ke MinIO via mc CLI (jika tersedia) ───────────────────────────────
function tryMcUpload() {
  try {
    // Cek apakah mc ada di PATH atau di docker
    execSync("mc --version", { stdio: "ignore" });
    console.log("[p5] mc ditemukan, menggunakan mc untuk upload...");
    execSync(`mc alias set local ${MINIO_URL} ${ACCESS_KEY} ${SECRET_KEY}`, { stdio: "inherit" });
    execSync(`mc mb --ignore-existing local/${BUCKET}`, { stdio: "inherit" });
    execSync(`mc anonymous set download local/${BUCKET}`, { stdio: "inherit" });
    for (const f of files) {
      execSync(`mc cp "${f.filepath}" local/${BUCKET}/products/${f.filename}`, { stdio: "inherit" });
      console.log(`[p5] Uploaded via mc: ${f.filename}`);
    }
    return true;
  } catch {
    return false;
  }
}

// ── Upload via HTTP PUT (anonymous bucket) ───────────────────────────────────
function putObject(url, filepath, contentType) {
  return new Promise((resolve, reject) => {
    const data = fs.readFileSync(filepath);
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request({
      method: "PUT",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname,
      headers: {
        "Content-Type": contentType,
        "Content-Length": data.length,
      },
    }, (res) => {
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.statusCode);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function httpUpload() {
  console.log(`[p5] Upload via HTTP PUT ke ${MINIO_URL}/${BUCKET}/...`);
  for (const f of files) {
    const url = `${MINIO_URL}/${BUCKET}/products/${f.filename}`;
    try {
      await putObject(url, f.filepath, f.contentType);
      console.log(`[p5] ✓ Uploaded: ${f.filename} → ${url}`);
    } catch (err) {
      console.error(`[p5] ✗ Gagal upload ${f.filename}: ${err.message}`);
    }
  }
}

async function main() {
  if (!tryMcUpload()) {
    await httpUpload();
  }

  console.log("\n[p5] Asset URLs (via CDN Edge http://127.0.0.1:8081):");
  for (const f of files) {
    console.log(`  http://127.0.0.1:8081/assets/products/${f.filename}`);
  }
  console.log("\n[p5] Asset URLs (via MinIO langsung http://127.0.0.1:9000):");
  for (const f of files) {
    console.log(`  http://127.0.0.1:9000/${BUCKET}/products/${f.filename}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

