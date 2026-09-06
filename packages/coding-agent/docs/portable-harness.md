# Portable execution contracts

The harness migration follows one invariant: an operation's admitted context, execution evidence,
and recovery identity must agree. Display paths, aliases, process-global directories, and another
machine's filesystem spelling are not execution authority.

## Ownership

- `packages/agent/src/execution-paths.ts` owns explicit lexical path semantics, immutable execution
  contexts, workspace attachments, and resource references. It never reads the filesystem,
  process working directory, home directory, or platform.
- `packages/agent/src/utils/paths.ts` is the native path-input adapter. Existing native callers
  retain their CLI defaults; backend callers can supply a dialect and home directory explicitly.
  Lexical resolution always uses the execution-path owner.
- Filesystem adapters own actual resource resolution and authorization, including symlinks,
  junctions, permission failures, and targets that do not exist yet. Lexical containment is not
  permission to access a file.
- An attachment identifies a concrete workspace binding. Reattachment changes its identity;
  retained evidence does not automatically certify the new attachment.

## Migration stages

1. Backend path/context foundation, production path-adapter integration, alias-reactivation
   regression, and synthetic portability fixtures.
2. Runner-neutral execution evidence, explicit shell context, and setup-repair verification.
3. Shared invocation/context lifecycle, terminal receipts, restart fencing, and side-effect-aware
   recovery across foreground, worker, extension, and background entry points.
4. Capability/protocol admission alignment and privacy-safe failure diagnostics.
5. Receipt-derived reporting and native backend conformance coverage.

Each stage has focused behavioral and negative-control tests and the repository check gate before
commit. A completed foundation stage does not establish that all execution adapters have migrated.
No full test suite is run locally. Native-platform conformance belongs in CI; a Linux simulation
of Windows path syntax is not evidence of native Windows process or filesystem behavior.

## Verification evidence

Read lookup now probes only the selected `ReadOperations.access` port. `ReadToolOptions.pathOptions`
binds lexical dialect and home at construction; a non-native dialect requires custom operations.
Exact input spelling wins before bounded screenshot/Unicode conveniences, and those conveniences
never rewrite the admitted working directory. Candidate generation is lazy, so an unavailable
fallback home cannot invalidate an existing literal filename. Only missing-path errors permit
another candidate; permission, I/O, and symlink-loop failures retain their identity. Cancellation
stops subsequent probes and reads. Missing-read recovery uses the same dialect and exact input.
Custom operations still own filesystem authorization and symlink semantics. This migrates read
lookup, not all mutation/search/rendering adapters or attachment-generation fencing.

`file-text-decoder.ts` owns read-only byte decoding for whole-file reads and native streaming
slices/counts. UTF-8 stays native and strict; BOM-marked Unicode and an explicit `encoding` use
the same packaged codec transport and BOM-selection owner as edit recovery. Decoding happens
before outline extraction, line counting, and slicing. Literal replacement characters remain
valid text; malformed bytes never silently become replacement characters. Read-only stateful
decoding does not claim that a subsequent edit can preserve that encoding's byte boundaries.

Encoded decoding splits input into approximately 1 MiB chunks (up to three extra prefix bytes),
retaining at most 16 MiB of codec state. Each chunk and final flush uses an isolated helper process;
this bounds codec payload memory but carries per-chunk startup cost. Caller cancellation detaches
immediately from shared runtime provisioning without canceling other callers. Source iteration closes on early completion,
cancellation, or decoding failure. No target path enters the helper. Custom text-producing
`readLineSlice`/`countLines` adapters receive `encoding` and `signal` and are responsible for honoring
them; custom `readFile` bytes go through the shared decoder. Image handling is unchanged.

The shared `StreamingLineDecoder` retains bounded windows while counting complete source lines.
Native ordinary reads retain at most 51,203 UTF-16 units per line; line counting retains no
line payload. `read` returns an unfiltered character window for an oversized first selected line.
Continue using its `lineWindow.nextColumn` with the same path, encoding, and offset. Columns are
1-based UTF-16 positions; boundaries expand to preserve complete surrogate pairs. Whole-file and
streamed reads share the same window formatter. No target path is inserted into shell guidance.
Custom text slice adapters must honor `startColumn`/`maxLineChars` and report retained windows'
source coordinates; custom whole-file adapters remain responsible for their own I/O memory bounds.

