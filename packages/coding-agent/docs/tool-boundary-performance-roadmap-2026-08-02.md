# Tool Boundary Performance Roadmap — 2026-08-02

This is the evidence ledger for avoiding wasted model output, repeated large-string work, foreground stalls,
and cross-session contention at tool boundaries. Findings are classified as fixed, open, rejected, or
incomplete. A green process exit is not evidence when a relevant payload, race, platform, or memory probe was
not exercised.

## Required invariants

1. Validate cheap authority, path, identity, availability, and collision facts at the earliest harness-owned
   execution boundary, before payload processing or mutation. Never make the model coordinate preparation, and
   recheck mutable facts inside the serialized mutation boundary immediately before the write.
2. Keep coordinators, payload handles, mutable queues, and retry state session-owned unless cross-session
   coordination is the explicit invariant.
3. Store large bytes once, outside the JavaScript heap where practical. Context and telemetry retain bounded
   metadata and opaque handles, not duplicate payloads.
4. Never flatten accumulated text repeatedly. Rendering, loop detection, failure handling, and telemetry use
   incremental processing or constant-size fingerprints.
5. A failure that requires a different approach discards its operation arguments. It may expose one bounded
   reason/directive for the next model turn, then expires.
6. Every visible tool operation reports elapsed time through the shared TUI timing owner.

## Confirmed and fixed in this cycle

| Boundary | Root cause | Fix | Evidence gate |
| --- | --- | --- | --- |
| Write collision | `write` accepted the full content before discovering an occupied destination and could overwrite it. | One semantic model call; the harness preflights collision and parent access, rechecks inside the path queue, and finishes with atomic no-clobber creation. When the generated payload is valid and only the name collides, its exact bytes move to a bounded session cache so repair supplies only a corrected path and opaque reference. | `test/file-mutation-preflight.test.ts`; `test/file-encoding-policy.test.ts`; `test/phone-filesystem-workflow.test.ts` |
| Missing/stale edit | `edit` accepted replacement payloads before existence checks and could apply a plan prepared against older bytes. | One semantic model call; the harness snapshots path identity, rechecks after queue admission and immediately before writing, and rejects missing or changed targets. Valid edits paired with only a missing/non-file path receive the same bounded retarget treatment and are fully revalidated against each corrected candidate. | `test/file-mutation-preflight.test.ts`; `test/file-mutation-queue.test.ts`; `test/phone-filesystem-workflow.test.ts` |
| Repeated exact content | Copying identical generated content to another destination required retransmitting it. | Successful writes/edits return a session-local `contentRef`; the bounded controller hashes the source and performs exclusive verified copies without retaining bytes on the JS heap. | `test/file-mutation-preflight.test.ts` |
| Encoding corruption | An unsafe text edit could be remembered as a retryable operation and teach repair/re-read loops. | The central execution-error catalogue classifies `PI_FILE_ENCODING_CORRUPTION` as change-approach, retains no operation arguments, exposes one bounded directive, and expires it after the next assistant response. | `packages/ai/test/tool-execution-error-catalogue.test.ts`; `packages/agent/test/tool-failure-memory.test.ts` |
| Edit preview flattening | Preview rendering used `JSON.stringify({ path, edits })` during render and result settlement, copying the complete edit payload. | Constant-size request generations fence asynchronous previews; partial renders do not scan accumulated edits. | `test/edit-tool-no-full-redraw.test.ts` |
| Write preview flattening | Collapsed streamed previews compared the complete prior content prefix, split and highlighted complete snapshots, and retained duplicate full line arrays. | Collapsed rendering inspects at most 8,192 characters, caches by argument-generation identity, and performs one allocation-free final line count; complete text is materialized only on explicit expansion. | `test/tool-execution-component.test.ts` |
| Loop/failure payload retention | Stall and failure signatures serialized complete tool arguments and stored the normalized string in the loop window. | A streaming structural fingerprint returns 32 hex characters; failure display keeps a bounded structural preview and never serializes the original payload. | `packages/agent/test/tool-failure-memory.test.ts` |
| Tool timing gaps | Only selected tool implementations exposed duration, so reads and Python appeared to have no timing. | One monotonic component displays live `Elapsed` and terminal `Took` timing for every tool surface, including failures, replayed panels, built-ins, and extensions. | `test/tool-execution-component.test.ts` |

