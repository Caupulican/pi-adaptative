# Harness architecture

Pi Adaptative has one production harness. `AgentSession` is its public facade and composition root;
the low-level agent loop and provider transports remain separate packages. The deleted
`packages/agent` `AgentHarness` was a competing implementation and must not be restored.

## Package boundaries

```text
coding-agent/AgentSession
  ├─ runtime + resource policy       RuntimeBuilder, ResourceLoader, ProfileFilterController
  ├─ model execution policy         ModelSelection, ModelRouter, LocalRuntime, protocol resolver
  ├─ foreground turn coordination   ContextPipeline, retry/failover, compaction, persistence
  └─ child work coordination        BackgroundLane, Reflection, managed-lane bridge
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
- Managed children carry parent identity. A valid parent PID classifies the process as a worker before
  settings, stores, resources, or tools are built, so the hard worker ceiling cannot be re-granted by
  a permissive profile.
- Per-call path/capability gates still validate every isolated lane tool invocation. Worktree-bound
  workers additionally run behind the lane mutation gate.

An extension is the unit of module loading. If a profile grants an extension, its module code may
register several definitions before tool-level filtering. Profiles that need zero extension
footprint must omit that extension at the resource layer, not merely block one of its tools.

## Child work contracts

In-process workers are bounded child loops with fresh context, a synthetic cache-affinity key, an
explicit model, clamped reasoning, a construction-filtered tool surface, turn/time/cost bounds, and
parent validation of the result. Worker output is untrusted; the parent retrieves it through
`delegate_status` after a terminal lane event.

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

The next structural extraction target is foreground turn coordination still resident in
`AgentSession`: prompt admission, retry/failover, save points, and terminal settlement should become
one controller without changing the public facade or duplicating session state.
