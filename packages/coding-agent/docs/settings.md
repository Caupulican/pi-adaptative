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
| `hideThinkingBlock` | boolean | `true` | Hide thinking blocks in output. Press the thinking toggle (default Shift+PageUp) to show them. |
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

#### Processing tiers

`/fast` and `/ultrafast` each toggle one tier of the model's catalog, as in Codex: `/fast` toggles the `priority` (Fast) tier, `/ultrafast` the `ultrafast` tier. Choosing the tier already in effect returns to standard processing; choosing the other tier switches to it. `/fast on`, `/fast priority`, `/fast ultrafast`, `/fast off`, `/ultrafast on` and `/ultrafast off` set a tier explicitly (`off` is standard processing), and `/fast status` and `/ultrafast status` report the selection and an unavailable saved tier. A tier the current model/account catalog does not advertise is refused. These commands preserve the model and thinking level.

Standard processing sends no `service_tier` field, as Codex does; the explicit `default` choice is never put on the wire. When no choice is saved, the account catalog's default tier for the model applies if the model still advertises it (`/fast status` says so); otherwise the request is standard.

A tier saved here applies only to the owner's live turn; workers, child sessions and every background lane (summaries, knowledge collection, judgments, reflection, curation, research) always run at standard processing, since nothing waits on their latency.

Preferences are stored per provider:

```json
{
  "fastMode": {
    "openai-codex": "ultrafast",
    "xai": true
  }
}
```

Codex account model metadata overrides the bundled catalog. An explicit empty tier list excludes premium tiers; missing metadata preserves legacy priority support but never enables Ultrafast. An unavailable saved tier is withheld from requests. Explicit SDK request/session Ultrafast selections must pass the same advertised-tier check. Root and native child requests use the same preference, with matching SSE/WebSocket routing headers.

The inspected Codex catalog supplies tier availability, not Ultrafast dollar prices. Ultrafast usage therefore retains base model rates with an estimate marker and a diagnostic. CURRENT and TODAY totals show `~$` and retain that qualification across sessions and cached redraws. Dollar budgets use these estimates; they do not measure Ultrafast charges or subscription quota consumption.

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `true` | Hide the startup banner and the loaded-resources listing; `false` shows them |
| `projectTrust` | string | `"trusted"` | Global only. What a project with no saved `/trust` decision gets: `"trusted"` loads its `.pi` settings, extensions and instructions, `"untrusted"` ignores them. A saved `/trust` decision wins, and `--approve` / `--no-approve` win for one run. `/trust` applies to the running session |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |

### Project Instructions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `projectContextFiles` | string | `"off"` | Project-instruction policy. `"off"` (default, shown as `global-only`) admits trusted global/bundled resources and physically external configured catalogs but excludes project `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, `.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md`, extensions, skills, and prompt templates even when a built-in SDK option or trusted catalog explicitly supplies their path. `"on-demand"` admits those project instruction resources. Save per directory, per project, or globally. |

```json
{
  "projectContextFiles": "on-demand"
}
```

Use `/settings` → **Project instructions**. Choose save scope (this directory, this project, or all projects) and Load (`global-only` or `on-demand`). In `global-only`, Pi excludes project instruction paths before content reads, discoverable-list insertion, or module import. The same decision covers automatic discovery, direct settings and project packages, extension-contributed paths, explicit built-in SDK file options, path-backed overrides, direct extension load/list methods, and registered external-resource catalogs. Path explicitness or catalog trust does not grant project authority; lexical and canonical targets are both checked, so symlink aliases cannot cross the boundary. Registering and trusting a project directory authorizes catalog scanning but does not reclassify its instruction files as external.

Trusted global/bundled resources, configured catalogs that resolve outside the physical project, inert project themes, and already-materialized caller content remain available. A true external SDK path remains subject to its existing resource-profile and extension-import gates. `--no-context-files` (`-nc`) separately skips project context files for that session. Restart or `/reload` after changing the setting.

