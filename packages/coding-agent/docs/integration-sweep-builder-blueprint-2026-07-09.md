# Integration Sweep — Builder Blueprint (2026-07-09)

**Purpose.** Finish the host-side integration sweep without changing Pi extensions. The invariant is:
**foreground work stays correct and responsive; all optional/local/background behavior is bounded,
capability-gated, observable, and never leaves an unresolvable artifact or silent mutation.**

This is a handoff specification for an implementation agent. It supersedes the implementation portion
of `packages/coding-agent/docs/integration-sweep-resume-2026-07-09.md`; retain that note as the
historical work log.

## Current handoff state

**Confirmed working-tree state:** all changes are uncommitted. Do not discard unrelated work. In
particular, `packages/coding-agent/docs/bug-ledger.md` predates this sweep and must remain untouched.
Pi extensions are out of scope, including `/home/caudev/__pi/agent/extensions`.

The latest focused run passed 9 test files and 89 tests; the newly added
`test/context-pipeline-artifact-release.test.ts` then passed separately (1 test). The combined final
command below has **not** been run as one command. `npm run check` must be rerun after the final
implementation; it is **not confirmed** for the final handoff state.

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run \
  test/agent-session-local-runtime.test.ts \
  test/runtime-arbiter.test.ts \
  test/model-perf-profile.test.ts \
  test/isolated-child-loop.test.ts \
  test/context-pipeline-local-priority.test.ts \
  test/context-pipeline-token-budget.test.ts \
  test/context-pipeline-artifact-release.test.ts \
  test/brain-curator.test.ts \
  test/run-toolkit-script.test.ts \
  test/suite/agent-session-tool-artifacts.test.ts
