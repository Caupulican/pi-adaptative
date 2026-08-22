# tmux Agent Manager

Portable bundled extension for event-driven external-provider teams in tmux. Enable it from a resource profile with `extensions.allow: ["tmux-agent-manager"]` (or `"*"`).

## Platform policy

- Use this extension on Linux, Windows-through-WSL/MSYS/Cygwin, and macOS when `tmux` is on `PATH`.
- Do not use `cmux` on Windows/Linux. The cmux manager is manual-only and disabled outside macOS.
- Gemini is intentionally not a native provider here; Agy covers that lane. Claude remains native Claude.

## Tool

`tmux_agent_manager`

Important actions:

- `status` — detect `tmux`, current session, and known sessions.
- `setup_help` — show install hints.
- `list_templates` / `show_template` — inspect reusable owner templates.
- `workspace_plan` — dry-run a tmux session/pane layout.
- `launch_workspace` — launch panes immediately; pass `dryRun:true` only when a preview is useful.
- `fire_task` — create provider panes, arm event-driven DONE/BLOCKED capture, then atomically start each CLI with its initial task, write result files, and wake the parent with a bounded terminal handoff.
- `send_followup` — re-inject a fresh prompt into an already-live job's pane (default: primary agent; `agentId` targets another) without relaunching. Re-arms the completion watcher for a new turn with a unique per-turn marker pair and reuses the same event-driven handoff.
- `dismiss` — detach completion capture and stop tracking a job without killing its tmux session; the pane keeps running and the old deadline no longer owns it.
- `job_status`, `list_jobs`, `set_variable`, `list_variables` — inspect and steer managed jobs.
- `stop_job`, `stop_session` — dry-run/confirmed tmux cleanup.
- `notify`, `set_status`, `clear_status` — tmux UI/status metadata.

Tmux availability is detected automatically for each action. `guard` remains a diagnostic action, not a
required launch handshake.

At session start, live tmux sessions are reconciled against this session's own job records: a session
that vanished while its job was not yet terminal is marked orphaned (informational only, nothing is
killed); a session that is still alive with a pending turn has its watcher re-armed.

## Built-in team templates

Templates are embedded in the tool and loaded at runtime from JSON under `templates/` / `~/.pi/agent/work/background/tmux-agent-manager/state/templates`. JSON templates with the same name override embedded defaults.

- `provider-prompt-smoke` — real minimal interactive prompt smoke for native Claude, Agy, and Pi. Consumes provider/model tokens.
- `full-provider-review` — Pi lead + Claude reviewer + Agy validator + Agy reviewer. Uses native provider CLIs and consumes model/provider tokens.
- `builder-validator` — Agy builder + Claude reviewer + Agy validator + Pi coordinator for scoped implementation/QA.

Example:

```ts
tmux_agent_manager({ action: "list_templates" })
tmux_agent_manager({ action: "show_template", teamTemplate: "builder-validator" })
tmux_agent_manager({
  action: "fire_task",
  teamTemplate: "builder-validator",
  task: "Implement the scoped fix, then independently review and validate. Report PASS/BLOCKED with evidence."
})
```

Custom commands are interactive CLI-start commands that accept the initial prompt as their final
positional argument, not non-interactive `--print` runners:

```ts
tmux_agent_manager({
  action: "fire_task",
  task: "Run through my local Claude wrapper CLI, then report PASS/BLOCKED.",
  agents: [
    { provider: "claude", name: "claude-wrapper", command: "my-claude-wrapper" },
    { provider: "agy", name: "agy-validator" },
    { provider: "pi", name: "pi-coordinator" }
  ]
})
```

## Safety

Real `fire_task` and `send_followup` actions run autonomously without a CLI allow flag or UI confirmation.
Before any pane, watcher, prompt, or job artifact is created, `fire_task` derives one
immutable internal execution profile for every worker and durably reserves its managed lane. Omitted
tool and thinking fields inherit the orchestrator's eligible worker surface. Omitted `path` uses the
normal process cwd while inheriting the host-derived full-machine scope except private harness paths;
an explicit `path` sets the worker cwd and enforces that workspace for Pi's structured filesystem tools.

For a `pi` worker, `tools`, `resourceProfile`, `thinkingLevel`, and `worktreeLane` are rendered into Pi
CLI flags. The shared worker ceiling removes memory and agent-launching/root-owned controls while
keeping eligible execution tools such as Python, and a scoped system prompt requires autonomous work
inside the assigned profile.
When `resourceProfile` is omitted, a one-shot profile inherits the parent's effective resources; an
explicit value overrides it. Pi's structured read/write/edit/search tools hard-deny private harness
roots and honor an explicit workspace path. Bash/Python remain explicit host-trust boundaries with
OS-visible filesystem access; the profile does not claim process sandboxing.
Those four overrides are rejected for non-Pi providers because an external CLI owns its own tool,
thinking, and workspace controls; use that provider's native options in `command`. A non-Pi `path`
changes cwd only. Its durable profile truthfully records a machine-wide host-trusted process instead of
projecting the parent's Pi tool list. Cooperative usage reports remain advisory claims, never hard
cross-process billing limits.

Capture is armed before the initial provider command starts. The prompt file is passed with that same
command (`--prompt-interactive` for Agy), eliminating the startup keystroke race. A deadline first
persists the terminal timeout and then terminates the owned tmux pane so a timed-out CLI cannot keep
spending resources in the background.

Use `dryRun:true` when the task or provider choice is still ambiguous. Stop actions are destructive to running pane work, so they remain previews by default and require `confirm:"yes-tmux-stop"` for real cleanup.

The tool refuses existing tmux sessions. Existing job directories are refused unless `force:true`, which archives the old job directory under `~/.pi/agent/work/background/tmux-agent-manager/state/archives` before launching.

Do not put secrets in task text or command strings. Prompts, commands, captured pane logs, and result files persist under `~/.pi/agent/work/background/tmux-agent-manager/state/jobs` until work retention removes the inactive run.

Terminal result-file events wake the parent exactly once with a bounded, untrusted handoff. Do not poll or peek into panes to detect completion; inspect `job_status` or terminal artifacts afterward only when the bounded handoff is insufficient for a material claim.
