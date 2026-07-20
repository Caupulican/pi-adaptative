# process-matrix

`core/process-matrix` is a durable, restart-surviving record of every `pi` process on this
machine and how they're related: a **master** (an interactive/direct session, or the root of a
launch chain) and its **workers** (sessions launched with a known parent -- today, tmux-dispatched
agents). It answers one question reliably even across a crash: *if my parent is gone, what do I
do?* -- and a companion question on resume: *did I leave orphaned children behind, and what should
happen to them?*

The matrix is an index of process identity and lifecycle status, not a scheduler: it never decides
what work runs, only how a process winds down or gets re-parented when its relationship to another
process breaks.

## Supervision model

Every `pi` process registers exactly one entry in the matrix, keyed by `<role>-<sessionId>`, under
`state/process-matrix/` (see `agent-paths.ts` -- durable, survives `/reload` and crashes, not the
transient `work/` tree).

- **Master** (no declared parent): writes its own entry once at startup, heartbeats it on an
  interval, and -- once, at startup -- scans the matrix for **orphaned workers**: worker entries
  whose recorded parent pid is dead.
- **Worker** (launched with `PI_PARENT_PID` / `--parent-pid` set): self-registers its own entry
  (the only writer of that entry during normal operation) and watches its parent's liveness on a
  poll interval.

### Resume: a master never auto-kills what it finds

On startup, a master's orphan scan finds worker entries whose parent is dead. It never assumes
those workers are also dead -- a worker can outlive a crashed parent -- so it never kills or
silently repurposes anything. Instead, for each orphan, **interactively**:

1. Ask: *"adopt worker `<entryId>` (lane `<laneKey>`)?"* Yes → this session becomes the worker's
   new parent (an adoption grant is written into the worker's own entry).
2. If declined: ask *"clean up worker `<entryId>` gracefully?"* Yes → a cooperative wind-down
   request is written into the worker's entry (the worker notices and self-exits; nothing is
   killed).
3. If both declined: leave the entry untouched.

**Non-interactively** (print/RPC mode, or no TTY), the scan is report-only: it logs what it found
and writes nothing, kills nothing. The one-time startup scan is the only place a master ever
touches another session's entry, and only with explicit owner confirmation each time.

### A worker on parent death: wind down, never vanish

A worker polls its parent's pid on `watcherPollMs`. The moment that pid is no longer alive, it:

1. Marks its own entry `winding_down` (reason `parent_lost`), then `resumable` with a payload
   (its worktree-sync lane key, if bound) describing how the task could be picked back up.
2. Emits one steer notice into its own session.
3. Starts a bounded grace window (`adoptionGraceMs`), polling its own entry every
   `watcherPollMs` for a directive a new master may have written (see above):
   - **Adopted** (entry's `parentPid` changed to a new, live pid): re-parents to the new master
     and resumes normal watching -- no task loss.
   - **Cooperative cleanup requested**: exits immediately.
   - **Grace window expires** with no directive: exits, leaving the entry `resumable` for a future
     session to notice.

"No new turns" after a parent is lost is automatic and requires no separate mechanism: a dead
parent injects no further follow-ups, so the worker simply runs out of work on its own.

## Env + CLI flag contract

Cross-process, like `PI_WORKTREE_LANE`/`--worktree-lane`:

| Env | CLI sugar | Meaning |
|---|---|---|
| `PI_PARENT_PID` | `--parent-pid <pid>` | Declares this process as a worker of `<pid>`. A malformed or non-positive value is ignored (never a crash on bad env) -- the process falls back to acting as a master. |
| `PI_PARENT_SESSION` | `--parent-session <id>` | The parent's sessionId, recorded alongside the pid for diagnostics/adoption. |

`tmux_agent_manager`'s `fire_task` sets both automatically on every `pi`-provider child it
launches (its own pid/sessionId), the same way it threads `--worktree-lane` for a lane-first
dispatch -- see `dispatch-grant.ts`'s `LaunchProfileSource.parentPid`/`parentSession`.

## Settings

`processMatrix` in `settings.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. Explicit `false` is the hard off-switch: no entry is ever written, no scan runs, no watcher runs -- zero behavior change once set. |
| `heartbeatMs` | `30000` | Master heartbeat interval (bounds: 1000-600000). |
| `adoptionGraceMs` | `300000` | How long an orphaned worker waits for an adopt/cleanup directive before self-exiting (bounds: 5000-3600000). |
| `watcherPollMs` | `25000` | Poll cadence for parent-liveness and directive checks (bounds: 1000-600000). |

## The zero-footprint sanction

A worker session otherwise carries a strict UAC ceiling and a zero-footprint guarantee -- see
`docs/worktree-sync.md`'s "Identity, UAC, and zero footprint". A worker's writes to its **own**
process-matrix entry are a sanctioned artifact, exactly like its own session transcript: the role
ceiling is untouched, and this is not a new escalation surface. A worker never writes any *other*
session's entry.

The one narrow exception on the master side: during the ask-gated startup orphan scan, a master
that the owner explicitly told to adopt or clean up a specific orphan writes that grant directly
into the *orphan's* own entry (never anywhere else, never without that confirmation). This mirrors
`worktree-sync`'s integration-lock takeover of a provably dead owner's resource -- a new owner may
claim what a dead owner left behind, audited (here, by the interactive confirmation itself) rather
than assumed. Outside that one handshake, a master never writes another session's entry.

## Foreign-CLI limitation

Only a `pi`-provider child self-registers and watches -- a non-`pi` agent launched via
`tmux_agent_manager` (a foreign CLI) has no way to be handed `--parent-pid`/`PI_PARENT_PID` and
act on it. Its lifecycle stays bounded only at the launch layer (agent/budget/count), the same
documented limitation `worktree-sync` already has for foreign CLIs -- not a hidden gap, a
cooperative boundary this system cannot structurally enforce across an arbitrary external process.

## What this does not do

- It never kills a process. Every termination is either the process's own cooperative self-exit or
  an owner-confirmed grant the process itself later notices and applies.
- It does not re-attach a tmux pane or re-dispatch a lane on adoption -- adoption changes who a
  worker considers its parent, nothing about its tmux session or worktree-sync lane state.
- Correctness never depends on a heartbeat or a watcher tick arriving -- a crashed process just
  leaves a stale entry behind. `supervisor.ts`'s `reconcileMatrix` (prune `closed` and any
  `running`/`winding_down` entry whose own pid is dead; keep `resumable`/`adopted` until they age
  past a TTL) is the building block for cleaning those up; nothing in this build wires it into an
  automatic sweep yet -- the matrix directory is left to grow with stale entries until a future
  caller (a manual command, or a periodic sweep) invokes it.
