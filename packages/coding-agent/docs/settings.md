# Settings

Pi uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/settings.json` | Global (all projects) |
| `.pi/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |

### Telemetry and update checks

`enableInstallTelemetry` only controls the anonymous install/update ping to `https://pi.dev/api/report-install`. Opting out of telemetry does not disable update checks; Pi can still fetch `https://registry.npmjs.org/@caupulican%2fpi-adaptative/latest` to look for the latest Pi Adaptative version.

Set `PI_SKIP_VERSION_CHECK=1` to disable the Pi version update check. Use `--offline` or `PI_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Self Modification

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `selfModification.enabled` | boolean | `false` | Allow the agent to modify Pi's own source/harness when explicitly tasked |
| `selfModification.sourcePath` | string | - | Path to the `pi-adaptative` source checkout the agent must use for self-modification |

Use `/settings` → **Self modification** to configure this interactively. The submenu lets you choose whether to save globally or to the current project's `.pi/settings.json`. Pi warns when the path does not look like a `pi-adaptative` checkout, and a new session or `/reload` is recommended after changing guardrail settings.

When disabled, the system prompt tells the agent not to edit Pi core, the installed runtime, or harness source for self-evolution. To permit self-modification, enable the setting and provide the source checkout path:

```json
{
  "selfModification": {
    "enabled": true,
    "sourcePath": "/path/to/pi-adaptative"
  }
}
```

The agent is instructed to edit only that source checkout, preserve unrelated changes, and validate before reporting success. Settings changes remain explicit-approval gated unless `autonomy.mode` is `full` and the change is limited to autonomy/Auto Learn tuning; publishing, pushing, tagging, and releasing always require explicit foreground approval.

### Autonomy

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `autonomy.mode` | string | `"off"` | Low-config autonomy preset: `"off"`, `"safe"`, `"balanced"`, or `"full"` |

Use `/settings` → **Autonomy** or `/autonomy off|safe|balanced|full` to choose one preset instead of tuning all Auto Learn knobs. `full` is the standing-autonomy mode: it schedules post-turn reflection whenever concurrency allows and grants autonomous authority for high-confidence memory writes, user/project skill creation or patching, small user/project extension/tool improvements, autonomy/Auto Learn setting tuning, and edits under the authorized `selfModification.sourcePath` when validation and rollback evidence are recorded.

Hard stops still require explicit foreground approval even in `full`: publishing, npm release, git push, tag creation, credential changes, destructive user-data deletion, network-exposed services, or authority expansion beyond this policy. `/autonomy status` shows the active grant and the Auto Learn audit/log directory.

```json
{
  "autonomy": {
    "mode": "balanced"
  }
}
```

### Auto Learn Advanced

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `autoLearn.enabled` | boolean | derived from `autonomy.mode` (`false` when off) | Autonomously trigger background history scavenging for long sessions |
| `autoLearn.model` | string | `"active"` | Model used by the background learner; `"active"` uses the current session model, otherwise use a `pi --model` pattern |
| `autoLearn.longSessionMessages` | number | `32` | Trigger after this many message entries in the active branch |
| `autoLearn.longSessionContextPercent` | number | `70` | Trigger when current context usage reaches this percent |
| `autoLearn.cooldownMinutes` | number | `120` | Per-session-tenant cooldown between learner launches |
| `autoLearn.leaseMinutes` | number | `90` | Shared-state lease duration for a running background learner |
| `autoLearn.maxConcurrentLearners` | number | `2` | Maximum running Auto Learn background learners per session tenant |
| `autoLearn.applyHighConfidence` | boolean | `false` | Allow the learner to apply high-confidence memory candidates; broader write authority is controlled by `autonomy.mode` |
| `autoLearn.reflectionReview` | boolean | `true` | When Auto Learn is enabled, also run bounded post-turn reflection after corrective or complex turns |
| `autoLearn.reflectionMinToolCalls` | number | `5` | Trigger reflection review after this many tool calls in one completed turn |
| `autoLearn.reflectionCooldownMinutes` | number | `60` | Per-session-tenant cooldown between reflection-review learners |

Use `/settings` → **Auto Learn Advanced** to override the active autonomy preset, including the scavenger model and reflection review. The submenu lets you choose whether to save globally or to the current project's `.pi/settings.json`. The model picker prioritizes models from currently configured subscription/API accounts and still offers a manual custom-pattern entry. Use `/autonomy status` for the compact preset dashboard, `/auto-learn status` to inspect trigger state, reflection cooldown, and running leases, or `/auto-learn run` to start one learner immediately.

When enabled, Auto Learn keeps a small shared state file for visibility/cooldowns, but prompt/log/session artifacts are isolated under per-session-tenant directories so one session's learner does not consume another session's concurrency budget. Learners must confront available user/project memory first, using existing rules, preferences, corrections, and project facts to decide whether each candidate is useful, unique versus merge/upgrade-worthy, and agent-improving. Candidate validation is chunked/vectorized instead of one memory query per candidate. Successful Auto Learn workers purge their internal prompt/log/session artifacts after exit; the 7-day retention pruner is a fallback for unfinished or failed artifacts, and active leases are skipped so running learners are not raced. Provider/user history pruning is delegated to the continuous-learning tool after it records a learning outcome: only files older than 7 days whose current fingerprint still matches a successfully extracted index entry are deleted, and active/current sessions are protected.

```json
{
  "autoLearn": {
    "enabled": true,
    "model": "active",
    "longSessionMessages": 32,
    "longSessionContextPercent": 70,
    "cooldownMinutes": 120,
    "leaseMinutes": 90,
    "maxConcurrentLearners": 2,
    "applyHighConfidence": false,
    "reflectionReview": true,
    "reflectionMinToolCalls": 5,
    "reflectionCooldownMinutes": 60
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before Pi sees them, which may block the agent until the provider quota resets in some circumstances.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.pi/agent/npm/`; project-scoped npm packages install under `.pi/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".pi/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.pi/agent/settings.json` resolve relative to `~/.pi/agent`. Paths in `.pi/settings.json` resolve relative to `.pi`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.pi/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.pi/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pi/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
