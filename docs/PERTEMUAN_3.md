# Pertemuan 3: isolated load testing and automatic backend scaling

Implementation is available; the 24 pilot runs and 72 final runs have **not** been executed. All thresholds below are configurable proposals, not lecturer requirements. Do not infer performance improvements from the presence of an autoscaler.

See [P3_VALIDATION.md](P3_VALIDATION.md) for the implementation inventory, completed validation and checks deferred until campaign approval.
The subsequent [pre-calibration review](P3_REVIEW.md) corrects lifecycle timing, collection safeguards, resource attribution and non-forcing scale-in, and records 2/4/6-backend collector measurements.

## Isolation and prerequisites

- Windows with Docker Desktop in Linux-container mode, Node.js 18.17+ and k6 on PATH.
- Work from the repository root. Quote paths containing spaces.
- P3 always uses project `flashsale-p3`, database `flashsale_p3`, network `flashsale-p3_p3`, and volumes `flashsale-p3_primary` / `flashsale-p3_replica`.
- The P2 Compose file, image tag, ports and volumes are not used by the P3 commands. P3 does not mount or expose the Docker socket.
- Only Nginx publishes a host port: `127.0.0.1:8080`. Management listeners bind container loopback port 3001 and are queried through validated `docker exec` calls.
- Controller and dataset operations verify Compose labels, network membership, database volume names, database name, primary/standby roles, and a UUID marker. The UUID lives in `.env.p3`; retain that file with the P3 volumes. Regenerating credentials cannot update an existing PostgreSQL volume.
- Existing P3 containers are not recreated by `p3:start`. After a source/config change, stop the controller, drain P3, and explicitly arrange P3-only container replacement while retaining volumes. This command deliberately does not automate replacement.
- Validation rejects drift between live backend quota/pool/identity or Nginx host binding and `.env.p3`, so editing resource settings cannot silently change the CPU normalization used for an existing container.

PowerShell may block `npm.ps1`; use `npm.cmd` instead of changing execution policy. Git Bash can use `npm`. All `node scripts/p3/...` commands work in both shells and avoid shell-specific environment assignment.

## Start safely

PowerShell:

```powershell
Set-Location 'D:\Kuliah\SEM 5\Cloud Computing\flashsale'
npm.cmd test
npm.cmd run p3:init
npm.cmd run p3:config
npm.cmd run p3:start
npm.cmd run p3:verify
```

Git Bash:

```bash
cd '/d/Kuliah/SEM 5/Cloud Computing/flashsale'
npm test
npm run p3:init
npm run p3:config
npm run p3:start
npm run p3:verify
```

Run `p3:init` **once**. It creates random local credentials and an environment UUID, refuses to overwrite an existing `.env.p3`, and does not print passwords. Files `.env.p3`, `.p3/`, and generated results are ignored by Git. Never replace `.env.p3` merely to fix a startup failure; inspect the failure first.

`p3:config` is read-only. It validates the resolved Compose model and existing P3 objects without printing resolved secrets. `p3:start` repeats these checks, explains the effects, builds `flashsale-api:p3`, starts the isolated stack with `--no-recreate`, waits for health, checks database identity and roles, and publishes the initial ready backend upstream. An existing backend count above two is preserved.

P2 may remain running for setup and the five-second read-only smoke test. The benchmark runner refuses performance campaigns while non-P3 containers are running; **it never stops P2**. Stop P2 manually only when a later benchmark campaign has been approved. Do not use `down -v`, remove volumes, or run the old `db:reset` against either stack.

## Controller and monitoring

In a second terminal:

```powershell
npm.cmd run p3:controller
```

Git Bash uses `npm run p3:controller`. Ctrl+C ends the controller after the current safe operation, leaving services and the last working routing configuration running. Restarting reconciles actual Engine membership, IP addresses, database identity, and Nginx generation. Failed startup/new backends are never published before readiness.

Useful commands, identical in both shells:

