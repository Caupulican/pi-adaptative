# Handoff: Teach-Then-Gate Tool Failure Recovery

## Objective

Finish the fix so an agent:

1. Receives diagnostic and recovery guidance after a tool failure.
2. Cannot immediately re-execute the same deterministic failing operation unchanged.
3. May execute materially changed arguments.
4. May perform one unchanged retry only when policy explicitly allows it, currently timeout failures.
5. May retry the original operation after a successful recovery action.

Do not commit, push, tag, release, publish, install dependencies, or modify unrelated files.

## Repository

```text
/home/caudev/GitHub/mine/pi-adaptative
branch: main
```

Last observed worktree:

```text
 M packages/agent/src/tool-failure-memory.ts
 M packages/agent/test/runaway-loop.test.ts
 M packages/ai/src/utils/tool-repair/registry.ts
 M packages/ai/test/tool-execution-error-catalogue.test.ts
```

`packages/agent/src/agent-loop.ts` is still untouched and is the missing integration.

## Confirmed Root Cause

Tool recovery currently teaches through `<harness_tool_failures>`, but this is advisory only.

`packages/agent/src/agent-loop.ts`:

- Executes the generated tool call.
- Records failure memory only after execution.
- Never checks unresolved failure memory before calling `tool.execute`.
- Stops repeated calls only through the runaway guard, after repeated execution.
- Defaults to 12 repeated signatures.

Thus deterministic failed calls can execute repeatedly even though the prompt says not to repeat them.

## Existing Partial Changes

### `packages/ai/src/utils/tool-repair/registry.ts`

Added:

- `unchangedRetryLimit?: number` to execution-error catalogue entries.
- `unchangedRetryLimit` to `ToolExecutionErrorPolicy`.
- `timedOut.unchangedRetryLimit = 1`.
- `getToolExecutionUnchangedRetryLimit(failureCode)`.

All unclassified and deterministic failures default to zero unchanged retries.

### `packages/ai/test/tool-execution-error-catalogue.test.ts`

Added assertions that:

- `timeout` permits one unchanged retry.
- `file_not_found` permits zero.
- Unknown failures permit zero.

Exact policy-object assertions were updated for the new field.

### `packages/agent/src/tool-failure-memory.ts`

Added:

```ts
getUnresolvedToolFailure(tracker, tool, args)
```

This uses the existing canonical operation identity, including sorted argument keys.

Added:

```ts
createRepeatedToolFailureResult(record)
```

This returns structured failure evidence with:

```text
failure_code: repeated_failed_operation
```

It preserves the original diagnostic and next action while stating that the unchanged operation was not executed.

### `packages/agent/test/runaway-loop.test.ts`

The regression now requires:

- Deterministic identical calls with reordered argument keys execute only once.
- Subsequent identical calls return `repeated_failed_operation`.
- The runaway detector can still stop a model that ignores the blocked result.
- An `ETIMEDOUT` operation gets one unchanged retry and succeeds on execution two.
- A materially changed operation remains executable.

Current red diagnostic:

```text
expected executions: 1
received executions: 3
```

This is expected until `agent-loop.ts` is wired.

## Required Implementation

Edit `packages/agent/src/agent-loop.ts`.

### 1. Add imports

From `@caupulican/pi-ai/tool-repair-registry`:

```ts
getToolExecutionUnchangedRetryLimit
```

From `./tool-failure-memory.ts`:

```ts
createRepeatedToolFailureResult
getUnresolvedToolFailure
type ToolFailureMemoryRecord
```

### 2. Create run-scoped gate state

Inside `runLoop`, alongside `toolFailureMemory`, create:

```ts
const toolFailureExecutionGate = new Map<string, number>();
```

This state must not persist beyond the current agent run. Historical failure memory remains prompt evidence, but each owner-initiated run may attempt recovery again.

Thread it through:

- `executeToolCalls`
- `executeToolCallsSequential`
- `executeToolCallsParallel`
- The tool preparation/admission path

