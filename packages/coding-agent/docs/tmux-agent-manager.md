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

`fire_task` creates panes, injects prompts, and arms one event-driven `tmux pipe-pane` watcher per worker before returning. Each watcher:

1. consumes pane output as it arrives;
2. writes one atomic terminal result when it sees the worker's `DONE` or `BLOCKED` marker, the pane closes, or its one-shot deadline expires;
3. updates tmux status metadata and emits a display notification.

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
  later with `stop_job`/`stop_session`.
- **Session reconcile** — on session start, Pi diffs live tmux sessions against its own job records for
  jobs it started. A session that has disappeared while its job was not yet terminal is marked orphaned
  (informational only — nothing is ever killed to produce this state, and the job directory is never
  deleted automatically). A session that is still alive with a pending turn has its watcher re-armed so
  the job can still complete normally. Killing a session always stays behind the explicit
  `stop_job`/`stop_session` confirm path.

An idle worker (no turn currently dispatched) does not hold this session's reload-quiesce; `/reload` is
never blocked merely because a persistent tmux worker exists between turns.

## Approval-gated dispatch: the standing grant

A real (non-dry-run) `fire_task` or `send_followup` launch requires either a **standing grant** or a
one-shot interactive approval — never a silent launch:

- **`grant_dispatch`** authorizes repeated unattended dispatch. Set `agent` (required), `maxLaunches`
  (required), and optionally `goalId` (an unscoped grant covers any goal), `allowedTools`,
  `resourceProfile`, `writePaths`, and `expiresInMinutes`. Requires interactive confirmation when a UI is
  attached; in print/rpc/non-interactive mode, requires the `--allow-tmux-dispatch` CLI flag instead.
  Once granted, matching launches proceed unattended and consume one unit of `maxLaunches` for each child process launched.
- **`revoke_grant`** ends a standing grant early (defaults to whichever grant is currently active).
- With **no covering grant**: an interactive session is prompted for a one-shot approval; a
  non-interactive session (no UI, no grant) is **refused** with a clear error — never launched silently.

A grant-covered (or one-shot-approved) `pi` child is launched with a **restricted profile**: `--tools`
(or a read-biased default), `--resource-profile` (or `--no-extensions --no-skills`), and a scoped
`--append-system-prompt` naming the grant and a fixed hard-stop list (publish/push/tag/credential
changes/destructive deletion must come back BLOCKED, never self-approved). This pushes the envelope into
the **child's own** launch configuration — it is not an in-process sandbox, and non-`pi` agents
(`agy`/`claude`/`codex`/`opencode`/custom) are bounded only at the launch layer; their internal tool-loop
behavior is that CLI's own responsibility.

Grant budget (`maxLaunches`, `expiresInMinutes`) is real and enforced. `maxUsdAdvisory` and any
self-reported worker usage are **advisory** — a claim to review, never a hard cap across the process
boundary (the child bills under its own authentication).

Dispatched tmux workers appear as `tmux-worker` lanes alongside in-process worker lanes in `/autonomy`
and `delegate_status`; a worker's self-reported changed files are re-checked against the session's active
write scope and flagged for parent review when out of scope, exactly like an in-process worker's.

## Goal-bound dispatch (`goal dispatch_worker dispatchTarget:"tmux"`)

The `goal` tool's `dispatch_worker` action can bind a single open requirement to a persistent tmux worker
instead of the default in-process one: pass `dispatchTarget: "tmux"`. Core invokes `fire_task` itself (the
same call the model would make) with exactly one `pi` agent, so the dispatch maps 1:1 to the
requirement's bound lane; the launch still goes through the standing-grant authorization above unchanged
— an unattended goal/idle loop with no covering grant is honestly refused, never silently launched. The
requirement's binding is recorded either way; a successful tmux dispatch waits and resumes through the
same lane machinery as an in-process worker.

When no worker was dispatched, the tool response's `dispatchSkipReason` explains why:

- `no_standing_grant` — no covering grant, and this call had no UI to prompt (run `grant_dispatch` first).
- `tmux_extension_not_loaded` — `tmux_agent_manager` is not loaded in this session (see Enable above).
- `tmux_dispatch_failed` — the `fire_task` launch threw for a reason other than the grant (a bad jobId, a
  live session-name collision, an environment failure).
- `tmux_dispatch_incomplete` — the launch call returned without the job/agent details needed to identify
  the new lane.
- `lane_correlation_failed` — the new lane could not be resolved to its internal tracking id.
- `worktree_create_failed` — worktree-sync refused the lane before any tmux pane was launched.
- `worker_capability_insufficient` — the selected model is not eligible for a lane worker; no lane or pane was created.
- `requirement_already_bound` — the requirement is already bound to a lane that is still queued/running;
  no duplicate dispatch was attempted.
- `bound_lane_indeterminate` — the requirement is bound to a lane whose liveness/outcome cannot be
  determined (e.g. after `/reload`); dispatch is refused rather than risking a duplicate worker. A bound
  lane with a confirmed terminal outcome allows a fresh dispatch normally.

## Safety

Launch actions run directly unless `dryRun: true` is requested, and are approval-gated per the standing
grant above. Stop actions can discard active pane work, so they remain previews by default and require
`confirm: "yes-tmux-stop"` for execution. Existing sessions are never replaced silently; `force: true`
archives an old job directory but does not kill a live tmux session.

The package includes the extension README and team templates under `dist/bundled-resources/extensions/tmux-agent-manager/`; the source repository keeps them under the matching `src/bundled-resources/` path.
