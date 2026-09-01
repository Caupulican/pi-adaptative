## [0.97.22] - 2026-09-01

### Fixed

- `PI_TOOL_CONCURRENCY` ignores a malformed value instead of reading a prefix out of it. Parsing went through `Number.parseInt`, which stops at the first non-digit, so `4junk` silently configured a pool width of 4 and `0x10` configured 0. The complete trimmed value must now be a decimal safe integer in 1-16; anything else leaves the configured or default width in effect. The `parallel` tool-execution docs in `types.ts` and the README also catch up with the partitioning scheduler that shipped in 0.97.20 — a batch containing one sequential tool is no longer serialised wholesale.
- A Windows kill that `taskkill` only claimed to have performed is reported as failed. The outcome was taken from `taskkill`'s exit status even when the PID was still confirmed alive afterwards, so a surviving process tree could be reported as killed; the liveness check now decides, and the contradiction is surfaced through the diagnostic callback.
- A session file whose first record is not a valid header is preserved rather than truncated. Recovery previously overwrote any file that produced no entries, which destroyed a corrupt-but-recoverable transcript; a non-empty file without a valid header now raises instead, and only a genuinely empty file is initialized in place. Note the behavior change for callers that relied on automatic truncation. The physical first record is also authoritative now, so a later valid header cannot launder a malformed or oversized prefix that the streaming parser skipped.
- A schema rejection no longer blocks the corrected call it asked for. Operation identity deliberately omits resource-envelope fields (`timeout`, `timeoutMs`, `wait_ms` and siblings) so that growing a bound cannot mint a fresh identity and replay a failed command forever — but that rule was applied to validation failures too, where the rejected field *is* the operation. A tool that rejected `timeoutMs` as a forbidden property and printed "Fix timeoutMs: expected forbidden" then hashed the repaired call identically to the bad one and refused it as `repeated_failed_operation`; one real session spent eleven round trips resending the exact call the harness had demanded, escaping only when an unrelated call happened to advance the world cursor. Failure records now also carry an envelope-retaining identity, consulted only for validation-phase records, so a genuinely different argument object is admitted. Execution identity is untouched: a non-zero exit re-run with a larger timeout is still the same operation.
- A timed-out operation can be repaired by raising its bound. Because `timeout` is excluded from identity, the one repair that addresses the cause counted as no repair, and the single unchanged retry the timeout class allows was spent whether or not the bound changed. A strict, material increase — at least double the bound that just failed — now earns an execution, capped at two escalations per episode, so 4x is reachable and an unbounded run of self-incremented timeouts is not.
- A blocked replay no longer claims the arguments were unchanged when they were not. A model told its edit did not transmit will resend it, which is exactly the loop the notice exists to end; when only envelope fields differ, the refusal now says so and asks for a change to the operation itself.
- A process killed at its timeout keeps a bounded tail of what it printed. Evidence extraction required a process exit code, which a killed process does not have, so the output a narrower retry has to be built from was discarded — the failure that destroys the most evidence was the one that surfaced none.

## [0.97.21] - 2026-08-31

### Fixed

- The untrusted-content boundary tags are no longer promoted as a failure diagnostic or kept in failure evidence. A tool result wrapped by the untrusted boundary always ends with `</untrusted_content>`, so whenever no line carried a classified error signal the unclassified fallback handed the model that closing tag as the entire diagnostic — a real session spent forty identical retries being told to repair from a framing tag. The tags are harness framing in the same class as the exit-status and `cwd:` lines that were already excluded, and are now stripped in both filters: the shared status-line filter feeding the generic diagnostic, the unclassified fallback and the evidence tail, and the independent `stderr:` branch whose no-strong-signal fallback joins the last stderr lines. The payload inside the envelope is unchanged, an unwrapped failure is byte-identical to before, and an envelope with an empty body now reports no diagnostic instead of a tag.

## [0.97.20] - 2026-08-29

### Added

- `PI_TOOL_CONCURRENCY=<1..16>` sets how many of a turn's tool calls execute at once (default 4), and a `toolConcurrency` agent option does the same programmatically; the environment variable wins. `PI_TOOL_PARALLELISM_DISABLED=1` is an escape hatch that routes every batch back through the untouched sequential path. Width 1 is not the same thing — it still runs the new scheduler, which makes it useful for isolating a suspected concurrency problem from the scheduler itself.

### Changed

- A turn's tool calls are no longer serialised beyond what correctness requires. Two things did that. A batch containing a single tool that declares sequential execution was pushed wholesale onto the sequential branch, so one `ask-question` sitting among six reads serialised all of them. And the parallel branch ran in fixed chunks of four joined together, so a fifth call could not start until every one of the first four had settled, however long the slowest ran. Batches are now partitioned in emission order — a sequential tool becomes its own barrier and adjacent parallel calls group together — and within a group, slots refill as they free rather than at a chunk boundary. Concurrency still requires adjacency: calls separated by a barrier stay ordered, because the barrier has to run between them. Session reflection, which configures sequential execution directly, is unchanged, as are the persistent shell's one-command-at-a-time contract and the file mutation barrier.
- Tool reservation keeps its batch shape. It is not telemetry — it is the crash-recovery record of which tools started under which provider request, and its consumer validates a whole wave against one request identity and persists every identity in a single prevalidated write. Slots therefore refill in batches: the calls being started together are prepared, reserved as one array, then dispatched, which also leaves the first refill identical to the old first wave. Preparation stays incremental rather than hoisted for the whole group, so policy hooks and the repeat-failure gate keep observing state that earlier completions changed.

### Fixed

- Recovery-gate effects are applied in the order the model emitted the calls, not the order they happen to finish. The gate stamps a failure against a world cursor that a sibling's success in the same batch increments, and admission compares the two — so applying effects as each call completed let a fast sibling's success bump the cursor before a slow sibling's failure was stamped, leaving that failure permanently unable to retry. Effects now retire through an in-order pointer that walks results from the front and stops at the first one still missing, reproducing the previous batch's apply order exactly while dispatch stays immediate. Execution-end events continue to fire at actual completion, which was already the observable contract.

## [0.97.19] - 2026-08-29

## [0.97.18] - 2026-08-29

### Fixed

- Duplicate-call deduplication no longer rewrites conversation history the provider has already seen. Erasing a superseded successful call shifts every byte after it, and providers prefill each request against the longest byte-identical prefix, so removing an early duplicate invalidated the whole conversation from that point — measured live, one repeated `ls` erased at message 5 of 15 cost a full re-prefill. Dedup is unchanged for history that has not been sent yet (the common case of a model repeating itself within a turn); it simply stops reaching back into bytes the provider is caching. The planner tracks the sent high-water mark per run and passes it to `sanitizeToolFailureContext`, whose new third parameter defaults to 0, so every direct caller keeps today's behavior.
- The tool-failure ledger no longer sits in the system prompt, where it invalidated the provider's prompt cache for the whole conversation. The ledger is per-request-mutable by nature — it appears on the first active failure, its `mistakes=` counts change as failures accumulate, and it clears on a matching success — so every one of those events re-prefilled the entire request from byte zero (measured on a real xAI subscription session: a single failed read plus a later failed bash cost two full re-prefills of a ~22k-token prompt). `sanitizeToolFailureContext` now returns the block as a separate `ledger` and hands the system prompt back byte-identical; the planner projects it as the last message of the request, where the same churn costs only the tail. Ledger content, the MUST protocol, and every recovery-gate semantic are unchanged.

## [0.97.17] - 2026-08-28

## [0.97.16] - 2026-08-28

## [0.97.15] - 2026-08-28

## [0.97.14] - 2026-08-28

## [0.97.13] - 2026-08-28

## [0.97.12] - 2026-08-28

## [0.97.11] - 2026-08-28

## [0.97.10] - 2026-08-28

### Fixed

- Lifecycle ledger tests cover requestId-dissociated foreground tool starts so resume can rebind in-flight tools.

## [0.97.9] - 2026-08-26

## [0.97.8] - 2026-08-26

## [0.97.7] - 2026-08-26

## [0.97.6] - 2026-08-26

## [0.97.5] - 2026-08-25

## [0.97.4] - 2026-08-25

## [0.97.3] - 2026-08-25

## [0.97.2] - 2026-08-25

## [0.97.1] - 2026-08-25

### Breaking Changes

- Retired npm publication; this package is now a private workspace component shipped only inside Pi Adaptative standalone releases.

## [0.97.0] - 2026-08-24

### Added

