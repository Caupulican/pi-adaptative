# Version-aware durable learning design

**Status:** Implemented and verified on 2026-08-23. The implementation tribunal reached unanimous core consensus, focused and repository-wide gates pass, and release verification remains pending.

This document defines one root-owned path for automatic durable learning and release-aware memory review. It complements [`memory-subsystem-design.md`](memory-subsystem-design.md), [`self-adaptation.md`](self-adaptation.md), and [`task-steps.md`](task-steps.md); it does not duplicate their general subsystem descriptions.

## Scope

Covered in depth: same-turn reflection ownership, durable knowledge routing, runtime-version state, lifecycle, bounded persistence, concurrency, failure behavior, migration, and acceptance tests.

Structurally referenced only: OKF file syntax, individual memory providers, pipeline implementation, and release automation. Those remain owned by their existing documents and source modules.

## Confirmed implemented behavior

- External root prompts call `ReflectionController.queueExternalRootTurnCue()` before provider planning (`src/core/agent-session.ts`).
- `ReflectionController` keeps at most one active cue on the current session branch, merges trigger classes, injects it only into provider context, and records accepted-plan delivery separately from terminal review (`src/core/reflection-controller.ts`).
- Automatic reflection is disabled for child sessions, disposed sessions, or resolved settings/environment kill switches (`ReflectionController.isAutomaticReflectionEnabled`).
- Completed-turn analysis uses bounded, secret-redacted user and assistant semantics plus tool names/counts; raw non-memory tool results are excluded (`src/core/learning/reflection-turn-analysis.ts`).
- Signal analysis recognizes corrections, explicit durable instructions, durable completed work, and configured complexity (`analyzeReflectionTurn`).
- `AgentSession` computes final root/child/worker role before constructing reflection. Child and worker sessions receive no `DurableLearningState` owner and therefore create no state-file footprint.
- `VERSION` and `VERSION_SOURCE_AVAILABLE` come from installed package metadata (`src/config.ts`). Missing metadata keeps ordinary reflection active but suppresses version claims.
- `DurableLearningState` persists bounded runtime/policy transition control state through `stateFile`, `withFileLockSync`, and `writeFileAtomicSync`; it has no semantic-memory writer dependency (`src/core/learning/durable-learning-state.ts`).
- The root memory tool remains the only semantic mutation route and directs structured project decisions, architecture, rules, findings, and references to OKF; child sessions receive no memory tool (`src/core/memory/providers/file-store.ts`).

## Core invariant

Exactly one root provider turn owns semantic learning decisions.

1. The current root model receives one provider-only reflection cue in the same turn.
2. That model confronts existing durable knowledge before writing.
3. Existing memory and skill tools remain the only semantic mutation path and retain their confidence, evidence, contradiction, rollback, and approval gates.
4. No child session, worker, background learner, isolated provider request, or concurrent unclaimed root turn may own or complete the reflection.
5. Runtime-version reconciliation stores only bounded control state. It never mechanically rewrites semantic memory, and `reviewed` can be committed only by compare-and-swap from the exact claimed cue-bearing successful root run.

## Canonical knowledge routing

A durable fact has one semantic owner:

- `USER.md`: collaborator preferences and stable working relationship facts.
- `MEMORY.md`: compact, frequently needed cross-session facts.
- OKF: canonical project decisions, architecture, rules, findings, references, implementation knowledge, and evidence.
- Skills: repeatable procedures whose value is operational specialization rather than a static fact.
- ICM task/pipeline context: workflow stage, progression, active artifacts, and references to OKF records. It must not copy an OKF fact into an independent second truth.

Verified stage findings may be promoted into OKF through the existing memory gate. ICM then references the resulting OKF record. Supersession updates the canonical record and leaves workflow history as history.

The provider cue and root memory-tool guidance enforce this routing together. A semantic fact must be written to exactly one durable target. Goal, task-step, and pipeline payloads may contain execution status, acceptance evidence, artifact paths, and OKF references, but not an independently maintained copy of canonical project semantics. Runtime reconciliation has no API for editing memory, OKF, skills, tasks, goals, or pipelines.

## Runtime learning state

`src/core/learning/durable-learning-state.ts` is the sole control-state owner. `DURABLE_LEARNING_MEMORY_POLICY_VERSION` is an explicit source string independent from JSON `schemaVersion`; file compatibility and semantic-policy review remain separate invariants.

