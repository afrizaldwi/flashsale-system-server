"use strict";
const fs = require("node:fs");
function storagePlan(vus, seconds) {
  // Conservative raw estimate: observed ~452 MB / 120s / 100 VU, doubled.
  const estimated = Math.ceil(80000 * vus * seconds);
  return { estimated_raw_bytes: estimated, required_free_bytes: estimated + 2 * 1024 ** 3,
    raw_format: "lossless gzip", estimate_is_guarantee: false };
}
function checkStorage(directory, plan) {
  if (!fs.statfsSync) throw new Error("Disk preflight requires Node statfsSync support");
  const disk = fs.statfsSync(directory, { bigint: true });
  const free = disk.bavail * disk.bsize;
  if (free < BigInt(plan.required_free_bytes)) throw new Error(`Insufficient disk space: need ${plan.required_free_bytes} bytes (conservative raw estimate plus reserve)`);
  return { ...plan, free_bytes: Number(free) };
}
module.exports = { storagePlan, checkStorage };