- Exported the trusted verification-obligation boundary and added a bounded per-file V8 coverage command for the live verification, compaction, session, shell, background-task, and goal harness.

### Fixed

- Prevented identical rewritable thinking from being persisted across consecutive tool turns and runaway closing turns while preserving visible text, opaque signed reasoning, and all tool calls and results.
- Kept repeated validation schema guidance visible to the provider and retained bounded repair teaching when a repaired tool execution itself fails.
- Preserved forced-sequential tool ordering across detached handoffs without allowing a detached terminal failure to suppress later batch calls.
- Made failed verification results durable across provider turns, compaction, and restart; stale or errored passes and unsupported completion claims can no longer clear the exact rerun obligation.

## [0.96.5] - 2026-08-24

### Fixed

- Stopped repeated tool-call cycles after three identical observable-result periods while preserving the configurable coarse runaway fuse for changing or volatile results.

## [0.96.4] - 2026-08-23

## [0.96.3] - 2026-08-23

## [0.96.2] - 2026-08-23

### Fixed

- Parsed mixed-unit provider retry windows, rejected over-bound waits instead of shortening them, and added abortable backoff to branch-summary retries.
- Limited runaway stops to exact repeated no-progress call cycles, allowing recurring goal/task status calls interleaved with distinct successful work to continue.

## [0.96.1] - 2026-08-22

### Fixed

- Prevented internal custom steering messages from re-admitting unchanged failed tool operations while keeping each queued owner turn aligned with restored recovery state.

## [0.96.0] - 2026-08-22

## [0.95.0] - 2026-08-22

### Added

- Added a host hook immediately before steering-queue drains so durable terminal events can join an active agent loop without a redundant provider wake.

## [0.94.1] - 2026-08-21

## [0.94.0] - 2026-08-21

## [0.93.19] - 2026-08-21

### Added

- Added a version 4 durable lifecycle ledger for accepted provider requests, foreground tool execution, and compaction recovery, including fail-closed request/tool hooks and deterministic reopen repair.

### Fixed

- Fixed provider request estimates counting persisted diagnostics, usage, and tool details that are not sent to providers.

## [0.93.18] - 2026-08-21

### Fixed

- Added atomic session-replacement compaction with structured-history replay, temporary non-persisted summary instructions, sparse original-request retention, and disk-backed release of discarded payloads.

## [0.93.17] - 2026-08-21

### Fixed

- Collapsed repeated OpenAI-compatible thinking summaries and included reasoning in live generation-loop detection without rewriting opaque signed thinking.
- Attached structured phase and elapsed-time evidence to stream-watchdog aborts while preserving the stable retryable error text.

## [0.93.16] - 2026-08-20

### Fixed

- Classified the observed xAI retained-history token-generation failure as independently retryable and compactable without rotating or leaving the subscription route.

## [0.93.15] - 2026-08-20

## [0.93.14] - 2026-08-20

### Fixed

- Bounded streams that emit only headers or empty structural frames with a separate first-progress phase instead of granting the ten-minute deep-thinking allowance.

## [0.93.13] - 2026-08-20

### Fixed

- Limited zero-progress xAI stream-stall recovery to one retry instead of repeating ten-minute quiet waits.

## [0.93.12] - 2026-08-20

## [0.93.11] - 2026-08-20

### Fixed

- Classified xAI Grok subscription capacity responses as transient overloads so zero-token failures retry on the same subscription route instead of requiring another user turn.

## [0.93.10] - 2026-08-19

## [0.93.9] - 2026-08-19

### Changed

- Tool failure recovery no longer ends a run. Refusal is always local to one exact operation: it can never deny an unrelated tool, terminate a tool batch, or stop the agent. Repeated unproductive work remains bounded by `maxStallTurns` and `maxProviderTurns`.
- A `maxStallTurns` stop now spends one final provider request with no tools and a request-local factual-closing instruction, through the same planned provider boundary as every other request, so the run closes in the model's own words. Native or terminal rendered tool calls in that response become empty protocol errors and never execute, including calls to unloaded tools. The request cannot open a tool batch or re-enter the loop; it is skipped when the run is aborted or `maxProviderTurns` leaves no budget, and a provider error keeps its own error message. The harness never fabricates model text in place of any of these.
- Replaced per-operation attempt counts, probe quotas, and session-long circuits with a single admission rule: an exact operation whose last run was unproductive is admitted again once the world has moved — any successful tool call, or a new user turn. Corrective work therefore re-admits the operation it repaired however many times the agent needs it, and error classes the catalogue marks transient keep their immediate identical retry.
- Errored tool results now declare an `errorKind`. `operation_outcome` means the tool ran the operation to completion and is reporting its own negative status, such as a non-zero process exit; those results keep the tool's own output untouched and never enter failure memory. `tool_failure` (the default, including for results written before this field existed) keeps the bounded harness record.
- Removed `exhaustionScope` and repair-action `getEvidence` from the tool failure-recovery contract. Declared targets and actions are now teaching only; they no longer grant execution budget.

### Fixed

- Stopped erasing an agent's own tool call from the transcript when its operation failed, which left corrections like "use a different operation" unactionable because the operation had been replaced by a 96-character middle-truncated preview. Failed calls and their bounded records now stay where they happened. Two cases still drop the call: a superseded successful call whose newer identical call remains, and a discard-attempt directive, where the harness owns the attempt and its arguments must not reappear — a retarget holds the payload by reference, and a corrupt payload must never be replayed. Unbounded failure results from older transcripts are bounded in place rather than removed.
- A completed operation reporting a non-zero status now clears any earlier failure recorded for that same operation, so a session resumed across this change cannot keep an obsolete `ACTIVE TOOL FAILURES` entry alive for an operation that has since run.
- Removed `transcriptHasBlockedToolOperation` and the task-step guidance branch it fed. Its only consumer injected task context alongside a user prompt, and a user turn already re-admits the operation, so the branch could only ever describe a refusal that had just been cleared.
- Rewrote the mandatory recovery standing prompt to the world-cursor rule; it no longer teaches permission, one-probe evidence, operation exhaustion, or run-ending consequences.
- Stopped a repaired-but-still-failing operation from ending the run on its second identical outcome, which previously depended on tool output being nondeterministic to avoid firing.
- Stopped the provider-turn fuse from opening an unmatched `turn_start` after its last admitted request; the fuse now ends the run without inventing an assistant turn or message.

## [0.93.8] - 2026-08-19

### Fixed

- Recovery circuits now count only repeated exact-operation outcomes with the same failure code and output signature, so changed failure evidence returns control to the agent instead of opening the circuit.

## [0.93.7] - 2026-08-18

## [0.93.6] - 2026-08-18

### Fixed

- Kept the original tool-failure diagnostic as the leading recovery cause when unchanged replay or recovery exhaustion adds harness context, separating that context into a bounded note without changing the exact-operation circuit.

## [0.93.5] - 2026-08-17

### Fixed

- Preserved path-bearing diagnostics and a bounded true tail of executed process output in tool-failure records, and made catalogued error guidance lead recovery-gate actions without weakening replay blocking.

## [0.93.4] - 2026-08-17

### Added

- Added bounded tool-owned failure evidence and operation-local recovery exhaustion contracts so recoverable failures can teach a corrected call without exposing unbounded raw diagnostics or stopping unrelated work.

### Fixed

- Preserved bounded session lineage across in-memory and persisted forks so session-owned projections can distinguish legitimate ancestry from unrelated records.

## [0.93.3] - 2026-08-17

### Changed

- Made the provider-turn fuse opt-in and removed cross-operation tool-failure family, run-count, and state-count stops while preserving exact repeated-operation recovery circuits.

### Fixed

- Marked host-synthesized assistant terminals as local so isolated consumers never charge them as provider output or consume a provider reservation, and kept an exact successful retry resolved until its result reaches the transcript.

## [0.93.2] - 2026-08-17

### Fixed

- Count inline images by semantic token cost and bound aggregate request bodies with provider-specific, request-local image eviction for xAI, Bedrock, and other providers.

## [0.93.1] - 2026-08-17

## [0.93.0] - 2026-08-16

### Added

- Added request-local system-prompt projection to `AgentContextPlan`, keeping host-owned instructions non-durable and non-compactable without representing them as user messages.
- Added a default 20-provider-turn cost fuse that remains active across host continuations of one logical prompt.

### Changed

- Published lean provider-request and tool-projection entry points so focused consumers do not evaluate the batteries-included root module graph.

### Fixed

- Ended exhausted tool-recovery runs with a deterministic local diagnostic instead of spending another provider turn on final delivery.

