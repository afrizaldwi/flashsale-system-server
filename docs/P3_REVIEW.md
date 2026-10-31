# P3 pre-calibration review — 31 October 2026

No pilot, final, calibration workload or long lifecycle test was executed in this review. All existing P2/P3 containers and database volumes were preserved. Only temporary P3 backend replicas were created and gracefully removed during the idle monitoring check.

## Defects and corrections

| Finding | Correction |
|---|---|
| 600 seconds cannot cover four separate 180-second low windows | Calculated/configurable lifecycle recovery phase and matching outer runner timeout |
| Many repeated Docker inspections, sequential SQL collection and separate backend probes | One validated inventory, parallel read-only collection, one bundled metrics/readiness probe per backend, inventory reconciliation afterward |
| Counts could appear complete with duplicate or replaced container IDs | Exact ID-set validation for inventory/stats/backend probes; duplicate IDs rejected |
| Slow, missing, nonnumeric, duplicated or old observations could be misused | Four-second collection budget, first-sample CPU baselines, freshness/membership checks, duplicate/out-of-order rejection and pre-actuation recheck |
| Windows process collector was blocked by execution policy; the old collector only recorded the error | Execute trusted local helper source via PowerShell stdin, without changing execution policy; required source failures invalidate decisions |
| Host, VM and generator resource constraints were not separately attributed | Explicit Windows host, Docker Linux VM, Engine limits, per-container quota/throttle counters and PID/start-time k6 utilization |
| Docker stop could escalate to SIGKILL after its grace period | SIGTERM only; bounded waiting leaves a live process intact; only an inspected exited backend can be removed |
| A stale scale-out target below the total container inventory could implicitly shrink through Compose | Refuse the command; stopped/orphaned inventory requires explicit reconciliation instead of un-drained removal |
| Cancellation and routing failure had incomplete drain recovery handling | Cancel checks before termination; pre-termination rollback restores routes without signaling the backend; pending termination survives controller failures |
| Initial baseline samples could invalidate an otherwise complete measurement | Report checks the actual measurement window; baseline samples are retained but excluded from measured-window validity |

Thresholds remain **65% scale-out / 25% scale-in**, with unchanged CPU quotas and replica limits.

## Lifecycle budget

`scripts/p3/timing.js` computes the minimum low phase from the active policy:

```text
steps = maxReplicas - minReplicas
perStep = max(lowWindow, scaleInCooldown)
          + drainTimeout + terminationWait + routingAllowance + 4 * pollInterval
lowPhase = max(scaleOutCooldown, scaleInCooldown) + steps * perStep + 30s margin
```

Defaults: `steps=4`, `perStep=420s`, low phase **1,830 seconds (30m30s)**. Total workload is **2,250 seconds** and the runner timeout **2,370 seconds**, including grace/slack. The previous 600-second phase was shorter than even the 720 seconds required for four low windows with zero drain overhead.

Set `P3_LIFECYCLE_LOW_SECONDS` in `.env.p3` only to increase the budget. Empty selects the calculation; a value below the calculated minimum is rejected. The runner passes the value to k6 and records it in the manifest. `node scripts/p3/run.js --campaign lifecycle` prints timing without running Docker or k6. This budget assumes continuously low CPU, healthy metrics and successful operations; faults may still invalidate the lifecycle test.

## Idle monitoring measurements

Successful artifact: `.p3/monitoring-review/2026-10-31T02-31-54-564Z/summary.json` with raw `metrics.ndjson` and `resources-v2.csv` beside it.

| Backends | Measured samples | Mean | Maximum | All valid |
|---:|---:|---:|---:|---|
| 2 | 3 | 2.299s | 2.594s | Yes |
| 4 | 3 | 2.750s | 2.809s | Yes |
| 6 | 3 | 2.796s | 2.883s | Yes |

Each topology had a counter warm-up before measured samples. The four-second collection budget leaves at least one second within the five-second polling interval. These are idle measurements, not guarantees under stress. Under load, any collection over budget, source failure, invalid CPU baseline or changing membership freezes scaling and resets the observation window. The controller rechecks sample age and backend IDs after database isolation validation, immediately before actuation.

The first review attempt is retained at `.p3/monitoring-review/2026-10-31T02-29-37-828Z/`. All its measured samples were correctly invalidated because PowerShell file execution was blocked. The environment was restored before correcting the helper and repeating the check.

No controller ran automatic capacity policy during the idle replica experiment. After both attempts, the original two P3 backend IDs were restored. Every original P2/P3 container retained its ID, start time and restart count; primary data was unchanged and consistency checks passed. No database or volume reset was used.

## Resource attribution

