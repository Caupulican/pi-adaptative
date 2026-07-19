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

Off by default — zero behavior change until turned on. Settings live under `worktreeSync` in
`settings.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. Off = the tool is hidden and no gating runs. |
| `mainBranch` | unset (auto) | Overrides default-branch resolution (`main`, then `master`; never guessed further). |
| `syncPolicy` | `"on_land_mandatory"` | Staleness-propagation policy — see below. |
| `gateCommand` | unset | Land gate command (G4), e.g. `"npm run check"`, run in the lane worktree at the exact tip that becomes main. |
| `gate` | `"on"` | `"off"` is the owner-level G4 opt-out, recorded per land event. Agents cannot flip this at runtime. |
| `gateTimeoutMs` | `900000` | Gate command timeout. |
| `maxLanes` | `5` | Active-lane ceiling; `create_lane` refuses beyond it. |
| `worktreesRoot` | agent-paths default | Overrides the lane-checkout root. |

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
