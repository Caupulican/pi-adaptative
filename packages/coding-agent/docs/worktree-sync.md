# worktree-sync

`worktree_sync` is a core (built-in, not extension) tool: a hard-gated, worktree-per-lane
parallel-work workflow for a solo developer who does not use PRs. Every writing agent works in
its own local git worktree on its own lane branch; integration is always rebase-onto-main +
fast-forward — linear history, no merge commits, no PRs, no push. `origin` is never touched;
push stays a manual owner act.

## Workflow overview

1. A lane worktree is created off main (`create_lane`) with its own branch (`pi/wt/<laneKey>`).
2. The agent bound to the lane works and commits inside that worktree only.
3. Before landing, the lane must be fresh relative to main: `sync` rebases current main onto the
   lane branch. A clean rebase leaves the lane fresh; conflicts leave the rebase in progress and
   return a structured worklist.
4. `land` is the only door to main: serialized under one integration lock, freshness-checked,
   gate-command-verified, fast-forward-only.
5. A successful land bumps a shared integration epoch and marks every other active lane stale —
   structurally, not by convention — so the next lane to touch files or land is directed to sync
   first.
6. `release_lane` removes a fully-landed, clean lane worktree and branch.

Correctness never depends on a notification arriving; it depends on `land`'s own freshness check
(G3 below), re-derived from git at land time while holding the lock. Notifications only make
lanes aware *promptly*.

## Enabling

