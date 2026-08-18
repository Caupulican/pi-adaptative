# Settings

Pi uses JSON settings files with project settings overriding global settings. Pi also supports zero-footprint directory resource profiles stored under the user-level agent directory.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/settings.json` | Global (all projects) |
| `.pi/settings.json` | Project (current directory) |
| `~/.pi/agent/profiles/directories/<hash>/settings.json` | User-level per repo/directory overlay; no repo files written |
| `~/.pi/agent/profiles/*.json` | Reusable named profile definitions |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | model default | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, or `"ultra"` |
| `hideThinkingBlock` | boolean | `true` | Hide thinking blocks in output. Press the thinking toggle (default Ctrl+T) to show them. |
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

### Context Files

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `projectContextFiles` | string | `"off"` | Opt-in for repository `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`. `"off"` (default) loads only `~/.pi/agent` files. `"on-demand"` lists this project's files for the agent to read. Save per directory, per project, or globally. |

```json
{
  "projectContextFiles": "on-demand"
}
```

Enable from `/settings` → **Project AGENTS.md**. Choose save scope (this directory, this project, or all projects) and Load (`global-only` or `on-demand`). `--no-context-files` (`-nc`) also skips project files for that session. Neither disables the global file. Restart or `/reload` after changing the setting.

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
| `autonomy.maxStallTurns` | number | `20` | Maximum provider rounds in one foreground goal loop before Pi stops continuing |

Use `/settings` → **Autonomy** to choose one preset and the foreground goal-loop round budget, or `/autonomy off|safe|balanced|full` to switch the preset while preserving the configured round budget. `full` is the standing-autonomy mode: it schedules post-turn reflection whenever concurrency allows and grants autonomous authority for high-confidence memory writes, user/project skill creation or patching, small user/project extension/tool improvements, autonomy/Auto Learn setting tuning, and edits under the authorized `selfModification.sourcePath` when validation and rollback evidence are recorded.

Hard stops still require explicit foreground approval even in `full`: publishing, npm release, git push, tag creation, credential disclosure or provider-auth changes, destructive user-data deletion, network-exposed services, or authority expansion beyond this policy. An active user-plane `secret_store` grant is the narrow exception: model-blind activation and migration from named accessible sources require no duplicate confirmation. `/autonomy status` shows the active grant and the Auto Learn audit/log directory.

```json
{
  "autonomy": {
    "mode": "balanced",
    "maxStallTurns": 20
  }
}
```

### Model Router

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `modelRouter.enabled` | boolean | `false` | Enable deterministic cheap/medium/expensive model routing |
| `modelRouter.fitnessGate` | boolean | `false` | Opt-in subtractive gate: when a tier model has a host-local failed probe for its router lanes, skip or fall back instead of routing to it; unprobed tier models still route |
| `modelRouter.cheapModel` | string | - | Model pattern for read-only, research, explanation, and question turns |
| `modelRouter.mediumModel` | string | - | Model pattern for scoped implementation/planning turns |
| `modelRouter.expensiveModel` | string | - | Model pattern for high-impact, modify, implementation, and escalated tool-heavy turns |
| `modelRouter.learningModel` | string | `"active"` | Model pattern for background reflection, learn, and skill-creator work; `"active"` uses the current session model |
| `failover.subscriptionHop` | boolean | `true` | Allow subscription/OAuth quota failures to switch once to an authenticated provider default; metered/API-key quota failures always halt for explicit user choice |

Use `/settings` → **Model Router** to configure these fields globally or for the current project's `.pi/settings.json`. `/session` and `/usage` show the active router state, diagnostics, and per-tier fitness when the gate is enabled. Profile files can also include a `modelRouter` block so a situation can carry its own cheap, medium, expensive, and learning/reflection models together with its model, thinking level, soul, and resource filters.

Fitness applicability is intentionally split by autonomy level:

- Class A autonomous adoption requires proof on this host: executor direct uses `toolCall`, curation uses `digest`, and scout `"auto"` uses `research` + `toolCall`.
- Class B routed turns are subtractive and opt-in via `modelRouter.fitnessGate`: cheap uses `research` + `toolCall`; medium/expensive use `worker` + `toolCall`; the routing judge uses parsed `judge` output. Unprobed tier models pass.
- Compaction summarizer auto-selection is always-on subtractive composition: when `compaction.model` is `auto`, a router cheap model with a probed failed `digest` lane falls back to the session model; unprobed cheap models still pass, and exhausted explicit/cheap summarizers fall back visibly.
- Class C explicit user choices are sovereign: explicit `/model` and explicit `scout.model` patterns are not router-gated, except for the existing all-lanes-failed adoption backstop and runtime output checks.

```json
{
  "modelRouter": {
    "enabled": true,
    "fitnessGate": true,
    "cheapModel": "openrouter/google/gemini-flash-latest",
    "mediumModel": "anthropic/claude-sonnet-4-5",
    "expensiveModel": "openai-codex/gpt-5.5",
    "learningModel": "anthropic/claude-haiku-4-5"
  }
}
```

### Worker Delegation

Pi's native delegation runtime is a durable recursive agent tree. A profile is not required. A profile-free root agent starts from the foreground model and the maximum classified core worker surface the host can materialize: `read`, `grep`, `find`, `ls`, `write`, `edit`, `memory`, the platform shell, and `delegate`. Live service switches can revoke memory, writes, or delegation. Every descendant inherits its parent's immutable execution grant and the tree's remaining budget by default.

Whenever `delegate` is active, root and worker prompts use the same provider-neutral decision rule: delegate useful independent research, implementation, tests, or specialist review early; keep dependent or trivial work local. Reasoning level, provider identity, and model identity do not enable or suppress that policy; the model-capability profile may still narrow tools for very small context windows.

An agent may set `authority` on `delegate` to choose its child's role label, authenticated model, supported reasoning level, and classified tool names. Omitted fields inherit from the parent or selected preset. The model-facing start schema has no per-dispatch budget field: ordinary starts inherit the unbounded baseline, host settings, or an owner-authored profile ceiling. The host validates the request, resolves the concrete model and tools, intersects execution authority with the immutable parent grant and live global switches, then persists the exact result before the child starts. A descendant can specialize or narrow authority but cannot add an execution capability, tool, path, or budget that the parent did not hold. Profile selection also cannot add context: every child resource pointer must fully match an ancestral pointer (ID alone is insufficient), soul text must match exactly, and a verifier stays within its previously admitted ancestral verifier or worker boundary. Roles are descriptive routing and audit labels; the built-in compiler does not impose hidden role ceilings, though an embedding may supply an explicit host ceiling.

`workerDelegation.modelPins` optionally lets the owner fix the provider, model, and thinking level used by each fresh worker role. With no pins, delegation keeps the adaptive behavior above exactly. An applicable pin overrides model/thinking chosen by `authority` or a preset, while role, tools, resources, paths, and budgets still follow normal admission. This applies to fresh top-level workers, fresh nested workers, and mandatory verifiers. The admitted binding is persisted and reported by `delegate start`; queued work, retries, resumes, recovery, and later tasks on a reused `agentId` keep that immutable contract even if settings change.

Pin precedence is deliberately different from ordinary deep-merged settings: global role, global default, trusted local role, trusted local default, then adaptive routing. A global default therefore wins over every project role. Within trusted local settings, the user-level directory overlay wins over the project file at the same role/default tier. Untrusted project settings are ignored. Every binding must contain an exact `provider`, `modelId`, and supported `thinkingLevel`. Malformed pin configuration blocks fresh worker admission with `worker_model_pins_invalid`; an unavailable applicable pin blocks with `worker_model_pin_unavailable:<role>`. Neither condition falls back to another model. Configure pins directly in JSON; `/settings` does not edit them.

A `roles`-only configuration (no `default` in any scope) leaves every role not listed under `roles` entirely unpinned: a delegation using an unlisted role plus an explicit `authority.model` is not blocked, since there is no applicable pin to enforce, and it uses the caller-requested model exactly as ordinary adaptive routing would. This is expected, not an admission bug, but it is easy to configure by accident. The host surfaces it two ways so it stays observable: a settings diagnostic lists the unpinned roles whenever a `roles`-only policy compiles with no `default`, and a delegation that hits this gap (an active pin policy, no pin for the effective role, and an explicit requested model) reports `modelPinBypass: <role>` on its `delegate start` result. Add a `default` to close the gap for every role, or pin every role explicitly under `roles` if adaptive routing is never intended.

```json
{
  "workerDelegation": {
    "modelPins": {
      "default": {
        "provider": "openai-codex",
        "modelId": "gpt-5.6-luna",
        "thinkingLevel": "high"
      },
      "roles": {
        "explorer": {
          "provider": "openai-codex",
          "modelId": "gpt-5.6-terra",
          "thinkingLevel": "medium"
        },
        "verifier": {
          "provider": "openai-codex",
          "modelId": "gpt-5.6-terra",
          "thinkingLevel": "high"
        }
      }
    }
  }
}
```

For a new logical agent, `forkTurns` chooses immutable sanitized birth context: `"none"`, `"all"`, or a positive user-turn count encoded as a string, such as `"3"`. When omitted, the worker receives no parent transcript, so a self-contained task cannot inherit and mistake parent-level orchestration intent for child ownership. A worker that changes provider or model also defaults to `"none"`, and explicitly requesting inherited turns across that boundary is rejected. Explicit `"all"` or count inheritance remains available inside the exact provider/model boundary. The bounded snapshot keeps whole text-only user/complete-assistant turns and a valid compaction checkpoint when needed. It excludes system/developer/custom context, reasoning/commentary, tool protocol and results, mailbox controls, attachments, and incomplete assistant output. A reused `agentId` continues its existing transcript and cannot replace its birth context.

```json
{
  "action": "start",
  "instructions": "Implement and verify the scheduler change.",
  "forkTurns": "3",
  "authority": {
    "role": "implementer",
    "model": { "provider": "openai-codex", "modelId": "gpt-5.5" },
    "thinkingLevel": "high",
    "capabilities": [
      "filesystem.read",
      "filesystem.write",
      "worktree.read",
      "worktree.mutate",
      "process.exec",
      "memory.query",
      "workflow.delegate"
    ],
    "toolNames": ["read", "grep", "find", "ls", "write", "edit", "memory", "bash", "delegate"],
    "readPaths": ["."],
    "writePaths": ["packages/coding-agent"],
    "budget": { "maxTokens": 32000, "maxCostUsd": 2, "maxToolCalls": 80 }
  }
}
```

Fleet creation is bounded before Pi creates a durable task, conversation, agent, or queue entry: depth is at most 8, one parent may own at most 64 direct children, one session may retain at most 256 logical agents, and the scheduler may retain at most 256 queued dispatches. The profile-free baseline is deliberately lean: the session may retain one nested identity at depth one, and that child is a leaf; additional root workers remain available and can reuse the retained specialists. An owner-authored profile may set `delegationLimits.maxDepth`, `delegationLimits.maxChildrenPerAgent`, and `delegationLimits.maxNestedAgentsPerSession` up to the host ceilings; omitted authored limits retain the host ceilings. Descendant profile selection intersects these limits with the ancestor's immutable contract and cannot widen them. Admission dynamically preserves queue and durable-projection headroom for every implementation whose mandatory verifier has not yet materialized, plus a newly admitted contract's verifier. A verifier dispatch that encounters saturation remains represented by its durable subject and replays on a queue-capacity event. The shared durable projection independently caps agents, tasks, and attempts at 256 each. `workerDelegation.maxConcurrent` remains the global running-agent limit; excess admitted work enters the bounded durable queue. The kernel also rejects an exact recursive cycle when a child repeats the same normalized instructions and effective profile already present in its ancestor chain. Root budgets are cumulative across every descendant and attempt: token, cost, tool-call, active-wall-clock, and attempt usage are reconstructed from durable checkpoints and checked before more work is admitted. The default delegation baseline adds no cost or active-time ceiling; positive global settings, profile budgets, and inherited foreground ceilings remain authoritative when explicitly configured.

`delegate` exposes the shared durable task/tree state through distinct authority boundaries:

- `tasks` returns a bounded view of durable DAG tasks, dependencies, status, latest attempt/agent dispatch, verifier state, terminal reason, and persisted retry eligibility. `start.dependsOn` accepts only existing same-objective task IDs; forward, cross-objective, self, and cyclic edges fail before dispatch.
- `list` returns safe metadata for session agents, including lineage, depth, state, and reusable activity; it does not grant transcript or control authority.
- `transcript` pages bounded messages only for the session root or the caller's own agent/control subtree, with an opaque raw-entry cursor and page size of 1-64. A page may be empty and still provide `nextCursor` after visiting non-message entries; an individually oversized message is omitted and counted rather than partially returned. Sibling and unrelated peer transcripts are not readable by workers.
- `send` and `broadcast` queue bounded, non-waking, threaded peer evidence; broadcast canonicalizes a bounded target set and reports acceptance per target. Peer content is untrusted data, never authority.
- `follow_up`, `interrupt`, `resume`, and `cancel` may wake or mutate only within the caller's control subtree. `resume` keeps the admitted model, transcript, resources, and grant; a paused objective retains its suspended attempt without starting or cancelling it until objective resume drains the scheduler. `cancel` terminates only the selected current task.
- `reply` answers one exact reply-expected request. The session root consumes replies through the acknowledged `inbox`, event-driven `inbox_wait`, and `inbox_ack` flow instead of unsolicited transcript injection.
- `wait` and `wait_many` are event-driven; `wait_many` accepts a bounded canonical target set and completes in `any` or `all` mode. `retire` replay-safely closes only an idle leaf after its mailbox and reply obligations clear, preserving its binding and transcript.

Transient attempt retries are evidence-gated. A classified provider or transport failure suspends the exact attempt with its retry count and ISO `notBefore` deadline, then resumes from the persisted transcript under a fresh fence when that deadline is eligible. Restart recovery uses the durable deadline rather than resetting an in-memory backoff; `maxAttempts: 1` disables the ladder, and missing/unknown failure classification never retries.

`delegate` returns a stable agent/lane identity immediately. A fresh `start` does not accept `laneId`; omit it, retain the returned `agentId`, and pass that `agentId` to a later `start` to reuse the persistent worker. Completion persists a bounded terminal handoff before waking the parent; late output stays in the worker transcript instead of racing into the active foreground transcript. Review-pending results remain `partial` and project blockers remain `blocked` in lane status and terminal handoffs instead of either being collapsed into harness failures. A scheduled transient retry is reported as nonterminal with its durable state retained. A full parent mailbox retains the attempt-keyed handoff until an explicit terminal, mailbox-capacity, state-change, or recovery event drains it—there is no retry polling loop. Exact replays are inert, conflicts fail closed, and delivery errors remain retained. Use `delegate { action: "status", laneId }` for bounded lane-result retrieval.

Global profiles live at `~/.pi/agent/profiles/orchestration/<id>.json`; project profiles live at `.pi/profiles/orchestration/<id>.json`. They are optional presets for model, reasoning, tools, resources, budget, verification, prompt defaults, and recursive `delegationLimits`. Select one with `profileId` on a call or configure `workerDelegation.orchestrationProfile`. `dispatchProfileIds` is preset-routing metadata, not an admission allowlist. Profile `maxConcurrent` is retained in the authored schema but does not override the global scheduler. `delegate` actions `profile_inspect` and `profile_create` manage optional immutable session-scoped narrowings; task profiles inherit the owner-authored base budget unchanged, and direct authority selection does not require a profile.

A preset with `requireIndependentVerification: true` still names an owner-authored `verificationProfileId`. The runtime creates a separate durable verifier task and accepts the implementation only after a typed verifier decision. A profile using `run_process` must declare `executionPolicy`; that tool launches only listed executables as direct argv. The platform shell is different: it is a real persistent per-agent shell and is not OS/container isolation. Shell commands can exercise the host process, filesystem, network, and credentials available to Pi; direct `write`/`edit` path scopes do not sandbox shell side effects.

Direct `write`/`edit` calls use review-after-apply semantics. The compiled grant and path policy reject out-of-scope direct mutations before they run, while accepted changes are reported to the parent with changed files, blockers, usage identity, and review state.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `workerDelegation.enabled` | boolean | `true` | Enable autonomous recursive agent trees; explicit `false` is a hard off-switch |
| `workerDelegation.orchestrationProfile` | string | - | Optional default execution preset; agents may replace its defaults within inherited authority |
| `workerDelegation.maxUsd` | number | `0` | Cumulative USD ceiling for one root tree; `0` is unbounded and a positive value explicitly enables the ceiling |
| `workerDelegation.maxWallClockMs` | number | `0` | Cumulative active wall-clock ceiling for one root tree; `0` is unbounded and a positive value explicitly enables the ceiling |
| `workerDelegation.maxConcurrent` | number | `20` | Global running-agent concurrency inside the fixed fleet and queue bounds |
| `workerDelegation.writeEnabled` | boolean | `true` | Expose direct `write`/`edit`; explicit `false` revokes them for newly admitted work and narrows resumed grants |
| `workerDelegation.writePaths` | string[] | `["."]` | Global envelope for direct child writes; an explicit empty array revokes direct `write`/`edit` |
| `workerDelegation.modelPins` | object | - | Optional exact `default` and per-role provider/model/thinking bindings for fresh workers; malformed or unavailable applicable pins fail closed |

### Tool Repair

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `toolRepair.teach` | boolean | `true` | Enable in-band repair teaching notes on repaired tool results |
| `toolRepair.textProtocol` | boolean | model-dependent | Emergency global override for text tool-call protocol calibration. Prefer per-model `textToolCallProtocol` in `models.json` for deterministic model setup. |
| `toolRepair.logging` | boolean | `true` | Enable background tool-recovery telemetry/failure-corpus logging. When `false`, repair still runs but Pi does not enqueue or write tool-recovery log records. |

Deterministic argument repair is built in and has no settings toggle; schema-valid calls still return unchanged without entering the repair layer. `PI_TOOL_REPAIR_DISABLED=1` remains only an emergency diagnostic kill switch.

Text protocol precedence is: `PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED=1` kills it; a persisted `/toolprobe` native verdict then keeps that exact model on native calls; otherwise `toolRepair.textProtocol` force-enables or disables globally, per-model `textToolCallProtocol` applies, and finally a persisted calibrated text-protocol verdict applies. The phone/text protocol is therefore a fallback lane for models without proven native calls, never a replacement for a proven native path. Failed calibration is stored per host/model and can be cleared with `/toolprotocol-reset <provider/model>`.

Environment kill switches override their diagnostic layers: `PI_TOOL_REPAIR_DISABLED=1`, `PI_TOOL_REPAIR_TEACH_DISABLED=1`, and `PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED=1`. See [Tool repair](tool-repair.md) for diagnostics, reset controls, and replay.

```json
{
  "toolRepair": {
    "teach": true,
    "textProtocol": true,
    "logging": true
  }
}
```

### Auto Learn Advanced

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `autoLearn.enabled` | boolean | derived from `autonomy.mode` (`false` when off) | Autonomously trigger background history scavenging for long sessions |
| `autoLearn.model` | string | `modelRouter.learningModel`, otherwise `"active"` | Legacy/direct override for the background learner; `"active"` uses the current session model, otherwise use a `pi --model` pattern |
| `autoLearn.longSessionMessages` | number | `32` | Trigger after this many message entries in the active branch |
| `autoLearn.longSessionContextPercent` | number | `70` | Trigger when current context usage reaches this percent |
| `autoLearn.cooldownMinutes` | number | `120` | Per-session-tenant cooldown between learner launches |
| `autoLearn.leaseMinutes` | number | `90` | Shared-state lease duration for a running background learner |
| `autoLearn.maxConcurrentLearners` | number | `2` | Maximum running Auto Learn background learners per session tenant |
| `autoLearn.applyHighConfidence` | boolean | `false` | Allow the learner to apply high-confidence memory candidates; broader write authority is controlled by `autonomy.mode` |
| `autoLearn.reflectionReview` | boolean | `true` | When Auto Learn is enabled, also run bounded post-turn reflection after corrective or complex turns |
| `autoLearn.reflectionMinToolCalls` | number | `5` | Trigger reflection review after this many tool calls in one completed turn |
| `autoLearn.reflectionCooldownMinutes` | number | `60` | Per-session-tenant cooldown between reflection-review learners |

Use `/settings` → **Model Router** for the preferred place to choose the scavenger/reflection/skill-creator model. Use `/settings` → **Auto Learn Advanced** for trigger/cooldown/concurrency overrides and the legacy direct `autoLearn.model` override. Use `/autonomy status` for the compact preset dashboard, `/auto-learn status` to inspect trigger state, reflection cooldown, and running leases, or `/auto-learn run` to start one learner immediately.

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

The checkpoint owns user intent mechanically: `## Active Task` copies the latest user request verbatim, and a split-turn prefix copies its original request without a second model rewrite. Tool output remains evidence and cannot become a new active task. Validated one-turn operation rejections expire instead of becoming durable completed actions or open problems.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.model` | string | `"auto"` | Summarizer model pattern. `auto` follows router cheap when available, but always consults exhausted-provider state and the subtractive `digest` fitness surface before falling back visibly to the session model. |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.triggerPercent` | number | `0.6` | Context-efficiency and latency trigger as a fraction of the model window; separate from the USD cost guard |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Cost Guard

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `costGuard.maxTurnUsd` | number | `0` | Projected per-turn USD warning ceiling; disabled by default, positive values explicitly enable it |
| `costGuard.action` | string | `"warn"` | `"warn"` only reports the estimate; `"downgrade"` also lowers reasoning one rung for that request without changing saved/profile state |

The projection uses the session response reserve, cached-input rates, and model-declared long-context tiers. ChatGPT subscription usage is marked `(sub)` and does not enter the USD guard.

### Context GC

Context GC only rewrites the provider-bound context view. It does not delete or mutate the canonical session log.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `contextGc.enabled` | boolean | `true` | Enable provider-context packing for stale bulky context |
| `contextGc.preserveRecentMessages` | number | `24` | Recent messages kept verbatim |
| `contextGc.minToolResultChars` | number | `1200` | Minimum stale tool-result size before packing |
| `contextGc.tools` | string[] | `read`, `bash`, `python`, `powershell`, `rg`, `grep`, `find`, `run_toolkit_script`, `ls`, `skill_open`, `automata_graph_status`, `automata_graph_search`, `automata_graph_query`, `automata_graph_neighbors`, `automata_graph_path`, `automata_graph_pointer_pack`, `learning_query_memory`, `subagent`, `delegate`, `task_steps`, `pipeline`, `task_background`, `task_goal`, `run_ledger`, `context_headroom_retrieve`, `headroom_retrieve` | Tool results eligible for stale-output packing |
| `contextGc.semanticMemory.enabled` | boolean | `true` | Pack stale Automata/Mind semantic context pages from provider context |
| `contextGc.semanticMemory.preserveRecentPages` | number | `1` | Newest semantic memory pages kept verbatim |
| `contextGc.semanticMemory.minChars` | number | `900` | Minimum semantic page size before packing |
| `contextGc.semanticMemory.markers` | string[] | Automata/Mind XML-ish tags | Markers used to identify deterministic memory pages |

Semantic memory packing only targets tool results and Automata/Mind custom context messages; normal user prompts are preserved even if they contain matching marker text.

```json
{
  "contextGc": {
    "enabled": true,
    "preserveRecentMessages": 24,
    "semanticMemory": {
      "enabled": true,
      "preserveRecentPages": 1
    }
  }
}
```

### Context Memory

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `contextPolicy.memory.enabled` | boolean | `true` | Enable local safe-auto memory retrieval |
| `contextPolicy.memory.includeInPrompt` | boolean | `true` | Include retrieved memory only when the active model budget permits it |
| `contextPolicy.memory.maxResults` | number | `5` | Maximum retrieval results before tier/budget pruning; clamped to 1-20 |
| `contextPolicy.memory.allowExternalEgress` | boolean | `false` | Explicitly allow eligible external memory providers to receive bounded, non-secret-like query text |

For models with `contextWindow <= 2048`, provider-visible memory is capped to 10 lines and about 200 estimated tokens total. If standing/current-work/long-term memory cannot fit that cap, Pi skips the memory block rather than overflowing context. `MEMORY.md`/`USER.md` stay in the static file-store prompt on normal windows; Pi uses the retrieval view for those files only when that static block cannot fit a compact model budget, avoiding duplicate prompt content. Custom local memory layers, such as Automata, should register a context provider with `pi.registerContextMemoryProvider`; core ships only local file-store and OKF readers. Legacy providers must declare `egress: "local"` to participate in safe-auto recall; omitted classifications fail closed as external. External memory egress requires the visible `/settings` consent or `allowExternalEgress: true`, remains bounded to 2,000 characters, and rejects labeled credentials, bearer/basic tokens, common raw provider tokens, private keys, and signed URLs. Every legacy provider recall page is centrally source-labeled and fenced as untrusted data. Live extension load/unload immediately rebuilds the memory generation, activating new providers and shutting down/removing only those owned by the unloaded extension.

```json
{
  "contextPolicy": {
    "memory": {
      "enabled": true,
      "includeInPrompt": true,
      "maxResults": 5,
      "allowExternalEgress": false
    }
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
| `httpIdleTimeoutMs` | number | `660000` | HTTP header/body idle timeout. Nonzero values constrain every phase-aware stream watchdog below the transport timeout; `0` disables only the HTTP bound. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |
| `images.clipboardDirectory` | string | `~/.pi/agent/state/attachments` | Store clipboard image attachments here; relative paths resolve from the active working directory |

Clipboard images use stable session numbers such as `[Image #3]`. A later prompt can refer to that number or say “look at the image” to attach the latest image from the current session again. The default directory is created only after an image is pasted, never inside the working repository. Pi recognizes and prunes only its own integrity-tagged files, with fixed 30-day, 512-file, and 512 MiB ceilings; unrelated files in a configured directory are untouched. `--no-session` keeps attachments in memory unless `images.clipboardDirectory` explicitly requests persistence.

To keep captures in an explicit location:

```json
{
  "images": {
    "clipboardDirectory": "~/Pictures/pi-captures"
  }
}
```

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | platform default | Custom platform-shell path (`pwsh.exe` on Windows; Bash-compatible shell elsewhere) |
| `shellCommandPrefix` | string | - | Platform-shell snippet prepended to every command (for example, `"shopt -s expand_aliases"` on Bash) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@24", "--", "npm"]`) |
| `windowsShell.pythonEngine` | boolean | `true` | Windows only. Routes pipelines, redirection, expansion, chaining, and state-mutating commands (`cd`/`export`/`unset`) through the bundled Python shell engine. Explicit `false` restores the PowerShell-only, simple-command-only contract verbatim — the same fail-closed behavior for pipelines/redirection/expansion/chaining as before the engine existed. |

Pi exposes one stable `bash` contract to the model on every platform. On Windows, the tool router parses a finite simple-command grammar, converts supported Bash-like forms to literal-path PowerShell, and rejects pipelines, redirection, expansion, chaining, nested shells, POSIX scripts, and unsupported builtin forms instead of guessing. Legacy `powershell` tool/profile references map to `bash`. The Windows backend requires PowerShell 7 (`pwsh.exe`) and runs it with `-NoLogo -NoProfile -NonInteractive -Command`, process-only headless settings, silent progress, and a warmed persistent command path. Pi does not overwrite PowerShell's input or output encoding; its output path preserves Unicode UTF-8 and recovers Windows-1252 bytes. `shellCommandPrefix` uses backend-native syntax because Pi applies it after routing. Agent, interactive, and RPC shell calls default to a 120-second wall-clock deadline; agent-tool overrides cap at one hour.

With `windowsShell.pythonEngine` at its default (`true`), the router also sends pipelines, redirection, expansion, chaining, and `cd`/`export`/`unset` to a bundled, uv-provisioned Python 3.13 engine implementing a bounded Bash grammar and coreutils vocabulary; state persists across calls and across the PowerShell/engine tiers. If the Python runtime cannot be resolved (uv/network unavailable), the simple-command PowerShell floor keeps working and engine-only commands return a named, actionable error — never a silent downgrade. See [Windows](windows.md) for the full supported-forms table.

The native `python` tool is active by default and resolves Python through pinned `uv`. Pi provisions missing uv/Python during package postinstall, `pi update`, `pi doctor`, or first tool use. Python calls default to 30 seconds and cap explicit overrides at 300 seconds. See [Native Python](python.md).

```json
{
  "npmCommand": ["mise", "exec", "node@24", "--", "npm"]
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
| `resourceProfiles` | object | `{}` | Named complete situations or legacy allow/block filters for `extensions`, `skills`, `prompts`, `themes`, `agents`, and `tools` |
| `~/.pi/agent/profiles/*.json` | files | - | Reusable named situations with model, thinking, soul, router, and resource metadata |
| `activeResourceProfile` | string/string[] | - | Active profile name(s) |
| `activeResourceProfiles` | string[] | - | Active profile names; equivalent to array form of `activeResourceProfile` |
| `disabledResources` | object | `{}` | Legacy block filters; still supported and merged into resource profiles |

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

#### resourceProfiles

Resource profiles dynamically filter resources after discovery. Each resource kind supports `allow` and `block` arrays. If `allow` is non-empty, only matching resources load; `block` is applied after allow. Under strict UAC, an unmentioned kind is denied and granting an entire kind requires `allow: ["*"]`. Patterns match relative paths, absolute paths, file names, and containing directory names.

```json
{
  "activeResourceProfile": "lean",
  "resourceProfiles": {
    "lean": {
      "extensions": { "block": ["cmux-agent-manager", "heavy-devtools"] },
      "skills": { "allow": ["engineering-principles", "graph-first-code-navigation"] },
      "agents": { "block": ["GEMINI.md"] },
      "tools": { "allow": ["read", "rg", "python"] }
    }
  }
}
```

Use `/profiles` in interactive mode to switch the current session profile without writing settings. Use `/profiles <name>` for a direct session-only switch, or `/settings` → **Profiles** to select from the settings menu. Use `--resource-profile lean` to select a profile for one session or subagent launch. Use `--resource-profile-json` for one-shot definitions that never touch disk:

```bash
pi --resource-profile oneoff \
  --resource-profile-json '{"oneoff":{"tools":{"allow":["read","rg"]}}}'
```

Resource files may also carry profile blocks. Pi parses only the matching `<resource-profile>` block as JSON config and strips the block from prompt/agent/skill expansion content:

```markdown
<resource-profile name="lean">
{ "tools": { "allow": ["read", "rg"] }, "agents": { "block": ["GEMINI.md"] } }
</resource-profile>
```

Supported carriers: extension files (`.ts`/`.js`, usually inside comments), prompt templates, skill files, and context agent files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`). Resource-profile block contents are data, not instructions.

Reusable profile files live under `~/.pi/agent/profiles/<name>.json`. They use a wrapper shape so metadata can live next to resource filters:

```json
{
  "name": "reviewer",
  "description": "Safe review profile",
  "model": "anthropic/claude-sonnet-4",
  "thinking": "low",
  "resources": {
    "tools": { "allow": ["read", "grep", "context_audit"] },
    "skills": { "allow": ["code-review"] }
  }
}
```

`resources` uses the same allow/block filter shape as `resourceProfiles`. Relative paths that start with `./` or `../` resolve from the profile file directory.

Zero-footprint repo/directory overlays live under `~/.pi/agent/profiles/directories/<hash>/settings.json`, where `<hash>` is derived from the nearest VCS root (or current directory when no VCS root exists). These files are user-level settings; Pi does not write `.pi/settings.json` just to remember directory profiles. Startup migrates the former root-level `resource-profiles/` layout without overwriting canonical data.

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
