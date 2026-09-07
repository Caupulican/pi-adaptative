# Harness reliability review

This review uses aggregate observations only. Private session records, prompts, tool arguments,
identities, and absolute operator paths are not fixtures. Regressions use synthetic tool streams,
mock filesystem errors, fake timers, and mock codec adapters.

## Observed failures

The reviewed foreground transcript contains 206 tool calls and 206 matching results, including
25 error results (12.14%). No foreground call lacks a result. These counts exclude workers' internal
calls and are not a complete multi-agent execution failure rate.

| Error-result category | Count | Interpretation |
| --- | ---: | --- |
| Invented or malformed tool name | 10 | Admission rejected; command not executed |
| Missing task action | 4 | Invalid arguments; admission rejected |
| Failed focused test invocation | 4 | One initial red regression and three subsequent development failures |
| Wrong working directory | 3 | Shell retained a package directory while later calls targeted other packages |
| Credential guard rejection | 2 | One legitimate broad-search refusal; one reproduced search-text false positive |
| Shell glob without matches | 1 | Command returned a negative result |
| Python replacement script missing its next anchor | 1 | Earlier replacement already written; partial mutation |

Receipt evidence separately records 155 completed successes, eight completed negative outcomes,
14 admission rejections, three unknown execution outcomes, and 26 results without receipts.
An error-result flag alone cannot distinguish these categories. An intentional red test is not
evidence of a broken test runner, and missing receipt evidence must not be guessed into success.

Malformed names contain prose or attempted edits while the arguments object is empty. The persisted
transcript confirms the malformed call, but contains no raw transport response proving whether its
origin is provider generation or stream assembly. Executing a guessed command is not safe recovery.

## Review of the preceding changes

| Finding | Disposition |
| --- | --- |
| Verification restoration made invocation descriptors writable | Existing fix retained; descriptor and hook-getter controls retained |
| Running handoff could advertise host-provided verification | Existing fix retained; shared descriptor-preserving removal used at both boundaries |
| After-hook failure poisoned successful execution | Existing live-gate fix extended to output retention, failure-memory replay, and restored retry gates |
| Progress listener never settled | Reproduced and fixed with bounded final draining; foreground/background effect and receipt controls |
| Synchronous path lookup swallowed non-missing filesystem errors | Existing fix retained; ineffective permission test replaced with deterministic errno fixtures and missing-path controls |
| CLI flattened path-resolution errors | Existing fix retained; permission, I/O, and symlink-loop diagnostics covered |
| Python source search mistaken for credential-file access | Reproduced and fixed for membership-test search operands; direct and assigned credential reads remain blocked |
| Native iconv unsupported codec returned generic preservation failure | Reproduced and fixed; unsupported codec and descriptor-resource failure have distinct controls |
| Malformed names inflated failure feedback and bypassed escalation | Reproduced and fixed with bounded escaped diagnostics and shared unknown-name escalation episodes |
| Paste timeout raised from 10 ms to 500 ms | Replaced the incomplete mitigation: idle drainage now preserves paste mode and closing-marker prefixes until real closure or explicit reset |

The preceding permission test used an existence check after removing read permissions. That does not
reliably generate a permission error, so a green result did not prove propagation. Mocked EACCES,
EIO, and ELOOP now prove propagation without depending on privileges or host OS. ENOENT and ENOTDIR
remain explicit alternate-spelling controls.

Native iconv changes do not change decoding, encoding, BOM handling, newline handling, or byte-splice
validation. Unsupported codecs produce recovery guidance; resource failures and lossy conversion do
not authorize a write. An arbitrary Python replacement script is not transactional and is not a
substitute for the packaged encoding-preserving edit path.

## Task directory binding: implementation in progress

`tasks/task-directory-state.ts` now owns the bounded pure registry and binding transitions, using the
existing execution-path owner. Its 14 focused tests cover pin/unpin, workspace selection, explicit
reattachment, immutable admitted contexts, snapshot restoration, duplicate identities, capacity,
revision exhaustion, and POSIX/Windows dialect changes.