```

**Important scope correction:** `packages/coding-agent/src/core/tool-selection/` is an untracked,
incomplete draft created immediately before the task was redirected to planning-only. It is not an
accepted implementation or source of truth. Do not extend or stage it without first reconciling it
against this blueprint; deletion requires the human's approval because it is a worktree change.

## Fixed placement and constraints

- Repository/package: `packages/coding-agent`.
- Language: erasable TypeScript only; top-level imports; no `any`.
- No new third-party dependency.
- Do not run `npm test` or `npm run build`. Run focused Vitest files and then `npm run check`.
- Do not commit, push, publish, alter settings authority, or modify extension files.
- Preserve the existing default tool surface and capability/path gates. Observe-only selection must
  not hide tools, mutate prompts, or execute tools on the model's behalf.

## Work unit 1 — reconcile and finish local-runtime foreground behavior

### Confirmed source baseline

- `OllamaRuntime.detect()` obtains live tags through `_serverModels()` and exposes them as
  `LocalRuntimeStatus.serverModels` (`src/core/models/local-runtime.ts:54-69`, `:370-438`).
- Local readiness checks the configured server's reported model names before accepting it and returns
  `model_missing_on_server` when the requested model is absent
  (`src/core/local-runtime-controller.ts:319-331`).
- Residency admission uses `loadModel: false`, leaving cold loading to the real stream
  (`src/core/local-runtime-controller.ts:189-191`, `:216-218`).
- `RuntimeResidencyArbiter` owns adapter-aware residency planning
  (`src/core/models/runtime-arbiter.ts:24-84`).

### Behavior contract

1. A cold Ollama readiness pass makes one `/api/tags` request for reachability/model presence and one
   `/api/ps` request for residency accounting. It must not issue empty `/api/generate` preloads.
2. After a successful readiness pass, the matching `_confirmedUp` key is the steady-state fast path:
   no readiness HTTP call until a matching local assistant error invalidates it.
3. A manually managed configured server is usable iff it exposes the requested model, including only
   the bare-name/`:latest` equivalence. It retains its own binary/backend/store/cache. A reachable
   server missing the model returns `model_missing_on_server`, never a later opaque provider error.
4. Pi starts a managed server only when the configured endpoint is down and a usable binary exists.
5. Residency identity is `(adapterId, model)`, not just `model`. Identical model names on different
   Ollama URLs or a Transformers runtime must not suppress loads, pins, evictions, or anti-thrash
   checks for each other.
6. Admission can evict according to the existing arbiter plan, but does not synchronously load a cold
   Ollama model. The real adaptive stream owns load/prefill timing.

### Required tests

- Preserve/extend `test/agent-session-local-runtime.test.ts` to count `/api/tags`, `/api/ps`, and
  `/api/generate`; assert the first two exactly once on cold readiness and the third zero times.
- Assert a second healthy request has no readiness HTTP calls.
- Assert configured manual-server acceptance, exact/bare/`:latest` matching, and visible absence.
- Preserve the cross-adapter same-name test in `test/runtime-arbiter.test.ts`.
- Run the focused command in **Current handoff state**.

## Work unit 2 — retain curator work while prioritizing a managed-local foreground

### Confirmed source baseline

`ContextPipeline.maybeDrainBrainCuration()` defers work when both the foreground and curator model
are managed-local and records `curation_deferred_for_local_foreground`
(`src/core/context-pipeline.ts:384-397`). The current regression is
`test/context-pipeline-local-priority.test.ts`.

### Behavior contract

1. If the foreground model and curator model are both managed-local, do not start a curator completion.
2. Deferral retains all queued jobs; it must not mark a job completed or failed.
3. On a later cloud foreground (or absent local foreground), the same queued job drains normally.
4. Cloud foreground plus a local curator remains allowed. Do not introduce a broad CPU-pressure
   heuristic in this slice.

### Required tests

- Assert the initial local/local call does not invoke `runIsolatedCompletion`, leaves `queued: 1`, and
  reports the exact skip reason.
- Change foreground to a cloud model and assert the same queued job drains, with `queued: 0` and
  `jobsRun: 1`.

## Work unit 3 — finish toolkit artifact integration

### Confirmed source baseline

- `run_toolkit_script` packs output with `maxLines: 400` and `maxBytes: 8 * 1024`, retains failure
  header/stdout/stderr, writes `details.artifactId`, and marks failed executions as errors
  (`src/core/tools/run-toolkit-script.ts:135-177`).
- The runtime withholds the artifact store if `artifact_retrieve` is unavailable, including the toolkit
  tool (`src/core/runtime-builder.ts:596-614`).
- Context GC now recognizes `run_toolkit_script` alongside `grep`/`find` when releasing references
  (`src/core/context-pipeline.ts:619-644`).

### Behavior contract

1. Small output remains inline.
2. Oversized output stores exact stdout/stderr/header content in the session artifact store and returns
   only an 8 KiB/400-line preview plus a resolvable `artifact_retrieve` handle.
3. Any active artifact-producing tool (`grep`, `find`, `run_toolkit_script`) auto-activates
   `artifact_retrieve` if registered and allowed. If retrieval is excluded, no artifact handle or
   artifact file may be emitted.
4. Failure state remains visible in the preview and structural details after packing.
5. Context GC releases the toolkit artifact's reference using `details.artifactId`, then only cleans
   it when it has no references.

### Required tests

- Keep `test/run-toolkit-script.test.ts` for full-output preservation and failed scripts.
- Keep `test/suite/agent-session-tool-artifacts.test.ts` for direct active-tool companion activation.
- Keep `test/context-pipeline-artifact-release.test.ts` for toolkit reference release.

## Work unit 4 — add an observe-only expected-utility tool selector

### Purpose and invariant

Improve later tool selection from measured outcomes without adding an LLM judge or taking control
away from the foreground model. The selector records a **redacted observation** only; it does not
change tools, prompt text, arguments, routing, gate decisions, or execution.

### Placement (fixed)

Create or reconcile these host-only files:

- `src/core/tool-selection/expected-utility.ts` — pure scoring/ranking math.
- `src/core/tool-selection/tool-performance-store.ts` — bounded host-local persistence.
- `src/core/tool-selection/tool-selection-controller.ts` — deterministic intent/candidate construction
  and observation lifecycle.
- `src/core/tool-gate-controller.ts` — invoke the controller only after existing router/autonomy/path
  gates allow the actual call; capture final execution outcome.
- `src/core/agent-session.ts` — wire the controller and forward existing tool-repair telemetry.

### Data contract (fixed)

Key statistics by `(host fingerprint, provider/model ref, intent class, tool)`. Intent classes are
`read`, `search`, `execute`, `write`, `retrieve`, `explain`, and `other`; persist only the class, never
prompt text, arguments, paths, tool output, or model reasoning.

For each key retain:

| Field | Rule |
| --- | --- |
| `alpha`, `beta` | Beta posterior for execution success; initial values `1`, `1`; increment alpha on successful execution and beta on failed execution. |
| `latencyEwmaMs`, `latencyDeviationEwmaMs` | Execution-time EWMA and absolute-deviation EWMA; alpha = `0.25`. |
| `inputTokenEstimateEwma`, `outputTokenEstimateEwma` | Optional estimated argument/output-token EWMAs only when text is observable; label them estimates. |
| `repairCount`, `bounceCount`, `failureCount` | Increment from existing validation telemetry and final execution result. |
| `lastUsedAt`, `sampleCount` | Update per execution. |

Use `currentHostFingerprint()` from `src/core/models/fitness-store.ts:14-32`. Store at
`<agentDir>/state/tool-performance.json`; cap statistics at 500 entries and redacted observations at
1,000 per host, pruning oldest by `lastUsedAt`/observation time. Corrupt or unreadable files fail
closed to an empty in-memory store and are overwritten only on the next valid save.

### Candidate and score contract (fixed)

1. Start from the active tool surface. Filter profile-denied and capability-denied tools before scoring.
   Do not guess path arguments: a tool whose path cannot be validated remains unresolved and must not
   become an automatic recommendation. Existing `evaluateToolGate()` remains the execution-time path
   authority (`src/core/tool-gate-controller.ts:45-63`).
2. Add `no_tool` as a real candidate with zero latency/token/risk/context cost and an intent-dependent
   value. It is an observation result, never a command.
3. Use deterministic name/alias/schema-intent matching only. Do not ask another model to judge intent.
4. Normalize cost inputs to `[0, 1]`, then calculate:

   ```text
   U(tool) = Psuccess(tool) * value(tool)
             - lambdaLatency * latencyCost
             - lambdaTokens * tokenCost
             - lambdaRisk * riskCost
             - lambdaContext * contextCost
   ```

   Initial constants: `lambdaLatency=0.15`, `lambdaTokens=0.10`, `lambdaRisk=0.20`,
   `lambdaContext=0.10`, latency scale `5,000 ms`, token scale `1,000` estimated tokens,
   minimum evidence `3`, minimum margin `0.10`, high normalized entropy `0.85`.
5. Recommend only when the best utility is positive, its margin exceeds `0.10`, and it has at least
   three samples or a deterministic match. High entropy or a sub-margin tie emits a top-three
   shortlist. Otherwise abstain.
6. Record comparison between recommendation/shortlist/abstention and the actual first tool outcome.
   The observation is diagnostics only; no hint is injected in this slice.

### Required tests

- Pure math: posterior, normalization, positive-best, tie/entropy shortlist, evidence threshold,
  deterministic override, and `no_tool`.
- Store: host separation, bounded pruning, corrupt-file recovery, EWMA/deviation updates, validation
  counter updates, and redaction (stored observations contain no prompt/args/output fields).
- Controller/gate: only gate-approved calls are observed; successful/failed calls update outcomes;
  repaired/bounced telemetry updates counters; selector never changes a gate result or active tool list.
- Metrics: first-tool success, wrong-tool/failure count, recommendation match rate, shortlist count,
  abstention count, and latency/token summaries are computable from the store.

## Work unit 5 — make worker mutation semantics explicit: review-after-apply

### Fixed decision

The shipped contract is **review-after-apply**, not staged apply. Do not silently remove the intentional
write lane or claim that mutation waits for parent review.

### Confirmed source baseline

- Structured actions are path-scoped and applied before final worker-result validation
  (`src/core/delegation/worker-actions.ts:98-136`,
  `src/core/delegation/worker-runner.ts:265-300`).
- A changed completed result receives `parent_review_required` after scope validation
  (`src/core/delegation/worker-result.ts:113-177`).
- The background controller grants writes only for explicit enabled/path-scoped settings, filters
  permitted actions, and records direct write/edit targets after a gate-approved call
  (`src/core/background-lane-controller.ts:639-724`, `:740-786`).

### Behavior contract

1. Direct write/edit tools may mutate after their normal path/capability gate authorizes them.
2. Structured actions may mutate through `applyWorkerActions()` only after envelope/path validation.
3. Parent review occurs after mutation. It must receive `changedFiles`, blockers, usage report id, and
   a `parent_review_required` acceptance outcome for an in-scope changed result.
4. An out-of-scope/denied structured action is refused before filesystem mutation. A blocked direct
   tool call must not reach the execution hook.
5. Partial action application returns `blocked`, includes changed files and failure/refusal blockers,
   and never appears as clean success.
6. Preserve symlink-aware path enforcement, disposal handling, terminal lane records, and spawned
   usage reporting.

### Required tests and docs

- Add/retain tests for in-scope write then parent review, denied/out-of-scope action with no file
  mutation, partial apply with changed-file accounting, and direct blocked write that never mutates.
- Document the exact review-after-apply contract in the operator/delegation documentation. Do not use
  ambiguous wording such as “staged” or “reviewed before apply.”

## Work unit 6 — verify generic external memory/graph compatibility

### Confirmed source baseline

- The public context-memory contract exposes generic capability flags including `graph`
  (`src/core/context/memory-provider-contract.ts:26-90`).
- Retrieval uses generic providers/policies and converts search results to source-labeled context items
  (`src/core/context/memory-retrieval.ts:88-139`,
  `src/core/context/memory-provider-contract.ts:239-277`).
- Extension-contributed legacy and context providers have separate pending lists, snapshot/restore, and
  fresh reinitialization (`src/core/memory-controller.ts:436-467`, `:473-509`).
- Active providers contribute dynamic context-GC markers through `MemoryManager.getContextMarkers()`
  (`src/core/memory/memory-manager.ts:244-260`); `ContextPipeline` merges them with configured markers
  before calling GC (`src/core/context-pipeline.ts:551-568`).

### Behavior contract

1. Keep both `registerMemoryProvider` and `registerContextMemoryProvider` contributions through a
   successful atomic reload. A failed reload restores the previous generation; do not add brand-specific
   retention logic.
2. A faux `graph: true` context provider is treated as an ordinary provider: policy-gated, source
   labeled, converted to context evidence, and framed as untrusted evidence before prompt inclusion.
3. Graph/context results enter only when the existing long-term-memory demand gate opens. Do not force
   graph pages into every prompt.
4. Provider markers join semantic-GC markers dynamically and deduplicate; no Graphify import, path,
   name, or private API belongs in host source.

### Required tests

- Add host-only faux-provider tests; never import Graphify.
- Reload test: register one provider of each public kind, reload successfully, assert both remain;
  inject a reload failure and assert snapshot restoration preserves the old generation.
- Retrieval test: `graph: true`, `source: "external_provider"`, allowed policy, and a demand-opening
  prompt produce a labeled, untrusted context item within budget. The same provider is absent when the
  demand gate is closed.
- Marker test: a dynamic provider marker causes the semantic-GC scan to recognize the page; duplicates
  are removed.

## Documentation and final review

After implementation, update only verified stale claims in:

- `packages/coding-agent/docs/model-router-rework.md`
- `packages/coding-agent/docs/model-router-rework/current-state.md`
- `packages/coding-agent/docs/model-router-rework/local-model-lifecycle-design.md`
- `packages/coding-agent/docs/context-management-rework/tool-output-artifacts.md`
- `packages/coding-agent/docs/integration-sweep-resume-2026-07-09.md`

State confidence explicitly. Do not claim the tool selector influences prompts or execution until an
independent replay validates that later phase. Add a dated, source-cited finding to `AGENTS.md` only
for a sharp, durable behavior discovered during implementation.

## Final acceptance command

```bash
cd /home/caudev/GitHub/mine/pi-adaptative