All fixed paths must retain the zero-clone production gate and the focused regression named above.

## P0 — confirmed open work

### P0.1 Persistent Python coordinator per session

Evidence:

- `src/core/tools/python.ts` creates `createLocalPythonOperations()` per tool definition and calls
  `spawnProcess()` for every execution.
- `src/core/python-runtime.ts` caches interpreter discovery process-wide, but it is not a command coordinator.
- `src/core/tools/python.ts` wraps every job in `withExclusiveMutationBarrier()`.
- `src/core/tools/file-mutation-queue.ts` owns one module-global writer queue, so a long Python job can block
  unrelated sessions and workspaces.

Required design:

- RuntimeBuilder owns one `PythonCommandCoordinator` per agent session. Never share the command process across
  sessions or tenants.
- Start the interpreter/worker once on first use, use framed requests and terminal acknowledgements, and reset
  the owned process after protocol corruption, timeout, abort, or crash.
- Completion is event-driven and emits the normal terminal tool signal. Jobs handed to the existing background
  lane after 15 seconds keep the same session coordinator and notify their owning session only.
- Replace the process-global exclusive writer with an explicit session/workspace mutation port. Same-file
  operations remain serialized; unrelated sessions are not globally stopped.

Acceptance evidence:

- Cold start and first dispatch measured separately from warm dispatch on Linux and Windows.
- Warm no-op harness overhead target: p95 <= 25 ms, excluding Python code runtime.
- Two concurrent sessions prove distinct worker PIDs/state and no cross-session variables.
- A 20-second Python job does not delay a read-only call or a mutation in another isolated workspace.
- Timeout, abort, malformed frame, worker exit, and session disposal each produce one terminal event and bounded
  handoff.

### P0.2 Python path/runtime preflight before inline code

Evidence: `python` receives up to 200,000 characters of inline code before it checks `cwd`, `scriptPath`, uv, or
the interpreter. An invalid working directory can therefore waste the entire generated program.

Required design:

- Keep one semantic model call. The harness owns cwd/runtime preflight at the start of execution and performs no
  code evaluation or process creation until it passes.
- Runtime failure or coordinator reset invalidates any internal lease; code is not stored as retry memory and
  no preparation token is exposed to the model.
- If a provider exposes a complete path before the remaining arguments, speculative streaming preflight may
  warm the same authority check, but final execution remains authoritative and provider-neutral.

Acceptance evidence: invalid cwd/runtime tests prove that no `code` field was accepted; stale and cross-session
intents fail; successful warm preparation meets the same p95 budget as P0.1.

### P0.3 Process-isolate extension smoke tests

Evidence: `src/core/tools/extensionify.ts` writes the complete draft and calls `loadExtension()` in the live Pi
process. The “isolated runtime” isolates registration state, not CPU, environment, memory, filesystem, or process
lifetime. A draft can block the event loop or inspect live process state.

Required design:

- Validate name, proposed destination, package JSON shape, size bounds, and policy before accepting factory code.
- Run the draft in a disposable child process with a bounded environment, output, time, memory, and capability
  surface. Send back registration metadata only.
- The child emits one terminal result; cleanup is lease-owned and event-driven.
- Do not repeat `code`/`packageJson` in tool result details.

Acceptance evidence: infinite loop, allocation bomb, environment read, process exit, malformed package JSON,
path traversal, and cleanup-failure probes; parent session remains responsive and bounded.

### P0.4 Close edit's external-writer race

Evidence: edit now verifies identity before `readFile()` and again immediately before `writeFile()`. A non-Pi
writer can still replace the file in the final check/write gap because the adapter overwrites by path.

