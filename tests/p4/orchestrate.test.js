"use strict";
/**
 * tests/p4/orchestrate.test.js
 * Unit Test Suite untuk Disaster Recovery Orchestration P4 (Isolated Environment)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  DR_CONFIG,
  assertDrIsolation,
  planDisasterRecovery,
  executeDisasterRecovery,
} = {
  ...require("../../scripts/p4/orchestrate-dr"),
  ...require("../../scripts/p4/orchestrate-dr").legacyIsolated,
};

const TEST_DR_DIR = path.resolve(__dirname, "../../tmp-test-dr");

function setupTestDir() {
  if (fs.existsSync(TEST_DR_DIR)) {
    fs.rmSync(TEST_DR_DIR, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
  fs.mkdirSync(TEST_DR_DIR, { recursive: true });

  // Buat dummy verified backup
  const dumpPath = path.join(TEST_DR_DIR, "flashsale_p3_20261108_120000.dump");
  const content = "VALID_DUMP";
  fs.writeFileSync(dumpPath, content, "utf8");
  const sha = crypto
    .createHash("sha256")
    .update(Buffer.from(content))
    .digest("hex");
  fs.writeFileSync(
    `${dumpPath}.sha256`,
    `${sha}  flashsale_p3_20261108_120000.dump\n`,
    "utf8",
  );
}

function cleanTestDir() {
  if (fs.existsSync(TEST_DR_DIR)) {
    try {
      fs.rmSync(TEST_DR_DIR, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    } catch {}
  }
}

test("p4 orchestrate: assertDrIsolation menolak container milik stack P3 atau P2 untuk mencegah kontaminasi", () => {
  // 1. Container milik stack P3 (Production Baseline) -> WAJIB DITOLAK
  const mockP3Container = () =>
    JSON.stringify([
      {
        Config: {
          Labels: {
            "com.docker.compose.project": "flashsale-p3",
            "flashsale.environment": "p3",
          },
        },
      },
    ]);
  assert.throws(
    () =>
      assertDrIsolation(
        "flashsale-p3-db-primary-1",
        "flashsale-p4-dr",
        mockP3Container,
      ),
    /ISOLATION BREACH PREVENTED: Target container memiliki project 'flashsale-p3'/,
  );

  // 2. Container milik stack P2 -> WAJIB DITOLAK
  const mockP2Container = () =>
    JSON.stringify([
      {
        Config: {
          Labels: {
            "com.docker.compose.project": "flashsale",
            "flashsale.environment": "p2",
          },
        },
      },
    ]);
  assert.throws(
    () =>
      assertDrIsolation(
        "flashsale-db-primary-1",
        "flashsale-p4-dr",
        mockP2Container,
      ),
    /ISOLATION BREACH PREVENTED/,
  );

  // 3. Container milik stack DR -> VALID
  const mockDrContainer = () =>
    JSON.stringify([
      {
        Config: {
          Labels: {
            "com.docker.compose.project": "flashsale-p4-dr",
            "flashsale.environment": "p4-dr",
          },
        },
      },
    ]);
  assert.equal(
    assertDrIsolation(
      "flashsale-p4-dr-db-primary-1",
      "flashsale-p4-dr",
      mockDrContainer,
    ),
    true,
  );
});

test("p4 orchestrate: planDisasterRecovery default adalah dry-run dan melindungi stack P3/P2", () => {
  setupTestDir();
  try {
    const mockExec = (cmd) => {
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      return "";
    };

    const plan = planDisasterRecovery({ backupDir: TEST_DR_DIR }, mockExec);

    assert.equal(plan.dryRun, true);
    assert.equal(plan.status, "READY_FOR_EXECUTION");
    assert.equal(plan.isolatedEnvironment.project, "flashsale-p4-dr");
    assert.equal(plan.isolatedEnvironment.ingressPort, 8088);
    assert.equal(plan.steps.length, 10);

    // Pastikan proteksi stack P3 dan P2 ditegaskan
    const p3Protection = plan.protectedEnvironments.find((e) =>
      e.name.includes("flashsale-p3"),
    );
    assert.equal(p3Protection.status, "UNTOUCHED");
  } finally {
    cleanTestDir();
  }
});

test("p4 historical clone: plan remains read-only and clone execution is retired", async () => {
  setupTestDir();
  try {
    let dockerCommandsExecuted = 0;
    const mockExec = (cmd) => {
      if (cmd.includes("docker compose") || cmd.includes("docker rm")) {
        dockerCommandsExecuted++;
      }
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      return "";
    };

    const result = planDisasterRecovery({ backupDir: TEST_DR_DIR }, mockExec);

    assert.equal(result.dryRun, true);
    assert.equal(
      dockerCommandsExecuted,
      0,
      "Pada mode non-execute, dilarang menjalankan perintah docker!",
    );
    await assert.rejects(
      executeDisasterRecovery({ execute: true }),
      /retired by Architecture v1.3/,
    );
  } finally {
    cleanTestDir();
  }
});
