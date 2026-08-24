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
transient `work/` tree). The session ID is derived from the entry's single `AgentIdentityContract`;
process entries and resumable payloads do not carry parallel agent/session/lane context fields. All
post-registration transitions use the same per-entry lock and replace/delete only the exact process
generation they observed. An older same-session process therefore loses write ownership as soon as a
newer process registers; its late heartbeat, reconciliation, or exit hook cannot overwrite the newer
entry.

- **Master** (no declared parent): writes its own entry once at startup, heartbeats it on an
  interval, and -- once, at startup -- scans the matrix for **orphaned workers**: worker entries
  whose recorded parent pid is dead. `/new`, `/resume`, and `/fork` replace this session-owned
  runtime, so its identity, notifications, and scan always follow the active session.
- **Worker** (launched with `PI_PARENT_PID` / `--parent-pid` set): self-registers its own entry
  (the only writer of that entry during normal operation) and watches its parent's liveness on a
  poll interval.

### Resume: a master never auto-kills what it finds

On startup or in-process session resume, a master's orphan scan finds worker entries whose parent
is dead. It never assumes those workers are also dead -- a worker can outlive a crashed parent --
so it never kills anything. Recovery is identity-fenced:

- If the worker's recorded `parentSessionId` and `taskRef` exactly match the active session and its
  active goal/task identity, resume restores that existing ownership without another approval. A
  live worker is re-adopted; a dead worker with a complete resumable Pi context is relaunched as the
  same logical agent. Terminal or still-blocked goals disable automatic recovery. This works in
  interactive, print, and RPC modes and is the process-level counterpart to `/resume` restoring the
  goal before supervisors start.
- Every foreign orphan is report-only. Interactive mode never offers resume, adopt, or cleanup
  prompts: `taskRef` is a caller-supplied correlation value rather than a session-scoped ownership
  proof, and a shared cwd cannot establish ownership. The scan writes nothing, launches nothing,
  and kills nothing for foreign workers.

When an exact-session worker's own process is dead and its resumable payload contains a Pi session
context, the scan launches the exact persisted session file with its agent ID, cwd, worktree,
orchestration profile, resource pointers, and bounded wake task. The direct-argv launch prefers the
exact persisted `sessionFile` over an ID lookup, carries the stable logical-agent ID in
`PI_ORCHESTRATION_AGENT_ID`, and names the latest checkpoint plus bounded context pointers in the
wake prompt instead of copying a second transcript. The resumed process overwrites the same
`<role>-<sessionId>` matrix entry. The launcher publishes its PID before self-registration, and
terminal persistence plus delivery acknowledgement conditionally replace only the process
generation they observed. A stale completion can therefore never close a newer replacement. The
terminal event is first persisted as an undelivered matrix handoff, then delivered to the owning
parent session and marked delivered. If that owner switched sessions before the event arrived, the
bounded handoff survives and replays on its next resume instead of being injected into the wrong
transcript. The orphan claim/recovery scan leaves foreign entries untouched and report-only until
their own worker-side wind-down/TTL handling resolves them. Bounded reconciliation still performs
generation-fenced lifecycle maintenance, such as converting dead running Pi-worker records to
resumable so TTL can prune them and pruning terminal or expired records; it does not change their
parent/session identity or launch, adopt, or clean them up.

This behavior is identical in interactive, print, and RPC modes: the foreign-orphan claim/recovery
scan logs without prompting, writes, launches, or kills. Neutral reconciliation may still perform
the bounded lifecycle maintenance described above. Exact-session recovery remains active because it
restores an already-recorded authority relationship rather than claiming another session's worker.

### A worker on parent death: wind down, never vanish

A worker polls its parent's pid on `watcherPollMs`. The moment that pid is no longer alive, it:

1. Marks its own entry `winding_down` (reason `parent_lost`), then `resumable` with a payload
   containing one clone of its logical-agent identity (exact Pi session/cwd/profile/lane context),
   its stable task reference, and a bounded task summary.
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
| `PI_ORCHESTRATION_AGENT_ID` | launch-only | Pins the logical agent identity across the initial process and exact-session resumes. |
| `PI_TASK_REF` | `--task-ref <id>` | Pins the goal/task identity used to fence automatic recovery across process generations. |
| `PI_WORKER_ALLOWED_PATHS` | launch-only | JSON array of absolute paths compiled once into a worker session's structural filesystem envelope. `[]` preserves full-machine scope; malformed or relative entries fail startup. Process tools remain an explicit host-trust boundary. |

`tmux_agent_manager`'s `fire_task` sets the parent pid/session and logical agent ID automatically on
every `pi`-provider child it launches and always sets the worker path channel from the immutable
launch profile. Goal-bound launches also set `PI_TASK_REF` from `goalId`, the
same way lane-first dispatch threads `--worktree-lane` -- see `launch-profile.ts`'s
`WorkerLaunchProfile`.

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

The narrow exception in the orphan claim scan is identity-fenced exact-session recovery. Exact
recovery may restore the same recorded parent session without another prompt. Foreign orphans are
report-only and remain untouched by that scan; bounded reconciliation may still perform the
generation-fenced lifecycle/TTL maintenance described above.

## Foreign-CLI limitation

Only a `pi`-provider child self-registers and watches -- a non-`pi` agent launched via
`tmux_agent_manager` (a foreign CLI) has no way to be handed `--parent-pid`/`PI_PARENT_PID` and
act on it. Its managed lane and event watcher still provide durable lifecycle/audit records, but its
internal tool and thinking controls remain owned by that external CLI. Pi-only profile overrides are
rejected rather than represented as enforced across a boundary the host cannot structurally control.

## What this does not do

- It never kills a process. Every termination is the process's own cooperative self-exit.
- It does not re-attach a tmux pane or re-dispatch a lane when a foreign worker is found. Relaunch
  is reserved for a dead worker with a complete persisted Pi resume context and exact session+task
  identity. Mismatched and foreign identities remain report-only.
- Correctness never depends on a heartbeat or watcher tick arriving. Each master activation runs
  the pure reconciliation pass once: a Pi worker interrupted before its own resumable write is
  repaired from its durable logical-agent identity, closed and unrecoverable records are removed,
  undelivered terminal handoffs are retained, and resumable/adopted/pending-terminal records remain
  recoverable for at most 30 days before expiry.
