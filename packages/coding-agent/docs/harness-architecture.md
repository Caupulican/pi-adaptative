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
  not copy the foreground registry, extensions, or skills. Native agents may materialize fresh
  memory, write/edit, platform-shell, and recursive-delegation adapters when their immutable grant
  and live service switches admit them.
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

The model-facing `delegate` request can choose role label, authenticated model, exact supported
reasoning level, classified tools, semantic capabilities, read/write paths, and budget. An optional
owner-authored orchestration profile supplies reusable defaults; it is not a dispatch allowlist.
Profile-free roots start from the foreground model and maximum host-permitted classified core
surface. Descendants inherit immutable parent execution authority by default. The host validates and
materializes every choice, intersects it with parent authority and live global switches, and persists
the exact resulting contract before execution. Built-in roles are routing/audit labels unless an
embedding supplies an explicit role ceiling.

The durable control plane is an append-only session event store projected into objectives, DAG
tasks, attempts, leases, checkpoints, logical agent bindings, typed results, and a notification
outbox. Every result carries its attempt lease and fencing token. A stale worker therefore cannot
win a race after retry or resume. In-process agents retain durable logical identity, lineage, exact
transcript, mailbox, immutable execution contract, and checkpoint usage across interruption and
resume. A process-backed Pi worker similarly retains its logical agent ID and resume context and is
woken with `/resume` against the same session, worktree, orchestration preset, and checkpoint
pointers when present.

The model-facing `delegate tasks` action is a bounded read model over that same durable DAG, not a
second task list. It exposes task dependencies, status, latest attempt/agent dispatch, terminal
reason, verifier state, and durable retry metadata. `delegate start` may attach existing
same-objective task IDs through `dependsOn`; unknown, forward, cross-objective, self, and cyclic edges
are rejected before dispatch. Agent, task, and attempt projections each retain at most 256 entries.
An evidence-classified transient failure suspends its exact attempt with a persisted `notBefore`
deadline; recovery reconstructs eligibility from that deadline and transcript instead of resetting a
process-local backoff counter.

Policy is a mandatory pre-lease gate. An attempt cannot lease without a compiled execution grant.
When compilation crosses owner authority or budget, the gate persists a typed approval request and
an owner notification; approval and rejection replay as durable human decisions. Approval alone is
never authority: an approved attempt remains unleaseable until policy compiles and binds a new grant
under the expanded owner authorization. Pausing an objective blocks lease, start, and agent resume;
queued and suspended attempts remain nonterminal until an objective-resume event drains them.
Cancellation remains a replayable terminal transition across its open tasks and attempts.

Acceptance is a runtime invariant, not a worker claim. Task criterion IDs must refer to their
objective, a completed criterion-bound result must carry trusted evidence for every linked criterion,
and an objective cannot close until all required criteria have trusted evidence in its task results.

In-process agents have immutable birth context, a synthetic cache-affinity key, a selected model and
exact reasoning level, and a construction-filtered tool surface. They inherit `delegate`, may inspect
bounded raw-transcript pages only for themselves and their control subtree, exchange non-waking
threaded evidence with discoverable session peers, broadcast to a bounded peer set, wait for one or
many workers through state-change events, and may materialize a persistent per-agent platform shell.
Wake, interrupt, resume, cancel, and retirement authority remains subtree-scoped. Retirement closes
only an idle leaf with no unresolved mailbox/reply obligations; it preserves the durable binding and
transcript for audit. Fleet admission runs before task, conversation, agent, or queue creation and
bounds depth to 8, direct children to 64, session identities to 256, and queued dispatches to 256.
Admission preserves queue, task, attempt, and agent headroom for every already-admitted pending
verifier plus the current contract's future verifier. Failed mandatory-verifier dispatch remains
durably derivable and replays on queue-capacity events. One global scheduler owns concurrency and
durable queuing, one root coordinator owns cumulative token/cost/tool/active-time/attempt budgets, and exact
ancestor task cycles are rejected. Descendant profile selection may vary model and role, but its
resource pointers must be a full-identity subset of the ancestral contract, its soul text must match
exactly, and verifier context/authority stays within the previously admitted verifier or worker
boundary. `run_process`
keeps its separate exact executable allowlist, direct argv, scoped environment, bounded output, and
process-tree termination contract. The platform shell is real host process authority, not container
isolation or a path-scoped substitute for `write`/`edit`.

