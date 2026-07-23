# Harness architecture

Pi Adaptative has one production harness. `AgentSession` is its public facade and composition root;
the low-level agent loop and provider transports remain separate packages. The deleted
`packages/agent` `AgentHarness` was a competing implementation and must not be restored.

## Package boundaries

```text
coding-agent/AgentSession
  ├─ runtime + resource policy       RuntimeBuilder, ResourceLoader, ProfileFilterController
  ├─ model execution policy         ModelSelection, ModelRouter, LocalRuntime, ToolProtocolController
  ├─ foreground turn coordination   ContextPipeline, CompactionController, ForegroundRecoveryController
  └─ child work coordination        WorkerDelegation, BackgroundLane, Reflection, managed-lane bridge
                 │
                 ▼
agent                         ai
agent loop + session tree     model metadata + provider transports + wire-format repair
```

Provider-specific request and response behavior belongs in `packages/ai`. Provider-neutral choices
about which model, reasoning level, tools, resources, or lane to use belong in `packages/coding-agent`.
`packages/agent` owns the reusable loop, session tree, retry primitives, and compaction mechanics; it
does not own a second application harness.

## Model execution contract

Every foreground or child request resolves the same four facts before transport:

1. Model identity and metadata come from `ModelRegistry` as `Model<Api>`.
2. Authentication and headers come from the registry for that exact model.
3. `resolveModelThinkingLevel()` applies explicit intent, model defaults, harness fallback, and
   capability clamping.
4. `resolveModelToolProtocol()` selects native calls, a forced text fallback, or the exact calibrated
   text dialect. Foreground and isolated tool loops use the same result.

Provider adapters may translate those facts to their wire protocol, but must not make orchestration
policy. Tool names that collide with a provider-reserved namespace are mapped only at the provider
boundary and mapped back for local execution and history.

## UAC is construction-time omission

UAC's primary guarantee is that a withheld capability is not materialized. Runtime checks remain a
second line of defense, not the main implementation.

- `RuntimeBuilder` resolves one access policy before invoking built-in or override tool factories.
  The same policy governs registration and activation, preventing construction/activation drift.
- `ResourceLoader` filters extension paths before module import and filters skill, prompt, theme, and
  context paths before content loading. Live extension loading repeats the profile check before
  import.
- Isolated research and worker lanes create fresh tools only for their expanded lane grant. They do
  not copy the foreground registry, extensions, skills, shell, or mutable memory surface.
- Worker orchestration state is lazily materialized only when the active surface grants `delegate`
  (or a managed-lane terminal report requires the shared notifier); worker-role sessions allocate no
  worker scheduler, lifecycle store, or notification coordinator.
- Managed children carry parent identity. A valid parent PID classifies the process as a worker before
  settings, stores, resources, or tools are built, so the hard worker ceiling cannot be re-granted by
  a permissive profile.
- Per-call path/capability gates still validate every isolated lane tool invocation. Worktree-bound
  workers additionally run behind the lane mutation gate.

An extension is the unit of module loading. If a profile grants an extension, its module code may
register several definitions before tool-level filtering. Profiles that need zero extension
footprint must omit that extension at the resource layer, not merely block one of its tools.

## Child work contracts

Owner-authored orchestration profiles are the routing authority. A profile fixes role, ordered model
policy, exact thinking level, tool names, resource profiles, semantic capability ceiling, budgets,
concurrency, lease duration, and verification policy. An architect profile additionally declares the
only worker profile IDs it may dispatch. The model-facing dispatch request contains a task, profile
ID, instructions, and resource pointers; it has no model, thinking, tool, budget, or concurrency
override fields.

The durable control plane is an append-only session event store projected into objectives, DAG
tasks, attempts, leases, checkpoints, logical agent bindings, typed results, and a notification
outbox. Every result carries its attempt lease and fencing token. A stale worker therefore cannot
win a race after retry or resume. In-process isolated completions have no resumable transcript: an
interrupted lease is fenced and its persisted dispatch is re-queued as a new attempt. A process-backed
Pi worker instead retains its logical agent ID and resume context and is woken with `/resume` against
the same session, worktree, orchestration profile, and checkpoint pointers when present.