- `resources.windows_host`: physical Windows host aggregate CPU/memory from Node OS counters. It includes Docker/WSL, k6 and other host activity.
- `resources.docker_vm`: CPU deltas and memory availability from the Docker Linux kernel's `/proc` data, plus Engine-reported CPU/RAM limits. This is the Docker VM, not all Windows memory or all WSL distributions.
- `resources.k6_generator`: tracked child PID, start time, CPU cores consumed, percentage of one core, percentage of all host logical CPU capacity, and process memory. A new/reused PID or missing CPU counter yields an unknown rate, never an invented zero.
- Backend `cgroup` records include CPU quota, usage/throttling counters and memory events. Container CPU is still normalized to the unchanged 0.5-CPU quota.
- `wsl_process_proxies` are labeled proxies only: `vmmemWSL` may include other distributions. Missing process counters remain null.

Reports have separate Windows, Docker VM and k6 charts and resource peak fields. A saturated VM with an idle-looking Windows aggregate is not attributed to application code. Generator pressure, VM pressure, database waits and backend throttling must be checked alongside RPS and latency. No-load process sampling cannot prove generator headroom under 1,000 VU.

The collector writes schema-2 `metrics.ndjson` and `resources-v2.csv`; old `metrics.csv` files are retained historical output. `node scripts/p3/cli.js sample` now takes a baseline and a second sample so its result has meaningful CPU deltas.

## Transaction safety

The controller may remove a backend only after its routing generation has withdrawn it, old Nginx workers have exited, HTTP activity is zero and all request-pool clients are idle with no waiters. A disconnected HTTP client does not count as transaction completion: a leased database client still prevents termination.

Routing/rollback exceptions and pre-termination interruption cannot reach the termination call. Once SIGTERM is sent, the application closes ingress and waits for pool completion; the host never escalates to SIGKILL or forced `rm`. A process that fails to exit remains running, with pending termination persisted. Recovery waits for it to exit and removes only the exited container, or reports that it is still terminating. Operator intervention may be needed for a genuinely hung transaction; safety takes precedence over automatic deletion.

Fault-injection tests cover leased clients after HTTP disconnect, interrupted scale-in, routing plus rollback failure, controller recovery during termination, and shutdown waiting for transaction-pool completion. Live idle scale-in was exercised at 6→5→4→3→2. No live business transaction was deliberately killed or faulted during this review.

Official semantics: [Docker stop and SIGKILL escalation](https://docs.docker.com/reference/cli/docker/container/stop/), [node-postgres pool shutdown](https://node-postgres.com/apis/pool#poolend).

## Can catalog reads trigger CPU scaling?

`GET /products` performs two replica SQL round trips and returns three products. Wall-clock latency is not backend CPU time. With two 0.5-CPU backends, the 65% mean threshold requires about **0.65 total CPU cores** of backend work sustained for 30 seconds.

With 100ms pacing, 10 VU cannot exceed 100 RPS even at zero response time: reaching the threshold would require at least 6.5ms of backend CPU per request at that upper bound. At 100 VU the upper bound is 1,000 RPS, corresponding to 0.65ms/request. Actual RPS is lower because each VU waits for the response. These are algebraic bounds, not measured service costs.

Read-heavy scaling is plausible at sufficient request rate, but is not yet proven. Replica throughput or connection waiting may bind first while Node CPU stays below 65%. Keep thresholds and quotas unchanged. If bounded calibration shows low backend CPU with DB waits, report that bottleneck; do not lower thresholds or add synthetic CPU work to manufacture scaling. Larger approved experiments or a revised metric policy would require separate evidence and a clearly documented change.

## Safest next commands — not executed

Stop any separately running controller first; the runner owns its controller and refuses a second one. P2 may stay running for feasibility calibration. Its resource competition must be acknowledged; these runs are explicitly excluded from fixed/auto capacity comparisons.

```powershell
npm.cmd run p3:config
npm.cmd run p3:verify
# Dry run; no Docker/k6 execution:
node scripts/p3/run.js --campaign calibration --mode fixed --vus 10 --seconds 60
node scripts/p3/run.js --campaign calibration --mode auto --vus 100 --seconds 120
```

Only after approval, add `--execute` to the calibration commands. Calibration is restricted to read-only workloads, 1–100 VU and 30–180 seconds; it never resets the dataset, changes thresholds or stops P2. A successful auto calibration drains added replicas back to two. An interrupted/faulted run may leave additional backends alive for safe recovery.

Inspect the first fixed result before running auto. Check generator CPU, Docker VM pressure, quality reasons, backend CPU, replica CPU/connection waits and response errors. A valid no-scale result is acceptable. Stop on monitoring gaps or infrastructure errors instead of extending the test automatically. Raw samples and event logs are retained; startup cooldown is 60 seconds, so the 120-second auto check only leaves a limited opportunity for one scale-out.

## Validation status

- 53 automated tests pass; syntax checks and `git diff --check` pass.
- k6 inspection parses both calculated lifecycle configuration and bounded calibration without sending traffic.
- Idle 2/4/6 collector verification passes; P3 is restored to two backends with its original containers/data.
- No pilot/final, calibration traffic, long lifecycle workload, volume deletion/reset, P2 mutation, commit or push occurred.
- Load-time collector behavior, live generator utilization and actual CPU-triggered scaling remain for the next approved calibration.