```text
node scripts/p3/cli.js status
node scripts/p3/cli.js fixed
node scripts/p3/cli.js auto
node scripts/p3/cli.js pause
node scripts/p3/cli.js resume
node scripts/p3/cli.js verify
```

`fixed` asks the running controller to drain back to two replicas and disables capacity decisions. `auto` enables them. `pause` suspends controller actions; it does not stop traffic or containers. `resume` resumes actions. These settings persist in `.p3/control.json`. Starting the controller does not silently override fixed/paused mode.

The controller writes `.p3/metrics.ndjson`, `.p3/resources-v2.csv`, `.p3/scaling-events.ndjson`, `.p3/state.json`, and `.p3/routing.json`. Historical `metrics.csv` files are retained. A standalone collector can be run as `node scripts/p3/cli.js collect results/p3/manual-observation` when the controller is not collecting. Do not duplicate collectors during official measurements.

Defaults in `.env.p3`:

| Setting | Default |
|---|---|
| Replicas | min 2, max 6 |
| Per backend | 0.5 CPU, 512 MiB; pool max 10 per DB |
| Primary / replica | each 2 CPU, 1 GiB; 100 DB connections |
| Nginx | 1 CPU, 256 MiB |
| Sampling | 5 seconds; samples over 15 seconds old are invalid |
| Scale out | mean backend CPU ≥65% of quota continuously for 30 seconds; +1 |
| Scale-out cooldown | 60 seconds after successful routing activation |
| Scale in | CPU <25% for 180 seconds, no pool wait, projected CPU after removal <50%; −1 |
| Scale-in cooldown | 120 seconds |
| Startup/readiness / drain timeout | 90 seconds each |
| Host guard | no scale-out at host CPU ≥90% or memory ≥85% |

CPU is normalized against each backend's configured quota. At six backends the request pools use at most 60 connections per database; readiness uses up to six more and the collector one. Twenty connections are reserved. Invalid configuration or a smaller actual DB limit is rejected. CPU/RAM quotas are controlled experimental inputs shared by fixed and auto modes.

RPS, request duration, event-loop delay and pool queues are observed; high latency alone does not trigger scaling. A shared PostgreSQL outage freezes capacity decisions while existing live routes remain available, including replica reads. Metrics loss resets observation windows. Three operational failures put the controller in degraded mode; fix the cause and restart it to reconcile. The controller does not promote any database.

## Routing and termination behavior

Discovery reads Engine container labels/IPs every reconciliation. New backends pass `/ready` twice. Nginx receives an explicit IP upstream; this works with the existing Nginx 1.25 image without assuming dynamic DNS features from newer versions.

Routing writes a candidate configuration inside the Nginx Linux filesystem, runs `nginx -t`, atomically replaces the active file, reloads, and verifies the generation through fresh health requests. Validation failure leaves the active configuration intact; activation failure restores the previous file.

Scale-out uses only `up -d --no-deps --no-recreate --no-build --scale backend=N backend`. PostgreSQL services are not included. Scale-in chooses the highest Compose ordinal, removes it from the upstream, waits for old Nginx workers to exit and for request/pool activity to reach zero, then stops/removes that exact validated backend ID. No volumes are removed. A drain timeout restores routing instead of terminating the request.

Express records bounded route/status histograms, request counts, active requests, process memory and event-loop delay. `/health` and all business API contracts remain available. Management is enabled only by `P3_OBSERVABILITY=1`. SIGTERM/SIGINT closes the HTTP server, waits for leased database clients to return, ends pools and closes management. No automatic timeout forcibly kills an in-flight transaction in the application.

## Short smoke validation

Stop a separately running controller first; the runner owns its controller instance and refuses a second one.

```text
node scripts/p3/run.js --campaign smoke
node scripts/p3/run.js --campaign smoke --execute
```

The first command only prints the plan. Execution sends read-only requests through Nginx for five seconds with two VUs and 100 ms pacing. It performs no dataset reset. It captures resource samples, validates the database before/after, and generates a report. P3 may be reduced to two replicas through the normal verified drain path if it had previously been scaled up.