Pi session JSONL reads retain their label-only projection, including outline fallback. Raw character
windows are unavailable for these protected records. Native projection retains at most 16 MiB
UTF-16 units per record; larger records produce an explicit omission, never a raw prefix. Full
structured projection of larger records remains unimplemented. Outlines omit oversized source
lines with a read continuation and retain subsequent declaration line numbers.

Mutation tools now share `FileMutationIntentController.pathOptions` for resolution, parent traversal,
preflight, and recovery identity. Explicit backends use literal names; the native CLI input adapter
retains its input conveniences. `FileMutationIntentOperations.mutationQueue` supplies canonical
keys and backend identity: cooperating controllers must share that object. Queue registration is
backend-scoped, so one stalled resolver cannot stall another backend. The existing conservative
process-wide shell/mutation barrier remains shared. Custom keys must account for their backend's
aliases and case policy. The SSH example resolves queue keys remotely; its older cwd substitution
and the remaining search/process adapters still need migration. Edit previews use the execution
backend and cwd, never the renderer's operator directory.

Edit defaults to strict UTF-8; BOM-marked encodings recover automatically through the packaged
`file-edit-codec.py`. Known legacy/BOM-less sources can supply `encoding`; ambiguous bytes are
never guessed. `decodeEditDocument` owns that decision for previews and execution. Python runs
in isolated, no-site mode and receives bounded bytes over stdin, never target paths, shell commands,
or model-authored programs. This is a fixed codec under the invoking read/edit authority, not implicit permission
to invoke the general Python tool. Remote bytes stay bound to their original mutation backend.

The existing match planner supplies source-coordinate splices. Untouched bytes and each original
line-ending sequence survive, including mixed CRLF/LF/CR. Replacement newlines reuse the matched
span's sequences; added newlines use its last ending or the surrounding ending. The codec requires
strict source round-trip equality and independently validates byte boundaries before splicing.
Unrepresentable replacements, conflicting BOMs, malformed text, and stateful representations that
cannot preserve those boundaries remain non-mutating failures with recovery guidance. Python is
resolved by the existing runtime manager, not an assumed interpreter path or host `iconv` command.
Recovery is bounded to 16 MiB sources/results, 64 MiB protocol input, and 30 seconds per codec call.

The shared Python runtime manager revalidates cached executable identity through its
`inspectInterpreter` port. The native adapter checks fully qualified paths, regular-file status,
POSIX execute permission, and stat identity. Removed or changed executables trigger fresh uv
discovery; an active refresh owns all concurrent callers. Returned outcomes are frozen.
The uv adapter retains `stdoutTruncated`; only complete path output can establish readiness.
Its one terminal LF is framing, not part of the path; internal newlines, CR, Unicode whitespace,
and trailing spaces stay literal. The entire candidate must pass backend inspection; there is no
first-line fallback. Runtime provisioning still uses the native agent-directory layout. This does
not migrate the general Python tool's custom working-directory adapter or close the race between
the final interpreter identity observation and OS process creation.

Custom `EditOperations.writeFile` accepts strings or buffers and must preserve supplied buffers.
Execution retains the original preflight/queue/stale checks and reads back encoded writes before
reporting `encodingRecovery.verified`. Retarget payloads retain the explicit codec; content references
hash the actual encoded bytes. This is executor-level verification, not a new durable engine receipt
immune to extension result rewriting. General Python recovery actions remain authority-matched
guidance, not verification of arbitrary scripts. The existing writer is not crash-atomic and external
writers can still race its last identity check; transactional replacement and durable encoding
verification remain separate migration work. Native Windows/macOS runtime behavior is not established
by Linux codec tests or a synthetic UNC backend.