```ts
interface DurableLearningStateFileV1 {
  schemaVersion: 1;
  revision: number;
  observedRuntimeVersion: string;
  observedMemoryPolicyVersion: string;
  current: PendingDurableLearningTransition | null;
  history: ResolvedDurableLearningTransition[];
}

interface PendingDurableLearningTransition {
  transitionId: string;
  reason:
    | "first-observation"
    | "runtime-change"
    | "memory-policy-change"
    | "runtime-and-policy-change"
    | "recovered-corrupt-state";
  previousRuntimeVersion: string | null;
  runtimeVersion: string;
  previousMemoryPolicyVersion: string | null;
  memoryPolicyVersion: string;
  createdAt: string;
  updatedAt: string;
  claim: {
    claimId: string;
    ownerId: string; // random per root ReflectionController; never a real session ID
    acquiredAt: string;
    expiresAt: string;
  } | null;
}
```

Exactly one `current` slot is the pending-transition truth. `history` contains only resolved `reviewed` or `superseded` records. A runtime or policy change resolves an older current transition as superseded before installing one new current transition. Completion identity includes transition ID, claim ID, owner ID, runtime version, and memory-policy version. `ownerId`, `claimId`, and `transitionId` use `randomUUID()` or an injected equivalent.

### Bounds and validation

- Keep at most 32 newest resolved history records plus the single current transition.
- Accept version strings matching the bounded implementation alphabet (`A-Z`, `a-z`, `0-9`, `.`, `_`, `+`, `-`) with length 1-128; accept canonical ISO timestamps up to 64 characters and UUID-v4-format IDs.
- Reject files larger than 64 KiB before JSON materialization. Default claim TTL is 90 minutes. Exact same-owner reconciliation or provider-loop continuation renews only the live matching token and never rotates identity. Retry also renews the same token. Superseded, released, expired-and-taken-over, or otherwise mismatched tokens cannot renew or complete.
- Store only bounded transition control fields. Never store transcript text, memory contents, credentials, tool results, provider output, real session IDs, task payloads, or OKF contents.
- Schema v1 is closed at every object level. Unknown v1 keys, unknown schema versions, and oversized state enter unsupported read-only mode and preserve exact bytes.

### Location, role, and atomicity

`DurableLearningState.forAgentDir()` uses `stateFile(agentDir, "durable-learning-state.json")`, `withFileLockSync`, and `writeFileAtomicSync(..., { mode: 0o600 })`.

Every reconcile, renewal, release, or completion performs lock-serialized load/validate/mutate/save. `revision` increases only when control state persists a change; read-only and rejected operations leave it unchanged.

`AgentSession` computes final child/worker role before constructing reflection or state. Child and worker sessions receive no durable-learning state owner and perform no state read, directory creation, lock acquisition, or write. Root runtime is the only activation owner.

## Reconciliation lifecycle

### Session construction

After computing final root-versus-child role, `AgentSession` constructs one root-only state owner from the agent state directory. Construction performs no I/O. `ReflectionController` owns one random non-session owner ID and receives installed `VERSION`, `VERSION_SOURCE_AVAILABLE`, and current `DURABLE_LEARNING_MEMORY_POLICY_VERSION` through dependencies at reconciliation time. Missing package metadata is therefore distinguishable from a real `"0.0.0"` release; missing identity emits one bounded warning and never claims a semantic review.

### Before an external root provider request

Only a prompt with no `internalContextType` may reconcile. It must pass the same authoritative eligibility predicate used by current-session reflection: resolved `enabled`, resolved `reflectionReview`, `PI_NATIVE_REFLECTION !== "0"`, `PI_AUTO_LEARN_CHILD !== "1"`, root role, and non-disposed session. An ineligible request performs no read, lock, or state write. If eligibility is revoked during an active review, only lease cleanup may write; observation and completion remain forbidden.

For an eligible external root prompt, one state-owner `reconcileClaimAndAttach(ownerId, attachCue)` transaction holds the state-file lock through both claim reconciliation and the synchronous durable cue-state append:

1. Missing state creates one pending `first-observation` transition and records the current observed runtime and policy. This first supporting release therefore audits an existing installation once.
2. A changed runtime or memory policy marks the older pending transition `superseded`, clears its embedded claim, updates observed values, and appends one pending transition. Exact string equality detects upgrade, downgrade, and reinstall; semver ordering is unnecessary.
3. Matching observed values create no transition and no revision change. An existing pending transition remains eligible.
4. The schema has exactly one current-transition slot and at most one embedded claim. A pending transition with no live claim receives a fresh cryptographically random claim ID. Exact same-owner renewal only extends that claim's expiry and returns the identical transition ID, claim ID, owner ID, runtime, and policy; renewal never rotates a token. Expiry takeover atomically revokes the predecessor claim before creating a new claim ID. A live different-owner claim returns `busy`; that root receives the ordinary reflection cue without version metadata.
5. The current claim is exposed to `attachCue` as an opaque compare-and-swap token containing transition ID, claim ID, owner ID, target runtime, and target policy. It is persisted in bounded session cue state but claim and owner IDs never enter provider text.

