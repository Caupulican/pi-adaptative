# tmux agent manager

Pi ships an optional `tmux-agent-manager` extension for external interactive provider teams. The extension is packaged with Pi; do not install or maintain a separate copy under `~/.pi/agent/extensions`.

## Enable

Bundled extensions are discoverable in the resource-profile editor and load only when an active profile explicitly allows them. Example settings:

```json
{
  "activeResourceProfiles": ["tmux-agents"],
  "resourceProfiles": {
    "tmux-agents": {
      "extensions": {
        "allow": ["tmux-agent-manager"]
      }
    }
  }
}
```

Use `allow: ["*"]` in a broader trusted profile to enable all bundled extensions. `--no-extensions` still disables the manager.

## Requirements

- `tmux` on `PATH`
- Interactive provider CLIs used by the selected team template, such as `pi`, `claude`, `agy`, or `codex`
- No credentials in task text or command strings

Run `/tmux-agents` or call `tmux_agent_manager` with `action: "status"` to check availability.

## Completion contract

`fire_task` creates idle panes and arms one event-driven `tmux pipe-pane` watcher per worker. It then
starts every provider with the initial prompt file as part of the same CLI command
(`--prompt-interactive` for Agy), so task delivery cannot race TUI startup. Each watcher:

1. consumes pane output as it arrives;
2. writes one atomic terminal result when it sees the worker's `DONE` or `BLOCKED` marker, the pane closes, or its one-shot deadline expires;
3. updates tmux status metadata and emits a display notification.

On deadline, the watcher persists `timeout` first and then terminates its owned pane. A timed-out
provider process therefore cannot remain live and continue spending resources.

The parent Pi session watches result-file events. Once a turn's worker is terminal, it records a per-agent notification marker (`notifiedTurn`) and sends a bounded, source-labelled untrusted handoff with `triggerTurn: true`. Startup performs one reconciliation pass for terminal events produced while Pi was offline, and also reconciles tmux **sessions**: see [Persistence](#persistence-follow-ups-reconcile-dismiss) below.

Do not poll pane state, capture pane output, or inspect logs merely to detect completion. Use `job_status` or terminal artifacts after the handoff only when its bounded evidence is insufficient.

## Persistence: follow-ups, reconcile, dismiss

A `fire_task` pane's provider CLI stays alive and interactive after its first terminal marker. Three
actions manage that persistence:

- **`send_followup`** — re-injects a new prompt into an already-live job's pane (default: the job's
  first/primary agent; pass `agentId` to target another). It re-arms the completion watcher for a fresh
  turn using a unique per-turn marker pair, so it cannot be confused with an earlier turn's markers, and
  reuses the same event-driven, exactly-once handoff. Refuses if the tmux session or pane is gone
  (relaunch with `fire_task` instead) or if the job was `dismiss`ed.
- **`dismiss`** — stops tracking a job (no more re-arming, no more handoffs) without killing its tmux
  session; the pane keeps running and can still be attached to (`tmux attach -t <session>`) or stopped
  later with `stop_job`/`stop_session`. Dismiss detaches the completion watcher, so its old deadline no
  longer owns that pane.
- **Session reconcile** — on session start, Pi diffs live tmux sessions against its own job records for
  jobs it started. A session that has disappeared while its job was not yet terminal is marked orphaned
  (informational only — reconciliation never kills it to produce this state, and the job directory is never
  deleted automatically). A session that is still alive with a pending turn has its watcher re-armed so
  the job can still complete normally. Manual early termination stays behind the explicit
  `stop_job`/`stop_session` confirm path; a managed deadline terminates only its owned pane.

An idle worker (no turn currently dispatched) does not hold this session's reload-quiesce; `/reload` is
never blocked merely because a persistent tmux worker exists between turns.

Running managed lanes are checkpointed at dispatch and rehydrated with the same lane identity after
`/reload`. A later terminal event therefore completes the existing goal binding instead of minting a
replacement lane or risking a duplicate dispatch.

## Autonomous dispatch profiles

A real `fire_task` or `send_followup` runs autonomously without a UI prompt or CLI allow flag. Tmux
availability detection happens inside every action; `guard` is diagnostic only and is never a required
handshake.

