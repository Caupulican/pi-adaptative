# Harness architecture

Pi Adaptative has one production harness. `AgentSession` is its public facade and composition root;
the low-level agent loop lives in `src/kernel/` and the provider transports in `packages/ai`. The
deleted `AgentHarness` was a competing implementation and must not be restored.

## Package boundaries

```text
coding-agent/AgentSession
  ├─ runtime + resource policy       RuntimeBuilder, ResourceLoader, ProfileFilterController
  ├─ model execution policy         ModelSelection, ModelRouter, LocalRuntime, ToolProtocolController
  ├─ foreground turn coordination   ContextPipeline, CompactionController, ForegroundRecoveryController
  └─ child work coordination        WorkerDelegation, BackgroundLane, Reflection, managed-lane bridge
                 │
                 ▼
src/kernel                    ai
agent loop + session tree     model metadata + provider transports + wire-format repair
```

Provider-specific request and response behavior belongs in `packages/ai`. Provider-neutral choices
about which model, reasoning level, tools, resources, or lane to use belong in `packages/coding-agent`.
`src/kernel/` owns the reusable loop, session tree, retry primitives, and compaction mechanics; it
does not own a second application harness, and it imports only itself, `packages/ai`, `packages/tui`
and Node built-ins.

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
  not copy the foreground registry, extensions, or skills. Native workers may materialize fresh
  read/write, process, Python, and platform-shell tools when their immutable host grant and live
  service switches admit them; the worker surface never materializes `delegate`.
- Worker orchestration state is owned by the root and is lazily materialized for root dispatch and
  managed-lane terminal reporting. Worker-role sessions do not receive a scheduler, lifecycle
  control surface, reflection, or memory-mutation adapter.
- Managed children carry parent identity. A valid parent PID classifies the process as a worker before
  settings, stores, resources, or tools are built, so the hard worker ceiling cannot be re-granted by
  a permissive profile.
- Per-call path/capability gates still validate every isolated lane tool invocation. Worktree-bound
  workers additionally run behind the lane mutation gate.

An extension is the unit of module loading. If a profile grants an extension, its module code may
register several definitions before tool-level filtering. Profiles that need zero extension
footprint must omit that extension at the resource layer, not merely block one of its tools.

## Child work contracts

The root is the director of its workers. Its system prompt carries a `ROLE: root, the director of a team of
workers` section (`ROOT_DIRECTOR_ROLE_PROMPT` in `src/core/provider-prompt-contracts.ts`), rendered after the
identity for the full class of a root session whose `delegate` tool is active with worker delegation enabled
(`SystemPromptBuilder` sets `directorRole`; a root that works alone, and every child session, gets none). Delegation
applies at every reasoning level and across providers whenever it is enabled and the tool is active; it is not an
Ultra-only switch. User restrictions remain binding. The rule hook `delegation`
(`src/core/rule-hooks/rule-hook-rules.ts`) owns the playbook for how to delegate (when, split by write ownership,
reuse, right-sizing, briefing, parallel start, proportional review, steering, cost, integration); `work-lifecycle`
keeps the phases and state owners. The host appends each, under its own id, to the result of the first successful
`create_goal`, `goal` (`start`), `task_steps` or `delegate` (`start`, `follow_up`) call of the context (see
`RuleHookDelivery`), so they hold for custom and routed prompts alike; bundled commands defer to that policy. Child
sessions never receive this root policy.
Workers open with `ROLE: worker, an executor with one assignment from the root` (`SUBAGENT_CORE_SYSTEM_PROMPT`); the
one-shot lane prompts and the verifier carry their own role line.

Usefulness remains a model judgment. The host does not infer independence from step counts,
elapsed time, or keywords, nor issue a separate judging request on every turn. The policy directs
the model to dispatch or reuse a suitable worker before doing that independent task itself,
avoid duplicate queued/running work, and retain integration ownership. Deterministic enforcement
starts at admission and covers authority, budgets, lifecycle, and acceptance below. Faux-provider
tests prove policy delivery and worker execution, not universal real-model compliance. Ultra
availability and provider-specific effort mappings remain model metadata concerns.

The model-facing `delegate` start request exposes only top-level `model`, `thinkingLevel`, `path`,
and `toolNames` overrides. An optional owner-authored orchestration profile supplies reusable
defaults. Omitted fields inherit the live compatible foreground model, thinking level, classified
tools, and machine scope. The host validates and materializes every choice, intersects it with live
global switches, and persists the exact execution grant before execution. Budgets, leases, role and
capability ceilings, and tool-call limits are host-owned; the model does not submit an authority
envelope. Every native worker is a root-managed leaf and cannot spawn another worker.