## [0.92.0] - 2026-08-15

## [0.91.4] - 2026-08-15

## [0.91.3] - 2026-08-15

### Fixed

- Collapsed a status sentence concatenated with no space (`Foo.Foo.`) and dropped a later text block that repeats an earlier one, so a Responses double-emit cannot persist into the next turn. Exact-tile collapse is power-of-two prose only; a long run of one filler character is not a generation loop. Parallel tool calls with distinct ids are not dropped.

## [0.91.2] - 2026-08-15

## [0.91.1] - 2026-08-15

## [0.91.0] - 2026-08-14

### Added

- Added `truncateMiddle`, `truncateKnownHeadTail`, and `formatMiddleOmissionMarker` so oversized tool output can keep a head and a tail instead of only the first or last window.

### Fixed

- Agent-loop `result()` now settles when a provider stream ends without a terminal event instead of hanging the turn.
- Execution and runaway identity now ignore resource-envelope fields such as `timeout` and `timeoutSeconds`, so a failed command cannot be replayed by changing only the wait bound.
- Collapsed consecutive repeated assistant text so a generation loop cannot persist into the next provider turn.
- Collapsed a single-line sentence generation loop (the same sentence repeated inside one paragraph) and abort the provider stream once that run is already long, so a toolless recovery turn cannot spend minutes emitting one sentence hundreds of times. A collapsed generation loop is not treated as a mandatory-delivery halt report.
- Prompt-scoped `owner_authorization_required` failures no longer restore an operation circuit across a new user turn.

## [0.90.12] - 2026-08-14

### Fixed

- Reconstructed tool-failure recovery admission from the transcript at the start of a new run so an already-exhausted identical operation is not re-executed after a user turn or session resume; run-level halt stays on the current run.
- Emitted the mandatory recovery diagnostic when the toolless delivery turn did not report the unresolved failure.

## [0.90.11] - 2026-08-14

## [0.90.10] - 2026-08-14

## [0.90.9] - 2026-08-14

## [0.90.8] - 2026-08-14

### Fixed

- Preserved model-carried Mandatory Rules the extractor does not own during compaction gap-fill, dropped only echoes of the harness's own instruction text, and never overwrote content with "(none)".
- Round-tripped Active Task sections containing markdown headings through compaction verification via symmetric per-line escaping instead of failing permanently.
- Parsed exit codes from the tool-owned status line (last authoritative match) instead of the first exit-shaped substring anywhere in program output, and stopped weak stderr text from fabricating failure diagnostics when a strong signal is required.
- Retained `type` on enum-bearing tool schema properties for providers whose schema subset requires it.
- Required native tool-protocol residue to be a standalone, parsable payload so assistant prose quoting the marker is no longer voided; residue after an unclosed fence is now detected.

### Changed

- Replaced the summarization prompt's worked example with synthetic sentinel-marked content, scrubbed sentinel echoes from Mandatory Rules deterministically, and failed verification on sentinel bleed-through outside the self-healing section.

## [0.90.7] - 2026-08-13

### Fixed

- Preserved runaway and tool-failure recovery gates across host continuations such as compaction and retry boundaries.
- Rejected escaped native tool-call markup rendered as assistant text without executing it.

## [0.90.6] - 2026-08-12

## [0.90.5] - 2026-08-12

## [0.90.4] - 2026-08-12

### Fixed

- Stabilized CPU scaling benchmarks on Windows hosts with coarse process-time accounting.

## [0.90.3] - 2026-08-12

### Fixed

- Scoped exhausted tool-operation recovery circuits to the failed operation so unrelated tools and independent work remain available, while repeated open-circuit calls and run-wide failure bounds still terminate safely.
- Replaced spent tool-recovery probe permission with one retained mandatory caveman no-replay directive, keeping visible and persisted recovery guidance consistent and preventing blocked operations from being mistaken for harness failure.
- Made compaction keep the active user task verbatim and build split-turn context mechanically, preventing tool output from rewriting a conditional request into new user intent while removing the redundant second summarizer call.
- Persisted user-owned compaction task/rule facts across iterative checkpoints and canonicalized those sections on every summary, preventing checkpoint-control prompts from becoming worker instructions.
- Excluded validated one-turn tool-failure directives from durable compaction actions and open problems.
- Made explicit process exit statuses outrank identifier-like stdout during tool-failure classification, retained bounded explicit compiler/test errors and structured stderr as repair evidence, and stopped uncatalogued stdout from being fabricated as a diagnostic.
- Compacted exact provider enum schemas by removing type and length constraints already proven by their literal values, while retaining the full execution-time validation contract.

## [0.90.2] - 2026-08-11

### Fixed

- Made the failure-context scaling gate measure batched process CPU time so shared-runner scheduling pauses cannot create false complexity regressions.

## [0.90.1] - 2026-08-11

### Fixed

- Avoided rebuilding already-safe tool diagnostics during failure-context sanitization, restoring latency headroom for million-token histories under shared-runner load.

## [0.90.0] - 2026-08-11

### Fixed

- Reduced tool-failure context sanitizer omission bookkeeping allocations for large successful histories.

## [0.89.0] - 2026-08-11

### Fixed

- Reduced tool-failure context sanitization allocations by retaining only the latest successful operation and payload during supersession.

## [0.88.0] - 2026-08-11

## [0.87.0] - 2026-08-11

### Changed

- Reduced provider input by removing annotation-only prose and non-enumerable TypeBox metadata, canonicalizing equivalent literal unions, and compacting model-facing recovery and compaction instructions while preserving executable schema constraints.

### Fixed

- Made every retained tool-failure recovery instruction explicitly mandatory, taught the execution-gate protocol in provider context, and added one bounded tool-free delivery turn after recovery exhaustion.
- Added a transactional provider-request boundary that budgets the complete materialized context, compacts and replans durable history only, rejects irreducible fixed-envelope overflow, bounds stale plans independently, and sends the accepted context without rebuilding it.

## [0.86.17] - 2026-08-10

### Fixed

- Removed redundant exact hashing and JSON preview construction from successful tool-result context sanitization.

## [0.86.16] - 2026-08-10

## [0.86.15] - 2026-08-10

### Added

- Added the `AgentTool.failureRecovery` contract for tool-owned failure targets, opaque shared backend authorities, loaded-surface corrective actions, and exact raw-success evidence.

### Fixed

- Fixed tool-failure loops executing despite recovery guidance by admitting at most one evidence-backed recovery probe and enforcing bounded unresolved-failure budgets without inferring recovery from argument text or hook-mutated results; exact operation success clears only its own budget, and exact admission identity remains separate from volatile-normalized diagnostic fingerprints.

## [0.86.14] - 2026-08-09

### Fixed

- Adjusted 50k token latency and GC memory delta thresholds in benchmark tests to accommodate shared CI runner environments.

## [0.86.13] - 2026-08-09

### Fixed

- Preserved original tool call argument order in compaction summary formatting to prevent key path arguments from being truncated.
- Aligned harness failure XML tag matching across agent and coding-agent test suites.

## [0.86.12] - 2026-08-09

### Added

- Added `getFullHistoryChainWithPayloads` for eager cross-platform session history payload retrieval.
- Added cooperative systems harmony test suite and Red Team 1M token performance benchmark suite.

### Fixed

- Fixed tool failure context sanitization to strip failed tool calls/results into system prompt memory (`<harness_tool_failures>`) with category-isolated mistake tracking (`tool_mistakes`).
- Added O(1) text payload signature deduplication (`fastTextSignature`) to eliminate duplicate content payload clutter across tool calls.
- Enforced deterministic key-order signature hashing across compaction summaries and operation fingerprinting.

## [0.86.11] - 2026-08-09

## [0.86.10] - 2026-08-09

## [0.86.9] - 2026-08-09

### Fixed

- Fixed tool failure memory guidance to prompt the model to analyze the diagnostic and try to self-recover, instead of suggesting that no safe repair is inferred.

## [0.86.8] - 2026-08-09

## [0.86.7] - 2026-08-09

## [0.86.5] - 2026-08-08

## [0.86.4] - 2026-08-08

### Fixed

- Fixed bounded session-history readers indexing every cold payload before visiting a small range; borrowed entry pages now resolve only their own cold records, and compacted payload restoration and prefix reads share one canonical file-location lookup.
- Fixed long-running session projection and persistence ownership: linear appends now advance a cached context without revisiting settled ancestry, persisted oversized payloads can be released into exact disk-backed getters, branch copies rebind those getters, malformed entry graphs fail closed, and failed JSONL writes cannot publish phantom state or permit later appends before explicit recovery.