Before `fire_task` creates any pane, watcher, prompt, or job artifact, it derives one immutable internal
execution profile per worker and durably reserves that worker's managed lane. Omitted tool and thinking
fields inherit the orchestrator's eligible worker surface. Omitted `path` uses the normal process cwd
while inheriting the host-derived full-machine scope except private harness paths. An explicit `path`
sets the process cwd and passes an immutable child-scope channel that enforces that workspace for Pi's
structured filesystem tools. Follow-up turns reuse the persisted profile and may change instructions,
never authority.

For `pi` workers, `tools`, `resourceProfile`, `thinkingLevel`, and `worktreeLane` become Pi CLI flags. The shared worker
ceiling removes memory, root-owned durable state, and agent-launching controls while retaining ordinary
inherited capabilities such as Python. When `resourceProfile` is omitted, the host compiles the
orchestrator's effective extension/skill/prompt/theme/agent/tool filters into a one-shot child profile;
an explicit value overrides that inheritance. The structured read/write/edit/search tools hard-deny
Pi's private auth, session, memory, settings, state, and work roots, and an explicit `path` further
restricts those structural calls to that workspace. Arbitrary process tools such as bash and
Python remain deliberate host-trust boundaries and can reach OS-visible files; this profile is not
misrepresented as process sandboxing. These fields are rejected for non-Pi providers because arbitrary
external CLIs own their own tool, thinking, and workspace controls; put native provider options in
`command` instead. A non-Pi `path` changes its cwd only. Its durable profile records one machine-wide,
host-trusted process (`bash` capability) rather than projecting the parent's Pi tool names or claiming
CLI/OS sandbox enforcement.

Any cooperative self-reported worker usage is **advisory** — a claim to review, never a hard cap across
the process boundary (the child bills under its own authentication).

Dispatched tmux workers appear as `tmux-worker` lanes alongside in-process worker lanes in `/autonomy`
and `delegate { action: "status" }`; a worker's self-reported changed files are re-checked against the session's active
write scope and flagged for parent review when out of scope, exactly like an in-process worker's.

## Goal-bound dispatch (`goal dispatch_worker dispatchTarget:"tmux"`)

The `goal` tool's `dispatch_worker` action can bind a single open requirement to a persistent tmux worker
instead of the default in-process one: pass `dispatchTarget: "tmux"`. Core invokes `fire_task` itself (the
same call the model would make) with exactly one `pi` agent, so the dispatch maps 1:1 to the
requirement's bound lane. The same autonomous profile derivation and pre-launch durable reservation
apply. A successful tmux dispatch waits and resumes through the same lane machinery as an in-process
worker.

When no worker was dispatched, the tool response's `dispatchSkipReason` explains why:

- `tmux_extension_not_loaded` — `tmux_agent_manager` is not loaded in this session (see Enable above).
- `tmux_dispatch_failed` — the `fire_task` launch threw (an invalid `launchKey`, a
  live session-name collision, an environment failure).
- `tmux_dispatch_incomplete` — the launch call returned without the job/agent details needed to identify
  the new lane.
- `lane_correlation_failed` — the new lane could not be resolved to its internal tracking id.
- `worktree_create_failed` — worktree-sync refused the lane before any tmux pane was launched.
- `worker_capability_insufficient` — the selected model is not eligible for a lane worker; no lane or pane was created.
- `requirement_already_bound` — the requirement is already bound to a lane that is still queued/running;
  no duplicate dispatch was attempted.
- `bound_lane_indeterminate` — the requirement is bound to a lane whose liveness/outcome cannot be
  determined because its durable record is missing or malformed; dispatch is refused rather than
  risking a duplicate worker. Normal `/reload` rehydrates running managed lanes. A bound lane with a
  confirmed terminal outcome allows a fresh dispatch normally.

## Safety

Launch actions run directly unless `dryRun: true` is requested. Stop actions can discard active pane
work, so they remain previews by default and require
`confirm: "yes-tmux-stop"` for execution. Existing sessions are never replaced silently; `force: true`
archives an old job directory but does not kill a live tmux session.

The package includes the extension README and team templates under `dist/bundled-resources/extensions/tmux-agent-manager/`; the source repository keeps them under the matching `src/bundled-resources/` path.