A separate short actuator check is `node scripts/p3/smoke-routing.js`: it requires exactly two P3 backends, adds a third, sends 18 sequential catalog reads, then drains/removes that backend. It verifies all three backend IDs served requests and that PostgreSQL container IDs/start times and order counts did not change. This is a routing/termination smoke, not evidence of load-triggered scaling.

## Dataset controls

Only the isolated marked P3 fixture tables may be reset. Do not send other traffic during resets or benchmark runs.

```text
node scripts/p3/cli.js pause
node scripts/p3/cli.js dataset --reset-p3-only
node scripts/p3/cli.js verify
node scripts/p3/cli.js resume
```

Reset requires paused control, a valid environment marker, correct volume identity, idle request pools, and an exclusive operation lock. The identity check is repeated in the reset transaction. It truncates only `orders`, `products`, and `users` in `flashsale_p3`, reseeds 100 users and three products with 10 million units each, analyzes tables, and waits for the replica to replay a recorded WAL LSN. No volume or database is dropped.

The runner uses these same controls automatically for approved non-smoke runs. Before/after validation checks nonnegative stock, unique idempotency keys, `initial_stock - stock = sum(order.qty)`, P3-only order key namespaces, and matching primary/replica totals after replay. Timeout/5xx checkout keys are logged to `k6.stderr.log` as ambiguous outcomes for reconciliation; a committed order whose response was lost must not be classified as lost data.

After non-smoke runs, `reconciliation.json` records ambiguous attempts as committed/not committed and checks the exact run namespace. Workload summaries include successful checkout responses across all phases, so the runner can require committed DB orders to equal confirmed responses plus reconciled ambiguous commits. Per-key outcomes are recorded in `ambiguous-checkouts.ndjson` when needed.

## Automatic scale-out / scale-in verification checklist

This is a later, explicit performance/lifecycle test, not a startup action.

1. Ensure configuration validation and unit tests pass; verify DB consistency.
2. Stop a standalone controller. Confirm P2/other containers are stopped manually only after campaign approval.
3. Dry-run `node scripts/p3/run.js --campaign lifecycle`.
4. After approval, add `--execute`. The runner starts at two backends, sends read traffic through Nginx, holds 1,000 VU for five minutes, then holds 10 VU for the calculated recovery phase (default 1,830 seconds). The dry run prints the budget and matching process timeout. See `P3_REVIEW.md` for the formula and configurable override.
5. Check a sustained high-CPU `decision`, `scale-start`, readiness/routing activation and `scale-complete` in the event log. A Compose command by itself is not proof of automatic scaling.
6. Confirm new backend IDs appear in routing/request distribution; PostgreSQL IDs/start times remain unchanged.
7. Confirm sustained low CPU triggers drain and scale-in back to two; check cooldown timestamps and absence of repeated oscillation.
8. Check 502/504/timeouts and Nginx error logs; inspect whether any failures coincide with a routing transition.
9. Verify post-test database invariants and primary/standby roles.

The lifecycle command fails validation unless both an automatic scale-out and scale-in occurred and the final count is two. A workload that does not exceed the configured CPU threshold may legitimately produce no scale-out; record that result rather than inserting a manual scaling command. Unit tests inject synthetic inputs only to test policy logic; they are never performance evidence.

## Pilot and final campaigns — run only after later approval

Dry runs are safe and do not touch Docker:

```text
node scripts/p3/run.js --campaign pilot
node scripts/p3/run.js --campaign final
```

After campaign approval, stop a standalone controller and non-P3 containers manually, then use:

```text
node scripts/p3/run.js --campaign pilot --execute
node scripts/p3/run.js --campaign final --execute
```