`task-directory-controller.ts` now serializes binding changes with admission leases, prevents new
admissions from starving a waiting rebind, and rejects stale journal state after asynchronous validation.
The session adapter uses the existing branch-scoped journal with compare-and-append and strict latest
snapshot restoration. The backend validation port resolves directories and links before an explicit
host authorization callback; a native filesystem adapter preserves missing/permission errors.

The foundation's five focused suites have 40 passing tests, including actual journal reopening,
cancellation, reattachment waiting for all leases, synthetic Windows/UNC paths, and native symlink controls.
The native runtime integration described below connects this owner to core tools and model controls.
Journal custom entries before the first assistant/lifecycle
record are deferred by SessionManager, so pre-conversation setup still needs an explicit durability
contract. Filesystem validation is not an OS sandbox or an atomic defense against external link swaps.

The shell adapters now accept a host-controlled `forceCwd` option. Persistent shell execution restores
the directory under its existing lock, while the Windows engine uses the same state owner to reset cwd
without clearing environment deltas. The Bash tool propagates this option and keeps direct Git filtering
in the pinned directory. The native runtime now supplies this option for admitted model shell calls.

Shell persistence already exists per agent. It is not a task-directory contract: a shell can retain
one directory while file tools and the session still use another. Increasing reminders to use `cd`
does not close that ownership gap.

The agent engine now admits a host-supplied `bindInvocation` after argument validation and before
policy/retry checks. The resulting immutable execution context reaches policy, durable reservation,
and after-tool/background hooks. Prepared leases release on rejection or scheduling failure;
executing leases remain held through the actual operation and asynchronous after-hook, even when a
foreground placeholder has already returned. Ordinary context-free tools retain their existing path.

An opaque binding identity in the engine receipt separates failure memory, retry admission, replay,
and successful-result deduplication across directories and attachment generations. Text-protocol
replay protection still applies within the same binding and refreshes after a changed binding really
executes. Capturing the context is browser-safe; filesystem normalization remains in the path adapter.
Seventeen synthetic engine regressions cover these boundaries.

The definition-first registry now preserves caller-supplied bindings. One execution decorator applies
credential filtering, envelope checks, and extension identity observation to admitted executors as well
as ordinary tools. It captures backend metadata before wrappers close over it and releases an acquired
lease if decoration fails. Policy and extension hooks receive the admitted directory; concurrent hooks
do not change the runner's ambient directory. Relative permission roots remain anchored to the granting
session. Hooks may still edit arguments, but their final arguments are checked against the captured grant.

Seventeen adapter regressions cover binding retention, guard composition, progress/result/error redaction,
bound recovery, hook-edited paths, concurrent contexts, and stale runner access. Two use the real
AgentSession registry with a faux provider and synthetic executors. This adapter checkpoint proved
caller-supplied bindings survive the registry. Native filesystem guards are not remote-backend
authorization adapters.

The native runtime now exposes `task_directory` for workspace registration/selection, explicit task
pin/unpin, status, and reattachment. The active `task_steps` item is the only task cursor. Task and
directory commands form sequential admission barriers, so a later read in the same assistant batch
uses the newly selected context. Tasks without an explicit pin inherit selection without a hidden
durable binding. The captured task identity also separates replay scopes for tasks sharing a directory.

Core native tool factories bind before decorators. Regression tests independently reproduced and fixed
an extension override being replaced by the native factory and a lane mutation guard being bypassed by
the rebuilt executor. SDK-supplied tools keep their explicit backend contract. Extension execute callbacks
receive an asynchronous invocation-local context; neither concurrent calls nor hooks change process cwd.
Native file tools retain their existing concrete-resource permission gate, including file-only grants;
process admission additionally checks its cwd. Directory metadata does not expand those grants.

Native shells are keyed by session, task, and attachment, with bounded idle eviction and terminal-close
ownership. Failed retirement stays owned and retryable; active leases cannot be evicted. Real faux-provider
session tests cover two-project task switching, same-batch ordering, runtime reload, shell-local `cd`,
and edits preserving BOM and mixed line endings. Separate native tests cover missing-root refusal,
explicit reattachment, foreign attachment markers, and concurrent callback isolation. These are synthetic
fixtures, not copied session data.

