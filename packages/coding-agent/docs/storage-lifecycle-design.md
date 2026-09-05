# Storage lifecycle and efficiency

**Status: proposed design and maintenance instructions, not a shipped database migration or cleanup command.**
Current-source observations below are marked **Confirmed**; targets and implementation work are marked
**Proposed**. No performance improvement or explanation of the reported cross-session stall is claimed.

Start with the existing [storage layout and transient-work contract](work-directory.md). That document
owns paths and retention defaults; this document owns the proposed cross-store lifecycle and acceptance
plan. See [worktree synchronization](worktree-sync.md) and [process matrix](process-matrix.md) for their
respective coordination protocols. Do not create a second authority for those protocols here.

## Decision: bounded ownership first, database second

**Proposed:** keep transcripts, artifacts, managed binaries, and worktree contents as files. Evaluate
SQLite only for small transactional coordination metadata after measuring the existing implementation.
Do not introduce a machine-wide broker, daemon, another storage dependency, or a global writer lock.
A database can simplify atomic claims and transitions; it cannot make unlimited history or unmanaged
runtime copies cheap, and it does not by itself fix a stall.

**Confirmed source boundaries:**

- [`agent-paths.ts`](../src/core/agent-paths.ts), `orchestrationSessionDir` and
  `sessionRootMailboxFile`, derive separate control-plane bundles from parent-session identity.
- [`orchestration/event-store.ts`](../src/core/orchestration/event-store.ts), `OrchestrationEventStore`,
  uses a session cursor file lock, event files, bounded tails, and projection snapshots.
- [`process-matrix/store.ts`](../src/core/process-matrix/store.ts), `entryPath`, stores one JSON entry
  per process identity. It is not a shared lane SQLite database.
- [`worktree-sync/store.ts`](../src/core/worktree-sync/store.ts), `syncStorePaths`, locates repository
  coordination under the Git common directory. Its integration lock remains owned by that subsystem.
- [`work-directory.ts`](../src/utils/work-directory.ts), `acquireWorkRun` and `pruneWorkTenant`, owns
  leased scratch runs and their removal. Acquisition currently invokes synchronous pruning unless
  retention is disabled; lease inspection can remove stale markers and is not a read-only audit API.
- [`context/sqlite-database.ts`](../src/core/context/sqlite-database.ts), `openSqliteDatabase`, already
  provides a Node/Bun adapter with a configurable busy timeout. Reuse it if a metadata experiment is
  approved; its existence does not mean lane stores currently use SQLite.

**Unconfirmed:** the historical stall's cause, peak resident memory, filesystem latency under load,
and whether SQLite would outperform the existing stores. Separate session files do not rule out
contention in another shared resource.

## Ownership and conservation rules

**Proposed implementation contract:** every producer registers a storage class, owner, stable identity,
terminal/released state, protection reason, and retention policy through its existing authoritative
store. A cleanup coordinator may select candidates; only the owning subsystem may reclaim them.
Do not maintain a parallel mutable inventory as a second truth. A rebuildable index may accelerate
selection, but stale index entries must never authorize deletion.

Classify data before applying pressure:

- **Durable:** sessions, authored memory, credentials/configuration, resumable coordination state,
  evidence referenced by open work, and user backups. Never auto-delete these to satisfy a cache cap.
- **Leased transient:** owned work runs. Reclaim only after release, ownership validation, and a final
  liveness check through the existing cleanup owner. An idle process is not necessarily dead.
- **Rebuildable cache:** evict through its owner after checking active consumers. Rebuildable does not
  mean that deleting a live runtime's files is operationally harmless.
- **Installed runtime/model and worktree:** protect active executable generations, referenced model
  files, dirty/unmerged worktrees, and the required rollback version. Age alone is insufficient.
- **Legacy or unknown:** report separately. Lack of a manifest is not evidence of abandonment.

Count logical bytes, allocated bytes where available, file count, and protected versus eligible bytes
separately. Deduplicate hardlinks within the measured scope; do not assume copies across scopes are
unique physical allocation. Deletion failures, links, absent roots, permission errors, and incomplete
scans must be explicit, not treated as zero-sized success.

## Bounded work, not another background service

**Proposed initial experiment targets, not current defaults:**

- Maintenance uses an existing host-owned execution opportunity, not a persistent daemon or timer
  per lane. Coalesce requests; only one maintenance pass per owning scope may run at once.