## [0.86.3] - 2026-08-06

## [0.86.2] - 2026-08-06

## [0.86.1] - 2026-08-05

## [0.86.0] - 2026-08-05

## [0.85.9] - 2026-08-05

## [0.85.8] - 2026-08-05

### Changed

- Added repository-only source exports for the supported agent, compaction, reliability, session, and utility owners so native TypeScript tests resolve narrow modules without loading built barrels.

## [0.85.7] - 2026-08-04

## [0.85.6] - 2026-08-04

## [0.85.5] - 2026-08-04

## [0.85.4] - 2026-08-04

### Added

- Added a typed `AgentBusyError` so session coordinators can retry transient prompt-admission races without treating them as terminal model or goal failures.

### Fixed

- Preserved bounded failure diagnostics when unsafe tool-attempt arguments are discarded from provider context, so repair guidance can retain an opaque harness reference without re-exposing the failed payload.

## [0.85.3] - 2026-08-03

## [0.85.2] - 2026-08-03

## [0.85.1] - 2026-08-03

### Fixed

- Stopped auto-compaction after one ineffective model retry and applied a stricter deterministic checkpoint instead of issuing repeated equivalent calls.
- Preserved tool-failure phase, bounded diagnostics, and corrective next actions across rejected and executed native or phone/text-protocol calls, including authoritative unknown-tool identity.

## [0.85.0] - 2026-08-02

### Fixed

- Prevented large tool arguments from being serialized or retained by loop/failure signatures, and made change-approach failures expire after one payload-free directive.

## [0.84.1] - 2026-08-02

## [0.84.0] - 2026-08-02

### Breaking Changes

- Require Node.js 24.18.0 or newer.

### Fixed

- Reopen large persisted sessions with bounded payload ownership by disk-backing each oversized message during the streaming load pass, preventing aggregate history from exhausting the V8 heap.

## [0.81.43] - 2026-08-02

### Added

- Added host-controlled automatic and manual handoff of still-running tool calls so the foreground model loop can continue while detached execution retains task-local cancellation and crosses `afterToolCall` exactly once.

### Changed

- Lowered the default fractional compaction trigger from 70% to 60% of the model context window so long, tool-heavy sessions compact before repeated large-context turns dominate latency; explicit overrides, reserve headroom, recent-context retention, anti-thrash savings, and verification gates are unchanged.

### Fixed

- Fixed compaction verification to score exact read-path and open-error identities, retain bounded failed-attempt evidence through deterministic fallback, and use one retry/telemetry path for split and non-split summaries.
- Fixed proxy streaming of fragmented text, thinking, tool arguments, and SSE lines to avoid accumulated-prefix reconstruction, geometrically bound partial JSON projections, and finalize retained chunks on every terminal path.

## [0.81.42] - 2026-07-27

### Changed

- Added a host-supplied compaction completion boundary so worker lanes can use their pinned model, request budget gate, usage checkpoints, and the shared verified retry/fallback pipeline.

### Fixed

- Replaced generic execution-repair guesses with bounded cause-bearing diagnostics and explicit next actions, retired the legacy generic guess when reopening persisted failures, retained both ends of long operation identities, and guaranteed matching successful retries clear the compact failure record.
- Moved provider request preflight ahead of credential resolution so a rejected request cannot trigger OAuth or SSO refresh work.

## [0.81.41] - 2026-07-27

### Fixed

- Restored explicit provider retry-message classification, routed compaction failures through the shared reliability classifier, and bounded serialized tool-call arguments before summarization.
- Replaced failed tool-call transcript payloads with a bounded occurrence-and-repair ledger, retained bounded preflight-denial diagnostics, removed failed protocol turns before provider conversion, and clear matching failure reminders after a successful retry.
- Isolated compaction and branch-summary requests from provider caches, persisted their exact token usage, and kept durable tool-hook usage visible after compaction and session resume.
- Added early-EOF, DNS, and resource-exhaustion retry classification and shared UUIDv7 generation across agent and provider boundaries.

## [0.81.40] - 2026-07-24

### Added

- Added non-mutating branched session-manager construction so hosts can prepare a fork before replacing a live runtime.

### Fixed

- Calibrated compaction verification around exact path identities and independently weighted operation/error recall, consolidated the duplicated summary-verification path, and preserved structured failed-attempt telemetry through deterministic retry fallback.

## [0.81.39] - 2026-07-20

### Added

- `SessionManager.getLatestCustomEntryOnBranch(customType, fromId?)`: an efficient branch-scoped custom-entry lookup (walks leaf→root ancestry, stops at the first match) for consumers that need the most recent custom entry of a given type without leaking another branch's history.

### Fixed

- `runAgentLoopContinue` no longer mutates the caller's `context.messages` in place (copies first, matching `runAgentLoop`).
- Compaction's structurally-broken-summary retry reuses the pre-digested conversation text from the first attempt (the pre-digest makes real curation-model LLM calls — previously re-run on an unchanged span); summarization requests set `cacheRetention` explicitly.
- Agent forwards `onRunawayStop` into the loop config (was silently dropped), mirroring `onToolValidationEscalation`.

## [0.81.38] - 2026-07-16

## [0.81.37] - 2026-07-16

## [0.81.36] - 2026-07-16

## [0.81.35] - 2026-07-15

## [0.81.34] - 2026-07-15

## [0.81.33] - 2026-07-15

### Fixed

- Made process-tree termination follow child exit events with a one-shot SIGKILL deadline instead of polling PID liveness, and made Windows `taskkill` execution tracked and bounded.

## [0.81.32] - 2026-07-13

## [0.81.31] - 2026-07-13

## [0.81.30] - 2026-07-13

### Fixed

- Made long session-path construction, proxy framing, and persisted JSONL loading linear instead of repeatedly copying accumulated prefixes.
- Released large compacted-away persisted message payloads from the live heap through exact disk-backed getters, restored those getters when reopening a session without parsing the file twice, added append-ordered session-entry delta access, and cleared retained label timestamps when starting a new session.

## [0.81.29] - 2026-07-10

## [0.81.28] - 2026-07-10

## [0.81.27] - 2026-07-10

### Added

- Added `max` and orchestration-level `ultra` thinking levels to the public agent API.
- Added bounded, explicitly untrusted delegated-worker evidence to deterministic compaction checkpoints.
- Added a request-local reasoning resolver that receives the routed model and complete provider context after transformation without mutating persisted agent state.

### Fixed

- Preserved explicit reasoning `off` through agent configuration and next-turn snapshots so request-local provider resolution does not erase it as an unspecified default.
- Converted rejected, prematurely ended, iterator-failed, and unresolved-setup provider streams into bounded terminal retryable errors instead of leaving turns unresolved; caller abort can now terminate before an inner stream exists.

## [0.81.26] - 2026-07-09

### Fixed
- Fixed retry classification for Bun socket drops reported as closed socket connections.

## [0.81.25] - 2026-07-09

### Fixed
- Fixed compaction verification to ignore failed read-tool noise, enumerate exact gate demands in summarizer prompts, and deterministically gap-fill missing gate facts before retrying the LLM.

## [0.81.24] - 2026-07-09

## [0.81.23] - 2026-07-09

### Changed
- Made deterministic tool-argument repair always active in the agent loop, with `PI_TOOL_REPAIR_DISABLED` retained only as an emergency diagnostic kill switch.

## [0.81.22] - 2026-07-09

### Added
- Added a bounded active-branch user-input history reader for prompt recall.

## [0.81.21] - 2026-07-08

## [0.81.20] - 2026-07-08

## [0.81.19] - 2026-07-08

### Fixed
- Fixed auto-compaction retries to skip within-threshold only at loop entry so gate-failed attempts can reach the deterministic checkpoint fallback.

## [0.81.18] - 2026-07-08

## [0.81.17] - 2026-07-08

### Changed
- Changed stream-idle option resolvers to receive the current model, context, and stream options for per-request tuning.

### Fixed
- Fixed stream-idle watchdogs to treat HTTP response headers as transport confirmation before the first streamed token.

## [0.81.16] - 2026-07-08

## [0.81.15] - 2026-07-07

## [0.81.14] - 2026-07-07

## [0.81.13] - 2026-07-07

### Fixed
- Fixed agent stream requests to forward calibrated text tool protocol variant options.

## [0.81.12] - 2026-07-07

0.81.10/0.81.11 retracted before distribution; changes are folded into this section for 0.81.12.