An archived checklist step can still have its binding forgotten by exact id; requiring a live checklist
selector made orphan bindings impossible to remove. The session regression reproduced that failure before
the tool adapter fix. Suspected id reuse on checklist replacement was rejected after inspection: the task
owner already keeps its next-step counter monotonic across replacement and clearing.

This integration is not the completed portability contract. Composite tools and delegated/background
task creation still need an end-to-end binding audit, and model context projection must survive compaction.
The current native host marker hashes platform and hostname; it detects differing hostnames, not identical
hostnames or cloned machines. It must not be presented as a strong machine identity. Native Windows runtime
integration still needs this stage's CI evidence. General backend fencing remains a release prerequisite.

The model must be able to start tasks in different directories and explicitly decide which tasks
are pinned. Pinning is durable execution state, not a prompt note or a process-global `chdir`.

### Ownership and behavior

- Reuse `ExecutionContext`, `ExecutionAttachment`, and `resolveExecutionResource` from
  `packages/agent/src/execution-paths.ts`; do not introduce another path dialect or resolver.
- A session-owned workspace registry maps bounded logical names to validated backend attachments.
  Machine-local roots stay out of shared fixtures and portable project configuration.
- One task-binding owner records the workspace identity, relative task directory, pin mode, and
  revision. Checklist, worker, and background-task adapters reference that binding rather than
  maintaining competing directory values.
- The model can register/select a workspace and pin, unpin, or explicitly rebind an idle task through
  structured actions. Existing grant checks still apply: a path or pin is not new file-access authority.
- Pinned tasks retain their selected directory across workspace selection changes and resume.
  Unpinned tasks inherit the selected workspace at admission, never halfway through an operation.
- Every admitted invocation captures an immutable context. Shell, Python, file I/O, search, verification,
  and recovery consume that same context. Background completion retains its original binding.
- Persistent shell sessions are isolated by task and attachment generation. A shell-local `cd` cannot
  rewrite a task pin or move another task. A later pinned invocation starts at its pinned directory.
- Binding changes serialize with admission. Queued work retains its admitted context; active work
  cannot be silently retargeted by a workspace switch, task update, or worker reuse.
- Resume validates the saved attachment. If a project moved or a drive is unavailable, offer an explicit
  reattachment action; never execute against an unrelated fallback directory. Reattachment advances
  generation, and old verification cannot certify the new binding.
- Task status and model context show the logical workspace, effective directory, pin state, and revision.
  The model should not have to reconstruct directory state from earlier shell output.

### Focused acceptance cases

1. Two tasks run in separate synthetic projects; relative reads, edits, searches, Python, and shell
   commands consistently target each task's project without embedded `cd`.
2. Switching the selected workspace moves only future unpinned admissions. Pinned, queued, and running
   work remain correctly bound; a worker cannot move its parent or sibling.
3. Pin/unpin/rebind, cancel, restart, branch restoration, worker reuse, and late completion cannot revive
   a stale attachment or reuse verification under a different generation.
4. POSIX paths, fully qualified Windows drive paths, UNC paths, spaces, and Unicode use the declared
   backend dialect. Drive-relative ambiguity and unavailable roots produce explicit repair actions.
5. A failed directory validation causes no process start or file mutation. Reattachment is authorized
   against the same capability boundary, including symlinks/junctions and custom backends.
6. Shell termination loses transient shell state but not the durable task binding. A retry restores the
   task directory without replaying a completed mutation.

Implement in separately verified stages: binding/persistence and reducers; admission and tool adapters;
then model-facing actions and status projection. Do not advertise the completed feature after only adding
a schema field or a prompt instruction. All execution paths must consume the binding before release.

## Open decisions and limits

- The approved unterminated-paste behavior retains paste mode until a closing marker or explicit
  terminal reset. Text drains during idle gaps without sending the tail through keyboard handling.
  Deterministic regressions cover 499 ms, 501 ms, and 60-second gaps, every closing-marker split,
  repeated drainage, explicit clear, shutdown, and 64 adversarial chunk sequences. A missing marker
  now requires explicit reset rather than allowing timeout-based keyboard recovery.