Required design: bind read/compare/commit to a file handle or an adapter-owned compare-and-replace primitive;
fail closed when identity changes. Define Windows replace/share semantics explicitly and preserve BOM/newlines.

Acceptance evidence: deterministic interleavings at every stat/read/write boundary, symlink swaps, same-size
same-timestamp replacement, Windows sharing violations, abort, and cleanup failure.

## P1 — confirmed, bounded, or dependent work

1. **General payload leases for `skillify`/`extensionify`.** Both tools repeat full draft bodies in result
   details, while their name/description checks happen only after the payload exists. Introduce a session-owned,
   disk-backed, byte/count/age-bounded payload store and return opaque handles. Keep security-sensitive payload
   classes separate even if they share a storage port.
2. **Streaming skill audit.** `skill-audit.ts` lowercases, regex-replaces, splits, and de-duplicates the complete
   draft body, then performs pairwise Jaccard comparisons. Add bounded streaming tokenization and an inverted
   candidate index before exact scoring. Preserve evidence that distinct trust/workflow semantics are not merged.
3. **Verify custom write adapters before issuing reusable content handles.** Local `wx` writes are authoritative;
   remote/custom adapters need an adapter-owned verified-create contract so a handle is not returned for altered
   bytes.
4. **Reduce bounded toolkit-output copies.** Script capture is capped at 512 KiB per stream, but result assembly
   trims and joins both strings before artifact packing. Stream directly into the existing output/artifact owner.
   This is not an OOM path under the present cap, so it follows the unbounded P0 items.
5. **Bound metadata schemas.** Add evidence-derived character/item limits to `extensionify`, `skillify`, and
   toolkit identifiers/arguments. Limits must be measured and must not truncate source or reduce correctness.
6. **Bound renderer-less tool arguments.** `ToolExecutionComponent.formatToolExecution()` currently
   `JSON.stringify()`s complete arguments for tools without a renderer, and the scrollback component retains
   that argument object after settlement. Use the shared bounded structural projection for display and release
   the UI-owned payload after the session transcript has accepted the authoritative call. Preserve explicit
   expansion through a disk-backed/session-owned handle instead of another heap copy.

## Rejected or low-benefit candidates

- **Ropes/piece tables for provider payloads:** rejected at the network boundary. Providers still require a
  contiguous JSON/body representation; chunked message ownership, pruning before formatting, and one terminal
  serialization are the useful controls.
- **Model-visible two-call preflight for `read`, `grep`, `find`, `ls`, and artifact retrieval:** rejected unless
  new evidence shows large arguments. Their requests are small, outputs are bounded or artifact-backed, and an
  extra model round trip would cost more than harness-owned validation.
- **Replacing native JSON globally:** rejected without per-boundary benchmarks. Several provider transports
  require JSON text; changing parsers cannot remove serialization and may add copies. Optimize duplicate
  serialization and retained ownership first.
- **Raising output/context limits:** rejected as a performance fix. It moves the failure boundary and increases
  heap exposure without removing repeated work.

## Incomplete probes

- Windows timing distributions for local and SSH-backed automatic preflight/final mutation.
- Live SSH round-trip coverage for remote retained-payload staging, expiry, retarget, and cleanup; the adapter is compile-checked but this cycle used no SSH fixture.
- Heap/GC profiles for multi-megabyte skill drafts and extension smoke tests.
- External-writer race reproduction on NTFS with antivirus/indexer sharing behavior.
- Provider-specific rejected-payload cost when a one-call mutation fails preflight after response completion,
  plus the portability and cancellation semantics of speculative streaming preflight.
- Persistent Python protocol throughput and reset cost; no implementation exists yet, so prior process-spawn
  timings are not acceptance evidence.

## Release gate for roadmap items

For each item: Detect -> deterministic failing regression and negative control -> fix at the named owner -> run
the smallest package test -> run adjacent package tests -> `npm run check` -> production clone audit. Run the full
non-e2e suite only at the pre-release gate. Report fixed findings, rejected candidates, incomplete probes, and
remaining platform risks separately.