- Each inspection slice visits at most 1,000 directory entries and yields after a 10 ms cooperative
  deadline. Check both budgets between operations. A slow filesystem call can exceed that deadline;
  use asynchronous I/O and report elapsed time rather than claiming a hard real-time bound.
- Count every visited entry, including malformed/unowned entries, against enumeration budgets. Keep
  a stable continuation cursor. Do not restart from the beginning on every request or skip forever
  over later candidates. Directory mutation must trigger bounded reconciliation, not a full hot-path scan.
- Keep at most 128 candidates and 4 MiB of maintenance metadata resident per coordinator; spill a
  bounded, owned page when necessary. Process fixed batches; release buffers between batches.
- Extend existing per-tenant policies with a host-configured aggregate inactive-work budget and a
  lower watermark. Select its value from measured deployment needs; this document changes no setting.
  Protected bytes are reported separately and may exceed the target. Never evict active work to fit it.
- When protected data dominates, pause optional producers or report explicit capacity pressure through
  the existing host authority. Do not silently lose tool terminals, session history, or user output.
- Persist deltas or bounded chunks. Never concatenate growing prefixes, rewrite unchanged history,
  rescan consumed input, or repeatedly serialize an unchanged projection on an interactive hot path.

**Confirmed and fixed enumeration defect:** `pruneWorkTenant` previously capped accepted manifests,
allowing hidden, unowned, and non-directory entries to exceed `maxScannedRuns`. The existing owner now
charges every directory entry against that bound. Deterministic tests reproduce all three rejected-entry
cases and retain a larger-budget control. This proves bounded enumeration, not a measured latency gain.
Continuation fairness and asynchronous pruning remain proposed; measure acquisition latency before
changing scheduling, and retain the current lease/deletion fencing.

## Cleanup protocol and operator instructions

The following is the **proposed preview/apply contract**, not an available `pi cleanup` CLI:

1. **Inspect without mutation.** Restrict traversal to named Pi storage roots. Use metadata only,
   bounded entries/time/depth, and no symlink traversal. Print aggregate classes, completeness, and
   lower bounds; keep private project names and raw session contents out of repository reports.
2. **Classify and explain.** For each proposed candidate record owner, identity/generation, size,
   eligibility reason, and every protection. Exclude durable, unknown, leased, referenced, and
   rollback-required objects. Discovery must not call APIs that remove stale markers.
3. **Preview.** Produce an immutable, expiring plan with its scope, policy version, bounded candidate
   set, and expected identities. Preview itself must neither delete nor migrate anything.
4. **Authorize the exact plan.** Destructive cleanup requires explicit owner approval. Neither a disk
   threshold, a request for a design, nor another agent's claim grants deletion authority.
5. **Revalidate at the owning boundary.** Reject changed identities, renewed leases, changed policy,
   new references, unexpected links, and scope escape. Acquire the existing exclusive cleanup fence,
   then recheck liveness. Unknown host/process state stays protected. Stale previews fail closed.
6. **Apply bounded batches.** Use the existing deletion owner, record outcomes idempotently, and
   continue from a durable cursor after interruption. Never remove a lease file to force eligibility.
   A crashed cleanup attempt must not permit both a new writer and an old deletion to proceed.
7. **Verify.** Report measured bytes actually reclaimed, failures, remaining protected bytes, and
   whether scanning was complete. Repeat the measurement method used for the baseline. An issued
   delete request is not reclaimed space, and a small directory count is not proof of low disk use.

**Available today:** the APIs and lease-aware retention described in [work-directory.md](work-directory.md)
remain authoritative. `pruneWorkTenant` is destructive and has no dry-run flag in its current signature;
do not call it as a preview. `hasActiveWorkRunLease` may remove stale markers. `pi doctor` is also not
an overall read-only storage inspector: [`doctor.ts`](../src/core/doctor.ts) includes dependency
provisioning. Do not recommend it as a no-side-effects size measurement command.

For current manual maintenance, first produce a scoped metadata report, identify eligible objects with
their owning subsystem, and obtain approval for the explicit cleanup operation. Do not offer a blanket
`rm -rf` for `work`, `state`, `sessions`, `cache`, or managed runtimes. Archiving durable sessions needs
an explicit export/restore plan with verified round-trip behavior; compaction is not permission to
remove the original history.

## Selective SQLite experiment

