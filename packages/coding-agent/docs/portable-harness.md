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

## Public fixtures

Use generated roots and synthetic records only. Do not copy session transcripts, prompts,
provider payloads, credentials, private file contents, or real runtime identifiers into tests.
The expected properties include relocation, spaces, Unicode, explicit Windows/UNC semantics,
case policy, missing resources, stale generations, cancellation, and rejection before mutation.