### 3. Gate at the execution boundary

Check after arguments have been repaired, validated, and canonicalized, but before:

- `beforeToolCall` if that hook may prompt or mutate external state;
- `tool.execute`.

For an unresolved record:

```ts
const allowedExecutions = 1 + getToolExecutionUnchangedRetryLimit(record.failureCode);
```

Semantics:

- First deterministic failure records execution count `1`.
- Next identical deterministic call is blocked without execution.
- Timeout failure records `1`; one identical retry is allowed, reserving count `2`.
- Further identical timeout calls are blocked.
- Different arguments produce a different failure key and remain allowed.

A blocked call must still return a normal `toolResult` paired with its `toolCall`, using:

```ts
createRepeatedToolFailureResult(record)
```

Do not break provider tool-call/result protocol.

### 4. Record execution outcomes

After actual tool execution:

- Failure: initialize or reserve the operation count if absent.
- Success of the same operation: existing `clearToolFailure` remains authoritative.
- Any successful recovery operation should clear the run-scoped gate counts, allowing a previously failed operation to be tried again after demonstrable progress.

Do not clear persistent failure records for unrelated operations; only reopen their run-scoped execution opportunity.

### 5. Handle parallel calls deterministically

Do not let two parallel identical retries consume more than the policy allows.

Reserve an allowed execution before launching it. Apply final outcome accounting in assistant call order rather than promise-completion order where practical.

## Validation

Run focused tests only:

```bash
./test.sh packages/agent/test/runaway-loop.test.ts
./test.sh packages/ai/test/tool-execution-error-catalogue.test.ts
```

For verbose diagnostics from repository root:

```bash
node node_modules/vitest/dist/cli.js \
  --run packages/agent/test/runaway-loop.test.ts \
  --reporter=verbose
```

Then run the mandatory repository check:

```bash
npm run check
```

Inspect full output. Fix every error, warning, and info.

Do not run `npm test`, `npm run build`, or the full Vitest suite.

## Changelog

Read the current `[Unreleased]` sections first.

Add concise entries under:

- `packages/agent/CHANGELOG.md`: fixed repeated deterministic failures executing despite recovery guidance.
- `packages/ai/CHANGELOG.md`: added machine-readable bounded unchanged-retry policy if considered public or operator-relevant.

Do not alter released sections.

## Acceptance Criteria

- Deterministic unchanged failed operation executes exactly once per recovery window.
- Reordered object keys cannot bypass the gate.
- Blocked calls return `repeated_failed_operation`.
- Timeout receives at most one unchanged retry.
- Changed arguments remain executable.
- Successful recovery action reopens the original operation.
- No dangling `toolCall`/`toolResult` pairs.
- Both focused tests pass.
- `npm run check` passes fully.
- Worktree contains only the intended files.
- No commit or publication is performed.

## Separate Review Findings Still Open

The original artifact is:

```text
/home/caudev/.gemini/antigravity-cli/brain/77916452-41b4-4f03-a84b-087bb5d3d6ae/handoff_spec.md
```

Material inaccuracies already confirmed:

1. `fastTextSignature` can falsely deduplicate different payloads with equal length and identical first and last 48 characters.
2. The document says the sampled signature applies at 64 characters; implementation samples only above 128, though dedup registration starts at 64.
3. The `44 ms` benchmark is not an assertion; the current gate permits 75 ms.
4. A two-size, one-sample ratio does not prove O(N).
5. The disk-integrity test checks in-memory object mutation, not disk state.
6. The GC test normally runs without exposed `globalThis.gc`.
7. The history test uses an in-memory session and exercises neither cold payloads nor Windows paths.
8. `v0.86.14` points to commit `3e014fbd9`; the original handoff incorrectly names its parent `a70e39965` as the release commit.
9. npm publication is confirmed.
10. GitHub Actions run `31340656641` remains unverified because the private API returned 404 and no owner credential profile is configured.