Policy is a mandatory pre-lease gate. An attempt cannot lease without a compiled execution grant.
When compilation crosses owner authority or budget, the gate persists a typed approval request and
an owner notification; approval and rejection replay as durable human decisions. Approval alone is
never authority: an approved attempt remains unleaseable until policy compiles and binds a new grant
under the expanded owner authorization. Pausing an objective blocks lease, start, and agent resume;
cancellation remains a replayable terminal transition across its open tasks and attempts.

Acceptance is a runtime invariant, not a worker claim. Task criterion IDs must refer to their
objective, a completed criterion-bound result must carry trusted evidence for every linked criterion,
and an objective cannot close until all required criteria have trusted evidence in its task results.

In-process workers are bounded child loops with fresh context, a synthetic cache-affinity key, a
profile-pinned model and exact reasoning level, a construction-filtered tool surface,
turn/time/token/tool/cost bounds, and parent validation of the result. Process-capable profiles may
expose `run_process`, which uses an exact executable allowlist, direct argv, a scoped environment,
bounded output, and process-tree termination; unrestricted shell is not inherited. Worker output is
untrusted; the parent retrieves it through `delegate_status` after a terminal lane event. A profile
that requires independent verification names a separate owner-pinned verifier profile. The runtime
automatically dispatches that verifier as a durable task, withholds the implementation's terminal
handoff, and reconciles the typed verdict before the implementation can become accepted. Restart
recovery closes both persistence gaps: an implementation awaiting a not-yet-created verifier is
re-dispatched, while a persisted verifier result awaiting reconciliation is applied exactly once.

Out-of-process managed workers use the same lifecycle shape:

```text
queued → running → terminal signal → bounded persisted handoff → parent notification → explicit retrieval
```

Completion discovery is event-driven. A parent never polls pane output to learn whether work ended,
and a late worker result is never injected into an active foreground transcript. Every managed
process must emit a terminal signal even on failure, persist a bounded handoff, and wake its owner.

## Runtime generations and reload

A runtime generation consists of the selected resource profile, loaded resources, base tool
definitions, extension runner, wrapped registry, active tool request, and derived system prompt.
Reload constructs and doctors a candidate generation, then commits it or restores the complete prior
snapshot. Model/profile changes are re-applied only after extension providers are bound. In-flight
turns, compaction, and child work register with the shared quiescence gate, so live mutation never
races an active execution unit.

## Ownership rules for further growth

- Keep `AgentSession` as facade and composition root; move coherent state machines into controllers
  with narrow dependencies instead of adding another facade with overlapping state.
- Add a capability decision to the shared model/resource contract first, then consume it everywhere.
  Do not add provider-name branches to orchestration code when model metadata can express the fact.
- Decide resource and tool authority before loading or construction. Keep execution gates for path,
  argument, and race-sensitive checks.
- A background process is incomplete until its terminal event, durable bounded handoff, and owner
  notification all succeed or are reported failed.
- Persist only serializable facts and stable identities. Runtime tools, extension functions, streams,
  and credentials are reconstructed dependencies, never session payloads.
- New harness behavior requires a focused faux-provider regression. Provider APIs and paid tokens are
  not used by the coding-agent suite.

Worker lifecycle, scheduling, execution, verification, recovery, and notification are owned by
`WorkerDelegationController`. `ResearchLaneController`, `ModelFitnessController`, and
`GoalAutoContinueController` own their respective timers, guards, cancellation, accounting, and
persistence; research and fitness share only the provider-neutral `LaneModelResolver`.
`BackgroundLaneController` is now a compatibility facade plus the distinct out-of-process
managed-lane bridge. `ToolProtocolController` owns model protocol selection, probing, calibration,
circuit breaking, repair teaching, and its per-turn state. `CompactionController` owns manual and
automatic detection, execution, retries, cancellation, persistence, and extension notification;
`CompactionSupport` is its provider-neutral model/auth/settings policy.
`ForegroundRecoveryController` owns the terminal-response latch and ordered retry, quota failover,
retry closeout, compaction, and queued-continuation decisions. The next structural extraction target
is the remaining foreground prompt preparation and submission flow in `AgentSession`; it must move
through cohesive owners without changing the public facade or duplicating session state.