**Confirmed scope:** system-prompt file resolution, package/resource discovery, SDK/resource-loader path admission, skill audit/skillify inputs, root/worker system guidance, and reload behavior enforce the same persisted setting. Ordinary project files remain available as task data; global-only mode is an instruction-admission boundary, not a hidden-filesystem sandbox. See [SDK: Project Instructions](sdk.md#project-instructions) for the exact built-in file-backed inputs and materialized-data controls.

### Update checks

Pi can fetch `https://api.github.com/repos/Caupulican/pi-adaptative/releases/latest` at startup to
look for a newer Pi Adaptative version. Set `PI_SKIP_VERSION_CHECK=1` to disable that check. Use
`--offline` or `PI_OFFLINE=1` to disable all startup network operations, including update checks
and package update checks.

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

The agent is instructed to edit only that source checkout, preserve unrelated changes, and validate before reporting success. Task-required settings changes and publication use the same active edge grants as other execution; self-modification adds no separate approval prompt.

### Autonomy

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `autonomy.mode` | string | `"off"` | Low-config autonomy preset: `"off"`, `"safe"`, `"balanced"`, or `"full"` |
| `autonomy.maxStallTurns` | number | `20` | Maximum provider rounds in one foreground goal loop before Pi stops continuing |

Use `/settings` → **Autonomy** to choose one preset and the foreground goal-loop round budget, or `/autonomy off|safe|balanced|full` to switch the preset while preserving the configured round budget. Main-session reflection is enabled in every mode, including `off`; eligible turns queue a durable root-only cue for the orchestrator's next ordinary current-session provider turn. It does not create a separate or background model request, and increasing autonomy never disables learning. `full` additionally grants standing authority for broader user/project skill, extension/tool, autonomy-setting, and authorized self-modification work when validation and rollback evidence are recorded.

Execution authority is independent of the learning preset. The default `edge.allow` grants every registered edge class, while the default `edge.mode: "guarded"` still applies tool, path, credential, and semantic permission gates. Set `edge.mode: "yolo"` to bypass those harness execution gates for the foreground and delegated lanes. `/autonomy status` shows learning policy; `/edge list` shows standing edge grants.

#### Execution authority

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `edge.mode` | `"guarded" \| "yolo"` | `"guarded"` | `"yolo"` bypasses routine harness execution permission gates for root and delegated lanes. The hardline boundary, explicit command denies, and fresh owner approval for repository deletion still apply. |
| `edge.allow` | string[] | All registered edge classes | Standing grants for the owner's own runs: `git.publish`, `package.publish`, `package.install`, `destructive.fs`, `settings.authority`, `toolkit.script`, `operation.irreversible`, `agent.delegate`, `forge.write` (the last two are only ever asked of a run that carries a third party's words). An explicit array replaces the default; `[]` opts into confirmation for ungranted edge operations in guarded mode. Unknown names are ignored. It never covers a run that carries a peer's or another channel's words; `edge.thirdPartyAllow` does. |
| `edge.thirdPartyAllow` | string[] | `[]` | The classes a run that carries a peer's or another channel's words may use without the owner (see [Third-party words](proactivity.md#third-party-words)). Read only from the global settings and the directory overlay under the agent directory (a project's `.pi/settings.json` never counts), and only for classes `edge.allow` also grants. A write into the session store is never granted. |
| `edge.deny` | string[] | `[]` | Exact shell-command globs to block even in YOLO; `*` matches any span and `?` one character. A malformed deny list disables YOLO until corrected; standing `edge.allow` grants are unaffected. |

No per-operation `goal grant_edge` call or `/edge allow all` command is needed with the default policy. Settings grants survive reload and compaction. To restrict execution, set `edge.allow` explicitly in the desired settings scope; `/edge revoke` removes session and instruction grants, while standing settings grants are changed in settings. An unreadable settings file reports its load error and withholds standing grants until repaired and reloaded. Provider turns and ordinary diagnostic tools remain available; the error never silently replaces restrictions with defaults. Instruction grants come only from the owner's typed words: pasted text grants nothing (see [System One](system-one.md#owner-words)). A grant given at an edge prompt, read from the owner's words by System One, or made by `goal grant_edge`, answers the owner's own runs and is not standing; `/edge allow` typed by the owner and `edge.thirdPartyAllow` are.

In guarded mode, these grants control operation approval. Explicit tool/path restrictions, worker ownership, credential-value protection, cancellation, and verification of results still apply. YOLO bypasses the permission checks: the capability envelope, edge prompts, System One operation review, external-acquisition and script authorization, worker tool narrowing, and extension `tool_call` vetoes. It keeps the harness's self-regulation: context compaction, model-router escalation, the model capability filter, owner model pins and model policy, `workerDelegation.enabled`, your tool allow/exclude configuration, credential masking, private harness state, the local-commit branch rule, project-rule acceptance, and `readOnly` worker grants. It blocks machine-wide destructive commands and `edge.deny` matches before execution. Deleting the repository requires a fresh owner decision every time; workers and headless sessions cannot make that decision. Cancellation, accounting, unavailable models or tools, and task budgets can still stop work. The command boundary inspects direct tool arguments; it is not OS isolation against destructive code hidden inside an interpreter or script.

```json
{
  "edge": { "mode": "yolo" }
}
```

Start a new session or run `/reload` after changing `edge.mode` so the tool registry reflects the mode.

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
| `modelRouter.enabled` | boolean | on with System One, off otherwise | Enable cheap/medium/expensive model routing. Unset, it is on when the session has System One (a TypeSafe or OpenRouter key) and off otherwise; an explicit value wins |
| `modelRouter.fitnessGate` | boolean | `false` | Opt in to model fitness checks. Failed host-local probes exclude tier models from their router lanes; unprobed tier models still route. Worker task-fitness judgments also require this setting, the router, and System One to be enabled |
| `modelRouter.cheapModel` | string | - | Model pattern for read-only, research, explanation, and question turns |
| `modelRouter.mediumModel` | string | - | Model pattern for scoped implementation/planning turns |
| `modelRouter.expensiveModel` | string | - | Model pattern for high-impact, modify, implementation, and escalated tool-heavy turns |
| `modelRouter.learningModel` | string | `"active"` | Model pattern for explicit/background Auto Learn, learn, and skill-creator work; automatic reflection uses the orchestrator's current session turn; `"active"` uses the current session model |
| `failover.subscriptionHop` | boolean | `true` | Allow subscription/OAuth quota failures to switch once to an authenticated provider default; metered/API-key quota failures always halt for explicit user choice |

Use `/settings` → **Model Router** to configure these fields globally or for the current project's `.pi/settings.json`. `/session` and `/usage` show the active router state, diagnostics, and per-tier fitness when the gate is enabled. Profile files can also include a `modelRouter` block so a situation can carry its own cheap, medium, expensive, and learning model together with its model, thinking level, soul, and resource filters. Automatic reflection does not select a separate reflection model.

Fitness applicability is intentionally split by autonomy level:

- Class A autonomous adoption requires proof on this host: executor direct uses `toolCall`, curation uses `digest`, and scout `"auto"` uses `research` + `toolCall`.
- Class B routed turns are subtractive and opt-in via `modelRouter.fitnessGate`: cheap uses `research` + `toolCall`; medium/expensive use `worker` + `toolCall`. Unprobed tier models pass. Routing itself is judged by System One, not a fitness-gated lane.
- Compaction summarizer auto-selection is always-on subtractive composition: when `compaction.model` is `auto`, a router cheap model with a probed failed `digest` lane falls back to the session model; unprobed cheap models still pass, and exhausted explicit/cheap summarizers fall back visibly.
- Class C explicit user choices are sovereign: explicit `/model` and explicit `scout.model` patterns are not router-gated, except for the existing all-lanes-failed adoption backstop and runtime output checks.
- Worker task-fitness judgments require `modelRouter.fitnessGate: true`, the router, and System One. Ordinary bot creation by the owner or root does not opt in. With the gate off, startup, queued dispatch, and execution do not require a task-fitness judgment. Authentication, model availability, permissions, capacity, and lifecycle checks still apply. With the gate on, all worker models require accepted task fitness; there are no model-specific waivers.

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

Pi's native delegation runtime manages durable, persistent leaf workers. A profile is not required. A fresh worker inherits the foreground model, live thinking level, and every active classified tool the native lane can materialize. It receives machine-wide read/write/process/network authority by default while raw Pi auth, session, settings, and memory state remain denied. Workers never receive `delegate`, descendant spawning, reflection, or memory mutation.

Whenever `delegate` is active, the root prompt uses a provider-neutral decision rule: delegate useful independent research, implementation, tests, or specialist review early; keep dependent or trivial work local. Reasoning level, provider identity, and model identity do not enable or suppress that policy; the model-capability profile may still narrow tools for very small context windows.

For a fresh `delegate start`, the orchestrator may optionally set `model`, `thinkingLevel`, one `path`, and `toolNames`. Omitted fields inherit. `path` changes the worker's real working directory and narrows direct read/write authority to that workspace; omitting it keeps the parent working directory for process execution without narrowing machine scope. Tool overrides may only narrow the compatible inherited surface and an unavailable or root-only requested tool fails admission instead of being silently ignored. The host derives capabilities and paths, applies global kill switches and private-state denials, and persists the exact immutable grant before execution. Reusing an `agentId` keeps its admitted grant and transcript, so overrides are rejected on reuse.

An explicit `model` on `delegate start` that the owner's model policy or the favorite pool (`modelFavorites`, when `modelRouter.enabled`) does not allow fails closed with `worker_model_not_allowed:<provider>/<model>` instead of running a reallocated model. Pin the model as a favorite or allow its provider to use it. Omitted or inherited models are still reallocated into the pool.

`workerDelegation.modelPins` optionally lets the owner fix the provider, model, and thinking level used by each fresh worker role and by each leader runtime (`leader`, below). With no pins, delegation keeps the adaptive behavior above exactly. An applicable role or leader pin is a hard ceiling: a conflicting explicit `model` or `thinkingLevel` override fails closed with `worker_model_pin_conflict:<role>` instead of silently running a different model, while an omitted override uses the pin. The `default` pin is only a fallback for workers that state no model: a persistent bot's own model (its record's explicit `model`) outranks it, so that bot runs on its record's model, and a conflicting role or leader pin still refuses it. Owner-authored preset bindings are still narrowed to the pin. Tools, resources, workspace, and budgets follow normal admission. This applies to fresh workers and mandatory verifiers. The admitted binding is persisted and reported by `delegate start`; queued work, retries, resumes, recovery, and later tasks on a reused `agentId` keep that immutable contract even if settings change.

Pin precedence is deliberately different from ordinary deep-merged settings: global role, global default, trusted local role, trusted local default, then adaptive routing. A leader runtime is checked against `leader` first, with the same layer order as `default` (global, then the trusted user-level directory overlay, then the trusted project file); without a `leader` pin it follows the role and default chain. A global default therefore wins over every project role. Within trusted local settings, the user-level directory overlay wins over the project file at the same role/default tier. Untrusted project settings are ignored. Every binding must contain an exact `provider`, `modelId`, and supported `thinkingLevel`. Malformed pin configuration blocks fresh worker admission with `worker_model_pins_invalid`; an unavailable applicable pin blocks with `worker_model_pin_unavailable:<role>:<causes>`, where each cause is `model_not_found`, `model_out_of_scope`, `auth_missing`, `model_account_refused`, `model_account_rejected`, `model_account_unlisted` or `thinking_level_unsupported(<levels>)`, which lists the levels the model accepts. A pin on a model out of quota is not refused at start: it waits for the recorded reset within the lane's wait budget (see the provider admission section). Neither condition falls back to another model. Configure pins directly in JSON; `/settings` does not edit them.

A `roles`-only configuration (no `default` in any scope) leaves every role not listed under `roles` unpinned. This is valid but easy to configure by accident, so settings diagnostics list unpinned roles. Add a `default` to close the gap for every role, or pin every role explicitly under `roles` if adaptive routing is never intended.

`workerDelegation.modelPins.leader` fixes the model and thinking level of every leader runtime: a bot with `leader: true`, whether a standing leader, a goal leader the root appoints, or a nested leader. For those runtimes it overrides the bot record's model, which is then not sent as an explicit model, so the record cannot conflict with it. Role and default pins still govern the workers a leader starts, and a `leader`-only configuration pins no `delegate` call, so those calls keep adaptive routing. Without a `leader` pin, a leader runtime runs on its bot record's model like any bot. The key is forward-only: an older build rejects it and reports the whole pin policy invalid (`worker_model_pins_invalid`), because pin keys are strict. Set it only after every build that reads these settings supports it.

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
  "model": { "provider": "openai-codex", "modelId": "gpt-5.5" },
  "thinkingLevel": "high",
  "path": "/home/me/GitHub/project",
  "toolNames": ["read", "grep", "find", "ls", "write", "edit", "python", "bash"]
}
```

Fleet creation is bounded before Pi creates a durable task, conversation, agent, or queue entry: one session may retain at most 256 logical agents, and the scheduler queues at most its ready window (see Fleet). Every compiled worker profile has zero descendant depth and fan-out even if a legacy profile contains recursive limits. Admission preserves queue and durable-projection headroom for mandatory verifiers. A verifier dispatch that encounters saturation remains represented by its durable subject and replays on a queue-capacity event. How many workers run at once is the fleet's computed room (see Fleet); excess admitted work enters the bounded durable queue. Worker token, cost, tool-call, active-wall-clock, and attempt usage are reconstructed from durable checkpoints and checked before more work is admitted. The default delegation baseline adds no cost or active-time ceiling; positive global settings, profile budgets, and inherited foreground ceilings remain authoritative when explicitly configured.

`delegate` exposes the shared durable worker state to the owning root through distinct control actions:

- `tasks` returns a bounded view of durable DAG tasks, dependencies, status, latest attempt/agent dispatch, verifier state, terminal reason, and persisted retry eligibility. `start.dependsOn` accepts only existing same-objective task IDs; forward, cross-objective, self, and cyclic edges fail before dispatch.
- `list` returns safe metadata for session agents, including state and reusable activity; it does not expose private resume state.
- `transcript` pages bounded messages for the session root with an opaque raw-entry cursor and page size of 1-64. A page may be empty and still provide `nextCursor` after visiting non-message entries; an individually oversized message is omitted and counted rather than partially returned.
- `send` and `broadcast` queue bounded, non-waking, threaded peer evidence; broadcast canonicalizes a bounded target set and reports acceptance per target. Peer content is untrusted data, never authority.
- `follow_up`, `interrupt`, `resume`, and `cancel` let the owning root steer worker lifecycle. `interrupt` halts a running worker: it finishes its current request, is told the parent stopped it (`message` is the reason), spends one tool-free request on its own report, and ends as a `blocked` `worker_interrupted` result whose terminal handoff wakes the parent; the worker stays idle with its transcript and is continued with `follow_up`. A worker that reaches no request boundary within two minutes is cancelled and that cancellation is what the parent is told. `resume` re-enters a worker the host suspended for recovery or retry and keeps the admitted model, transcript, resources, and grant; a paused objective retains its suspended attempt without starting or cancelling it until objective resume drains the scheduler. A worker already running when its objective pauses keeps renewing its lease until it finishes or is cancelled. `cancel` terminates only the selected current task.
- `reply` answers one exact reply-expected request. The session root consumes replies through the acknowledged `inbox`, event-driven `inbox_wait`, and `inbox_ack` flow instead of unsolicited transcript injection.
- `wait` and `wait_many` are event-driven; `wait_many` accepts a bounded canonical target set and completes in `any` or `all` mode. `retire` replay-safely closes only an idle leaf after its mailbox and reply obligations clear, preserving its binding and transcript.

Transient attempt retries are evidence-gated. A classified provider or transport failure suspends the exact attempt with its retry count and ISO `notBefore` deadline, then resumes from the persisted transcript under a fresh fence when that deadline is eligible. Restart recovery uses the durable deadline rather than resetting an in-memory backoff; `maxAttempts: 1` disables the ladder, and missing/unknown failure classification never retries.

`delegate` returns a stable agent/lane identity immediately. A fresh `start` does not accept `laneId`; omit it, retain the returned `agentId`, and pass that `agentId` to a later `start` to reuse the persistent worker. Completion persists a bounded terminal handoff before waking the parent; late output stays in the worker transcript instead of racing into the active foreground transcript. Review-pending results remain `partial` and project blockers remain `blocked` in lane status and terminal handoffs instead of either being collapsed into harness failures. A scheduled transient retry is reported as nonterminal with its durable state retained. A full parent mailbox retains the attempt-keyed handoff until an explicit terminal, mailbox-capacity, state-change, or recovery event drains it—there is no retry polling loop. Exact replays are inert, conflicts fail closed, and delivery errors remain retained. Use `delegate { action: "status", laneId }` for bounded lane-result retrieval.

Global profiles live at `~/.pi/agent/profiles/orchestration/<id>.json`; project profiles live at `.pi/profiles/orchestration/<id>.json`. They are optional presets for model, reasoning, tools, resources, workspace, budget, verification, and prompt defaults. Select one with `profileId` on a call or configure `workerDelegation.orchestrationProfile`. Profile `maxConcurrent` is retained in the authored schema but does not override the global scheduler. `delegate` actions `profile_inspect` and `profile_create` manage immutable session-scoped narrowings. `profile_create` can omit `baseProfileId`; Pi then derives the foreground model, live thinking, compatible tools, and machine scope before applying optional `model`, `thinkingLevel`, `path`, and `toolNames` narrowing.

A preset with `requireIndependentVerification: true` still names an owner-authored `verificationProfileId`. The runtime creates a separate durable verifier task and accepts the implementation only after a typed verifier decision. A profile using `run_process` must declare `executionPolicy`; that tool launches only listed executables as direct argv. The platform shell is different: it is a real persistent per-agent shell and is not OS/container isolation. Shell commands can exercise the host process, filesystem, network, and credentials available to Pi; direct `write`/`edit` path scopes do not sandbox shell side effects.

Direct `write`/`edit` calls use review-after-apply semantics. The compiled grant and path policy reject out-of-scope direct mutations before they run, while accepted changes are reported to the parent with changed files, blockers, usage identity, and review state.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `workerDelegation.enabled` | boolean | `true` | Enable autonomous persistent leaf workers; explicit `false` is a hard off-switch |
| `workerDelegation.orchestrationProfile` | string | - | Optional default execution preset; agents may replace its defaults within inherited authority |
| `workerDelegation.maxUsd` | number | `0` | USD ceiling for one worker task; `0` is unbounded and a positive value explicitly enables the ceiling |
| `workerDelegation.maxWallClockMs` | number | `0` | Active wall-clock ceiling for one worker task; `0` is unbounded and a positive value explicitly enables the ceiling |
| `workerDelegation.haltReportDeadlineMs` | number | `120000` | How long an interrupted worker gets to reach a request boundary and report before it is cancelled; up to 2147483647 |
| `workerDelegation.routeProviders` | string[] | `[]` | Providers workers are routed to, in order, under `account: other`. Left empty, the harness routes only to subscription logins (OAuth), never to a provider reached only by an API key; naming an API provider here is the explicit choice that allows it |
| `workerDelegation.modelPins.leader` | binding | unset | The model and thinking level of every leader runtime: a bot with `leader: true`, whether a standing leader, a goal leader the root appoints, or a nested leader. It overrides the bot record's model for those runtimes; role and default pins still govern the workers a leader starts |
| `workerDelegation.modelPins.default` | binding | unset | The worker profile: `{provider, modelId, thinkingLevel}` every worker that states no model uses; a persistent bot's own model outranks it. A hard task (`assign` with `deep`, or `delegate` with a higher `thinkingLevel`) raises only the thinking level, never the model |
| `workerDelegation.writeEnabled` | boolean | `true` | Expose direct `write`/`edit`; explicit `false` revokes them for newly admitted work and narrows resumed grants |
| `workerDelegation.reportHandshake` | boolean | `true` | A worker about to stop with something the host can check (task requirement ids, commands it ran, files it changed) is asked once for a report through `submit_report`, citing the host's receipts; the host checks it and gives the root a verdict. A plain text answer is still accepted. Explicit `false` keeps the plain text path |
| `workerDelegation.modelPins` | object | - | Optional exact `default`, `leader` and per-role provider/model/thinking bindings for fresh workers and leader runtimes; malformed or unavailable applicable pins fail closed |
| `workerDelegation.account` | `"other"` \| `"same"` | `"other"` | Which account a fresh, unpinned worker runs on: another authenticated provider (a separate subscription or key, so a worker wave never competes with the owner's turn for one account) or the foreground model. A candidate whose account has a live machine-wide limit (see Provider Admission) is skipped for that dispatch. Falls back to the foreground when no alternative is authenticated |
| `workerDelegation.routeProviders` | string[] | `[]` | Ordered routing candidates, each `provider` (its default model) or `provider/modelId`; every other authenticated provider follows in catalog order. Example: `["openrouter/inclusionai/ling-3.0-flash-fin:free", "openai-codex"]` |
| `workerDelegation.routeProvidersByRole` | object | - | Per worker role (`explorer`, `implementer`, `verifier`, ...), an ordered candidate list that replaces `routeProviders` for that role, so a verifier can run on a stronger account than an explorer |
| `workerDelegation.outcomes.escalation.enabled` | boolean | `true` | After a worker outcome leaves requirements uncovered, the host reruns them itself (rung 1: same model, one thinking step higher; rung 2: the next ranked model, unbound lanes only) and runs host requirement checks. `false` leaves every such outcome with the owner or the parent. Takes effect once worker delegation installs the outcome follow-up; until then no rerun or host check is offered |
| `workerDelegation.outcomes.escalation.maxRungs` | integer 0-8 | `3` | The most escalation reruns one task's outcomes may schedule; budget limits and an already placed identical rerun also stop it |
| `workerDelegation.outcomes.learning.enabled` | boolean | `true` | Record worker outcomes in the host outcome ledger (model ids, task classes and counts only) and order routed worker models by that evidence inside the subscription-filtered list. `false` keeps the configured order. Takes effect once worker delegation installs the outcome follow-up; until then nothing is recorded and the order is unchanged |
| `workerDelegation.outcomes.learning.halfLifeDays` | number 1-365 | `14` | Days after which a recorded observation counts half |
| `workerDelegation.outcomes.learning.restHours` | number 1-720 | `24` | Hours a demoted model rests before it is tried again; doubles per repeated demotion |
| `workerDelegation.outcomes.learning.maxRestDays` | number 1-90 | `7` | The longest rest |
| `workerDelegation.thinking` | `"step_down"` \| `"inherit"` | `"step_down"` | How a worker derives its thinking level when no authority, profile or pin sets one: one notch below the foreground level (`xhigh` -> `high`, floor `minimal`, `off` stays off) or an exact copy |

The former `workerDelegation.maxConcurrent` and `workerDelegation.maxConcurrentBurst` are retired: a settings file that still contains them loads, the keys are ignored, and the harness log records one `settings` info line naming them.

### Fleet

The fleet decides how many workers run at once from facts, not from a fixed count. Before a queued worker starts, its room is the smallest of these terms, checked in order; the first term without room for one more worker holds it and names the reason in the queue entry:

1. the fleet is stopped;
2. the running ceiling (`fleet.ceiling.running`), and for a worker that writes files the writer ceiling;
3. the subscription allowance of the account the worker's own model runs on: while the provider flags a limit or any usage window is at or past 95% (the default owner quota line, fixed for the fleet), nothing more starts on that account until the latest of those windows resets; a reading below it, or one that is missing, stale or not a subscription, leaves the term open;
4. the account's adaptive window: how many workers one provider account serves at once is learned from the provider's answers. It starts at 4, halves on a 429, 529 or rate-limit refusal (once per congestion episode, never below 1), grows by one per success while the window is in use until the last refusal's level and slowly above it, and stays within the running ceiling and `providerAdmission.limits[provider]`. A used-up usage window blocks the account until its stated reset without shrinking the window. When a blocked window reopens, and after a resume or a restart that restores queued work, at most half the window starts until the first success, and the wake is spread by up to a tenth of the block (at most 30 s). Windows are shared by every pi process on the agent directory (`<agentDir>/state/fleet/accounts.json`);
5. the metered cost room, for paid (API-key) work on a priced model only (a subscription login and a local model never count): each bounded budget (`fleet.budgets.meteredUsdPerDay`, `fleet.budgets.meteredUsdPerGoal`) leaves room for its remainder divided by the worker's expected cost. A worker reserves its expected cost when it starts and is charged its measured cost when its run ends. The spend-rate brake pauses new paid starts while the current 15-minute window's spend is above the larger of `fleet.brake.minUsd` and 3 times the trailing week's 95th-percentile window; the owner is told in plain words, subscription work continues, nothing running stops, and paid starts resume at the next window or when the workers are resumed. Settled spend is shared by every pi process on the agent directory (`<agentDir>/state/fleet/spend.json`);
6. free machine memory above the reserve (`fleet.reserve.memoryPercent` of total memory, at least 1 GiB), after the expected cost of workers that started but have not grown yet;
7. the shared heap of in-process workers, kept under 70% of its limit (open under Bun, which reports no V8 old-space limit).

A waiting worker starts when the resource it waits on changes (a worker ends, an allowance reading changes, an allowance window's reset time arrives, an account window grows or reopens, a budget period ends); nothing polls. A planned dispatch whose binding term reopens later than `fleet.queueHorizonMs` from now (or whose day or goal budget is used up) is refused with the reopen time instead of queued, so its owner can plan around it. The queue is fair across objectives and their subtrees, ages waiting work, and keeps mandatory verifiers first. Queued ordering metadata (first enqueue time, last wait reason, reopen time, the stop flag) is kept at `<agentDir>/state/fleet/queue/<sessionId>.json` so a restarted session restores it; the queued work itself is recovered from the durable task ledger. The queue admits at most its ready window: the running ceiling plus the larger of 8 and a quarter of it, with the last slot reserved for a mandatory verifier.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `fleet.ceiling.running` | number | `256` | Blast-radius ceiling on workers running at once; computed room decides below it |
| `fleet.ceiling.writers` | number | `64` | Ceiling on running workers that hold write authority |
| `fleet.ceiling.tree` | number | `1024` | Ceiling on the nodes of one work tree; read by plan and leader owners, which do not exist yet, so nothing enforces it today |
| `fleet.reserve.memoryPercent` | number | `10` | Percent of total memory kept free for the rest of the machine (at least 1 GiB); clamped to 0-90 |
| `fleet.budgets.meteredUsdPerDay` | number | `0` | Paid (API-key) worker spend allowed per local calendar day, in dollars, across every pi process on the agent directory; `0` means unbounded |
| `fleet.budgets.meteredUsdPerGoal` | number | `0` | Paid (API-key) worker spend allowed per goal, in dollars; `0` means unbounded |
| `fleet.brake.minUsd` | number | `1` | The spend-rate brake never engages below this 15-minute paid spend, in dollars |
| `fleet.queueHorizonMs` | number | `900000` | A planned dispatch waits queued for a known reopen up to this far ahead; a later one is refused with its reopen time |

### Orchestrator

The root orchestrates and its workers carry out the work. While the `delegate` tool is active, the delegation gate checks each root call before it runs: a `write` or `edit` outside the orchestration directories (the agent directory and the project's `.pi`), and a `bash`, `run_process`, `powershell` or `python` call System One establishes as task work (changing project files, or running a build, test, install or program) are refused, and the refusal says how to delegate. Reading, searching, planning, reviewing, and writing agent definitions and instruction files for workers always pass. A System One doubt or outage lets the call run; without a System One engine only the typed-write rule applies. The gate never applies to a worker, and YOLO does not skip it.

| Setting | Default | Description |
|---------|---------|-------------|
| `orchestrator.delegationGate` | `false` | Opt-in strict split: refuse root calls that are task work and send them to a worker. Off by default: the root edits and runs commands itself and delegates by choice. |

### Orchestration retention

```json
{ "orchestration": { "retention": { "closedObjectiveDays": 14 } } }
```

| Setting | Default | Description |
|---|---|---|
| `retention.closedObjectiveDays` | `14` | Days a closed objective, a finished session task, or a closed session plan (released together with every task it names) stays in the session's orchestration store before it is released at idle (0 to 3650; 0 keeps everything for the session's life). When the store is within 32 records of its objective or attempt limit, closed work with nothing in the store holding it is released regardless of age (unless the setting is 0). Released records are written to the session's `archive/` folder first, and they stop counting toward the store's limits. Work an agent resumes from, a notice or approval still pending, an open plan, a result not yet received, and a delegation whose outcome has not been delivered are never released. Once a session releases work, earlier pi versions cannot open that session's orchestration store. Not the same as `orchestrator` (the delegation gate). |

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

Native reflection belongs only to the main/orchestrator session. Each eligible external root turn carries one provider-only cue in that same current-session request; completed-turn evidence coalesces into the next eligible cue. Reflection never starts a separate/background model request. Workers cannot run reflection or mutate durable memory; they return evidence to the parent, which decides what should be retained. A fresh main session uses this audited learning policy:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `learningPolicy.enabled` | boolean | `true` | Route reflection writes through the decision/audit/rollback policy |
| `learningPolicy.autoApplyEnabled` | boolean | `true` | Apply eligible additive or organizational learning without asking the user to babysit it |
| `learningPolicy.confidenceThreshold` | number | `50` | Minimum confidence for automatic application |
| `learningPolicy.minObservations` | number | `1` | Minimum repeated observations for automatic application |
| `learningPolicy.allowedAutoApplyLayers` | string[] | `["memory", "skill"]` | Layers eligible for automatic application; other layers remain proposals |
| `learningPolicy.requireRollbackPlan` | boolean | `true` | Require an inverse plan before an automatic durable write |
| `learningPolicy.autoApplySupersessions` | boolean | `false` | Keep memory replacement/removal approval-gated unless explicitly enabled |

Safe `memory_add`, `okf_add`, and `okf_organize` writes can therefore land autonomously, including moving an exact hot-memory fact from `MEMORY.md` into structured OKF storage. Clean skill promotion is also eligible after overlap checks. `memory_replace` and `memory_remove` remain proposals by default because they supersede existing knowledge. Every applied write records its decision, outcome, and rollback data.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `autoLearn.enabled` | boolean | `true` in every autonomy mode | Enable root-session current-turn reflection. Disabling it immediately dismisses the session cue and releases any exact version claim. Re-enabling lets the next external root turn reconcile a still-pending version transition, but does not resurrect ordinary dismissed cue evidence. Automatic reflection never schedules a separate or background model request. |
| `autoLearn.model` | string | `modelRouter.learningModel`, otherwise `"active"` | Legacy/direct override for the background learner; `"active"` uses the current session model, otherwise use a `pi --model` pattern |
| `autoLearn.longSessionMessages` | number | `32` | Readiness threshold after this many message entries in the active branch for an eligible learner run |
| `autoLearn.longSessionContextPercent` | number | `70` | Readiness threshold when current context usage reaches this percent |
| `autoLearn.cooldownMinutes` | number | `1440` | Per-session-tenant cooldown between learner launches |
| `autoLearn.leaseMinutes` | number | `90` | Shared-state lease duration for a running background learner |
| `autoLearn.maxConcurrentLearners` | number | `1` | Maximum running Auto Learn background learners per session tenant |
| `autoLearn.applyHighConfidence` | boolean | `false` | Allow the main session to apply high-confidence proposals returned by the read-only background learner (memory candidates; skill create/update under skill-evolution eligibility). The learner itself never writes; broader authority is controlled by `autonomy.mode` |
| `autoLearn.reflectionReview` | boolean | `true` | Allow root-only provider cues on eligible external turns. Corrective, durable, complex, and version-transition evidence coalesces into the one current cue; accepted delivery is distinct from strict terminal review completion. |
| `autoLearn.reflectionMinToolCalls` | number | `12` | Queue a root-session reflection cue after this many tool calls in one completed turn |
| `autoLearn.reflectionCooldownMinutes` | number | `1440` | Per-session-tenant cooldown between automatic root-session reflection cues; corrective and complex-task signals can bypass it |

Eligible root sessions also reconcile `~/.pi/agent/state/durable-learning-state.json`, which records only bounded runtime/memory-policy transition control state. First observation and version changes are audit cues, not semantic-write authority. Child and worker sessions receive no state owner; unsupported or oversized state remains byte-preserved and read-only. In OKF mode, canonical project truth routes to OKF, while workflow context keeps status plus OKF references instead of duplicate facts. The ICM memory-system setting below disables this legacy automatic learning path and uses ordinary workspace files instead.

Use `/settings` → **Model Router** for the preferred place to choose the learner/skill-creator model. Automatic reflection uses the orchestrator's current session turn rather than a separate or background model request. Use `/settings` → **Auto Learn Advanced** for readiness/cooldown/concurrency overrides and the legacy direct `autoLearn.model` override. Use `/autonomy status` for the compact preset dashboard, `/auto-learn status` to inspect readiness and running leases, or `/auto-learn run` to explicitly start one bounded background learner immediately. Workers never receive reflection or durable-memory mutation authority; they return evidence to the root orchestrator. When the session that launched a learner is no longer active at exit, the learner's validated proposals stay in the run's handoff record (`parent_session_changed`, attributed to the run id). The next interactive session for the same project offers them at startup under the same `autoLearn.enabled` and autonomy eligibility, then finalizes the record: applied or reported, retained proposals cleared, never offered twice. While `autoLearn` is disabled they stay pending until the 7-day handoff retention expires them. A re-offer interrupted after the record was claimed is reported and not re-applied.

When enabled, Auto Learn keeps a small shared state file for visibility/cooldowns, but prompt/log/session artifacts are isolated under per-session-tenant directories so one session's learner does not consume another session's concurrency budget. Learners must confront available user/project memory first, using existing rules, preferences, corrections, and project facts to decide whether each candidate is useful, unique versus merge/upgrade-worthy, and agent-improving. Candidate validation is chunked/vectorized instead of one memory query per candidate. Successful Auto Learn workers purge their internal prompt/log/session artifacts after exit; the 7-day retention pruner is a fallback for unfinished or failed artifacts, and active leases are skipped so running learners are not raced. Provider/user history pruning is delegated to the continuous-learning tool after it records a learning outcome: only files older than 7 days whose current fingerprint still matches a successfully extracted index entry are deleted, and active/current sessions are protected.

```json
{
  "autoLearn": {
    "enabled": true,
    "model": "active",
    "longSessionMessages": 32,
    "longSessionContextPercent": 70,
    "cooldownMinutes": 1440,
    "leaseMinutes": 90,
    "maxConcurrentLearners": 1,
    "applyHighConfidence": false,
    "reflectionReview": true,
    "reflectionMinToolCalls": 12,
    "reflectionCooldownMinutes": 1440
  }
}
```

### Compaction

The checkpoint owns user intent mechanically: `## Active Task` copies the latest user request verbatim, and a split-turn prefix copies its original request without a second model rewrite. Tool output remains evidence and cannot become a new active task. Validated one-turn operation rejections expire instead of becoming durable completed actions or open problems.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction. Under ICM it applies to the running chat turn only (see [Compaction](compaction.md#icm-and-host-compaction)) |
| `compaction.model` | string | `"auto"` | Summarizer model pattern. `auto` follows router cheap when available, but always consults exhausted-provider state and the subtractive `digest` fitness surface before falling back visibly to the session model. |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.triggerPercent` | number | `0.6` | Context-efficiency and latency trigger as a fraction of the model window; separate from the USD cost guard |
| `compaction.selfMonitor.enabled` | boolean | `true` | Let the agent watch its context gauge and hand itself off with `self_compact` (see [Compaction](compaction.md#self-monitoring-compaction)). Under ICM the end of the turn releases the context instead of a compaction |
| `compaction.selfMonitor.notice` | number | `0.7` | Notice line as a fraction of the first compaction trigger (the early trigger when it is below hard, else hard) |
| `compaction.selfMonitor.warning` | number | `0.85` | Warning line as a fraction of the first compaction trigger; must not be below `notice` |
| `compaction.selfMonitor.forced` | number | `0.95` | Forced line as a fraction of the hard trigger (never below the warning line) |
| `compaction.selfMonitor.prompts` | object | built-in | Optional `notice`, `warning` and `summary` texts with `{{placeholders}}` |

A rejected `compaction.selfMonitor` value (a non-boolean `enabled`, a fraction outside (0, 1], `notice` above `warning`, or a malformed prompt) disables self-monitoring and names the reason in `/self-compact-info` and `context_audit`.

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Proactivity

A bounded idle review that raises notes the owner did not ask for. It is on by default and each review is a model request nobody asked for, so it is capped: a few reviews per session, a spend bound per review, a minimum of new owner turns between reviews, and two rolling-day bounds across sessions: review spend, and note deliveries that start a parent turn. `/proactivity off` or `"proactivity": { "enabled": false }` turns it off.

```json
{
  "proactivity": {
    "enabled": true,
    "idleDelayMs": 120000,
    "minOwnerTurnsBetweenRuns": 3,
    "maxRunsPerSession": 4,
    "maxNotesPerRun": 2,
    "maxUsd": 0.05,
    "maxUsdPerDay": 0.25,
    "maxTurnWakesPerDay": 3,
    "delivery": "turn",
    "preferences": "Raise only work I asked for that is still undone.",
    "ciEvents": true
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Allows the idle review. `/proactivity on` and `/proactivity off` write it. |
| `model` | session model | Model pattern for the review. |
| `idleDelayMs` | `120000` | Foreground idle time before a review starts. A turn that begins during the delay cancels it in effect: the next idle arms a fresh review. |
| `minOwnerTurnsBetweenRuns` | `3` | New owner-typed turns required since the last review. Peer messages, goal continuations and other internal turns do not count. |
| `maxRunsPerSession` | `4` | Reviews per running session, whether or not they raised anything. |
| `maxNotesPerRun` | `2` | Notes one review may raise. |
| `maxUsd` | `0.05` | Spend bound of the isolated review, limited to two provider requests. A parent wake uses normal session accounting and budgets and can incur additional inference cost. |
| `maxUsdPerDay` | `0.25` | Review spend over the last rolling 24 hours, across every session stored with this one (all projects under the agent directory, or only the custom session directory). Once reached, no review starts (`max_usd_per_day_reached`); below it, a review's bound is the smaller of `maxUsd` and what remains. `0` allows no review spend. |
| `maxTurnWakesPerDay` | `3` | Parent turns started without an owner message over the same rolling 24 hours and sessions: proactive note deliveries and CI events delivered to the main session count together. Past it, an accepted note or CI event waits for the owner's next turn instead (`max_turn_wakes_per_day_reached`); it is never dropped. `0` sends every note and CI event with the owner's next turn. |
| `delivery` | `"turn"` | An accepted note starts a parent turn without another owner message. Explicit `"note"` carries it with the owner's next turn instead. Both explicit choices are preserved. |
| `preferences` | empty | The owner's standing words about what to raise, how often and in what tone, at most 2000 characters. Every review reads them and they override the review's defaults. |
| `actAhead.enabled` | `true` | When the checkout's CI fails, the main session prepares a validated patch in a throwaway worktree by itself (see [Acting ahead on failing CI](proactivity.md#acting-ahead-on-failing-ci)). Independent of `enabled`. Read only from the global settings and the directory overlay under the agent directory; a settings file that cannot be read turns it off. |
| `actAhead.validate` | `"static"` | The check run before and after the worker: `"static"` runs `npm run check`, else `typecheck`, else `lint`, as named in the failing revision's `package.json`; `"command"` runs `actAhead.command` (without a command it stays `"static"`). |
| `actAhead.command` | unset | The owner's check command for `"command"`, at most 500 characters. |
| `actAhead.maxAttemptsPerDay` | `3` | Workers started over any rolling 24 hours across the sessions stored together (0 to 20). |
| `actAhead.maxUsdPerDay` | `0.5` | Worker spend over the same window (0 to 20). An attempt counts `maxUsdPerAttempt` when it starts and its worker's spend once it ends. |
| `actAhead.maxUsdPerAttempt` | `0.25` | One worker's spend budget (0 to 5). |
| `actAhead.maxMinutesPerAttempt` | `20` | One worker's wall-clock budget and each check run's timeout (1 to 120). |
| `feedback.enabled` | `true` | System One judges what the owner's next typed reply did with each delivered note, and code sets a topic aside after unanswered or declined notes in a row (see [Note feedback](proactivity.md#note-feedback)). `false` asks, records and sets aside nothing. The `feedback` fields are read only from the global settings and the directory overlay under the agent directory; an invalid value is ignored. |
| `feedback.suppressAfter` | `2` | Ignored or dismissed notes in a row on one topic that set it aside (1 to 10). |
| `feedback.baseSuppressDays` | `7` | Days a set-aside lasts at level one (1 to 28); each set-aside raises the topic's level, up to three, doubling the length per level, and a note the owner takes up lowers it by one. |
| `ciEvents` | `true` | The main interactive session observes the checkout's `ci.yml` results through `gh` and delivers them as host events (see [Proactivity](proactivity.md)). `false` stops that discovery: no `gh` process or GitHub request. The footer CI verdict still reads the local record written by the pre-push watcher. Read when a session starts or is switched. |

**What the review can do.** The host decides whether a review may start (enabled, the per-session cap, enough new owner turns, an idle foreground, the rolling-day spend) and what it may do: its one tool records a note. The model only judges whether the conversation shows a need, so the behavior does not depend on a particular model. The host then drops notes that are empty, malformed or repeats of a note already raised on the branch, and delivers at most `maxNotesPerRun`. A review that raises nothing, the usual outcome, leaves no trace in the conversation.

**Owner control.** `/proactivity status` shows the settings, the last rolling-day measurement, the topics set aside after unanswered or declined notes, the gate that last kept a review from running, and whether the last accepted notes woke a parent turn or wait for the owner's next turn and why. `/proactivity prefs <text>` replaces the standing preferences and `/proactivity prefs clear` removes them. `/proactivity review` runs one review now, still subject to every gate except the idle delay. The root model can also read or propose changes through the `proactivity` tool. Every change requires confirmation on the owner's screen; cancellation, refusal, a conflicting edit during confirmation, or an unattended session prevents the write. Workers do not receive this tool. See [Proactivity](proactivity.md).

### Routines

```json
{
  "routines": {
    "automaticIntake": true,
    "maxResultWakesPerDay": 10,
    "away": { "enabled": true, "maxUsdPerRun": 0.25, "maxUsdPerDay": 1, "maxParentHosts": 4, "autostart": "notify" }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `automaticIntake` | `true` | After an owner turn settles, the host reads the owner's new messages and creates a read-only routine for each explicit recurring, scheduled or CI-conditioned request, announced on the next turn (see [Proactivity](proactivity.md#scheduled-work)). `false` stops it; messages written while it is off are never read later. The `routine` tool is unaffected. |
| `maxResultWakesPerDay` | `10` | Routine results that start a parent turn over any rolling 24 hours, across the sessions stored together (0 to 1000). Past it a result is saved to the conversation and carried with the owner's next turn instead, and the first one held adds one notice naming this setting; quiet results never count (see [Proactivity](proactivity.md#limits)). `0` starts no turn for a routine result. |
| `away.enabled` | `true` | A due read-only routine run of a session that is not open runs in the background bot daemon (see [Proactivity](proactivity.md#scheduled-work)). `false` leaves it for the session's next open. |
| `away.maxUsdPerRun` | `0.25` | Spend bound of one run away (0.01 to 5); a run is charged this from its admission until it finishes, then its settled spend (read from its ledger usage and saved on the run) for 24 hours. Each provider request of the run has its output capped to what is left of the bound; a request the rest cannot pay for, or one on a model without declared prices, ends the run failed, and a routine whose pinned model has no declared prices is not admitted away. |
| `away.maxUsdPerDay` | `1.00` | Spend of runs away over any rolling 24 hours across the agent directory (0 to 50), counted in whole micro-dollars. A due run that would pass it waits for its session or for charged spend to leave the window; `0` runs nothing away. |
| `away.maxParentHosts` | `4` | Sessions the daemon holds open away at once (1 to 16). |
| `away.autostart` | `"notify"` | Always-on: a user service of the operating system that starts the daemon at login, so routines of closed sessions keep running after a reboot (see [Always-on](proactivity.md#scheduled-work)). `"notify"` installs nothing and tells the owner once per agent directory how to turn it on; `"on"` installs it at the next session start or routine save while an enabled routine exists; `"off"` does neither. Read from the global settings and the directory overlay under the agent directory only; a settings file that cannot be read gives `"notify"`, and any other value reads as `"notify"`. |

A value outside its range is replaced by the default. The daemon reads `routines.away` from the global settings file only, and applies a change from its next renewal (every 10 seconds).

### Leaders

```json
{ "leaders": { "maxDepth": 1 } }
```

| Setting | Default | Description |
|---------|---------|-------------|
| `maxDepth` | `1` | How many leader levels a goal handed over with `bot lead` may nest (1 to 2; a value outside the range reads as 1). See [Leaders lead goals](bots-and-groups.md#leaders-lead-goals). |

### Channels

Admission policy for each chat or mail channel: the shipped `telegram`, `slack` and `gmail` transports, which start by themselves under an explicit policy, and any channel a deployment wrapper registers on a session (see [Channels](channels.md)). Read from the global settings and the directory profile only, never from a repository's `.pi/settings.json`; the first of the two that names a channel decides its whole policy. When the session's settings change or are reloaded, its channels start or stop to match.

```json
{
  "channels": {
    "mail": { "mode": "explicit", "allowedSenders": ["alice@example.com"] },
    "chat": { "mode": "explicit", "allowedSenders": ["U024BE7LH"], "replyMode": "auto", "maxWakesPerDay": 5 }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `channels.<name>.mode` | `"ignore"` | `"explicit"` starts the channel; `"ignore"` keeps it stopped. A channel with no entry is not started. |
| `channels.<name>.allowedSenders` | `[]` | Sender ids (as the provider reports them, at most 50) whose verified messages may start a turn; a whole number (a Telegram user id) may be written unquoted; a Slack user id is written as a string (`"U0123ABCDEF"`); a Gmail sender is its mail address (`"alice@example.com"`), compared without regard to case. Any other sender, and an unverified one, is held and starts nothing; the owner is told of a held verified sender once a day, with its id when the platform assigned it (Telegram, Slack), else the `channel_reply` tool's `list` shows the id. |
| `channels.<name>.replyMode` | `"draft"` | `"draft"` keeps each answer for the owner to send with the `channel_reply` tool; `"auto"` sends it to the conversation's address. |
| `channels.<name>.maxWakesPerDay` | `10` | Turns the channel may start over the last 24 hours (0 to 200). |
| `channels.<name>.maxUsdPerDay` | `0.5` | Spend of those turns over the last 24 hours (0 to 100). |
| `channels.<name>.maxBatch` | `10` | Messages of one conversation delivered as one turn (1 to 25). |
| `channels.<name>.maxPendingPerConversation` | `25` | Messages one conversation may have waiting (1 to 100); further ones are held. |
| `channels.<name>.awayCwd` | unset | Absolute directory where the background bot daemon serves the channel while no session is open (see [Channels](channels.md#while-no-session-is-open)). Read from the global settings only; a relative path rejects the policy. |
| `channels.<name>.ownerSenders` | `[]` | The owner's own platform ids (at most 10, each once), read only on the `telegram` (user numbers, may be written unquoted) and `slack` (user ids such as `"U0123ABCDEF"`) channels; a non-empty list on another channel or an id of the wrong shape rejects the policy. Their verified private-chat messages run as owner turns (see [Channels](channels.md#the-owners-own-chat)). |
| `channels.<name>.ownerMaxUsdPerDay` | `5` | Spend of owner turns over the last 24 hours (0 to 100); `0` starts no owner turn, control words still answer. |
| `channels.<name>.ownerMaxUsdPerTurn` | `1` | Spend of one owner turn (0.05 to 20): reserved from its offer, the turn is stopped when it reaches it. |
| `channels.<name>.ownerPushPerHour` | `12` | Updates pushed to the owner's chats per rolling hour (0 to 60); past it one line an hour says how many more wait. |
| `channels.<name>.ownerAuthority` | `"guarded"` | Read only on the `telegram` and `slack` channels (any value elsewhere rejects the policy). `"guarded"` keeps the phone's limits: typed-only actions are refused and only the standing third-party grants apply. `"full"` makes a live, verified owner message from the phone run with the owner's own authority at the terminal: the session's grants, the terminal's classifier (none in YOLO), and held confirmations released by `approve`; the hardline and `edge.deny` floor, the emergency stop, the spend bounds and the live check stay. Any edit of the policy ends a running full turn (see [Channels](channels.md#the-owners-own-chat)). |
| `channels.<name>.ownerQuotaMaxUsedPercent` | `95` | `0` to `100`. While the session's model is a subscription login (OAuth) whose account usage, read from the provider, is fresh (at most 5 minutes old) and reports every usage window (a 5 hour one, a weekly one, whatever the account has) below this percent with no limit flag, `ownerMaxUsdPerTurn` and `ownerMaxUsdPerDay` do not apply: a turn runs past its per-turn bound, new turns start whatever the day holds, and turns accepted then charge no dollars to the owner pool. A reading that is missing, stale, failed or unsupported, a model that is not a subscription login, or a value of `0` leaves the dollar bounds in force. `ownerMaxUsdPerDay: 0` still starts no turn. See [Channels](channels.md#the-owners-own-chat). |
| `channels.<name>.ownerTerminalOnlyClasses` | `[]` | Edge classes of held actions that `approve` from the owner's chat never releases; they are released at the terminal. |

Unlike other settings, a value outside its range is not replaced: the whole policy of that channel is rejected, the channel is not started, and the owner is told why.

### Cost Guard

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `costGuard.enabled` | boolean | `false` | Explicitly enable foreground per-turn cost projections and enforcement |
| `costGuard.maxTurnUsd` | number | `0` | Projected per-turn USD ceiling; a positive legacy value remains dormant until `enabled` is `true` |
| `costGuard.action` | string | `"warn"` | `"warn"` only reports the estimate; `"downgrade"` also lowers reasoning one rung for that request without changing saved/profile state |

The projection uses the session response reserve, cached-input rates, and model-declared long-context tiers. ChatGPT subscription usage is marked `(sub)` and does not enter the USD guard. Enable it explicitly through `/settings` → **Foreground cost guard**, or in JSON:

```json
{
  "costGuard": {
    "enabled": true,
    "maxTurnUsd": 0.5,
    "action": "warn"
  }
}
```

### Context GC

Context GC only rewrites the provider-bound context view. It does not delete or mutate the canonical session log.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `contextGc.enabled` | boolean | `true` | Enable provider-context packing for stale bulky context |
| `contextGc.preserveRecentMessages` | number | `24` | Recent messages kept verbatim |
| `contextGc.packStrideMessages` | number | half the window (`12`) | Grid the recent boundary advances on. Unsent messages pack as the boundary passes them. At each grid crossing, the packable messages the provider has already cached are offered as one batch and packed only when the tokens saved over the remaining requests pay for re-prefilling the suffix behind them (priced on the executing model); a declined batch stays as sent and is offered again at the next crossing. `1` means no crossings: the sent prefix is never rewritten |
| `contextGc.minToolResultChars` | number | `1200` | Minimum stale tool-result size before packing |
| `contextGc.tools` | string[] | `read`, `bash`, `python`, `powershell`, `rg`, `grep`, `find`, `run_toolkit_script`, `ls`, `skill_open`, `automata_graph_status`, `automata_graph_search`, `automata_graph_query`, `automata_graph_neighbors`, `automata_graph_path`, `automata_graph_pointer_pack`, `learning_query_memory`, `subagent`, `delegate`, `task_steps`, `pipeline`, `task_background`, `task_goal`, `run_ledger`, `artifact_retrieve` | Tool results eligible for stale-output packing. A packed stub names its original as `artifact_retrieve context:<key>`; a packed retrieval points back at the same original |
| `contextGc.semanticMemory.enabled` | boolean | `true` | Pack stale Automata/Mind semantic context pages from provider context |
| `contextGc.semanticMemory.preserveRecentPages` | number | `1` | Newest semantic memory pages kept verbatim |
| `contextGc.semanticMemory.minChars` | number | `900` | Minimum semantic page size before packing |
| `contextGc.semanticMemory.markers` | string[] | Automata/Mind XML-ish tags | Markers used to identify deterministic memory pages |

Semantic memory packing only targets tool results and Automata/Mind custom context messages; normal user prompts are preserved even if they contain matching marker text.

The host's task_steps checklist page is packed the same way and is recognized by its message type, so it needs no marker and a custom `markers` list does not turn it off. `markers` governs memory-provider and other foreign pages, and pipeline pages, which also appear in `pipeline` tool results.

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

### Proof sheets

When a goal completes, a worker's result arrives or a plan's combined result settles, the host shows a proof sheet before the model's words: the commands that ran, which check covered which requirement, the changed files no check touched, assumptions, the brief's done line and out-of-scope items, and the stakes. `/status` counts the results with a proof sheet that arrived since your last message.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `proofSheets.reviewWaitingNoticeAt` | number | `5` | Give one notice when this many results wait since your last message (at most 100; `0` turns the notice off). It never holds work. |

### Explanation style

`steStrictness` sets the standing ASD-STE100 writing strictness for explanations, analyses, reviews and summaries: an integer from 1 to 10, default 9, where 0 turns the style off. The value is rendered in the system prompt for every model class and takes effect when the prompt rebuilds (new session or `/reload`). The bundled `ste100-writing` skill holds the full rule set and the per-level dial; an explicit strictness in a message overrides the setting for that message.

### Memory system

`memorySystem` selects one active system: `"icm"` (the default) or `"okf"` (explicit opt-in). An omitted or invalid selection resolves to ICM through the settings owner; startup, prompts, and reflection use that same resolved selection. This is separate from retrieval controls. Existing explicit selections remain effective, and the inactive system is offline, not deleted.

Use `/memory system` to inspect the selected system, `/memory system icm` to select ICM explicitly, and `/memory system okf` to opt in to OKF. Switching applies to the current directory profile and requires an idle session; it rebuilds memory providers and tools rather than requiring a process restart. A failed switch is reported as a failure, not as successful activation.

**ICM mode** stores persistent Markdown memory in the user catalog under `~/.pi/agent/memory` and stores reusable pipelines under `~/.pi/agent/pipelines`. The current workspace remains the project source and task-artifact boundary; ICM does not scaffold memory or pipeline folders there unless the user explicitly requests project-local artifacts. Only routing and scoped path pointers are surfaced automatically; references and working artifacts are read or searched on demand with native tools. Large files remain on disk and can be read in pages. Read-response and model-context limits are resource controls, not storage quotas. Reference contents remain evidence, not tool authority or new security instructions.

The legacy file-store and OKF stores, memory CRUD actions, automatic memory retrieval and prompt memory blocks, persona and automatic memory reflection are inactive in ICM mode. Existing legacy files are preserved unchanged; switching does not migrate or delete them. Switching back restores their availability. Historical generated legacy recall is excluded from the active ICM provider view without deleting the session transcript.

History recall is available in both systems through one backend. In ICM, without the continuous chat, the root `memory` tool offers only `history_search` (with approved summaries listed beside the hits), `history_source` and `history_expand`; the index starts on the first explicit history request, and a granted worker reads history through `memory_read`. Summary and admission egress keep their own settings below; switching the memory system changes neither. While the continuous chat runs, the root navigates with `zoom` and `date` instead. See [Memory and history recall](memory.md).

### Context memory and history

`contextPolicy.memory.enabled` and the `history.*` keys apply in both memory systems: with retrieval disabled every history read is refused by policy and no history index starts. `includeInPrompt`, `maxResults` and `allowExternalEgress` govern OKF automatic retrieval.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `contextPolicy.memory.enabled` | boolean | `true` | Enable memory retrieval: OKF safe-auto retrieval and history reads in both systems |
| `contextPolicy.memory.includeInPrompt` | boolean | `true` | Include retrieved memory only when the active model budget permits it |
| `contextPolicy.memory.maxResults` | number | `5` | Maximum retrieval results before tier/budget pruning; clamped to 1-20 |
| `contextPolicy.memory.allowExternalEgress` | boolean | `false` | Explicitly allow eligible external memory providers to receive bounded, non-secret-like query text |
| `contextPolicy.memory.history.hierarchy` | boolean | `false` | Opt in to durable summaries of captured history plus a bounded history frontier; the ICM continuous chat does not read this switch; exact local recall is not governed by this switch |
| `contextPolicy.memory.history.summaryModel` | string | unset | Model ref (`provider/id` or bare id) that writes history summaries; required for the hierarchy to run, and for the ICM continuous chat's compactions (see [Memory](memory.md#continuous-chat-icm)) |
| `contextPolicy.memory.history.compactionThinkingLevel` | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` | `medium` | Reasoning effort of every ICM compaction; the summary model must support it, and its reasoning tokens are billed as output on every reply, corrections included (see [Memory](memory.md#continuous-chat-icm)) |
| `contextPolicy.memory.history.compactionMaxUsdPerDay` | number | `10` | Daily USD the ICM chat's background summaries may spend, shared by every project and session on the account. At the limit no new summary starts until the next UTC day, the owner is told once, and the full history stays readable with `zoom` and `date`. `0` removes the limit. |
| `contextPolicy.memory.history.allowExternalSummaryEgress` | boolean | `false` | Allow captured history to be sent to a non-local summarizer (external egress) |
| `contextPolicy.memory.history.allowExternalAdmissionEgress` | boolean | `false` | Allow captured history to be sent to the remote System One evaluator that admits model summaries (external egress, independent of the summarizer's; a local summary model does not make the evaluator local). Without it, model summaries are held and `/memory history` says why; exact copies and exact history recall are unaffected |
| `contextPolicy.memory.history.maxConcurrentSummaries` | number | `2` | Concurrent summary jobs; clamped to 1-4 |
| `contextPolicy.memory.history.frontierMaxBytes` | number | `4096` | UTF-8 byte allowance for the serialized history frontier; clamped to 1024-16384 |
| `contextPolicy.memory.history.retentionDays` | number | unset | Age out derived summaries whose source history is older than this many days; never erases transcripts or limits exact history reads; unset keeps summaries as long as their canonical sessions; clamped to 1-3650 |

Numeric memory settings share one input policy: a non-finite or non-number value takes the default (`retentionDays` takes unset); a finite value outside the range is clamped to it, and a fraction is truncated. Curation differs: `contextPolicy.curation.maxJobsPerTurn` (default `4`, range 1-16) rejects a non-integer or out-of-range value and uses the default; it is never clamped.

For models with `contextWindow <= 2048`, provider-visible memory is capped to 10 lines and about 200 estimated tokens total. If standing/current-work/long-term memory cannot fit that cap, Pi skips the memory block rather than overflowing context. `MEMORY.md`/`USER.md` retain bounded static prompt views. Normal-window retrieval can also find general/project facts omitted from the installed prompt snapshot, excluding exact lines already included; compact windows retain the file-store fallback. Custom local memory layers, such as Automata, should register a context provider with `pi.registerContextMemoryProvider`; core ships only local file-store and OKF readers. Legacy providers must declare `egress: "local"` to participate in safe-auto recall; omitted classifications fail closed as external. External memory egress requires the visible `/settings` consent or `allowExternalEgress: true`, remains bounded to 2,000 characters, and rejects labeled credentials, bearer/basic tokens, common raw provider tokens, private keys, and signed URLs. Every legacy provider recall page is centrally source-labeled and fenced as untrusted data. Past-session history recall is not a pre-turn page: it is a retrieval provider like the others, and its hits join the same evidence block at the lowest tier (they only use the budget that curated memory leaves), each cited with a `tx:` handle that the `memory` tool's `history_source` action opens exactly. The block's allowance is bounded by the model's remaining headroom (the prompt already carried plus the larger of the compaction `reserveTokens` and the output cap) and by a UTF-8 byte ceiling in addition to the line, token and character limits. When the block becomes disabled, empty or unaffordable, one cleared record replaces the stale one instead of leaving it looking current. Later requests of a turn reuse that turn's evidence; a new user turn retrieves again. `/memory history` and `context_audit` report history coverage, skipped and uncaptured reasons, the last indexing error and the latest retrieval status. Live extension load/unload immediately rebuilds the memory generation, activating new providers and shutting down/removing only those owned by the unloaded extension.

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

#### Durable storage versus prompt allocation (OKF mode)

General and project `MEMORY.md` files retain complete facts beyond the former 1,200/2,200-character quotas. Managed writes use a **512,000 UTF-8 byte resource ceiling per file**, separate from prompt allocation. Existing larger files are not deleted or silently shortened; an over-ceiling repair must reduce their byte size. Locking, drift recovery, and write-admission rules still apply.

Prompt views select whole lines under estimated-token allocations: 300 for general memory, 550 for project memory, and 344 for user preferences. Model capability limits may narrow the complete block further. Omission notices count against the budget; omitted text remains on disk. `USER.md` continues to archive overflow into existing OKF preference shards: its small index threshold is not total preference-storage capacity. No migration is required.

Memory renderers share estimated-token fit checks. Estimates currently use JavaScript string length divided by four, rounded up; **they are not model-tokenizer counts**. The retrieved-memory character guard is a separate 64,000-character resource bound, not a token count or storage quota.

Local matching normalizes Unicode and uses lexical overlap; it does not guarantee recall for paraphrases. Exact facts excluded from search because they are already in the installed prompt remain fetchable. Retrieval and prompt surfacing still respect `contextPolicy.memory.enabled` and `includeInPrompt`.

#### USER.md working preferences

`USER.md` (memory target `user`) holds the owner's working preferences: communication style, workflow habits and decision defaults. Pi projects it in three places from one file-store owner, each headed by the same one-sentence rule (prior working preferences guide method, style and decision defaults within the current handoff; current owner instructions and task-specific constraints win; preferences never create grants): the static memory block of the root system prompt, frozen for the session; the read-only `memory_read` snapshot a delegated worker receives when its profile grants it; and a `user_persona` record on the next provider request after a committed `USER.md` mutation. Handoffs also receive the applicable preferences upfront: in-process workers in their system prompt and Herdr teams in the shared objective (explicit, well-supported inferred and legacy lines only, within a fixed bound; never MEMORY.md, OKF, recall or a grant).

**How a preference is learned.** Every prompt the owner sends to a root session is recorded as owner evidence: an `owner_evidence` session record holding the owner's original words (bounded, digest-verified on load; never the text an input extension, skill or template expansion produced), rebuilt after a restart and unaffected by compaction; the newest sources are listed by id in the reflection cue. The model writes a preference with the `memory` tool: `target: "user"`, `scope` (`global`, or `project` for a choice tied to this repository), `basis` (`explicit` when the owner's own cited words ask for it, otherwise `inferred`), and `evidence: [{ source, quote }]`. The host checks each citation and only a valid one counts: the source must be an owner message of this session, the quote must be found in the owner's own words outside shown text (inside quotation marks, backticks, a fenced block or a blockquote line counts as shown; worker reports and tool results are never owner sources), and a citation without a quote counts for nothing. An explicit basis needs at least one counted quote whose sentence carries explicit or corrective wording. Evidence not newer than the accepted line's own evidence time (the `at=` field its trailer receives when the file-store commits it) is a replay of a superseded instruction and counts for nothing; a fresh owner instruction can change a preference back, and a correction whose write failed can be retried with the same still-valid evidence. Counted receipts are stored at once, per scope and preference value, in `state/learning-observations.json` (bounded to the eight newest per value), so a candidate observed in one session and independently again in another becomes eligible, while the same source replayed in any session stays one; receipts older than the accepted line's fence are history, not support for returning to that value. A preference's identity includes its project when scoped, so identical words in two projects are two facts, and a write only supersedes, replaces or removes a line of the scope it names (global by default; another project's line is never touched). Then the existing learning gate decides: an explicit, supported preference or correction applies at once (also over an explicit or legacy line, and even when automatic learning is disabled, because it is the owner's command); an inferred pattern needs two independent owner observations and never overrides an explicit or legacy line; anything else stays a durable learning candidate, recorded in `learning_audit` and `learning_decision` session records, with no approval prompt. An admitted write is audited only after the file-store reports that the bytes landed (`apply`, with a rollback plan) or that the write failed (`apply_failed`); a candidate is audited at once. A one-off instruction for the current task is not a preference; the model is told so, and nothing forces a write per turn.

**What is stored.** One line per fact, human-readable, in the same transaction as the archive: `Keep status updates short. [pref 3f9c1a2b | global | explicit | n=1 | rev=2 | src=a1b2c3d4/entry-7]` (identity, scope, basis, independent sources, revision, owner source ids). The sources listed are the ones supporting the current value; a correction starts from its own evidence and the superseded value's sources become history, not support. A line without a trailer is a legacy preference: usable guidance, never presented as evidence-backed. A write without an admission owner (narrow hosts) is labelled `unverified`. `expectedRevision` on replace or remove refuses a stale update. Prompts render `- text (explicit, learned 2026-11-04)`, `- text (inferred, 2 independent observations, learned 2026-11-04)` or `- text` for legacy lines (the learned day is the newest owner evidence supporting the current value, and is left out when the line has none); a legacy line written under a heading keeps that heading path as context (`- GrimDex engineering roles: Root designs; Luna implements.`), in the block, the record, the handoff guidance and the archive, because the heading is the only scope its author gave it and is never turned into a verified project key; trailers never reach a prompt; project-scoped lines appear only inside the project they name (checked by directory key, not by wording).

**Settings.** No new keys. `learningPolicy.enabled: false` or `autoLearn.enabled: false` stops inferred learning (candidates only); explicit owner commands still apply. `learningPolicy.autoApplyEnabled`, `confidenceThreshold`, `requireRollbackPlan` and `autoApplySupersessions` apply to inferred writes as to any memory learning; `minObservations` is raised to at least two for inferred preferences. `contextPolicy.memory.enabled` and `includeInPrompt` govern delivery.

**Limits.** Source identity, quote matching, shown-versus-stated spans, replay counting, freshness, scope and the apply/candidate outcome are host-checked and deterministic. Whether a quoted sentence really means the preference the model wrote, whether an instruction was meant for one task or for good, and whether a pattern is real are model judgments; the host cannot prove semantic entailment and does not claim to predict the owner's reactions. A receipt validated in an earlier session is reused from the observation store; a source id from a closed session that was never validated cannot be verified and counts for nothing. The USER.md write, its managed state, the archive shards and the session audit are separate files written in order; a crash between them is recovered by the drift and heal protocol, and the audit describes only what completed.

If a managed memory file (`MEMORY.md`, the project `MEMORY.md`, `USER.md`) differs from its managed revision when a root session starts, Pi reports it once per file and active on-disk revision through the session warning line (held for the first subscriber when none is attached yet), names the two digests and the `/memory accept <target>` and `/memory restore <target>` commands, keeps the on-disk bytes as they are, and keeps refusing writes to that target until the operator decides. `/memory drift` shows the same state on demand.

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

Provider-stated delays now reach the classifier from every adapter: a `retry-after-ms` or `retry-after` response header, or a structured `availability.retry_after` body field, is appended to the error text as "retry after N seconds", so a limit learned from a header is published machine-wide with its true reset. Evidence (2026-09-12): the failure corpus on the reference box held 986 classified provider failures and none carried a provider-stated retry delay, so the `maxRetryDelayMs` cap has never bound there; with the default three attempts at a 2 s base the local backoff peaks at 8 s, well under the agent's 120 s local ceiling. Both caps are documented ceilings, not tuned values.

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before Pi sees them, which may block the agent until the provider quota resets in some circumstances. The same budget bounds the OpenAI Codex WebSocket path's in-stream retry of a transient rejection (`server_is_overloaded` and the like) that arrives before any output: each retry is one delta on the same connection, and whatever survives the budget reaches the agent-level retry as before.

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

### Provider Admission

Every pi process on the machine (owner sessions, their delegated workers, background lanes such as reflection and research) registers each provider request it has in flight under `~/.pi/agent/state/provider-admission/`, one small file per request, removed when the stream settles and pruned by every reader when its owner process is gone or its heartbeat is stale. A request from the owner's own turn (the foreground lane) is always admitted at once. A worker or background request to a provider whose machine-wide in-flight count has reached its limit waits for a slot, polling with a doubling interval, and is admitted regardless after `maxWaitMs` so a wedged sibling can never starve it. Each wait is recorded in the owner session as a `provider_admission` entry (provider, lane, wait, whether it timed out).

**Account keys.** Limits and in-flight counts are keyed by provider plus the credential the request runs under (`<provider>#<identity>`: an OAuth account id, else the access token's subject, else a short digest of the key), so two accounts on one provider are two budgets. `/load` shows the account beside the provider. `providerAdmission.limits` stays keyed by provider id and applies per account.

**Shared limit state.** The first process to receive a 429 or overload with a known reset (stated by the provider, or the delay its own retry ladder chose, the owner's and a worker's alike), or a fully used Codex subscription window, records the reset time under `state/provider-admission/limits/`; every process consults it before sending, in every lane. Nothing invents a cooldown. A limit that fits the lane's wait budget is waited out; a longer one refuses the request before it is sent, with a message the retry ladder reads as a rate limit carrying the remaining delay, so the owner's retry and a worker's durable retry both sleep until the reset without a request that would be refused and billed. A successful response clears a rate-limit or overload record; Codex window snapshots (`x-codex-*-used-percent`, `-reset-at`) are persisted under `state/provider-admission/usage/` and turn into a limit when a window is fully used. Exhausted models and providers learned from billing failures are shared the same way under `state/provider-admission/exhausted/`. A worker or background request to an exhausted model waits for its recorded reset within the lane's wait budget, the same as a recorded limit; past that budget, or when no reset was recorded, it is refused before it is sent, with a quota message that names the reset. The owner's foreground turn is never held: it moves to another model as before.

**Refusal windows.** A worker or background request refused at admission (a recorded limit or an exhausted model longer than the lane's wait budget) never leaves the machine, and the refusal carries `retryAt`, the epoch time admission can next succeed: the recorded reset, or, when none was stated, the lane's `maxWaitMs` from the refusal. Within one open window (provider account, lane, reason and reset) the refusals share that `retryAt`, only the first is logged and written as a `provider_admission` entry, and the count of the rest is logged once when the window closes; the foreground lane records every refusal. Lanes that retry on their own schedule (knowledge collection, routine intake) wait for `retryAt` on the timer they already use instead of retrying into the refusal, do not count it as a failure of their work, and log once per window that they are parked. A completion that ended in a refusal reports it as `providerRefusal` on the isolated completion result.

**Live waits.** While a request waits at admission the activity lane shows which lane is waiting, on which provider and account, why (rate-limited with the reset countdown, at its in-flight limit, or the emergency stop), and when it was admitted. The same waits are durable `provider_admission` entries. `node scripts/multi-tenancy-census.mjs [--since <days>] [--gate]` reads sessions and worker conversations and reports first-token latency by machine-wide in-flight count, retries by model and reason, waits by reason, and fails its gate when two processes rediscovered the same rate limit within five seconds, the one property the shared limit state exists to guarantee.

**Emergency stop.** `/estop on [reason]` writes `<agentDir>/ESTOP`; every pi on the machine then holds new worker and background provider requests (queued workers stay queued, a running worker's next request waits up to `maxWaitMs` then refuses) while foreground turns continue. `/estop off` lifts it; `touch ~/.pi/agent/ESTOP` works too. `/load` shows what is in flight machine-wide by provider and lane, the recorded limits, the latest provider windows, and the stop.

Measured 2026-09-11 on one box running several pi sessions, Codex CLI and Claude Code: with another Codex request in flight from any process, Codex generation fell from 97.7 to 62.2 tokens per second and first-token latency rose 40% at two or more, while xAI showed no per-account slowdown at up to eight in flight. The census did not measure the in-flight count at which a cap pays for itself, and the Codex CLI applies no per-account cap of its own (its only concurrency control is a per-session thread limit), so no provider is capped by default: the ledger records what is in flight and a limit is an owner choice. Raising a limit trades the owner's foreground latency for aggregate worker throughput.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `providerAdmission.enabled` | boolean | `true` | Register in-flight requests and gate worker/background lanes; `false` disables both |
| `providerAdmission.limits` | object | `{}` | Per provider id, how many requests may be in flight machine-wide before worker and background lanes wait; no provider is capped by default, `0` removes an entry |
| `providerAdmission.maxWaitMs` | number | `120000` | Longest a worker or background request waits (for a slot, a recorded limit, or the emergency stop) before it proceeds or refuses (recorded as `timedOut`) |
| `providerAdmission.foregroundLimitWaitMs` | number | `60000` | Longest the foreground waits for a machine-wide recorded provider limit before the request is refused with the reset time instead of being sent |

```json
{
  "providerAdmission": {
    "limits": { "openai-codex": 3, "xai": 6 },
    "maxWaitMs": 60000
  }
}
```

### Output Cap

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxOutputTokens` | number | `32768` | Per-response output cap sent with every provider request. Narrows the model's own limit; the model's capability tier (16,384 on the strong tier, 8,192 on the constrained tier) and a goal's remaining token budget narrow it further; it never widens a model's limit. |

A model's registry limit is a theoretical maximum (grok-4.6 advertises 500,000 output tokens), and a request that carries no cap lets a degenerate generation run to it: one measured continuation turn streamed a single repeated sentence for over twenty minutes at the model's output price. Real responses, a long file write included, stay far below the default.

```json
{
  "maxOutputTokens": 32768
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"all"` | How steering messages are sent: `"all"` (every queued steer reaches the next model turn together) or `"one-at-a-time"` (one per turn) |
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
| `shellCommandPrefix` | string | - | Snippet prepended to every command, in the grammar of the tier that runs it: Bash on Linux/macOS and in the Windows shell engine (for example, `"shopt -s expand_aliases"` or `"export FOO=bar"`); PowerShell only when the Windows floor runs the command (`windowsShell.pythonEngine: false`, or the engine's runtime unavailable) |
| `npmCommand` | string[] | - | Optional command argv for third-party npm extension/package lookup and install operations (e.g., `["mise", "exec", "node@24", "--", "npm"]`); it never installs or publishes the Pi Adaptative CLI |
| `windowsShell.pythonEngine` | boolean | `true` | Windows only. Routes pipelines, redirection, expansion, chaining, and state-mutating commands (`cd`/`export`/`unset`) through the bundled Python shell engine. Explicit `false` restores the PowerShell-only, simple-command-only contract verbatim — the same fail-closed behavior for pipelines/redirection/expansion/chaining as before the engine existed. |
| `windowsShell.gnuToolsDir` | `"auto"` \| `"off"` \| string | `"auto"` | Windows only. Where the shell engine finds real GNU tools for `ls`, `find`, `grep`, `sed`, `awk`, `wc`, `head`, `tail`, `sort`, `stat`, `xargs`, `diff`, and the rest of the coreutils names. `"auto"` discovers Git for Windows' `usr\bin` from the `git` on PATH (or under Program Files) once per session; `"off"` keeps every name on the engine's own builtins; an explicit directory must hold `ls.exe` and `find.exe` or the shell tool reports it. See [Windows](windows.md). |

Pi exposes one stable `bash` contract to the model on every platform. On Windows, the tool router parses a finite simple-command grammar, converts supported Bash-like forms to literal-path PowerShell, and rejects pipelines, redirection, expansion, chaining, nested shells, POSIX scripts, and unsupported builtin forms instead of guessing. Legacy `powershell` tool/profile references map to `bash`. The Windows backend requires PowerShell 7 (`pwsh.exe`) and runs it with `-NoLogo -NoProfile -NonInteractive -Command`, process-only headless settings, silent progress, and a warmed persistent command path. Pi does not overwrite PowerShell's input or output encoding; its output path preserves Unicode UTF-8 and recovers Windows-1252 bytes. `shellCommandPrefix` uses backend-native syntax because Pi applies it after routing. Agent, interactive, and RPC shell calls default to a 120-second wall-clock deadline; agent-tool overrides cap at one hour.

With `windowsShell.pythonEngine` at its default (`true`), the router also sends pipelines, redirection, expansion, chaining, and `cd`/`export`/`unset` to a bundled, uv-provisioned Python 3.13 engine implementing a bounded Bash grammar and coreutils vocabulary; state persists across calls and across the PowerShell/engine tiers. If the Python runtime cannot be resolved (uv/network unavailable), the simple-command PowerShell floor keeps working and engine-only commands return a named, actionable error — never a silent downgrade. See [Windows](windows.md) for the full supported-forms table.

The native `python` tool is active by default and resolves Python through pinned `uv`. Pi provisions missing uv/Python during package postinstall, `pi update`, `pi doctor`, or first tool use. Python calls default to 30 seconds and cap explicit overrides at 300 seconds. See [Native Python](python.md).

```json
{
  "npmCommand": ["mise", "exec", "node@24", "--", "npm"]
}
```

`npmCommand` is used only for third-party npm package operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.pi/agent/npm/`; project-scoped npm packages install under `.pi/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers. The CLI itself is a standalone Linux or Windows release and has no npm publication path.

### Tool Output

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `toolOutput.reduction` | `"on"` \| `"off"` | `"on"` | Runs every `bash` and `python` result through the output-reduction pipeline: generic cleaning (ANSI codes, carriage-return progress frames resolved, trailing whitespace, blank runs, repeated lines collapsed), then the first family reducer (`rg`/`grep` hits regrouped per file, compiler and linter diagnostics as one line each, git filters, test-run projections) or data-driven rule that applies. `"off"` sends raw output; `PI_TOOL_FILTER_DISABLED=1` does the same for one process. |
| `toolOutput.level` | `"auto"` \| `"standard"` \| `"compact"` | `"auto"` | How hard reducers may cut: `compact` lowers per-file hit caps and collapses repeats sooner. `auto` follows the model's capability tier. |
| `toolOutput.rulesFile` | string | - | Extra rules file with the `.pi/output-filters.json` schema, loaded after the user file (`~/.pi/agent/output-filters.json`) and the project file (`.pi/output-filters.json`). |

Reduced output reads as a shorter version of the real output, never a different one: every stage only removes lines or collapses repeats, and unknown shapes pass through. When lines were dropped and the cut is at least 512 bytes, the raw output is persisted to a managed file and the result ends with one notice, `[<family> output filtered: retained X of Y lines. Full output: <path>]`; the model reads the file only when it needs the omitted lines. Pure cleaning writes no file and adds no notice. The model can bypass every stage for one call with `fullOutput: true`, and explicit verbose flags (`--verbose`, `-vv`, `--nocapture`) do the same automatically. `details.outputReduction` on the tool result records bytes in and out for `scripts/output-reduction-census.mjs`.

Rules files hold `{ "rules": [ ... ] }`. Each rule names the commands it matches (`match`, a regular expression tested against the program and its arguments, with `cd` prefixes and environment assignments removed) and the operations to apply: `stripLinesMatching`, `keepLinesMatching`, `replace` (`[{ "pattern", "with" }]`), `maxLines`, `tailLines`, `onEmpty`; `tools` defaults to `["bash"]` (`"python"` matches the tool label). Every rule should carry `tests` (`[{ "input", "expected" }]`): `npm run check` runs the inline tests of the bundled rules and of the project file. Later files override earlier rules of the same name.

Bash validates rule files at tool creation. Python validates them before each filtered call; repaired files take effect on the next call, and `fullOutput: true` or disabled reduction bypasses rule loading entirely. Python's project rules come from its execution backend and tool root, even with a per-call `cwd`; global and explicit extra files remain operator-side configuration. See [Portable execution contracts](portable-harness.md).

```json
{
  "rules": [
    {
      "name": "make-build",
      "match": "^make\\b",
      "stripLinesMatching": ["^make\\[\\d+\\]: (?:Entering|Leaving) directory"],
      "tests": [
        { "input": "make[1]: Entering directory '/repo/src'\ncc -c a.c\nmake[1]: Leaving directory '/repo/src'\n", "expected": "cc -c a.c\n" }
      ]
    }
  ]
}
```

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".pi/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

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
  "model": "anthropic/claude-sonnet-5-5",
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

### Logging

The harness writes a log of what it decided and why, so it can be improved from evidence: one JSON line per entry in `<agent dir>/logs/harness/harness-<date>.jsonl`, with a level, a category (`delegation`, `link`, `bots`, `tools`, `readiness`, `channels`, `memory`, `provider`, `router`, `cost`, `edge`, `routines`, `goals`, `workers`, `fleet`, `plan`, `leaders`, `settings`, ...), the process id and role. A line never carries a prompt, a message, a credential or a file's contents; the host redacts secrets before anything is written.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `logging.level` | `off` \| `error` \| `warn` \| `info` \| `debug` \| `trace` | `warn` | What is written. Below the level a log call costs one comparison. `PI_LOG_LEVEL` overrides it |
| `logging.categories` | string[] | all | Only these categories are written. `PI_LOG_CATEGORIES` (comma list) overrides it |
| `logging.maxFileMb` | number | `8` | A log file past this size is rotated once (`.1`) |
| `logging.retainDays` | number | `14` | Log files older than this are deleted at start |