Birth context is selected once, before a new logical agent is admitted, with `forkTurns: "none"`,
`"all"`, or a positive turn count such as `"3"`. Omission means `all` only when parent and child use
the exact same provider and model; crossing either boundary defaults to `none`, and an explicit
non-`none` cross-boundary request is rejected. The content-addressed snapshot contains bounded whole
user turns and complete text-only assistant answers. It excludes system/developer/custom messages,
reasoning and commentary, tool calls/results, mailbox controls, non-text attachments, and incomplete
assistant output. A compacted prefix can enter only as its bounded checkpoint attached to the next
real user turn. The snapshot and its durable reference are immutable; reusing a persistent worker
continues its existing transcript and cannot install a second birth context.

Worker output remains untrusted evidence. The parent receives a bounded terminal event and retrieves
lane results explicitly; child/subtree transcript pages require an explicit `transcript` action,
and the subtree authority check happens before bounded pagination. Transcript cursors are opaque raw
session-entry offsets: a page can contain no messages but still return `nextCursor`, and an individual
message that exceeds the byte bound is omitted with an explicit omission count. A preset that requires independent
verification names a separate owner-pinned verifier profile. The runtime automatically dispatches
that verifier as a durable task, withholds the implementation's terminal handoff, and reconciles the
typed verdict before the implementation can become accepted. Restart recovery closes both
persistence gaps: an implementation awaiting a
not-yet-created verifier is re-dispatched, while a persisted verifier result awaiting reconciliation
is applied exactly once.

Out-of-process managed workers use the same lifecycle shape:

```text
queued → running → terminal signal → bounded persisted handoff → parent notification → explicit retrieval
```

Completion discovery is event-driven. A parent never polls pane output or retries a full mailbox on a
clock to learn whether work ended, and a late worker result is never injected into an active
foreground transcript. Each terminal attempt is retained once in a bounded process-local queue until
the parent mailbox accepts it; terminal publication, mailbox-capacity changes, state changes, and
restart recovery are the only drain events. Exact replays are inert, conflicting payloads fail closed,
delivery errors stay retained, and reentrant state signals coalesce into a bounded redrain. Every
managed process must emit a terminal signal even on failure, persist a bounded handoff, and wake its
owner.

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

`WorkerDelegationController` composes and coordinates the native worker subsystem.
`WorkerLifecycle` owns durable lifecycle and verification transitions; `WorkerDispatchScheduler`
owns queue and running-promise transitions; `WorkerAttemptExecutor` and `WorkerRunner` own the
provider/tool loop and result projection; `WorkerRecoveryCoordinator` owns retry and recovery;
`WorkerNotificationCoordinator` owns status and owner notification delivery; and
`WorkerTerminalHandoffCoordinator` owns bounded process-local terminal retention and redrain.
`ResearchLaneController`, `ModelFitnessController`, and
`GoalAutoContinueController` own their respective timers, guards, cancellation, accounting, and
persistence; research and fitness share only the provider-neutral `LaneModelResolver`.
`BackgroundLaneController` only coordinates these owners and their shared lane read model;
`ManagedLaneController` owns the distinct out-of-process managed-lane bridge. `ToolProtocolController` owns model protocol selection, probing, calibration,
circuit breaking, repair teaching, and its per-turn state. `CompactionController` owns manual and
automatic detection, execution, retries, cancellation, persistence, and extension notification;
`CompactionSupport` is its provider-neutral model/auth/settings policy.
`ForegroundRecoveryController` owns the terminal-response latch and ordered retry, quota failover,
retry closeout, compaction, and queued-continuation decisions. Foreground prompt submission remains
an `AgentSession` transaction because it composes those independent owners and the public event
surface; extracting it today would create a callback-heavy proxy rather than a new state owner. Its
contract is balanced routing events, commit-on-success `nextTurn` consumption, stable per-turn cost
accounting, and bounded early-message identity cleanup.
`HostStateStore` owns validated versioned host partitions, lock-scoped mutations, atomic replacement,
and worker-role zero-write behavior for fitness, model adaptation, and tool-selection evidence.