### Fixed
- Fixed agent failure messages to use fresh zero-usage objects instead of sharing mutable usage state.
- Fixed watchdog-wrapped streams to settle with an aborted result when caller abort makes the inner stream end without a terminal event.
- Fixed provider-marked tool call errors to bounce as tool results without executing the tool.
- Added agent-loop forwarding for shape-only tool argument validation telemetry.
- Fixed repaired tool calls to store repaired arguments on the assistant message while preserving raw arguments for diagnostics.
- Added repeated tool validation failure escalation with enriched schema/example feedback.
- Added throttled in-band teach-back notes on repaired tool results.
- Added in-band guidance after repeated identical tool execution failures.
- Linked tool argument validation telemetry to teach state and same-call execution outcome.
- Added catalogued guidance lines to matching tool execution errors.
- Added agent-loop forwarding for calibrated text tool-call protocol variants.
- Added repaired-tool execution markers and independent repair/teach layer switches.
- Fixed checkpoint v2 open-error extraction to classify tool failures from authoritative/structured outcome signals instead of matching error words in successful tool content; compaction facts now include retained recent messages so checkpoints carry the current task state.

## [0.81.9] - 2026-07-07

### Fixed
- Added checkpoint v2 update-path coverage for clearing resolved open problems and refreshing stale working-set entries.
- Added checkpoint v2 prompt sections and verification gates for working-set files and open errors.
- Added checkpoint v2 extraction facts for open errors and working-set recency, with deterministic fallback parity and no post-gate file appendix.

## [0.81.8] - 2026-07-07

### Fixed
- Fixed compaction checkpoints to bound and dedupe gated facts, clamp tiny-model summary budgets, reduce oversized chunk merges before the final request, and truncate assistant thinking in summarization input.
- Fixed v1 session migration to retry generated entry IDs on collision.
- Fixed recent-session lookup to skip files that vanish during stat instead of aborting the scan.

## [0.81.7] - 2026-07-06

### Fixed
- Fixed shell-output sanitization to remove lone surrogates, DEL, and C1 controls while preserving valid Unicode pairs.
- Fixed public agent-loop streams to complete with an error assistant message when the detached async loop fails before normal `agent_end`.
- Fixed compaction prohibition extraction to avoid splitting version-number sentences into mid-clause rule fragments.

## [0.81.6] - 2026-07-06

### Fixed
- Fixed prohibition extraction so pasted documents (user messages over 1500 chars) no longer flood the mandatory-rules gate; harvested rules are capped at the 8 most recent.
- Fixed provider-failure classification so numeric HTTP status patterns only match standalone codes, not digits embedded in longer tokens.
- Fixed the compaction loop so an effect-not-restored retry can continue after the host appends the loop's own compaction entry and deterministic checkpoint preparation failures return failed outcomes instead of escaping the loop.
- Removed unused compaction verification-bypass execution options so manual compaction keeps the normal verification gate.
- Fixed compaction-loop failure mapping so provider errors containing "aborted" retry normally unless the compaction signal was actually aborted.
- Fixed watchdog-wrapped and proxied streams that close without a terminal event to emit a synthetic error result instead of leaving `result()` unresolved.
- Fixed compaction chunk sizing to leave input-bound headroom for per-chunk instructions and corrected the token-estimator comment.
- Fixed branch summarization to use the host's wrapped stream path and retry retryable stream failures instead of bypassing the reliability kernel.

## [0.81.5] - 2026-07-06

### Fixed
- Fixed the compaction actions gate for the update path (resumed sessions): it now measures recall of the NEW span's actions in `## Done` (asymmetric containment) instead of symmetric Jaccard, which punished faithfully carried-over history and made 2nd+ compactions fail deterministically; the update prompt now also bounds Done carry-over (15 most recent items verbatim, older compressed).
- Fixed the cancelled-work gate so required file paths are excluded from the leakage measure — a reversal message naming a modified file no longer makes `cancelled-work-dropped` and `files-modified-recall` mutually unsatisfiable.
- Narrowed the reversal trigger so everyday phrasing like "stop the server" no longer marks the whole prior turn as cancelled work.

## [0.81.4] - 2026-07-06

### Added
- Added `summarizerCanIngest` so hosts can reject compaction summarizer candidates whose context window cannot hold the actual summarization input.

### Fixed
- Fixed turn retry backoff so provider `retryAfterMs` hints are honored and capped by the retry policy.
- Fixed the compaction summary budget to scale with the extracted facts block (bounded at 4000 tokens) instead of length-stopping on large spans; a length-stopped summary now fails loudly (`summary-length-stop`) and the compaction cycle escalates to the session tier.
- Fixed summary truncation so the gate-checked `## Files` and `## Done` sections are never deleted.
- Fixed the compaction facts block to carry the (bounded) active-task text, so the active-task verification gate stays satisfiable when the conversation input is pre-digested or truncated.

## [0.81.3] - 2026-07-05


### Added
- Added deterministic compaction-facts extraction, script verification, closed-loop auto-compaction orchestration, bounded chunked summarization, output truncation, and the self-calibrating `TokenBudget`.

### Changed
- Compaction checkpoints now use the caveman checkpoint format with `### Mandatory Rules`, a cached worked example, and pre-seeded facts.

## [0.81.2] - 2026-07-05


## [0.81.1] - 2026-07-05

### Added
- Reliability kernel: `SilenceWatchdog` now supports dynamic re-arming via `touch()` and `withStreamIdleWatchdog` uses `idleBoundFor` to apply phase-aware bounds (`connectMs`, `activeIdleMs`, `quietIdleMs`) based on the stream's state (thinking vs text).
## [0.81.0] - 2026-07-04

### Breaking Changes
- Removed the dead harness fork and its public exports: `AgentHarness`; branch summarization (`BranchPreparation`, `BranchSummaryDetails`, `CollectEntriesResult`, `collectEntriesForBranchSummary`, `generateBranchSummary`, `prepareBranchEntries`); compaction (`calculateContextTokens`, `compact`, `DEFAULT_COMPACTION_SETTINGS`, `estimateContextTokens`, `estimateTokens`, `findCutPoint`, `findTurnStartIndex`, `generateSummary`, `getLastAssistantUsage`, `prepareCompaction`, `serializeConversation`, `shouldCompact`); messages (`bashExecutionToText`, `convertToLlm`, `createBranchSummaryMessage`, `createCompactionSummaryMessage`, `createCustomMessage`); prompt templates (`loadPromptTemplates`, `loadSourcedPromptTemplates`, `parseCommandArgs`, `substituteArgs`, `formatPromptTemplateInvocation`); session storage/repos (`InMemorySessionRepo`, JSONL repo/storage, in-memory storage, repo utils, `Session`); skills (`formatSkillInvocation`, `loadSourcedSkills`); system prompt (`formatSkillsForSystemPrompt`); shared types (`FileError`, `Result`, `getOrThrow`, `ok`, `toError`, `ExecutionEnv`); text utils (`truncateHead`, `truncateTail`, `truncateLine`, `formatSize`); and the Node.js execution env (`NodeExecutionEnv`, from the `/node` entry). These were an internally unused parallel implementation of coding-agent's live session/compaction/messages stack (verified: no functional consumers anywhere in the repo, including the browser-safety smoke entry which is updated in this same change to exercise only the remaining surface). Live equivalents are promoted from coding-agent in follow-up changes. `uuidv7` is unaffected, now exported from `./uuid.ts`.

### Added
- A granular `./paths` subpath export exposes just the pure `normalizePath`/`resolvePath` helpers
  (and `PathInputOptions`) without pulling in the rest of the Node.js conditional entry (`/node`),
  which transitively loads `SessionManager`, compaction, messages, and process-tree — session
  storage and reliability-kernel modules that a caller wanting only path normalization has no
  reason to pay for. Importing `/node` for these two helpers cost ~240ms; importing `/paths` costs
  ~5ms. `/node` still re-exports the same helpers unchanged for existing consumers.
- Reliability kernel: pure provider-failure classifier (ClassifiedError, FailureReason, classifyError) with four independent action flags (retry/compact/rotate-credential/fallback); retry backoff policy (RetryPolicy, computeRetryDelayMs, sleepAbortable) with configurable jitter and exponential backoff; command-silence and stream-idle watchdogs (SilenceWatchdog, withStreamIdleWatchdog, DEFAULT_STREAM_IDLE); process-tree kill primitives (isProcessAlive, killTreeNow) with liveness-based SIGTERM→SIGKILL escalation. Portable decision logic exported from main entry (`@caupulican/pi-agent-core`); Node.js-only process tree exports from Node.js conditional entry (`@caupulican/pi-agent-core/node`). Host wiring lands in follow-up changes; nothing consumes these yet.
- RetryController: host-agnostic auto-retry driver (classifier-based, abortable backoff, event sink).

