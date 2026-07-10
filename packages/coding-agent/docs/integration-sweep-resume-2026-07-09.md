# Integration Sweep Resume Note — 2026-07-09

Status: paused by user after a second work slice; implementation is intentionally uncommitted and
ready to resume. The latest slice has not yet been re-tested.

## Scope

Synchronize and simplify these host subsystems while prioritizing foreground performance and
accuracy:

- toolkit store and deterministic toolkit routing;
- shared tool repair and isolated child loops;
- local-model lifecycle, routing, residency, and background lanes;
- memory and file-backed tool-output artifacts;
- worker/subagent contracts and accounting;
- generic external memory-provider compatibility.

Do not modify Pi extensions. In particular, no files under
`/home/caudev/__pi/agent/extensions` were changed. Graphify was inspected only as an external
consumer of the host's generic tool and context-memory-provider contracts.

## Design decisions

1. Foreground first: optional local curation/background work must not compete with a local user
   turn.
2. One model-call gateway: foreground, routed, and isolated calls must share managed-local
   readiness, repair telemetry, timeout behavior, and accounting.
3. Reuse a configured healthy Ollama server when it exposes the requested model. Server/store
   ownership is not a capability boundary.
4. Residency admission must not synchronously cold-load Ollama with an empty generation. The real
   adaptive stream owns cold load and prefill timing.
5. Preserve exact oversized tool output in retrievable artifacts; send bounded previews to models.
6. Use compact structured model-to-model contracts. Do not use Unicode/Braille as compression;
   measure tokenizer cost instead.
7. Future automatic tool selection should use constrained expected utility, not another free-form
   judge:

   `utility = success_probability * value - latency_cost - token_cost - risk_cost - context_cost`

   Hard capability/path/profile gates run first; ambiguous rankings return a shortlist or defer to
   the foreground model.

## Implemented in the working tree

### Local model reliability and performance

- `ReflectionController.runIsolatedCompletion` now calls a shared managed-local readiness gate, so
  research, workers, route judges, curation, reflex interpretation, fitness probes, and other
  isolated calls no longer bypass local runtime startup.
- Manual/default local foreground models now receive readiness handling even when the model router
  is disabled.
- A healthy configured Ollama server is reused when `/api/tags` contains the requested model,
  regardless of whether its store is Pi-owned, user-owned, or externally managed.
- Ollama detection now carries the live server's model list in `LocalRuntimeStatus`, so the initial
  readiness pass uses one `/api/tags` request instead of detecting and listing separately.
- A running server missing the requested model fails visibly instead of being used incorrectly.
- Runtime residency adapters are collected into one session-wide view instead of constructing an
  arbiter that sees only the current runtime.
- Residency supports admission/eviction without loading the model. The local controller uses this
  mode to avoid a blocking empty `/api/generate` with a 60-second timeout before the real request.
- Already-resident models no longer receive redundant activation calls from the arbiter.
- Local curator draining is deferred while both the foreground and curator models are managed-local,
  preventing a fire-and-forget curator from taking a single-parallel Ollama slot before the user
  request.
- A focused local-priority regression test was added but has not yet been run.

### Tool repair

- Isolated child tool loops now forward `onToolArgumentValidation` and
  `onToolValidationEscalation`, so their deterministic repairs and repeated validation failures use
  the same telemetry/adaptation path as foreground calls.

### Toolkit output artifacts

- `run_toolkit_script` now stores exact oversized stdout/stderr in the session artifact store and
  returns an 8 KiB/400-line bounded preview plus an `artifact_retrieve` handle.
- Exit status and failure text remain in the preview; toolkit output is marked non-reproducible.

## Live diagnosis captured

- The active Pi config is under `~/.pi/agent`.
- Its Ollama provider targets `http://localhost:11434/v1` and registers local qwen/MiniCPM models.
- The model router was disabled at inspection time, but local cheap/executor models remained
  configured.
- No Ollama server was running during inspection and no Linux Ollama binary was found in PATH or the
  Pi runtime directory.