Claim attachment and cue coalescing are one state-owner operation: no claim token escapes for later attachment. While the state-file lock remains held, the synchronous callback attaches `root-turn` plus `version-change`, hidden token, and bounded metadata to the single cue. It returns `attached` when it created or amended the cue, `coalesced` when that cue already durably carries the identical token, `replaced-stale` when the one current claim proves a different hidden token non-current, `disabled` when reflection became ineligible, or `failed` on persistence. `attached`, exact-token `coalesced`, and `replaced-stale` retain the current claim; a boolean no-op is never interpreted as failure. A different token can only name a superseded transition, an exactly released claim, or an expired claim atomically revoked before takeover: same-owner renewal preserves the exact claim ID, one current transition prevents a second live same-owner claim, and the held lock prevents interleaving between proof and cue append. The stale token is retired in the same cue-state revision that attaches the current token. `disabled`, `failed`, or a thrown append releases only the exact current claim before unlocking; a crash after claim persistence but before cue append is recovered only by lease expiry. Adding `version-change` requires extending `CurrentTurnReflectionTrigger`, `CURRENT_TURN_REFLECTION_TRIGGERS`, the provider-hidden cue-state token, and the cue-state parser. Deterministic completed-turn analysis must never infer `version-change` from transcript text.

### Provider cue contract

For every root turn, one logical cue asks the current model to classify:

- explicit durable intent;
- corrections and standing preferences;
- repeated patterns or behavior supported by accumulated evidence;
- reusable procedures that belong in skills;
- verified project knowledge that belongs in OKF;
- version-sensitive knowledge when a claimed transition is pending.

It routes stable collaborator preferences to USER, compact hot facts to MEMORY, canonical project semantics and evidence to OKF, repeatable procedures to skills, and workflow status plus OKF references to goals/tasks/pipelines. It forbids an independently maintained semantic copy in ICM.

For a claimed transition, provider-visible metadata contains current runtime version, prior runtime version when known, policy versions, and reason, but no control token. `first-observation` is explicitly an audit-only reason: it does not imply that existing memory is stale. Every transition cue says that version movement alone is not semantic evidence; source-backed revalidation and existing memory/skill approval gates remain mandatory.

The same cue ID is transiently injected into every provider request in that cue's one logical request loop: the first attempt, tool-loop continuations, and routed retries only. Injection stops on that loop's terminal success, terminal failure, or abort; a later unrelated external prompt must reconcile and claim independently and must never inherit the prior run token. No extra provider request is created. The first accepted request-plan commit marks durable cue state `consumed` and records the exact active-run review token; later injections inside the same loop are idempotent continuations of that one logical cue. `consumed` means delivered, not reviewed.

### Successful completion

The sole completion hook is the existing non-retry `agent_end` path in `AgentSession._handleAgentEvent`. It may call compare-and-swap completion only when all conditions hold:

1. the run has the exact token recorded by accepted-plan commit;
2. reflection remains eligible and the session is root and non-disposed;
3. `_willRetryAfterAgentEnd(event)` is false;
4. the final assistant message has `stopReason === "stop"`, no `errorMessage`, and non-empty assistant text;
5. under the file lock, the matching transition is still pending and its transition ID, claim ID, owner ID, runtime, and policy all match.

Error, abort, length/runaway stop, empty assistant, disposal, provider-plan rejection, stale token, failed request, or failed write cannot mark reviewed. A retry requeues the same logical cue through one revision-bumping cue-state transaction and extends the exact existing claim expiry without changing any token field, so the successful retry is still cue-bearing; ordinary branch-navigation cache invalidation therefore applies. A terminal failure releases the exact claim while leaving the transition pending for a later enabled external root turn. Process death is recovered by claim expiry.

`reviewed` means the current root model completed the required comparison. It does not claim that semantic memory changed; a valid evidence-based review may make no write. Completion, release, and stale-token handling are idempotent. Exactly one current-transition slot, one embedded claim, non-rotating same-owner renewal, locked claim-and-attach, and exact completion compare-and-swap prevent two live tokens from existing for one transition. Competing root sessions can preview ordinary cues, but only the claimed cue can complete the transition; first valid compare-and-swap wins.

### Disabled learning

Resolved settings and environment kill switches are authoritative for reconciliation, cue delivery, and completion. Disabling mid-turn permits only exact-claim cleanup and leaves the semantic transition pending. Re-enabling later allows a new eligible external root turn to claim it.

## Failure and compatibility behavior