Enabled by default; `"worktreeSync": { "enabled": false }` is the explicit off-switch — zero
behavior change once set. Settings live under `worktreeSync` in `settings.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. Explicit `false` is the hard off-switch: the tool is hidden and no gating runs. |
| `mainBranch` | unset (auto) | Overrides default-branch resolution (`main`, then `master`; never guessed further). |
| `syncPolicy` | `"on_land_mandatory"` | Staleness-propagation policy — see below. |
| `gateCommand` | unset | Land gate command (G4), e.g. `"npm run check"`, run in the lane worktree at the exact tip that becomes main. |
| `gate` | `"on"` | `"off"` is the owner-level G4 opt-out, recorded per land event. Agents cannot flip this at runtime. |
| `gateTimeoutMs` | `900000` | Gate command timeout. |
| `maxLanes` | `5` | Active-lane ceiling; `create_lane` refuses beyond it. |
| `worktreesRoot` | agent-paths default | Overrides the lane-checkout root. |
| `workerLand` | `"deny"` | `"allow"` lets a WORKER session (see "Identity, UAC, and zero footprint" below) run `land` on its own bound lane; still subject to normal freshness/ownership gating. |

`syncPolicy` values:

- **`on_land_mandatory`** (default) — every successful land marks every *other* active lane
  `sync_required`; under this policy a stale lane's file mutations are refused until it syncs.
- **`overlap_mandatory`** — `sync_required` fires only when the land's changed paths overlap the
  lane's own changed paths; otherwise staleness stays advisory until land time.
- **`land_time_only`** — staleness is always advisory; only the land gate (G3) enforces.

## The hard gates (G1–G11)

Enforced in core code paths, never by prompt compliance. Every refusal carries a tagged code and
appends an audit event.

| # | Gate |
|---|---|
| G1 | `land` is serialized under one integration lock — two concurrent lands are impossible. |
| G2 | `land` requires the lane worktree clean (no uncommitted/untracked-modified state). Refusal: `lane_dirty`. |
| G3 | `land` requires the lane fresh (current main is an ancestor of the lane tip), re-derived from git while holding the lock. Refusal: `stale_lane` + a structural sync directive. This is the backstop that cannot be evaded even if every notification failed. |
| G4 | `land` requires the configured gate command to pass at the exact tip that will become main, unless the owner set `gate: "off"` (recorded per land event). |
| G5 | Main only ever moves by a fast-forward merge of the lane branch in the hub checkout — no merge commits, no force, no rewrite of main. |
| G6 | `land` refuses `hub_dirty` only when hub-local modifications intersect the land's changed-file set (overlap-based, not pristine-hub-based). |
| G7 | A successful land bumps the epoch and broadcasts staleness in the same critical section as the merge, before the lock releases. |
| G8 | A stale lane under the mandatory policy is refused by the file-mutation tools (edit/write/mutating bash) of a lane-bound `pi` session until it syncs. Hard for `pi` children; cooperative for foreign CLIs. |
| G9 | Sync completion requires the rebase finished, zero conflict markers (byte-scanned), and freshness passing. Refusals: `conflict_markers_present`, `rebase_in_progress`. |
| G10 | No lane touches main directly — a lane-bound `pi` session's `git commit/merge/rebase/reset/switch` targeting main is refused (`main_mutation_refused`). Main is written by the land gate alone. |
| G11 | A lane with unlanded commits or dirty state is never auto-deleted; `release_lane` on such a lane requires `confirm: "yes-discard-lane"`. |

## The `worktree_sync` tool

One tool, eight actions — the entire agent-facing surface, so a model never improvises git
ceremony. Every outcome carries a tagged code (`details.code`) and refusal text always names the
exact recovery step.

| Action | Effect |
|---|---|
| `status` | The deterministic full picture: epoch, hub state, lock, per-lane freshness/staleness/dirty/rebase state, and a one-sentence assembled `advice`. Read-only. |
| `create_lane` | Worktree add + branch + registration off main. Params: `laneKey?` (else auto-allocated), `goalId?`, `requirementId?`. |
| `sync` | Rebases current main into the lane branch. Clean → lane fresh. Conflicts → rebase left in progress plus a structured worklist. |
| `continue` | After conflicts are resolved: verifies zero conflict markers, stages, and drives the rebase to completion (looping per conflicted commit). |
| `abort_sync` | Aborts the in-progress rebase; the lane returns to its pre-sync tip, still honestly reported as stale. |
| `land` | The full G1–G7 pipeline. On success returns the new epoch and main sha. |
| `release_lane` | Unregisters the lane and removes the worktree/branch — only when fully landed and clean, else the G11 confirm. |
| `reconcile` | Re-syncs the lane registry with git reality (orphaned worktrees, stale locks, cleared owners). Runs automatically at startup; also directly callable. |

## Lane lifecycle

`create` → work/commit on the lane branch → `sync` (rebase current main in) → resolve conflicts
locally and `continue` → `land` → (optionally) `release`. Landing does not happen automatically
when a worker finishes its task — it is a distinct, deliberate step the orchestrator (or the
worker, when instructed) triggers, since the gate run at land time is itself the evidence the
goal record relies on.

## Session binding: `PI_WORKTREE_LANE` / `--worktree-lane`

A session becomes lane-bound via the `PI_WORKTREE_LANE=<laneKey>` environment variable, or the
`--worktree-lane <laneKey>` CLI flag (sugar over the same env contract — tmux panes launched by a
lane-first goal dispatch inherit it automatically). A lane-bound session:

- gets the G8/G10 lane gate wrapped under its file-mutation tools (edit/write/bash);
- defaults `worktree_sync`'s `laneKey` param to its own bound lane for `sync`/`continue`/
  `abort_sync`/`land`, so the model rarely needs to pass it explicitly;
- runs a lane-sync watcher (an `fs.watch` on the shared epoch file, checked at every turn start)
  that injects a source-labelled system notice when the epoch changes, so the session learns
  about staleness promptly instead of only at its next `status` call.

A goal-bound tmux dispatch (`goal` tool's `dispatch_worker` with `dispatchTarget: "tmux"`, when
`worktreeSync.enabled`) creates the lane first, then launches its `pi` worker with `--worktree-lane
<laneKey>` and one extra system-prompt clause naming the lane doctrine (work only inside this
lane's worktree; integrate exclusively via `worktree_sync land`; never touch main directly). A
lane-creation refusal (e.g. `maxLanes` reached) aborts the dispatch cleanly before any tmux
session is ever launched (`dispatchSkipReason: "worktree_create_failed"`).

## Capability adaptation

The lane-worker surface adapts to the model actually driving it, riding the existing model-capability
system (`core/model-capability.ts`) rather than a parallel mechanism. A model is eligible to drive a
worktree-sync lane worker only if it is BOTH capability class `full` AND has a working native
tool-call path:

- **Class `full`** with a DECLARED context window: the classifier reads the model's own REGISTRY
  metadata (`Model.contextWindow` -- the source of truth), never the live serving context a local
  runtime happens to be configured with; an unknown/undeclared window is treated as ineligible for
  lane-worker duty even though it defaults to class `full` for the general tool surface.
- **Advertised native tool calling**: `Model.textToolCallProtocol` unset or `false`. A model with
  `textToolCallProtocol: true` is phone-only by declaration and never eligible.
- **Not graded-demoted**: a persisted `/toolprobe` verdict of `"text-protocol"` or `"none"` makes the
  model ineligible. An UNPROBED model (no verdict on record yet) is eligible on its advertised
  support alone -- unprobed is never treated as demoted.

Additionally, the lean capability class (16k-32k context window) sheds the orchestration surface
entirely: `goal`, `worktree_sync`, `improvement_loop`, `extensionify`, `skillify`, `model_fitness`,
`context_scout`, and `tmux_agent_manager` are blocked for a lean-class session regardless of lane
binding (`MODEL_CAPABILITY_LEAN_BLOCKED_TOOLS`) -- `run_toolkit_script` and `task_steps` stay
available by design.

Two refusal points, one authority:

- A goal→tmux dispatch (`tools/tmux-dispatch.ts`'s `dispatchTmuxWorker`) checks the DISPATCHING
  session's own eligibility FIRST, before `createLaneWorktree` or any `fire_task` call --
  `dispatchSkipReason: "worker_capability_insufficient"`, zero lane/pane side effect on refusal. This
  is the parent's best-effort expectation only; it can race a model swap between dispatch and child
  startup.
- The DISPATCHED child session refuses AUTHORITATIVELY at its own startup (main.ts), regardless of
  how it became lane-bound (`--worktree-lane`, `PI_WORKTREE_LANE`, or a launcher-set env): an
  ineligible model prints a deterministic, greppable refusal line (`formatLaneWorkerRefusal`, prefix
  `worktree-sync lane-worker refusal:`) and exits with a non-zero status before the lane gate or the
  epoch watcher ever start. There is no silent unbinding -- a session that cannot drive the surface
  never gets a reduced version of it, it never starts.

Enforcement is orthogonal to prompt complexity: the lane gate (G8/G10) and the epoch watcher stay
wired for every OTHER session exactly as before this system existed. An ineligible session simply
never reaches them, because it never reaches session startup's live phase at all.

## Identity, UAC, and zero footprint

A session's **role** (`main` or `worker`) is derived structurally, never asserted by the session
itself (`core/session-role.ts`): a session is a **worker** iff it is bound to a worktree-sync lane
(`PI_WORKTREE_LANE`) OR launched with `PI_SESSION_ROLE=worker`. `PI_SESSION_ROLE=main` is
deliberately **not** an escalation -- it can never override a bound lane, so there is no
environment value a lane-bound process can set to shed the worker ceiling below.

### Forbidden-tool ceiling

A worker session can never activate: `goal`, `delegate`, `delegate_status`, `improvement_loop`,
`extensionify`, `skillify`, `run_toolkit_script`, `model_fitness`, `tmux_agent_manager`,
`context_scout`, `python`. This is enforced as the FIRST line of the tool registry's allow
predicate (`RuntimeBuilder.refreshToolRegistry`'s `isAllowedTool`) -- it wins over an allow-list,
an exclude-list, or an active resource profile that names the tool explicitly. `goal`/`delegate`/
`delegate_status`/`tmux_agent_manager` are sub-orchestration (a worker dispatching its own workers
defeats single-owner lane accountability); `improvement_loop`/`extensionify`/`skillify` are
self-adaptation surface a worker should never mutate; `run_toolkit_script`/`model_fitness` spend
budget a worker's dispatcher does not control. **`python`** is included because it is a bounded but
still largely unrestricted execution contract -- excluding it is load-bearing for the zero-footprint
guarantee below (an unbounded interpreter can write state anywhere it can reach on disk).
**`context_scout`** is excluded because it is itself sub-orchestration: it spawns its own isolated
agent loop.

`bash` is deliberately **not** forbidden. It stays available as the same documented cooperative
boundary the lane gate already applies to foreign (non-`pi`) CLIs it cannot structurally contain --
a worker's bash access is bounded by the lane gate's G8/G10 rules and the path envelope below, not
by removing the tool.

### `worktree_sync` tool scoping for a worker

A worker session's `worktree_sync` calls are narrowed at the tool layer (independent of the engine
-- see the next section):

- `status`, `sync`, `continue`, `abort_sync` stay available unconditionally.
- `create_lane`, `release_lane`, `reconcile` are always refused (`role_forbidden`).
- `land` is refused by default (`role_forbidden`); the new `worktreeSync.workerLand` setting
  (`"deny"` default, `"allow"` opt-in) lets a worker land its own lane when set -- still subject to
  the normal freshness/ownership gates below.
- An explicit `laneKey` that differs from the session's own bound lane is always refused
  (`role_forbidden`): a worker may only ever target its own lane.

### Land/release ownership

`land` and `release_lane` refuse `lane_owner_conflict` when the target lane is owned (its
registration's `ownerSessionId`) by a **different, still-alive** session -- same-host pid liveness,
the same pattern the integration lock and `reconcile` already use. A lane with no recorded owner,
owned by the calling session itself, or whose recorded owner is dead never conflicts. This check is
deliberately engine-level and applies to `land`/`release_lane` ONLY -- `sync`/`continue`/
`abort_sync` are never owner-gated at the engine; a worker's cross-lane containment for those comes
from the tool-layer `laneKey` check above. `release_lane`'s existing G11 discard-confirm requirement
is unaffected: it still applies once ownership no longer conflicts.

### Edit/write path envelope

For a lane-bound session, `edit`/`write` targets are checked against the lane's own worktree root
(`WorktreeLaneGate.checkMutation`'s `targetPath` parameter, resolved by `RuntimeBuilder`'s tool
wrapper via the same `resolveToCwd` the tools themselves use). The check is symlink-safe: the
lane's worktree root and the target are both resolved through `realpath` (walking up to the target's
nearest EXISTING ancestor when the target itself does not exist yet, so a not-yet-created file
cannot be smuggled through a symlink that escapes the lane). A target outside the resolved lane root
is refused (`path_outside_lane`). No active lane record leaves the existing fail-open behavior
unchanged. `bash` is untouched by this check -- its containment stays the G10 cooperative boundary
described above.

### Zero state/settings footprint

A worker session leaves no footprint in `~/.pi/agent/state` or `settings.json`: every scattered
on-disk store (`ToolPerformanceStore`, `ObservationStore`, `ModelAdaptationStore`, `FitnessStore`,
`ProjectTrustStore`) takes a `readOnly` constructor option defaulting to `isWorkerSession()`, gated
ABOVE any locking/directory-creation the store's write path performs -- never at the innermost
`writeFileSync` alone, since the lock itself already creates a lockfile and parent directory before
any write. A read-only store still returns the value a real write would have produced (e.g.
`ObservationStore.increment` returns `base + 1`, `ModelAdaptationStore`'s internal `store()` returns
the computed entry) so callers see normal in-memory behavior; nothing durable ever lands on disk.
`SettingsManager`'s single write choke (`enqueueWrite`, used by every settings scope: global,
project, and directory-profile) is gated the same way -- a worker session never writes
`settings.json` in any scope; in-memory settings reads are unaffected since callers update the
in-memory state before reaching the write queue. The one INTENTIONAL artifact a worker session still
produces is its own session transcript -- that is the point of running it, not a footprint to avoid.

## Trust boundary (honest, not faked)

- **`pi` children are hard-gated**: G8/G10 run in core code, wrapped under the file-mutation
  tools of any lane-bound `pi` session — a stale mutation or a direct write to main is refused
  structurally, not by prompt compliance.
- **Foreign CLIs (agy/claude/codex/opencode/custom) are cooperative only**: their internal tool
  loop is that CLI's own responsibility; the harness cannot enforce G8/G10 inside a process it
  does not control. Sync directives can still be pushed to a live foreign pane via the tmux
  extension's existing `send_followup`, but compliance is not guaranteed.
- **The land gate (G1–G7) is the backstop that cannot be evaded by either kind of worker**: no
  matter how a lane got dirty, stale, or ignored a notification, `land` re-derives freshness and
  cleanliness from git itself while holding the integration lock. A stale or dirty lane cannot
  land, full stop.
