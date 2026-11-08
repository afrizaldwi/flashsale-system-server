P4 final safety review — 8 November 2026

Governing specifications remain Architecture P1 v1.3, DRP P1 v1.1 and `P4_GOVERNING_ALIGNMENT.md`. The official environment remains `flashsale-p3`, `docker-compose.p3.yml`, `.env.p3`, `flashsale_p3`, and `http://127.0.0.1:8080`. This review changed source code and temporary test fixtures only. No real container/volume deletion, service start/stop, restore, database write, commit/push or DOCX modification was performed. Existing unrelated work was preserved.

Root causes and corrections

| Priority | Root cause | Correction |
| --- | --- | --- |
| P0 manifest | Recovery state was written only after primary deletion, workload draining and volume creation. A crash could leave normal startup unaware of the incident. | Generate run ID/volume names first; complete preflight, verify IDs/mount and unused volume names; atomically save `recovering` intent immediately before deletion. The manifest includes original primary ID/volume, P3 database/marker, original replica and both recovery volumes. Failures or ambiguous deletion never clear it or resume the controller. |
| P0 restore ownership | `.restore.lock` used an overwriting write, ignored acquisition errors, then removed any lock file in finally. | Exclusive `wx` acquisition with random ownership token, PID and creation UTC; fail closed on errors; release only matching token/PID. Missing/malformed/unreadable ownership evidence never authorizes deletion. No automatic stale archive-lock reclamation. |
| P1 retention | Metadata and TOC validation were optional; the old implementation protected only one selected file during restore and swallowed malformed lock parsing. Backup and restore did not share one mutex. | Require complete `.dump`, `.sha256`, `.meta.json`, validated metadata, matching size/checksum, valid times/duration/TOC count and actual nonempty TOC. Backup, restore/trial restore and retention share `.backup-job.lock`. Any `.restore.lock` suspends all pruning, including malformed/unreadable files. Preserve up to ten newest valid sets and at least one valid set; preserve temporary/unrelated/invalid files. Windows deletion retries remain. |
| P1 controller | Controller ticks held the operation mutex, but startup/reconciliation and direct benchmark actuators could bypass it. Pausing control state alone did not drain an existing action. | P4 waits for the existing `.p3/operation.lock`. CLI start, controller startup/ticks, recover, scale-in and scale-out use the same mutex. Nested calls reuse only the owning token in the same async context. Separate operations/processes cannot borrow it. Normal start/scale/resume reject recovering manifests; incomplete recovery stays paused. |
| P2 documentation | Historical instructions still described 30 seconds and could imply the schedule established RPO. | Current default is 60 seconds; environment overrides change the effective interval. RPO still requires transaction-level ledger/database evidence. Historical clone notes remain clearly marked as historical. |

Recovery sequence now enforced

1. Read/validate P3 configuration, immutable primary/volume and explicit confirmation.
2. Generate unique recovery names, wait for the shared operation mutex, capture control state and pause the controller.
3. Check marker/roles, baseline stats/health/reads, backup validity, trial restore and acknowledged/error-free K6 traffic. Trial restore holds an exclusive archive/restore session; locks are released before workload begins so scheduled backups may continue.
4. Recheck primary ID/mount, workload and recovery-volume name availability.
5. Atomically persist the full `recovering` manifest, then record/attempt primary deletion. If the process exits immediately afterwards, the manifest and pause state survive independently of finally.
6. Detect the incident using two consecutive health 503 responses, drain the bounded workload and fence application writers.
7. Acquire the shared archive mutex and exclusive restore lock before selecting/pinning the recovery backup; keep both until primary restore and its independent audit complete. Exceptions clean up only the owned archive locks, retain the manifest and leave the controller paused.
8. Rebuild standby, restore P3 backend readiness/routing and complete checkout, transaction and stock audits. Only then may the manifest become `validated` and prior controller control state be restored. An unsuccessful workload still produces a failed overall report even if database recovery completes.

Archive-lock protocol

- Lock order is operation mutex (for P3 DR), archive mutex, then restore lock. Standalone backup/restore/retention use the same archive mutex; backup-loop uses a separate loop lock while idle and acquires the archive mutex only during a job.
- A lock file contains a unique token and PID. A different token with the same PID is a different owner. A failed acquisition never enters database commands and never cleans up another owner's file.
- The restore wrapper acquires its locks before archive selection and database validation. Both success and error paths release only those leases. Official trial/disaster restore use the same session helper.
- A crashed owner can leave an archive lock. Operators must inspect its owner and incident evidence before any manual cleanup. Automatic takeover is intentionally disabled for archive locks.
- Retention obtains the mutex itself or verifies the exact lease held by the backup job. It rechecks ownership and restore-lock presence before pruning each set. An active restore cannot race a cooperating backup/pruner.

Exact files changed in this review

