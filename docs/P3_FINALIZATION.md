# P3 finalization review ? 31 October 2026

Status: implementation ready for bounded experimental verification. Week 3 is not complete. No new traffic, pilot, final, or lifecycle campaign was run in this pass.

## Findings and decisions

| Priority | Finding | Action |
| --- | --- | --- |
| BLOCKER for valid auto comparison | Collector was suspended by the awaited scaling actuator. The real auto calibration has a 16,653 ms gap spanning the 9,637 ms scale-out and a resource-baseline-gap observation. | Sample serially during policy actuator waits, without a second policy loop. Preserve timestamps, invalid flags, source errors and the 15s freshness rule. Correction is unit tested; load validation remains pending. Historical auto calibration remains excluded. |
| BLOCKER for lifecycle reporting | Lifecycle emitted no measured request counters/latencies and inherited a 180s report window. | Add request counters, latency, errors and summary; measure the full calculated lifecycle. Lifecycle is read-only and no longer resets the dataset. It is excluded from capacity aggregates. |
| IMPORTANT | Cleanup can resemble scale-in in a presentation. | Policy scaling events now explicitly carry source=policy. Lifecycle success checks only policy completion events after workload start and requires final minimum membership, before cleanup. Calibration cleanup is never proof of automatic scale-in. |
| IMPORTANT | Auto raw metrics occupied 451,730,981 bytes over 120s; fixed 10 VU occupied 33,892,316 bytes over 60s. | Future runs use native k6 lossless gzip, retaining every point. Disk preflight per run uses conservative 80,000 bytes/VU/s plus 2 GiB reserve. Dry runs show estimates; at 1,000 VU/120s the raw estimate is 9.6 GB. Estimates are not upper bounds. No existing raw artifacts are removed or compressed. |
| IMPORTANT | No equal-workload/VU/duration comparison exists. | Add bounded single read-only stress runs (1?1,000 VU, 30?180s), avoiding a mandatory 24/72-run matrix. Reports group repetitions by profile, duration and settings as well as workload/VU/mode. Check actual manifests before comparing fixed and auto. |
| OPTIONAL | Replica pool waiting reached 58; primary/readiness waiting stayed zero in observed samples. | Keep pool limits, PostgreSQL settings, transaction logic and quotas unchanged. Waiting is a legitimate saturation finding; extra connections are not justified by these artifacts. |
| OPTIONAL | External metrics platform, pool tuning, controller redesign. | Deferred: unnecessary for the assignment. |

Native gzip reference: https://grafana.com/docs/k6/latest/results-output/real-time/json/

Compression changes generator CPU/I/O overhead. Treat old calibration as feasibility evidence; collect both members of future comparisons using the same revised runner. Collection during actuation adds bounded observer work and needs actual load verification. Invalid topology observations still invalidate capacity comparison; they are never hidden to make a run pass. Successful workload traffic and safe scaling do not imply complete monitoring coverage.

## Evidence and remaining experiments

Existing fixed 10 VU/60s: 5,508 successful requests, 91.8 RPS, p95 24.0983 ms. Existing auto 100 VU/120s: 73,410 successful requests, 611.75 RPS, p95 231.4606 ms; one policy scale-out 2?3, zero infrastructure errors. Neither is a capacity comparison. No actual automatic scale-in evidence exists yet.

Implemented: CPU scale-out/in, readiness routing, drain, minimum reconciliation, policy timestamp logging, stale/partial metric rejection. Automated tests validate these paths and transaction preservation, not real-load scale-in. Lifecycle low phase remains calculated (default 1,830s, full duration 2,250s). CPU thresholds 65/25 and resource/pool limits are unchanged. Ten low-load VUs may or may not satisfy the measured scale-in threshold: a long enough phase does not guarantee low CPU.

Validation in this pass: automated suite, JavaScript syntax, all three k6 scripts via inspect with explicit environment arguments, P3 Compose/isolation preflight, primary/replica invariants, and HTML/JSON/CSV regeneration from both real calibration artifacts. P1/P2 compatibility tests pass. P3 is healthy at two backends, orders=0, stock=10,000,000 per product on both databases. P2 containers were found stopped during read-only inspection; their original IDs/start times/restart counts remain recorded. No container/image/volume mutation was executed by this review. No direct P2 database-content audit was performed because it would require starting stopped resources. No credentials, volumes or historical raw samples were changed; no commit/push.