**Proposed only:** benchmark a session-scoped metadata store, behind the existing store interface,
against the current file implementation. Keep repository integration authority where it is; do not
split an invariant across file and database owners. Do not put artifacts or full transcripts in rows.

- Use primary keys for stable operation/lease identities, conditional transitions with expected
  generations, bounded rows, and idempotency keys. A stale worker must not commit after losing ownership.
- Keep transactions short. No network/model calls, child-process waits, filesystem scans, prompts, or
  arbitrary callbacks inside a transaction. Bound busy retries by the caller's remaining deadline;
  expose lock wait and transaction duration, support cancellation, and release on every failure path.
- Evaluate WAL only on validated local filesystems and supported packaged Node/Bun builds. SQLite
  still permits only one writer at a time; WAL requires same-host coordination, is not suitable for
  network filesystems, and needs checkpoint management. Long readers can prevent reset and grow the
  WAL. These are **confirmed upstream constraints**, not optional tuning details: see the
  [SQLite WAL documentation](https://sqlite.org/wal.html), sections 1, 2.2, and 6.
- Include database, WAL, shared-memory, free-page, and snapshot sizes in the budget. Bound page cache
  and connection count through the host's resource policy; aggregate them across active sessions.
  Do not run `VACUUM` or blocking checkpoints in foreground tool dispatch. Test idle maintenance and
  checkpoint starvation before selecting thresholds.
- No hot-path dual writes. At a quiescent, fenced boundary, validate and import into a temporary store,
  check invariants, then atomically switch the format/authority marker. Older clients must refuse an
  unsupported format instead of writing the old files. Crash recovery must choose one authority.
- Preserve one verified rollback snapshot for an explicitly bounded window. After new writes exist,
  rollback requires tested reverse export/replay or a stopped, owner-approved recovery; swapping in
  a stale snapshot loses state. Retire the old implementation and migration residue only after
  compatibility and rollback acceptance, not while two stores can disagree.

## Delivery increments and acceptance

**Proposed sequence:**

1. Ship bounded, non-mutating inspection with completeness reporting and a repeatable baseline.
2. Reproduce and fix enumeration/latency gaps at the existing owner. Add preview and revalidation
   around that owner; do not replace its safety protocol with another cleanup engine.
3. Apply an approved candidate batch and verify disk reclamation without losing active/durable state.
4. Run the SQLite experiment only if measured metadata contention or file overhead warrants it.
5. Promote a migration only with crash, compatibility, resource, and rollback proof. Otherwise retain
   the simpler file implementation and the cleanup improvements.

For each increment, exercise active/released/foreign-host/malformed leases; stale previews; path
replacement and symlinks; corrupt manifests; duplicate operations; cancellation; crash between claim
and deletion/commit; disk-full/permission failures; incomplete scans; and concurrent sessions.
Negative controls must show that active/durable/unowned objects remain untouched and that a contended
scope does not block an unrelated scope.

Measure foreground p50/p95/p99 latency, lock wait, process RSS, aggregate connection/cache memory,
visited entries, bytes written per operation, file count, and allocated disk after an equal workload.
Use fixed workloads with increasing history sizes and multiple sessions. Accept only correct results,
no unexplained omissions, no growing-prefix work, no more than 10% foreground p95 regression against
the same-host baseline, and a repeatable improvement in the targeted metric. These are proposed
acceptance targets, not measured gains. Keep per-worker budgets and concurrency under existing host
settings, not new hard-coded worker limits.

Existing focused starting gates (source development only):

```sh
node_modules/.bin/vitest run --root packages/coding-agent \
  test/work-directory.test.ts test/agent-paths.test.ts \
  test/orchestration-event-store.test.ts test/session-root-mailbox.test.ts --pool=forks
```

These tests cover existing owners, not the unimplemented preview or SQLite migration. Add failing
regressions and negative controls for new behavior. Full-suite, native Windows fixture, and packaged
cross-platform acceptance belong in CI; do not execute shell-script fixtures named `pi.exe` as native
Windows programs.

## Scope and remaining proof

This document verifies the cited owners and identifies implementation/review gates. It does not claim
an exhaustive machine inventory, live cleanup eligibility, reclaimed space, a shipped maintenance UI,
measured performance improvement, or a diagnosed cross-session deadlock. Installed releases outside
the agent directory, model stores, and deployment-specific mounts require separately bounded surveys.