- Foreground progress-delivery failure still stops after preserving the result; that is intentional.
- Machine-wide mutation barriers are conservative safety policy, not a demonstrated concurrency bug.
- Native iconv discovery/trust and the documented 16 MiB iconv-only read bound remain unchanged.
- General attachment fencing and all-backend admission migration are not completed by these fixes.
- Provider-origin malformed generation, native Windows task-binding behavior, and complete worker-session
  failure counts are not proven by this review. Static worker claims are candidates, not executed evidence.
- Released changelog sections remain immutable; an empty historical TUI release section is a documentation
  omission, not evidence that the code change was absent.

## Verification checkpoint

- 411 distinct targeted tests pass across 21 files: 238 agent, 109 coding-agent, and 64 TUI tests.
  The codec wrapper additionally checks all 32 synthetic Python adapter cases.
- `npm run check` exits successfully, including TypeScript and browser smoke. Production clone coverage
  accounts for 959 eligible files out of 968 owned candidates, with zero clones; the largest candidate
  is 4,180 lines / 173,405 bytes, below the configured scanner limits.
- The 30 tracked changed files retain their existing BOM/newline-kind signatures and valid UTF-8 encoding.
  No blanket encoding conversion was performed.
- The previously failing paste probe is now packaged in `stdin-buffer-paste-lifecycle.test.ts`;
  all 12 lifecycle regressions pass. The earlier count above predates this additional coverage.
- The five task-directory suites pass all 40 tests. Both existing session-persistence-failure tests
  pass, confirming write failure does not publish an in-memory entry and fences subsequent writes.
  A new stale-admission regression failed before the controller fix and passes afterward. New backend
  suites initially failed to load their not-yet-implemented modules; those are test-first scaffolding
  failures, not evidence of an existing backend defect.
- Eight targeted shell/verification suites pass 110 tests. The new pin regressions first reproduced
  retained cwd in the native shell, the real Python engine, the Bash adapter, and the Git filter. The
  last case was independently checked with the filter fix removed: ordinary pinned commands passed
  while filtered Git read the wrong synthetic repository. Native Windows execution still requires CI.
- The shell checkpoint and its Windows path-alias fixture correction passed all ten Linux/Windows
  jobs in GitHub CI at commit `3315193082e8f233451855b17c1f5613e9b0981f`. The assertions compare native
  directory identity without removing short-name inputs from the tests.
- The subsequent engine-binding slice passes 314 targeted agent tests across 14 files and six
  coding-agent autonomy tests. This includes 17 binding regressions and seven new receipt decoder
  cases. The earlier counts overlap these suites and must not be added as distinct coverage.
- The engine checkpoint `fbdbe077e2db625663504bec8a2ed8f2f5e25d37` passed all ten GitHub CI jobs.
  The following registry/policy adapter slice passes 201 targeted coding-agent tests in 12 files,
  including 17 new adapter cases. Repository checks pass with 962 eligible / 971 owned production
  files accounted for and zero clones. Ten edited tracked files retain their BOM/newline conventions;
  two new files validate as UTF-8. These edits do not transcode existing content.
- The registry/policy checkpoint `a7aaca284f186752d383595c41761646b6595e97` also passed all ten
  GitHub CI jobs. This is evidence for that exact checkpoint, not for uncommitted native integration.
- Native runtime integration passes 104 targeted coding-agent tests in 17 files and 34 targeted
  agent tests in two files. The ownership audit reproduced duplicate registry guard construction,
  then consolidated it without changing extension override order. The clone gate accounts for
  965 eligible / 974 owned files, with zero clones at the unchanged 50-token sensitivity.
  Eleven tracked files preserve their UTF-8 validity, BOM and newline conventions; six new files
  validate as UTF-8. No existing file was transcoded.
- Host npm configuration emits `globalignorefile` warnings. Local Node is 24.18.1, below the declared
  24.20.0 minimum. Successful checks on this host do not replace supported-runtime CI evidence.

Targeted regression success and a repository check are not release approval. Task-directory binding
remains open. Exact-candidate remote CI and the documented release gates remain required.