## PowerShell workflow (future execution requires approval)

Run from repository root. Keep any standalone controller stopped while the runner owns it. Configuration/status/verify are read-only:

~~~powershell
npm.cmd run p3:config
npm.cmd run p3:status
npm.cmd run p3:verify
~~~

If P3 actually needs starting later, npm.cmd run p3:start verifies project flashsale-p3 and starts/builds only P3 with --no-recreate. It can create missing services and volumes: inspect status first; do not invoke it merely to review a healthy stack. Never run init again or down -v.

First repeat the previously successful bounded calibration under the revised observer/compression path. These are dry runs; append --execute only after approval:

~~~powershell
node scripts/p3/run.js --campaign calibration --mode fixed --vus 10 --seconds 60
node scripts/p3/run.js --campaign calibration --mode auto --vus 100 --seconds 120
~~~

The 100 VU auto scenario previously demonstrated scale-out. Its revised implementation still needs live validation; do not promise the same timing. A short calibration does not demonstrate sustained-policy scale-in. The runner may restore the minimum during cleanup.

Next collect matched read-only fixed/auto pairs, starting at 10 and 100 before separately approving 500 and 1,000. Dry-run example for all required VU levels:

~~~powershell
foreach ($vus in @(10,100,500,1000)) {
  node scripts/p3/run.js --campaign stress --mode fixed --vus $vus --seconds 120
  node scripts/p3/run.js --campaign stress --mode auto --vus $vus --seconds 120
}
~~~

Do not append --execute to the entire loop for a live presentation. Approve and execute one run at a time, review disk estimates, generator/VM/host pressure, errors, DB and monitoring coverage, then proceed. Stress/lifecycle/pilot/final execution refuses other running containers to avoid shared-host comparisons. It never stops P2: if P2 is running, defer the campaign until separately authorized scheduling resolves contention. Read-only runs verify unchanged database state; setup may drain extra P3 backends to minimum. Auto stress may leave additional P3 backends, which the next runner reconciles safely.

Long lifecycle remains a separate future approval (dry run only):

~~~powershell
node scripts/p3/run.js --campaign lifecycle
~~~

Pilot/final matrices remain available unchanged but are not needed during the presentation. Read/write/mixed comparisons use those established matrices and their isolated dataset reset safeguards; the new single stress profile deliberately accepts only read workload.

Inspect events and display an existing actual report:

~~~powershell
Get-Content .p3/scaling-events.ndjson -Tail 30
$root = 'results/p3/2026-10-31T02-54-02-217Z-calibration'
node scripts/p3/report.js $root
Start-Process (Resolve-Path (Join-Path $root 'report.html')).Path
~~~

Use per-run scaling-events.ndjson plus manifest workload_started to attribute events; source=policy marks new policy events. Existing artifacts predate that additive source field. The old auto report should continue showing invalid monitoring warnings, not a valid-comparison claim.

## Presentation evidence checklist

- Capture configuration: min/max, quotas, thresholds, cooldown/window and unchanged pool sizes.
- Capture matched manifests: workload, VU, duration, initial database, images/settings, monitoring completeness; retain raw gzip, metrics, events and logs.
- Show RPS, average/p95, error rate and bottleneck evidence with Windows host, Docker Linux VM and generator utilization separately.
- Show policy scale-start/complete times and newly routed ready backend count.
- For automatic scale-in, show sustained low CPU, policy-origin removal, drain and return to minimum while lifecycle workload is still running. Never substitute cleanup.
- Show final primary/replica invariants and DB deltas.
- Save approved full stress results beforehand. Use a bounded previously verified calibration and saved HTML during the live presentation, not a 72-run matrix.
- Label implemented, unit tested, real-workload demonstrated and experimentally unverified claims separately. Collect real scale-in and matched stress comparisons before declaring the assignment complete.