The durable control plane is an append-only session event store projected into objectives, DAG
tasks, attempts, leases, checkpoints, logical agent bindings, typed results, and a notification
outbox. Every result carries its attempt lease and fencing token. A stale worker therefore cannot
win a race after retry or resume. In-process agents retain durable logical identity, lineage, exact
transcript, mailbox, immutable execution contract, and checkpoint usage across interruption and
resume. A process-backed Pi worker similarly retains its logical agent ID and resume context and is
woken with `/resume` against the same session, worktree, orchestration preset, and checkpoint
pointers when present.

Messages between the root and its workers are canonical records with a model view. A `delegate`
result carries `details.v` and, when the call was refused, an `err` record (`c` class, `f` field, `m`
reason, `h` hint, `x` value) beside its tagged content; the terminal handoff carries `details.v` and
each lane's state codes (`h`). The host states a fact as a code (`QUEUED`, `HELD`, `DELIVERED`,
`READ_REPORT`, `READ_ALL`, and so on) whose meaning is defined once in the root director prompt, and a
decision reads the record, never the rendered text. A worker ends its task with `submit_report`
(its schema refuses unknown properties); the host judges that report against its own receipts. An
`accepted` verdict with every requirement covered and no parent review pending lets the root read the
report and sample the transcript on demand (`READ_REPORT`); any other verdict keeps the full read
(`READ_ALL`). A claim carries what the host itself observed in typed `hostFindings` and its wait for
an independent verifier in `pending`.

Host injections follow the same rule. The tool-failure ledger, the authority context, the task
directory context and the path-alias legend are each built as one versioned record (`{v: 1, k, ...}`)
by the code that owns the fact and rendered into a tagged view: a header line, then one line per
failure, grant, workspace or alias. The transient-record planner stores the record in the durable
record's `details.record`; the legend's committed alias ids are read from it, and the per-call
failure envelope's readers (the recovery gate's refused-replay check, the progress signature) read
typed `details` rather than its text. The views stay at the request tail, so a view change never
rewrites bytes the provider has cached. Transient records themselves are recognized by
`details.superseding` / `details.cumulative`, not by their superseding note, and a tool result is a
harness failure by `isError`, not by a `[harness]` text prefix.

The path-alias legend names only what the model can see. Each request's legend record lists the
aliases referenced on its wire (the rendered messages, the transients before the legend, and the
text the kernel and a host projection carry beside them: the failure ledger, the verification
obligation, a continuous-chat turn view) that no legend record in the history lists yet. Records
are tail appends and are never retracted, so cached prefix bytes do not change. Tool arguments do
not depend on the legend: the tool wrapper expands any minted alias against the full table.

A message the host writes into a worker's transcript (a mailbox control message or the attempt's task prompt) carries a typed identity on its session entry, and readers recognize it by that record instead of its rendered header. A mailbox message carries a version header that selects the replay digest, and a replay of an identity accepted by an older build is judged under the older digest.

A `delegate start` may state its task as fields (`goal`, `note`, `refs`, `evid`, `out`) instead of free text. The host renders the worker's task text from them and persists the record as the dispatch `brief` beside the rendered `instructions`; requirement ids, dependencies and the grant stay separate, host-validated fields.

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

In-process workers have immutable birth context, a synthetic cache-affinity key, a selected model and
exact reasoning level, and a construction-filtered tool surface. They do not inherit `delegate` or
any descendant-spawning control surface. The root coordinates worker status, bounded transcript
reads, wake, interrupt, resume, cancel, and retirement. Retirement closes only an idle leaf with no
unresolved mailbox/reply obligations; it preserves the durable binding and transcript for audit.
Fleet admission runs before task, conversation, agent, or queue creation and bounds root-dispatched
workers, session identities, and queued dispatches. There is no worker-child depth or descendant
authority to inherit.
Admission preserves queue, task, attempt, and agent headroom for every already-admitted pending
verifier plus the current contract's future verifier. Failed mandatory-verifier dispatch remains
durably derivable and replays on queue-capacity events. One scheduler per session owns durable
queuing; the session's fleet (`core/fleet/`) decides concurrency as room computed from facts (the
running and writer ceilings, the worker account's subscription allowance, free memory and the shared
heap) and wakes a queued worker when the resource it waits on changes. One root coordinator owns cumulative token/cost/tool/active-time/attempt budgets, and exact
task cycles are rejected. Each worker's host execution grant remains immutable for its lifetime and
is narrowed only by explicit root-owned policy. `run_process`
keeps its separate exact executable allowlist, direct argv, scoped environment, bounded output, and
process-tree termination contract. The platform shell is real host process authority, not container
isolation or a path-scoped substitute for `write`/`edit`.