| Files | Reason |
| --- | --- |
| `scripts/p4/p3-dr.js` | Pre-injection manifest, operation synchronization, archive sessions for trial/actual restore, conservative pause/manifest behavior on errors. |
| `scripts/p3/recovery.js` | Validate original primary identity in manifests; shared incomplete-recovery guard. |
| `scripts/p3/util.js` | Token ownership on operation leases, bounded waiting, async-context ownership reuse for nested actuator calls. |
| `scripts/p3/controller.js` | Serialize startup/recover/scale-in/tick paths and reject incomplete recovery before scale actions. No autoscaling policy redesign. |
| `scripts/p3/docker.js` | Serialize scale-out; guard backend removal against incomplete recovery. |
| `scripts/p3/cli.js` | Serialize normal startup and control commands; reject resume/start during incomplete recovery. |
| `scripts/p4/locks.js` | New exclusive token/PID archive/restore lease implementation. |
| `scripts/p4/restore.js` | Replace non-exclusive restore lock and unconditional unlink with an owned session. |
| `scripts/p4/backup.js` | Shared archive mutex and explicit lease for nested retention. |
| `scripts/p4/backup-loop.js` | Owned loop token; preserve separate job mutex and 60-second default. |
| `scripts/p4/common.js` | Strict metadata/TOC retention, complete restore-lock suspension, serialization and empty-TOC rejection. |
| `tests/p4/p3-dr.test.js` | Eight new crash/fault/synchronization regressions; valid manifest/metadata fixtures. |
| `tests/p4/archive-safety.test.js` | Twenty-one new archive, restore ownership, retention and concurrency regressions. |
| `tests/p4/loop.test.js` | Same-PID replacement-token regression. |
| `tests/p4/retention.test.js` | Complete validated metadata and explicit synthetic TOC fixtures; existing assertions retained. |
| `tests/p4/helpers/dr-runtime.js` | Extract the existing fake runtime/archive fixture for reuse; no real Docker implementation. |
| `tests/p4/helpers/crash-after-delete.js` | Real child-process exit immediately after simulated deletion; no finally cleanup. |
| `tests/p3/isolation.test.js`, `tests/p3/scaleout-inventory.test.js`, `tests/p3/transaction-safety.test.js` | Add real temporary runtime directories to existing actuator fixtures; preserve their safety assertions. |
| `docs/PERTEMUAN_4.md`, `docs/P4_GOVERNING_ALIGNMENT.md` | Current interval, manifest sequence, lock protocol and test evidence. |
| `docs/P4_SAFETY_REVIEW.md` | This review and handoff. |
| `PROMPTS.md`, `docker-compose.p4-dr.yml`, `docker-compose.p4-dr.recovery.yml` | Remove only pre-existing end-of-file whitespace reported by `git diff --check`; no prompt/configuration content changes. |

Regression coverage and results

- Real child process exits with status 73 immediately after fake primary deletion. Parent verifies a valid persisted manifest, pause state, and rejected normal start/scale/resume; no finally ran in the child.
- Exceptions before volume creation, during volume creation and during restore preserve `recovering` and original-volume identity; controller remains paused. Archive locks acquired by the failed operation are cleaned up.
- Existing operation completes before failure injection; startup waits for the shared mutex; direct benchmark actuator entrypoints cannot bypass an active DR operation; nested owner calls complete without deadlocking. Resume happens after validated recovery; failed audit retains pause and does not record T1.
- Retention tests cover missing/corrupt metadata, wrong metadata checksum/status/size, missing dump/checksum, failed/empty TOC, newest-ten retention, last-valid preservation, and temporary/unrelated-file preservation.
- Active, malformed and unreadable restore locks suspend the entire pruning operation. Token replacement with the same PID cannot be released by a previous owner. Success/failure cleanup and foreign-lock preservation are tested.
- A restore held in one real Node process blocks a backup attempted by another Node process. An active backup mutex blocks restore and retention without any Docker/database command.
- Full suite: `npm.cmd test` — **209 total, 203 passed, 0 failed, 6 skipped, 0 cancelled, 0 todo**. Full output: `backups/p4/safety-full-tests.txt`.
- Focused non-destructive unit suite: **92 passed, 0 failed, 0 skipped** across P4 archive/restore/backup/loop/pipeline and the affected P3 actuator tests. Output: `backups/p4/safety-targeted.txt`.
- Six skips are the stopped-P3 live checks: container identity, primary role, standby role, replica read routing, backend health, and business invariants. They are not counted as passed recovery tests.
- `git diff --check`: passed after whitespace-only cleanup. No destructive validation or live P3 integration was performed. Pipeline Docker/HTTP are simulated, while file locking/child lifecycle use real Node/filesystem behavior.

Remaining blockers and safe manual validation

P3 remains stopped as stated in the task. The official live baseline, destructive DR, recovery volumes, actual RTO/RPO and runtime integrity after a real disaster have not been verified. The unit/mock results do not establish those outcomes. No remaining failure was observed in the authorized unit checks.

```powershell
npm.cmd test
git diff --check
npm.cmd run p3:status
npm.cmd run p4:dr
```

The latter two commands are read-only status/planning checks; do not append `--execute`. Do not start P3 merely to bypass skipped checks. A future actual drill requires a separately reviewed healthy baseline, current immutable target confirmation and preserved backup/volume evidence. No destructive commands are part of this handoff.