git status --short

cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run \
  test/agent-session-local-runtime.test.ts \
  test/runtime-arbiter.test.ts \
  test/model-perf-profile.test.ts \
  test/isolated-child-loop.test.ts \
  test/context-pipeline-local-priority.test.ts \
  test/context-pipeline-token-budget.test.ts \
  test/context-pipeline-artifact-release.test.ts \
  test/brain-curator.test.ts \
  test/run-toolkit-script.test.ts \
  test/suite/agent-session-tool-artifacts.test.ts \
  test/tool-selection-expected-utility.test.ts \
  test/tool-performance-store.test.ts \
  test/tool-selection-controller.test.ts

cd /home/caudev/GitHub/mine/pi-adaptative
npm run check
```

Fix every error, warning, and info. Do not run the full Vitest suite, `npm test`, or `npm run build`.
Do not commit.

## Explicitly out of scope

- Pi extension changes, Graphify imports, or provider-private dependencies.
- Prompt hints, automatic tool execution, hidden tools, or routing changes from the new selector.
- A staged worker-write redesign, background CPU scheduling heuristics, or changes to manual Ollama
  server ownership/backends.
- Package installation, lockfile changes, releases, commits, pushes, and destructive cleanup of the
  current worktree.

## Review gate

Return the implementation for adversarial review. The reviewer must inspect: local cold-path HTTP
counts; cross-runtime residency identity; artifact-handle resolvability and cleanup; selector redaction,
non-interference, and bounded persistence; worker mutation timing/scope; and provider reload rollback.
The implementer’s reported test result is not sufficient—run the acceptance command independently.

## Scope confidence

**Confirmed:** source references cited above and the 89-test focused run recorded in this handoff.
**Not checked:** final TypeScript/lint/browser-smoke state after the eventual implementation, live Ollama
behavior on this host, and any private external provider/Graphify implementation.