### Changed
- The truncate helpers (`truncateHead`, `truncateTail`, `truncateLine`) now live in the Node.js conditional entry (`@caupulican/pi-agent-core/node`), since they depend on Buffer-based byte-length math; migrating consumers must not import them from the root entry. `sanitizeBinaryOutput` now lives in the main entry (`@caupulican/pi-agent-core`), and remains reachable from `/node` as well.
- The live custom message types (BashExecutionMessage, CustomMessage, BranchSummaryMessage, CompactionSummaryMessage) and the convertToLlm transformer are promoted from coding-agent into the kernel, exported from the main entry (`@caupulican/pi-agent-core`). They populate `CustomAgentMessages` via declaration merging, so `AgentMessage` and `convertToLlm` handle these roles out of the box; apps may still extend `CustomAgentMessages` further.
- The tool-result-details retention helpers (`compactToolResultDetailsForRetention`, `compactRetainedDetails`, `MAX_RETAINED_TOOL_RESULT_DETAILS_BYTES`, `MAX_TUI_RETAINED_DETAILS_BYTES`) are promoted from coding-agent into the kernel, exported from the main entry (`@caupulican/pi-agent-core`). The module is pure string/object manipulation with no Node dependencies, so it is browser-safe.
- The `normalizePath` and `resolvePath` path helpers (and the `PathInputOptions` type) are promoted from coding-agent into the kernel, exported from the Node.js conditional entry (`@caupulican/pi-agent-core/node`) because they depend on `node:os`/`node:path`/`node:url`. coding-agent's `utils/paths.ts` re-exports them unchanged, so its consumers are unaffected; the other (impure) helpers in that module — `canonicalizePath`, `isLocalPath`, `getCwdRelativePath`, `formatPathRelativeToCwdOrAbsolute`, `markPathIgnoredByCloudSync` — stay in coding-agent.
- The live `SessionManager` (append-only JSONL session storage, tree traversal, `buildSessionContext`, version migrations, session listing/search) is promoted from coding-agent into the kernel, exported from the Node.js conditional entry (`@caupulican/pi-agent-core/node`) because it depends on `fs`/`fs/promises`/`readline`. It is config-agnostic — the constructor and statics (`create`, `open`, `continueRecent`, `forkFrom`, `list`, `listAll`) take the agent/sessions directories explicitly, per the kernel-promotion seam that already landed in coding-agent. coding-agent's host-layer `core/session-manager-factory.ts` still closes over `getAgentDir()`/`getSessionsDir()` and delegates to it unchanged.
- The live compaction + branch-summarization stack (`shouldCompact`, `prepareCompaction`, `compact`, `generateSummary`, `findCutPoint`, `findTurnStartIndex`, `estimateTokens`, `estimateContextTokens`, `calculateContextTokens`, `getLastAssistantUsage`, `serializeConversation`, `DEFAULT_COMPACTION_SETTINGS`, the `#30` cost-guard triggers `triggerPercent`/`MIN_COMPACTION_SAVINGS`, and branch summarization `collectEntriesForBranchSummary`/`prepareBranchEntries`/`generateBranchSummary`, plus the `CompactionResult`/`CompactionSettings`/`CompactionPreparation`/`FileOperations` types) is promoted from coding-agent into the kernel, exported from the Node.js conditional entry (`@caupulican/pi-agent-core/node`) because it transitively depends on session storage (`buildSessionContext`, which pulls in `fs`/`readline`); the browser-safe main entry is unchanged (verified by the browser-safety smoke entry). The module is otherwise pure summarization/token-accounting logic — the auto-compaction orchestration (trigger evaluation, session appends, retry) stays in coding-agent's `AgentSession`. coding-agent imports these from the kernel unchanged, so its public surface and behavior are preserved.

## [0.80.103] - 2026-07-03

## [0.80.102] - 2026-07-03

## [0.80.101] - 2026-07-03

## [0.80.100] - 2026-07-02

## [0.80.99] - 2026-07-02

## [0.80.98] - 2026-07-02

## [0.80.97] - 2026-07-02

## [0.80.96] - 2026-07-02

## [0.80.95] - 2026-07-02

## [0.80.94] - 2026-07-02

## [0.80.93] - 2026-07-02

## [0.80.92] - 2026-07-02

## [0.80.91] - 2026-07-02

## [0.80.90] - 2026-07-02

## [0.80.89] - 2026-07-02

## [0.80.88] - 2026-07-02

## [0.80.87] - 2026-07-02

## [0.80.86] - 2026-06-29

## [0.80.85] - 2026-06-29

## [0.80.84] - 2026-06-29

## [0.80.83] - 2026-06-28

## [0.80.82] - 2026-06-28

## [0.80.81] - 2026-06-28

## [0.80.80] - 2026-06-28

## [0.80.79] - 2026-06-28

## [0.80.78] - 2026-06-28

## [0.80.77] - 2026-06-28

## [0.80.76] - 2026-06-28

## [0.80.75] - 2026-06-28

## [0.80.74] - 2026-06-28

### Fixed

- Runaway-loop backstop hardening (peer review): tool-call signatures are now normalized so volatile
  arguments (timestamps, UUIDs, long hashes/nonces) can't disguise an otherwise-identical repeating call,
  and the detection window was widened so short oscillating cycles (A→B→C→…) are caught too — not just
  back-to-back repeats. Short numbers in arguments are preserved so genuinely distinct calls are not
  falsely merged.

## [0.80.73] - 2026-06-28

### Added

- Runaway-loop backstop (cost guard): the core agent loop now stops gracefully when a model gets wedged
  repeating the same tool call (identical name + arguments) — a no-progress state that otherwise spends
  tokens unbounded. Configurable via `maxStallTurns` (default 12) with an `onRunawayStop` hook; keyed on
  a sliding window of exact tool-call signatures so legitimate long or varied work never trips it.

## [0.80.72] - 2026-06-28

## [0.80.71] - 2026-06-28

## [0.80.70] - 2026-06-28

## [0.80.69] - 2026-06-28

## [0.80.68] - 2026-06-27

## [0.80.67] - 2026-06-27

## [0.80.66] - 2026-06-27

## [0.80.65] - 2026-06-27

## [0.80.64] - 2026-06-27

## [0.80.63] - 2026-06-27

## [0.80.62] - 2026-06-27

## [0.80.61] - 2026-06-27

## [0.80.60] - 2026-06-27

## [0.80.59] - 2026-06-27

## [0.80.58] - 2026-06-27

## [0.80.57] - 2026-06-27

## [0.80.56] - 2026-06-27

## [0.80.55] - 2026-06-27

## [0.80.54] - 2026-06-27

## [0.80.53] - 2026-06-27

## [0.80.52] - 2026-06-26

## [0.80.51] - 2026-06-26

## [0.80.50] - 2026-06-26

## [0.80.49] - 2026-06-26

## [0.80.48] - 2026-06-26

## [0.80.47] - 2026-06-26

## [0.80.46] - 2026-06-26

## [0.80.45] - 2026-06-26

## [0.80.44] - 2026-06-26

## [0.80.43] - 2026-06-26

## [0.80.42] - 2026-06-24

## [0.80.41] - 2026-06-24

## [0.80.40] - 2026-06-24

## [0.80.39] - 2026-06-24

## [0.80.38] - 2026-06-24

## [0.80.34] - 2026-06-21

## [0.80.33] - 2026-06-21

## [0.80.32] - 2026-06-21

## [0.80.31] - 2026-06-19

## [0.80.30] - 2026-06-19

## [0.80.29] - 2026-06-18

## [0.80.28] - 2026-06-18

## [0.80.25] - 2026-06-14

## [0.80.24] - 2026-06-14

## [0.80.23] - 2026-06-12

## [0.80.20] - 2026-06-10

## [0.80.17] - 2026-06-07

## [0.80.16] - 2026-06-07

## [0.80.15] - 2026-06-08

## [0.80.14] - 2026-06-08

## [0.80.13] - 2026-06-08

## [0.80.12] - 2026-06-07

## [0.80.8] - 2026-06-04

## [0.80.6] - 2026-06-03

## [0.80.5] - 2026-06-03

## [0.80.4] - 2026-06-02

## [0.80.3] - 2026-06-02

