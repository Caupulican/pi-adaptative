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

The parent Pi session watches result-file events. Once every worker is terminal, it records an exactly-once notification marker and sends a bounded, source-labelled untrusted handoff with `triggerTurn: true`. Startup performs one reconciliation pass for terminal events produced while Pi was offline.

Do not poll pane state, capture pane output, or inspect logs merely to detect completion. Use `job_status` or terminal artifacts after the handoff only when its bounded evidence is insufficient.

## Safety

Launch actions run directly unless `dryRun: true` is requested. Stop actions can discard active pane work, so they remain previews by default and require `confirm: "yes-tmux-stop"` for execution. Existing sessions are never replaced silently; `force: true` archives an old job directory but does not kill a live tmux session.

The package includes the extension README and team templates under `dist/bundled-resources/extensions/tmux-agent-manager/`; the source repository keeps them under the matching `src/bundled-resources/` path.