- Missing state: initialize one pending first review on the next eligible external root request.
- Malformed closed-schema v1 state within the size bound: recover to one bounded pending state with reason `recovered-corrupt-state`, emit a bounded warning without raw file content, and never touch semantic memory.
- Unknown newer schema, unknown v1 keys, or oversize file: enter unsupported read-only mode, preserve bytes exactly, emit at most one bounded warning per session, keep ordinary turns usable, suppress version metadata, and block review completion until compatible code or explicit repair exists.
- Missing package-version metadata: record no claim or semantic review; emit one bounded warning and keep ordinary reflection usable.
- Atomic or lock failure: report a bounded warning, treat the operation as unsuccessful, and leave the prior file authoritative.
- Concurrent root sessions: one current-transition slot, lock serialization held through cue attachment, non-rotating same-owner renewal, atomic expiry takeover/supersession, and exact-token compare-and-swap prevent lost transitions, duplicate ownership, and false completion.
- Existing sessions and state files require no eager migration. The first compatible eligible request performs lazy, idempotent reconciliation.

## Required tests

### State unit tests

- Missing file creates one bounded pending first-observation transition; cue text treats it as audit-only and no reconciliation API can write semantic memory.
- Same runtime and policy reconcile twice without a second transition or observation revision increase.
- Runtime upgrade, downgrade, and policy-only change supersede the older pending transition and create the correct new identity.
- Repeated reconciliation coalesces one pending transition without unbounded growth; history retains only the newest 32 records.
- Claim acquisition, exact same-owner renewal that preserves every token field, live different-owner rejection, expiry takeover with predecessor revocation, release, and crash-recovery paths are deterministic under an injected clock; no path creates a second live claim and takeover prevents the old owner from renewing or completing.
- Successful exact-token completion marks exactly one transition reviewed; duplicate completion is a no-op.
- Stale transition, claim, runtime, policy, or older-session completion cannot close a newer pending transition.
- Corrupt supported v1 state recovers without touching memory files; warning text contains no raw state.
- Unknown newer schema, unknown v1 keys, and oversize files preserve exact bytes and create no lock/write footprint.
- Invalid version strings, timestamps, IDs, counts, outcomes, claims, and unsafe revisions fail closed.
- In-process child and worker construction/access leave zero filesystem footprint.
- Two real OS-thread roots cannot both own one live claim, lose a transition, or falsely complete after supersession.
- Atomic write and lock fault injection leaves prior bytes authoritative.

### Reflection integration tests

- Root turn receives one logical cue with the full durable-learning taxonomy and exact canonical routing.
- One locked claim-and-attach operation atomically attaches one recognized `version-change` trigger plus provider-hidden exact token and bounded provider metadata without control IDs; same-owner renewal preserves the token and returns `coalesced`, while expiry takeover, exact release, or transition supersession revokes the predecessor before one `replaced-stale` cue revision.
- The same cue ID appears on the first request, tool-loop continuations, and routed retries of one logical request loop, while provider-request count remains unchanged; terminal completion clears the run token and a later unrelated external prompt cannot reuse it.
- First accepted plan commit means consumed/delivered only; preview, discarded plan, stale plan, and commit do not mark reviewed.
- Strict terminal success marks review only on matching non-retry `agent_end`; a direct spy on the completion boundary proves that no `markReviewed`/completion call occurs unless every listed success condition is true. Error, abort, length, runaway stop, empty text, disposal, failover/retry, handled extension error, and `errorMessage` retain pending state.
- Retry requeues the claimed cue; a later success without that cue cannot complete it.
- Internal-context, child, and worker turns receive no version cue and perform no state I/O.
- Each resolved setting/environment kill switch suppresses reconcile, claim, cue, and completion; mid-turn disable only releases the claim.
- Fallback runtime identity and unsupported schema warn once, preserve ordinary root reflection, and never complete version review.
- Existing trigger coalescing, exact-token idempotent coalescing, stale-token replacement after release/expiry/supersession, live different-owner rejection before cue attachment, branch navigation, stale-plan rejection, cue-state backward parsing, transcript non-persistence, and no-extra-provider-request behavior remain intact.

### Canonical-truth negative tests

- Runtime reconciliation has no semantic-writer dependency and never edits `MEMORY.md`, `USER.md`, OKF records, skill files, goal/task state, or pipeline artifacts.
- Cue text routes project semantics to OKF and ICM workflow context to OKF references, never an independent duplicated fact.
- First-observation, runtime movement, and policy movement alone never authorize a semantic write.
- No transcript, raw tool result, real session ID, provider content, or secret-shaped input appears in runtime state, durable cue state, warnings, or provider-visible metadata.

## Release acceptance

The implementation is releasable only when:

1. Grok, Ox Alpha, Claude, and Agy explicitly accept the core invariant after adversarial review.
2. Material dissent is either implemented or rejected with source-backed evidence and reviewer re-review.
3. Focused state/reflection tests, package tests, type checks, repository checks, and build all pass.
4. Documentation and changelog describe the state file, kill switches, canonical routing, compatibility, and recovery.
5. Final commit is pushed through the authorized flow.
6. Canonical release automation publishes the next patch version.
7. Exact-head CI, tag, registry artifact, and installed runtime behavior are verified.