## [0.80.2] - 2026-06-02

## [0.80.1] - 2026-06-01

## [0.80.0] - 2026-06-01

## [0.79.0] - 2026-06-01

## [0.78.3] - 2026-06-01

### Added

- Added raw prompt-template argument placeholders (`$ARGUMENTS_RAW` and `$RAW_ARGUMENTS`) to harness prompt formatting.

### Fixed

- Fixed JSONL session directory encoding to avoid cwd collisions while preserving legacy directory reads.

## [0.78.1] - 2026-05-31

## [0.78.0] - 2026-05-29

## [0.77.0] - 2026-05-28

### Breaking Changes

- Renamed agent harness `model_select` and `thinking_level_select` events to `model_update` and `thinking_level_update`.

### Added

- Added agent harness tool registry APIs, `tools_update` events, branch-scoped active-tool persistence, and duplicate tool validation.

## [0.76.0] - 2026-05-27

### Fixed

- Fixed context token estimates to count user image attachments consistently with tool result images ([#4983](https://github.com/earendil-works/pi/issues/4983)).

## [0.75.5] - 2026-05-23

## [0.75.4] - 2026-05-20

### Changed

- Changed source syntax to avoid TypeScript constructs that require JavaScript emit, keeping the package compatible with Node.js strip-only TypeScript checks.
- Removed the package-level development watch script now that the root TypeScript check validates strip-only-compatible sources.

### Fixed

- Fixed tool-call preflight to stop preparing sibling tool calls after the run is aborted ([#4276](https://github.com/earendil-works/pi/issues/4276)).
- Fixed tail truncation for oversized single-line output that ends with a trailing newline ([#4715](https://github.com/earendil-works/pi/issues/4715)).
- Fixed Windows Node execution environment command spawns to hide helper console windows from background processes ([#4699](https://github.com/earendil-works/pi/issues/4699)).

## [0.75.3] - 2026-05-18

## [0.75.2] - 2026-05-18

## [0.75.1] - 2026-05-18

## [0.75.0] - 2026-05-17

### Breaking Changes

- Raised the minimum supported Node.js version to 22.19.0.

## [0.74.1] - 2026-05-16

## [0.74.0] - 2026-05-07

## [0.73.1] - 2026-05-07

## [0.73.0] - 2026-05-04

## [0.72.1] - 2026-05-02

### Changed

- Changed the default agent transport to `auto` so providers can use their best available transport by default ([#4083](https://github.com/badlogic/pi-mono/issues/4083)).

## [0.72.0] - 2026-05-01

### Added

- Added `shouldStopAfterTurn` to the low-level agent loop config for gracefully exiting after a completed turn before polling queued messages or starting another LLM call.

## [0.71.1] - 2026-05-01

## [0.71.0] - 2026-04-30

## [0.70.6] - 2026-04-28

## [0.70.5] - 2026-04-27

## [0.70.4] - 2026-04-27

## [0.70.3] - 2026-04-27

## [0.70.2] - 2026-04-24

## [0.70.1] - 2026-04-24

## [0.70.0] - 2026-04-23

## [0.69.0] - 2026-04-22

### Breaking Changes

- Migrated public TypeBox-facing types and examples from `@sinclair/typebox` 0.34.x to `typebox` 1.x. Install and import from `typebox` instead of relying on `@sinclair/typebox` transitively ([#3112](https://github.com/badlogic/pi-mono/issues/3112))

### Added

- Added `terminate: true` tool-result hints to skip the automatic follow-up LLM call when every finalized tool result in the current batch opts into early termination ([#3525](https://github.com/badlogic/pi-mono/issues/3525))

## [0.68.1] - 2026-04-22

### Fixed

- Fixed `streamProxy()` to preserve the proxy-safe serializable subset of stream options, including session, transport, retry-delay, metadata, header, cache-retention, and thinking-budget settings ([#3512](https://github.com/badlogic/pi-mono/issues/3512))
- Fixed parallel tool execution to emit `tool_execution_end` as soon as each tool is finalized, while still emitting persisted tool-result messages in assistant source order ([#3503](https://github.com/badlogic/pi-mono/issues/3503))

## [0.68.0] - 2026-04-20

### Changed

- Clarified parallel tool execution ordering docs to specify that final tool lifecycle and tool-result artifacts are emitted in tool completion order.

## [0.67.68] - 2026-04-17

## [0.67.67] - 2026-04-17

### Fixed

- Fixed parallel tool-call finalization to convert `afterToolCall` hook throws into error tool results instead of aborting the batch ([#3084](https://github.com/badlogic/pi-mono/issues/3084))

## [0.67.6] - 2026-04-16

## [0.67.5] - 2026-04-16

## [0.67.4] - 2026-04-16

## [0.67.3] - 2026-04-15

## [0.67.2] - 2026-04-14

## [0.67.1] - 2026-04-13

## [0.67.0] - 2026-04-13

## [0.66.1] - 2026-04-08

## [0.66.0] - 2026-04-08

## [0.65.2] - 2026-04-06

## [0.65.1] - 2026-04-05

## [0.65.0] - 2026-04-03

### Breaking Changes

- `AgentState` has been reshaped:
  - `streamMessage` was renamed to `streamingMessage`
  - `error` was renamed to `errorMessage`
  - `isStreaming`, `streamingMessage`, `pendingToolCalls`, and `errorMessage` are now readonly in the public API
  - `pendingToolCalls` is now typed as `ReadonlySet<string>`
  - `tools` and `messages` are now accessor properties, and assigning either field copies the provided top-level array instead of preserving array identity
- `AgentOptions.initialState` no longer accepts runtime-owned fields. Remove `isStreaming`, `streamingMessage`, `pendingToolCalls`, and `errorMessage` from `initialState` values.
- Removed `Agent` mutator methods in favor of direct property access:
  - `agent.setSystemPrompt(value)` -> `agent.state.systemPrompt = value`
  - `agent.setModel(model)` -> `agent.state.model = model`
  - `agent.setThinkingLevel(level)` -> `agent.state.thinkingLevel = level`
  - `agent.setTools(tools)` -> `agent.state.tools = tools`
  - `agent.replaceMessages(messages)` -> `agent.state.messages = messages`
  - `agent.appendMessage(message)` -> `agent.state.messages.push(message)`
  - `agent.clearMessages()` -> `agent.state.messages = []`
  - `agent.setToolExecution(mode)` -> `agent.toolExecution = mode`
  - `agent.setBeforeToolCall(fn)` -> `agent.beforeToolCall = fn`
  - `agent.setAfterToolCall(fn)` -> `agent.afterToolCall = fn`
  - `agent.setTransport(transport)` -> `agent.transport = transport`
- Removed queue mode getter/setter methods in favor of properties:
  - `agent.setSteeringMode(mode)` -> `agent.steeringMode = mode`
  - `agent.getSteeringMode()` -> `agent.steeringMode`
  - `agent.setFollowUpMode(mode)` -> `agent.followUpMode = mode`
  - `agent.getFollowUpMode()` -> `agent.followUpMode`
- `Agent.subscribe()` listeners are now awaited and receive the active `AbortSignal`:
  - `agent.subscribe((event) => { ... })` -> `agent.subscribe(async (event, signal) => { ... })`
  - `agent_end` is now the final emitted event for a run, but not the idle boundary
  - `agent.waitForIdle()`, `agent.prompt(...)`, and `agent.continue()` now settle only after awaited `agent_end` listeners finish
  - `agent.state.isStreaming` remains `true` until that settlement completes

## [0.64.0] - 2026-03-29

### Added

- Added `AgentTool.prepareArguments` hook to prepare raw tool call arguments before schema validation, enabling compatibility shims for resumed sessions with outdated tool schemas

## [0.63.2] - 2026-03-29

### Added

- Added `Agent.signal` to expose the active abort signal for the current turn, allowing callers to forward cancellation into nested async work ([#2660](https://github.com/badlogic/pi-mono/issues/2660))

## [0.63.1] - 2026-03-27

## [0.63.0] - 2026-03-27

## [0.62.0] - 2026-03-23

## [0.61.1] - 2026-03-20

## [0.61.0] - 2026-03-20

## [0.60.0] - 2026-03-18

## [0.59.0] - 2026-03-17

## [0.58.4] - 2026-03-16

### Fixed

- Fixed steering messages to wait until the current assistant message's tool-call batch fully finishes instead of skipping pending tool calls.

## [0.58.3] - 2026-03-15

## [0.58.2] - 2026-03-15

## [0.58.1] - 2026-03-14

## [0.58.0] - 2026-03-14

### Added

- Added `beforeToolCall` and `afterToolCall` hooks to `AgentOptions` and `AgentLoopConfig` for preflight blocking and post-execution tool result mutation.

### Changed

- Added configurable tool execution mode to `Agent` and `agentLoop` via `toolExecution: "parallel" | "sequential"`, with `parallel` as the default. Parallel mode preflights tool calls sequentially, executes allowed tools concurrently, and emits final tool results in assistant source order.

## [0.57.1] - 2026-03-07

## [0.57.0] - 2026-03-07

## [0.56.3] - 2026-03-06

## [0.56.2] - 2026-03-05

## [0.56.1] - 2026-03-05

## [0.56.0] - 2026-03-04

## [0.55.4] - 2026-03-02

## [0.55.3] - 2026-02-27

## [0.55.2] - 2026-02-27

## [0.55.1] - 2026-02-26

## [0.55.0] - 2026-02-24

## [0.54.2] - 2026-02-23

## [0.54.1] - 2026-02-22

## [0.54.0] - 2026-02-19

## [0.53.1] - 2026-02-19

## [0.53.0] - 2026-02-17

## [0.52.12] - 2026-02-13

### Added

- Added `transport` to `AgentOptions` and `AgentLoopConfig` forwarding, allowing stream transport preference (`"sse"`, `"websocket"`, `"auto"`) to flow into provider calls.

## [0.52.11] - 2026-02-13

## [0.52.10] - 2026-02-12

## [0.52.9] - 2026-02-08

## [0.52.8] - 2026-02-07

## [0.52.7] - 2026-02-06

### Fixed

- Fixed `continue()` to resume queued steering/follow-up messages when context currently ends in an assistant message, and preserved one-at-a-time steering ordering during assistant-tail resumes ([#1312](https://github.com/badlogic/pi-mono/pull/1312) by [@ferologics](https://github.com/ferologics))

## [0.52.6] - 2026-02-05

## [0.52.5] - 2026-02-05

## [0.52.4] - 2026-02-05

## [0.52.3] - 2026-02-05

## [0.52.2] - 2026-02-05

## [0.52.1] - 2026-02-05

## [0.52.0] - 2026-02-05

## [0.51.6] - 2026-02-04

## [0.51.5] - 2026-02-04

## [0.51.4] - 2026-02-03

## [0.51.3] - 2026-02-03

## [0.51.2] - 2026-02-03

## [0.51.1] - 2026-02-02

## [0.51.0] - 2026-02-01

## [0.50.9] - 2026-02-01

## [0.50.8] - 2026-02-01

### Added

- Added `maxRetryDelayMs` option to `AgentOptions` to cap server-requested retry delays. Passed through to the underlying stream function. ([#1123](https://github.com/badlogic/pi-mono/issues/1123))

## [0.50.7] - 2026-01-31

## [0.50.6] - 2026-01-30

## [0.50.5] - 2026-01-30

## [0.50.3] - 2026-01-29

## [0.50.2] - 2026-01-29

## [0.50.1] - 2026-01-26

## [0.50.0] - 2026-01-26

## [0.49.3] - 2026-01-22

## [0.49.2] - 2026-01-19

## [0.49.1] - 2026-01-18

## [0.49.0] - 2026-01-17

## [0.48.0] - 2026-01-16

## [0.47.0] - 2026-01-16

## [0.46.0] - 2026-01-15

## [0.45.7] - 2026-01-13

## [0.45.6] - 2026-01-13

## [0.45.5] - 2026-01-13

## [0.45.4] - 2026-01-13

## [0.45.3] - 2026-01-13

## [0.45.2] - 2026-01-13

## [0.45.1] - 2026-01-13

## [0.45.0] - 2026-01-13

## [0.44.0] - 2026-01-12

## [0.43.0] - 2026-01-11

## [0.42.5] - 2026-01-11

## [0.42.4] - 2026-01-10

## [0.42.3] - 2026-01-10

## [0.42.2] - 2026-01-10

## [0.42.1] - 2026-01-09

## [0.42.0] - 2026-01-09

## [0.41.0] - 2026-01-09

## [0.40.1] - 2026-01-09

## [0.40.0] - 2026-01-08

## [0.39.1] - 2026-01-08

## [0.39.0] - 2026-01-08

## [0.38.0] - 2026-01-08

### Added

- `thinkingBudgets` option on `Agent` and `AgentOptions` to customize token budgets per thinking level ([#529](https://github.com/badlogic/pi-mono/pull/529) by [@melihmucuk](https://github.com/melihmucuk))

## [0.37.8] - 2026-01-07

## [0.37.7] - 2026-01-07

## [0.37.6] - 2026-01-06

## [0.37.5] - 2026-01-06

## [0.37.4] - 2026-01-06

## [0.37.3] - 2026-01-06

### Added

- `sessionId` option on `Agent` to forward session identifiers to LLM providers for session-based caching.

## [0.37.2] - 2026-01-05

## [0.37.1] - 2026-01-05

## [0.37.0] - 2026-01-05

### Fixed

- `minimal` thinking level now maps to `minimal` reasoning effort instead of being treated as `low`.

## [0.36.0] - 2026-01-05

## [0.35.0] - 2026-01-05

## [0.34.2] - 2026-01-04

## [0.34.1] - 2026-01-04

## [0.34.0] - 2026-01-04

## [0.33.0] - 2026-01-04

## [0.32.3] - 2026-01-03

## [0.32.2] - 2026-01-03

## [0.32.1] - 2026-01-03

## [0.32.0] - 2026-01-03

### Breaking Changes

- **Queue API replaced with steer/followUp**: The `queueMessage()` method has been split into two methods with different delivery semantics ([#403](https://github.com/badlogic/pi-mono/issues/403)):
  - `steer(msg)`: Interrupts the agent mid-run. Delivered after current tool execution, skips remaining tools.
  - `followUp(msg)`: Waits until the agent finishes. Delivered only when there are no more tool calls or steering messages.
- **Queue mode renamed**: `queueMode` option renamed to `steeringMode`. Added new `followUpMode` option. Both control whether messages are delivered one-at-a-time or all at once.
- **AgentLoopConfig callbacks renamed**: `getQueuedMessages` split into `getSteeringMessages` and `getFollowUpMessages`.
- **Agent methods renamed**:
  - `queueMessage()` → `steer()` and `followUp()`
  - `clearMessageQueue()` → `clearSteeringQueue()`, `clearFollowUpQueue()`, `clearAllQueues()`
  - `setQueueMode()`/`getQueueMode()` → `setSteeringMode()`/`getSteeringMode()` and `setFollowUpMode()`/`getFollowUpMode()`

### Fixed

- `prompt()` and `continue()` now throw if called while the agent is already streaming, preventing race conditions and corrupted state. Use `steer()` or `followUp()` to queue messages during streaming, or `await` the previous call.

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, and `AgentTransport` interface have been removed. Use the `streamFn` option directly for custom streaming implementations.

- **Agent options renamed**:
  - `transport` → removed (use `streamFn` instead)
  - `messageTransformer` → `convertToLlm`
  - `preprocessor` → `transformContext`

- **`AppMessage` renamed to `AgentMessage`**: All references to `AppMessage` have been renamed to `AgentMessage` for consistency.

- **`CustomMessages` renamed to `CustomAgentMessages`**: The declaration merging interface has been renamed.

- **`UserMessageWithAttachments` and `Attachment` types removed**: Attachment handling is now the responsibility of the `convertToLlm` function.

- **Agent loop moved from `@mariozechner/pi-ai`**: The `agentLoop`, `agentLoopContinue`, and related types have moved to this package. Import from `@mariozechner/pi-agent-core` instead.

### Added

- `streamFn` option on `Agent` for custom stream implementations. Default uses `streamSimple` from pi-ai.

- `streamProxy()` utility function for browser apps that need to proxy LLM calls through a backend server. Replaces the removed `AppTransport`.

- `getApiKey` option for dynamic API key resolution (useful for expiring OAuth tokens like GitHub Copilot).

- `agentLoop()` and `agentLoopContinue()` low-level functions for running the agent loop without the `Agent` class wrapper.

- New exported types: `AgentLoopConfig`, `AgentContext`, `AgentTool`, `AgentToolResult`, `AgentToolUpdateCallback`, `StreamFn`.

### Changed

- `Agent` constructor now has all options optional (empty options use defaults).

- `queueMessage()` is now synchronous (no longer returns a Promise).