`TestVerificationOutput` owns bounded UTF-8 decoding and terminal settlement. Runner strategies
parse Vitest summaries or Node TAP/spec summaries; shell classification declares every stage.
An empty, skipped-only, malformed, missing, or incomplete summary is not a passing test run.
Unknown runner formats remain unconfirmed; no parser borrows another runner's evidence.

Receipts distinguish `evidence: tests` from `evidence: command`. Opaque commands still execute and
retain their exit-status verification and ordinary goal-tool evidence. New goal test evidence
requires an explicit executed-test witness; historical receipts without that witness are not
upgraded. Call a directly supported runner to produce new test evidence. Existing unresolved
obligations remain retained and can still be resolved by their matching check or validated setup repair.

Shell verification identity takes the backend's explicit path flavor. Custom backends can supply
`BashToolOptions.pathFlavor`; native adapters derive it from their selected platform contract.
Unqualified Windows contexts cannot borrow an operator's current drive. This is lexical context
validation, not a filesystem authorization check or the full attachment lifecycle migration.

The core finalizer captures executor-owned verification before calling post-execution hooks.
That independent witness survives hook failure, replacement, in-place mutation, and background
handoff. Hooks can still change ordinary display details and policy results, but cannot create
or rewrite verification. This terminal-evidence boundary is a lifecycle migration substage;
shared attachment fencing, restart recovery, and all-backend admission remain separate work.

Batch settlement owns results across reservation failures: dispatched siblings drain before the
parent terminals, completed results remain source-ordered and callback-consistent, and queued
bodies are not started after failed admission. Cancellation ends the current batch without a
doomed extra provider request. This applies to streaming and direct core-loop entry points;
it does not yet establish complete attachment fencing.

Progress delivery has a separate lifecycle owner. Subscriber throws and rejections cannot escape
into the tool body or erase a result. The owner drains admitted observations without retaining their
history and closes late callbacks. Core finalization stamps `piToolInvocation`: request identity,
execution state, completed operation status, and bounded progress/after-hook failure tags. No
listener text, arguments, or paths enter that receipt. Rejection is `not_started`; a handoff is
`running`; a generic exception leaves effects `unknown`; an explicit operation-outcome exception
is completed-negative. Hook policy cannot rewrite those execution facts.

Foreground delivery failure stops after preserving results. Background records retain the same
validated receipt across notification and restart, bound to the admitted request and tool call.
Lost or mismatched completions become unknown, never a successful rerun. Malformed latest durable
records cannot resurrect older success. Legacy records without admission identity remain without
strong execution evidence. Receipts add separately bounded durable metadata (under 512 serialized
characters) alongside the existing failure-payload budget. Attachment fencing remains separate
migration work.

## Reporting scope

`ToolInvocationReport` is the single provider-neutral counter owner. It reconciles observations by
request and tool-call identity, retains their original cycle, and separates not-started, running,
completed-success, completed-negative, unknown-effects, and unclassified results. Postprocessing
faults and display error results are independent dimensions, not additional failed calls. Conflicting
terminal claims become unknown; late handoff placeholders never undo completed evidence.

The workbench displays cycle-local calls and an explicitly labeled retained error-result count;
their quotient is not a failure rate. Retained means observations since the report/UI reset, not
every root and worker action in the durable session. A new cycle keeps the previous view labeled
as previous until its first evidence arrives. Background terminals update the owning cycle even
after a later cycle begins, and notification replay does not increase totals.

Bookkeeping has a 256 KiB charged-retention budget, using bounded identities and fixed records,
without storing output or arguments. If it saturates, counts are labeled partial and already-retained
identities still reconcile; replay protection is never silently evicted. Missing historical receipts
remain unclassified. No percentage or complete-session claim is derived from incomplete evidence.
Native backend conformance and full attachment migration are not established by these reporting tests.

## Public fixtures

Use generated roots and synthetic records only. Do not copy session transcripts, prompts,
provider payloads, credentials, private file contents, or real runtime identifiers into tests.
The expected properties include relocation, spaces, Unicode, explicit Windows/UNC semantics,
case policy, missing resources, stale generations, cancellation, and rejection before mutation.