Birth context is selected once, before a new logical agent is admitted, with `forkTurns: "none"`,
`"all"`, or a positive turn count such as `"3"`. Omitted starts mean `none`, so a self-contained
child task cannot inherit and mistake parent-level orchestration intent for child ownership.
Explicit inheritance remains available inside the exact provider/model boundary.
Crossing either provider or model defaults to `none`, and an explicit non-`none` cross-boundary
request is rejected. The content-addressed snapshot contains bounded whole
user turns and complete text-only assistant answers. It excludes system/developer/custom messages,
reasoning and commentary, tool calls/results, mailbox controls, non-text attachments, and incomplete
assistant output. A compacted prefix can enter only as its bounded checkpoint attached to the next
real user turn. The snapshot and its durable reference are immutable; reusing a persistent worker
continues its existing transcript and cannot install a second birth context.

Worker output remains untrusted evidence. The root receives a bounded terminal event and retrieves
lane results explicitly; worker transcript pages require an explicit root-owned `transcript` action.
Transcript cursors are opaque raw session-entry offsets: a page can contain no messages but still
return `nextCursor`, and an individual message that exceeds the byte bound is omitted with an explicit
omission count. A preset that requires independent
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

## Bash route stage

The default tool surface has no `ls`, `find` or `grep` tool, so the model reads files and directories through `bash`. `routeBashCommand` (`src/core/tools/bash-route.ts`, pure) classifies a command as `shell`, `read` or `list`; only exact plain forms route (`cat <file>`, `head -n N <file>`, `head -N <file>`, `tail -n N <file>`, `sed -n 'A,Bp' <file>`, `ls`, `ls [-l|-a|-la|-al] [dir]`), and any pipe, redirect, glob, expansion, `..` segment, chaining or unlisted option is `shell`. The stage runs inside the bash tool's `execute`, after the credential, path-scope and edge guards that wrap the tool have admitted the command text, and before a shell is spawned (`bash-route-serve.ts`); it applies only to a local POSIX shell with no command prefix, no custom operations and no rewritten command, never to a background run or Windows. The read tool answers under the same mutation barrier a shell run takes, and the result ends with `(served by the read tool: <routeId>)`. A listing is the read tool's as it is: hidden entries are listed on purpose, because the agent reads and writes dotfiles, and secrets are redacted by the credential guard, not hidden; the trailer says hidden entries are included, directories come first and sizes are shown, and a listing past the read tool's 500-entry cap is answered by the shell. When the target is not the expected kind of object, or the read tool refuses, fails, returns an image, or shows the file is not text, the shell runs the command unchanged and stays the authority for failure text. The `tools` log records `bash command routed` (debug) and the shell passes (trace, command class only).

## Batch lookup

`lookup` (`src/core/tools/lookup.ts`) is the read-only batch tool: 1 to 12 independent requests, each one of `read`, `list` (a directory through `read`), `repo` (the `repo_read` arguments) or `search` (the `grep` tool and its search router), returned as one result with a labeled section per request in order. It holds no authority of its own (its capability policy is empty); each request is a call of the equivalent tool. The tool resolves that tool from the surface's registry, validates the arguments against its schema, acquires its own invocation binding and asks the surface to admit it: in a session `ToolGateController.admitNested` runs the same `beforeToolCall` a standalone call faces (envelope and path authority, router, extension hooks, edge, operation, delegation, soul and System One checks, the tool's credential guard and scope envelopes inside its `execute`) under the parent call's real request, then closes it through `afterToolCall`; in a worker lane the lane's execution admission runs inside each tool's `execute`. Requests are admitted one at a time in order and executed together. A kind whose tool the surface withholds, or a request the gate refuses, is that section (`refused: <reason>`); a failing request is its section and the result is an error only if every request failed. Each section is cut to its share of the output bound (50 KB divided by the request count) and says which offset or narrower call continues it. The `tools` log records `lookup batch` with counts only. Sub-requests do not pass through the loop's failure memory or recovery gate, and extension hooks see their synthetic ids (`<call id>#<n>`).

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