| Campaign | Runs | Per-run phases |
|---|---:|---|
| Pilot | 24 | 10s warm-up, 10s ramp, 10s stabilization, 30s measurement, 10s ramp-down |
| Final | 72 | 30s warm-up, 30s ramp, 30s stabilization, 180s measurement, 30s ramp-down |

Both use read/write/mixed × 10/100/500/1000 VU × fixed/auto. Final repeats each combination three times and reverses pair order on alternate repetitions. There is a minimum 60-second gap between runs. Fixed and auto share dataset, resource limits, image and monitoring. Mixed uses a deterministic 80% read/20% checkout sequence; checkout selects hot/secondary/third products in an 80/15/5 distribution. Each new checkout has a unique run/VU/iteration key. No benchmark retry masks a failed request.

The final campaign takes approximately 7–9 hours including preparation/reset/drain. Actual duration depends on the host. Pilot startup cooldown may consume much of its short measurement window; pilot validates tooling and feasibility, not final scaling benefits. Inspect it before freezing parameters for the final campaign.

Additional explicit correctness runs (also require an idle, approved isolated test environment):

```text
node scripts/p3/run.js --campaign soldout --execute
node scripts/p3/run.js --campaign idempotency --execute
```

Sold-out uses stock 100 and 500 new checkout attempts; validation requires exactly 100 new orders and stock zero on product 1. Idempotency sends 20 concurrent requests with one key and requires one order. These are correctness checks, not capacity results. Saturation/no-pacing workloads are intentionally not launched by the main runner; a separate approved experiment should define that change explicitly.

## Outputs and interpretation

Each run under `results/p3/<campaign>/<run-id>/` contains its manifest, image IDs/tool versions/configuration, DB snapshots, raw k6 points, stdout/stderr, collector NDJSON/CSV, scaling events, and analysis. Campaign root contains `comparison.json`, `comparison.csv`, and standalone `report.html` with SVG charts. Regenerate with:

```text
node scripts/p3/report.js results/p3/<campaign-directory>
```

Raw k6 points can be large; reserve disk space and retain raw samples with the submitted results. Never log credentials or use transaction keys as metric labels. The HTML uses no external CDN.

The report distinguishes total request throughput, successful requests, successful checkout responses, committed database orders, infra errors, sold-out and unexpected responses. It calculates average/p95 request duration and TTFB from measured samples, including endpoint/outcome breakdowns. Request duration excludes connection setup; raw k6 connection/blocked timing remains available. Results with sold-out, invariant failure, missing monitoring, unexpected responses or sustained host pressure are excluded from automatic comparison aggregates pending review.

Three repeats are shown individually plus median/range; median per-run p95 is not a pooled percentile. Fast failures can lower overall latency, so inspect outcome-specific latency and error rate. Suggested p95 <500ms and infra errors <1% are evaluation targets, not lecturer requirements. Backend scaling may fail to improve throughput because of product row locks, PostgreSQL connections/WAL, Nginx CPU, or host/generator contention. Collector evidence flags symptoms; it does not prove causation by itself.

## Rollback and limits

The controller preserves the last working upstream on failed updates and restores the drained backend on failed scale-in. Startup reconciles actual membership rather than blindly replaying stale desired counts. P3 containers are removed only by exact validated backend ID after drain; neither controller nor runner stops P2 or removes a database volume.

To leave a test session, Ctrl+C the runner/controller, wait for transaction drain, and keep the result directory. P3 can remain idle. If stopping it manually, always specify `--project-name flashsale-p3 --env-file .env.p3 -f docker-compose.p3.yml` and use `stop`, never `down -v`. Restart P2 using its original configuration only when it had previously been stopped with approval.

This is a single-host lab controller, not a distributed orchestrator or authorization boundary. All Docker commands run with the local user's existing Docker privileges. The process has a single-writer lock and serializes mutations; another user manually changing the same P3 project concurrently is unsupported. The stack's existing Node/Nginx base versions are retained for compatibility; version migration is a separate task.

Finalization review and presentation workflow: [P3_FINALIZATION.md](P3_FINALIZATION.md).