- Another local configuration under `~/__pi/agent` targets a manually served Windows/WSL endpoint.
- The prior host policy rejected non-Pi-owned running stores and synchronously preloaded models;
  these were concrete causes of manual-server performance being better and local use failing.

## Focused validation completed

From `packages/coding-agent`:

```bash
node ../../node_modules/vitest/dist/cli.js --run \
  test/run-toolkit-script.test.ts \
  test/isolated-child-loop.test.ts \
  test/agent-session-local-runtime.test.ts \
  test/runtime-arbiter.test.ts \
  test/brain-curator.test.ts \
  test/context-pipeline-token-budget.test.ts
```

Result: 6 files passed, 65 tests passed.

Earlier focused run also passed the existing local runtime and isolated child tests after the
readiness changes.

`npm run check` has not been run yet because the user paused the sweep before final validation.

Important: after that 65-test green run, the second slice changed `LocalRuntimeStatus` to include
`serverModels` and added `context-pipeline-local-priority.test.ts`. Those latest changes have not yet
been compiled or tested.

## Files changed by this sweep

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/context-pipeline.ts`
- `packages/coding-agent/src/core/local-runtime-controller.ts`
- `packages/coding-agent/src/core/models/runtime-arbiter.ts`
- `packages/coding-agent/src/core/reflection-controller.ts`
- `packages/coding-agent/src/core/runtime-builder.ts`
- `packages/coding-agent/src/core/tools/run-toolkit-script.ts`
- `packages/coding-agent/test/agent-session-local-runtime.test.ts`
- `packages/coding-agent/test/context-pipeline-token-budget.test.ts`
- `packages/coding-agent/test/context-pipeline-local-priority.test.ts`
- `packages/coding-agent/test/isolated-child-loop.test.ts`
- `packages/coding-agent/test/run-toolkit-script.test.ts`
- `packages/coding-agent/test/runtime-arbiter.test.ts`
- this resume note.

`packages/coding-agent/docs/bug-ledger.md` was already modified before this sweep and was not edited
as part of this work.

## Remaining work: exact execution plan

### 1. Stabilize the latest local-runtime changes

Files:

- `src/core/models/local-runtime.ts`
- `src/core/local-runtime-controller.ts`
- `src/core/models/runtime-arbiter.ts`
- `test/agent-session-local-runtime.test.ts`
- `test/runtime-arbiter.test.ts`

How:

1. Compile/run the focused tests first. `LocalRuntimeStatus.serverModels` is newly required, so faux
   status literals in other tests may need `serverModels: []`.
2. Check that one cold readiness pass performs:
   - one `/api/tags` request for reachability plus requested-model presence;
   - one `/api/ps` request for residency accounting;
   - no empty `/api/generate` preload;
   - then the real OpenAI-compatible stream, whose adaptive local connect bound owns cold load and
     prefill.
3. Keep `_confirmedUp` as the steady-state fast path: subsequent successful turns should perform no
   readiness HTTP requests until a matching local assistant error invalidates the key.
4. Verify a manually managed server is accepted only when it exposes the exact requested model or
   the bare/`:latest` equivalent. A reachable server without the model must return
   `model_missing_on_server`, not proceed and fail later.
5. Review session-wide residency adapter identities for multiple Ollama URLs and Transformers
   models. They must not collide.

Expected:

- Manually started Ollama keeps its own binary, GPU/backend configuration, model store, and warm
  cache.
- Pi starts its managed server only when the configured endpoint is down and a usable binary exists.
- No duplicate server is started against an already reachable configured endpoint.
- Local route, manual model, judge, research, worker, curation, reflex, and fitness calls all pass
  through readiness.
- Foreground failure remains visible and router fallback remains bounded/explicit.

Acceptance tests:

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run \
  test/agent-session-local-runtime.test.ts \
  test/runtime-arbiter.test.ts \
  test/model-perf-profile.test.ts \
  test/isolated-child-loop.test.ts
```

### 2. Finish foreground-priority behavior

Files:

- `src/core/context-pipeline.ts`
- `test/context-pipeline-local-priority.test.ts`
- optionally `test/brain-curator.test.ts` if a session-level regression is clearer.

How:

1. Run the newly added local-priority test and correct type/faux-dependency issues.
2. Keep queued curator work intact when both foreground and curator are managed-local.
3. Add a second assertion or test proving the same queued job can drain later when the foreground is
   a cloud model or no local foreground is active. Do not drop or mark the job completed on defer.
4. Keep the visible reason code `curation_deferred_for_local_foreground` in diagnostics.

Expected:

- Optional curation never takes a single-parallel local server slot before a user request.
- Deferral loses no work; curation can run on a later non-competing turn.
- Cloud foreground plus local curator remains allowed unless profiling later shows host CPU pressure.

### 3. Complete toolkit/artifact integration

Files:

- `src/core/tools/run-toolkit-script.ts`
- `src/core/runtime-builder.ts`
- `test/run-toolkit-script.test.ts`

How:

1. Re-run the artifact regression.
2. Confirm the active-tool companion rule always activates `artifact_retrieve` when
   `run_toolkit_script` can emit an artifact. The current runtime only auto-adds the companion for
   `grep`/`find`; either extend that condition to toolkit or suppress the artifact store when the
   retrieval tool is not active. Never emit an unresolvable handle.
3. Keep the preview bounded at 8 KiB/400 lines unless measurement supports a smaller cap.
4. Preserve exit code, timeout state, first failure text, stdout/stderr labels, and exact full output
   in the artifact.
5. Verify context-GC reference release recognizes toolkit `details.artifactId` exactly as it does for
   grep/find.

Expected:

- Small script output stays directly readable.
- Large output never bloats prompt context and is never lost.
- Every emitted artifact handle is resolvable in the same active tool surface.
- Failed scripts remain unmistakably failed even when output is packed.

### 4. Tool-selection policy: observe first

Do not add an orphan policy module. Integrate only when its inputs and output have live owners.

Suggested files:

- new `src/core/tool-selection/expected-utility.ts` for pure math;
- new `src/core/tool-selection/tool-performance-store.ts` for bounded host/model/tool statistics;
- `src/core/tool-gate-controller.ts` for execution outcomes/timing;
- `src/core/system-prompt-builder.ts` or a dedicated pre-turn controller for a compact recommendation;
- focused tests under `test/tool-selection-*.test.ts`.

How:

1. Candidate generation uses only active, profile-allowed, capability-compatible tools.
2. Hard gates run before scoring: denied tool/path/capability never becomes a candidate.
3. Maintain per `(host, model ref, intent class, tool)` bounded statistics:
   - Beta posterior `alpha/beta` for success probability;
   - latency EWMA and bounded deviation;
   - prompt/output-token EWMA where observable;
   - repair/bounce/failure counts;
   - last-used timestamp and sample count.
4. Score candidates with normalized units:

   `U(t) = Psuccess(t) * value(t) - λL*latency(t) - λT*tokens(t) - λR*risk(t) - λC*context(t)`

5. Include `no_tool` as a real candidate with zero cost and an intent-dependent value.
6. Recommend a tool only when:
   - best utility is positive;
   - best-minus-runner-up exceeds a configured margin;
   - minimum evidence exists, or the match is deterministic name/alias/schema intent.
7. Compute normalized entropy over candidate probabilities. High entropy produces a shortlist; it
   never executes automatically.
8. First production slice is observe-only: persist/redact rankings and compare recommendation to the
   model's actual choice. Do not hide tools or execute on the model's behalf.
9. Promote to a concise prompt hint only after offline replay shows higher first-tool success and no
   increase in unsafe/wrong-tool calls.

Expected:

- Exact toolkit/name hits remain deterministic and model-call-free.
- Repeated host/model workflows improve from observed outcomes.
- Ambiguity remains conservative.
- The selector reduces wrong first tools, retries, latency, and context cost without becoming another
  prompt-heavy router.

Acceptance metrics:

- first-tool success rate;
- wrong-tool/refusal rate;
- p50/p95 time to first useful tool result;
- tool-related input/output tokens;
- repair and validation-bounce rate;
- shortlist/abstention calibration;
- no regression in capability/path gate enforcement.

### 5. Worker semantics

Files:

- `src/core/delegation/worker-runner.ts`
- `src/core/background-lane-controller.ts`
- `src/core/delegation/worker-result.ts`
- worker delegation tests.

Current fact: direct write/edit tools and structured actions may mutate inside the capability
envelope before `validateWorkerResult` returns `parent_review_required`.

How:

1. Do not silently remove the intentional write lane.
2. Choose and document one explicit contract:
   - review-after-apply: envelope authorization permits mutation; parent reviews/validates afterward;
   - staged apply: worker returns structured actions/patches, parent gate accepts, then runner applies.
3. If staged apply is selected, direct write/edit tools must also target a staging layer; otherwise
   only structured actions are truly staged.
4. Preserve symlink-aware path enforcement, changed-file accounting on partial failure, blockers, and
   spawned usage under either contract.

Expected:

- User and parent can tell whether review is pre- or post-mutation.
- A blocked/out-of-scope action never mutates.
- Partial mutations never look like clean success.

### 6. External memory and Graphify compatibility

Host files only. Do not modify Pi extensions.

How:

1. Verify extension registration/reload keeps both `registerMemoryProvider` and
   `registerContextMemoryProvider` contributions across atomic reloads.
2. Add/retain host tests using faux graph-capable context providers (`graph: true`) rather than
   importing private Graphify code.
3. Confirm generic graph results are budgeted, source-labeled, wrapped as untrusted evidence, and
   included only when the long-term-memory demand gate opens.
4. Confirm dynamic provider GC markers join context-GC markers without brand-specific host logic.

Expected:

- The host is fully ready for Graphify or any graph provider through public contracts.
- Private providers remain optional and can disappear/reload without breaking the session.
- No private brand or path becomes a package dependency.

### 7. Documentation and final validation

Update these stale planning snapshots after behavior is final:

- `docs/model-router-rework.md`
- `docs/model-router-rework/current-state.md`
- `docs/model-router-rework/local-model-lifecycle-design.md`
- `docs/context-management-rework/tool-output-artifacts.md`
- this note: change status to completed and record final test/check results.

Document:

- three-tier router and judge are implemented;
- autonomy/delegation/research directories exist;
- managed-local readiness covers every call path;
- configured manual Ollama servers are preferred when valid;
- residency admission is non-blocking;
- local foreground has priority over optional local sidecars;
- artifact coverage is grep/find/toolkit, plus any additional tools actually completed;
- worker mutation semantics exactly as implemented.

Final commands:

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
  test/brain-curator.test.ts \
  test/run-toolkit-script.test.ts

cd /home/caudev/GitHub/mine/pi-adaptative
npm run check
```

Fix every error, warning, and info from `npm run check`. Do not use `tail`. Do not run `npm test` or
`npm run build` unless requested. Do not commit unless requested.

## Resume command

Start at the repository root and inspect only; do not discard other-session changes:

```bash
git status --short
git diff -- \
  packages/coding-agent/src/core/agent-session.ts \
  packages/coding-agent/src/core/context-pipeline.ts \
  packages/coding-agent/src/core/local-runtime-controller.ts \
  packages/coding-agent/src/core/models/runtime-arbiter.ts \
  packages/coding-agent/src/core/reflection-controller.ts \
  packages/coding-agent/src/core/runtime-builder.ts \
  packages/coding-agent/src/core/tools/run-toolkit-script.ts \
  packages/coding-agent/test/agent-session-local-runtime.test.ts \
  packages/coding-agent/test/context-pipeline-token-budget.test.ts \
  packages/coding-agent/test/context-pipeline-local-priority.test.ts \
  packages/coding-agent/test/isolated-child-loop.test.ts \
  packages/coding-agent/test/run-toolkit-script.test.ts \
  packages/coding-agent/test/runtime-arbiter.test.ts
```
