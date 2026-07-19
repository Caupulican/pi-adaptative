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
- `fire_task` — open provider CLIs in tmux panes, inject prompts, stream pane output through event-driven DONE/BLOCKED watchers, write result files, and wake the parent with a bounded terminal handoff.
- `send_followup` — re-inject a fresh prompt into an already-live job's pane (default: primary agent; `agentId` targets another) without relaunching. Re-arms the completion watcher for a new turn with a unique per-turn marker pair and reuses the same event-driven handoff.
- `dismiss` — stop tracking a job (no more re-arming/handoffs) without killing its tmux session; the pane keeps running.
- `job_status`, `list_jobs`, `set_variable`, `list_variables` — inspect and steer managed jobs.
- `stop_job`, `stop_session` — dry-run/confirmed tmux cleanup.
- `notify`, `set_status`, `clear_status` — tmux UI/status metadata.
- `grant_dispatch`, `revoke_grant` — create/end a standing approval grant that lets `fire_task`/`send_followup` dispatch unattended within its bounds (agent, budget, optional goal/tool/path scope). See Safety below.

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

Custom commands are CLI-start commands, not non-interactive `--print` runners:

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

A real (non-`dryRun`) `fire_task`/`send_followup` launch is approval-gated: it requires either a
standing grant (`grant_dispatch` — interactively confirmed, or authorized via the `--allow-tmux-dispatch`
flag when no UI is attached) or a one-shot interactive approval. With neither available, the launch is
refused, never silent. A grant-covered `pi` child launches with a restricted profile (`--tools`/
`--resource-profile` or `--no-extensions --no-skills`, plus a scoped `--append-system-prompt` naming the
grant and its hard stops) pushed into the child's own launch configuration — this is not an in-process
sandbox, and non-`pi` agents are bounded only at the launch layer; their internal tool-loop behavior is
that CLI's own responsibility. Grant budget (`maxLaunches`, expiry) is enforced; any advisory USD figure
or self-reported worker usage is a claim to review, never a hard cross-process cap.

Use `dryRun:true` when the task or provider choice is still ambiguous. Stop actions are destructive to running pane work, so they remain previews by default and require `confirm:"yes-tmux-stop"` for real cleanup.

The tool refuses existing tmux sessions. Existing job directories are refused unless `force:true`, which archives the old job directory under `~/.pi/agent/work/background/tmux-agent-manager/state/archives` before launching.

Do not put secrets in task text or command strings. Prompts, commands, captured pane logs, and result files persist under `~/.pi/agent/work/background/tmux-agent-manager/state/jobs` until work retention removes the inactive run.

Terminal result-file events wake the parent exactly once with a bounded, untrusted handoff. Do not poll or peek into panes to detect completion; inspect `job_status` or terminal artifacts afterward only when the bounded handoff is insufficient for a material claim.
