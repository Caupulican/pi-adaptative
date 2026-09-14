# Harness failure causes and remediation design

Status: reproduced defects repaired locally; broader design gaps remain listed below.
The original audit describes the source baseline.
Source baseline: `ef610235f58330040c6b1bbad1aa3806496a7420`.

The dominant failure is disagreement between contracts at subsystem boundaries. The
harness executes work under one interpretation, records evidence under another, and
instructs the model to repair the disagreement through prose. Provider and model
failures then amplify the resulting retries, shared-file edits, and bookkeeping.
Adding more mandatory instructions will not resolve those ownership gaps.

## Evidence scope

The latest two Pi Adaptative sessions in this workspace were selected by start time:

| Reference | Session | Start, UTC | Records | Messages |
| --- | --- | --- | ---: | ---: |
| A | `01a09bab-ea54-7beb-907a-483a637514a5` | September 13, 16:48:50 | 4,447 | 1,010 |
| B | `01a09c65-cb0c-7a8f-8767-831f138d52c1` | September 13, 20:11:51 | 138 | 40 |

References below use one-based JSONL record numbers in the original session files.
All records were parsed; dialogue, tool failures, terminal handoffs, and relevant
worker transcript tails were inspected. Provider request payloads were not exhaustively
compared. The neighboring AIdeas session was not substituted for either Pi session.
Private transcripts and memory contents are not copied into this repository.

Severity means effect on completing trustworthy work: P1 blocks or misrepresents
execution/evidence; P2 causes avoidable retries or recovery work. A historical symptom
is not automatically a currently reproduced implementation defect.

## 1. Verification has three incompatible views of the same execution — P1

### Observed failure chain

1. A's first R5 test run failed during import with missing pinned `jscpd` metadata.
   The failure receipt at A:710 records `status=failed`, `outcome=unconfirmed`.
2. The agent repaired the launch context by prefixing the command with
   `PI_PACKAGE_DIR=<repository coding-agent package>`. An initial corrected run
   exposed a real failing assertion. Subsequent R5 runs passed, including A:834
   and A:3104, but produced no trusted verification receipt.
3. The old failed obligation remained active. Repeating the original launch at
   A:3067 recreated the import failure and another `unconfirmed` receipt at A:3084.
4. The session treated operator `/verify` intervention as the remaining way out,
   although passing test output already existed. Goal completion and task updates
   then consumed further turns without repairing the evidence path.

### Confirmed implementation causes

- **Bootstrap ordering:** [config.ts](../../packages/coding-agent/src/config.ts)
  loads package metadata at module evaluation using `PI_PACKAGE_DIR`.
  [test-agent-dir-isolation-setup.ts](../../packages/coding-agent/test/test-agent-dir-isolation-setup.ts)
  imports that module before deleting inherited launch variables. Cleanup cannot
  undo the cached metadata. A synthetic runtime package without `jscpd` reproduced
  the same import error with zero tests collected; the identical selected test
  passed when pointed at the repository package.
- **Command interpretation differs by consumer:**
  [shell-test-command.ts](../../packages/coding-agent/src/core/tools/shell-test-command.ts)
  handles environment assignments for test-output projection, but its verification
  classifier does not recognize the same prefixed test invocation. A direct Vitest
  command receives an identity and repair group; adding the environment assignment
  returns `undefined`. `repairOf` cannot reconcile a run that has no receipt.
- **Execution phase is inferred from an inadequate summary:**
  [vitest-verification-parser.ts](../../packages/coding-agent/src/core/tools/vitest-verification-parser.ts)
  classifies `Test Files 1 failed (1)` plus `Tests no tests` as failed/unconfirmed.
  A missing-file result is setup_failed. The existing parser test explicitly
  expects the former distinction. This is a policy/design gap, not merely a missing
  test or an assertion to weaken.
- **The consumer correctly requires evidence it never receives:**
  [verification-obligations.ts](../../packages/agent/src/verification-obligations.ts)
  requires a later executed receipt in the setup repair group. Replaying A's
  persisted messages through the current tracker reproduces its remaining R5
  obligation. Changing only the two failure phases to setup_failed in an in-memory
  copy still leaves it active. Fixing only the parser is insufficient.

### Required invariant and design

Every admitted verification execution must have a host-owned identity and terminal
receipt independent of shell spelling, foreground/background delivery, or output
presentation. Ordinary shell commands can remain unclassified, but a requested
verification or `repairOf` must never silently run without attestation.

Extend the existing shell parser and execution observer with one parsed command
representation: executable, argv, working directory, explicit environment changes,
shell connectors, and verification stages. Classification and output projection
consume this representation. Environment changes belong in execution identity;
do not erase all environment variables merely to make hashes match. Define which
setup differences can participate in a repair group and explain mismatches.

Separate result (`passed`, `failed`, `cancelled`, `unknown`) from phase (`launch`,
`collection`, `execution`, `unknown`). Prefer structured runner results when
available; retain conservative parsing for arbitrary shell output. A collection
failure remains failed. It becomes eligible for a narrowly matched repair only
when collection failure is evidenced, not just because an output string says
"no tests". Partial or truncated output must remain unconfirmed.

Attach receipts at the execution owner before terminal publication. The tracker
remains the single obligation reducer; goal completion and `/verify` consume its
projection. Display why a repair was accepted or refused. Historical reconciliation
must use a new trusted event or rerun, never rewrite old transcript records or
convert an operator waiver into a passing test.

Fix package identity before config imports: separate installed-runtime metadata
from the project execution environment, and bootstrap test sanitization before
loading either. Preserve explicitly supported operator overrides; the existing
[harness-environment.ts](../../packages/coding-agent/src/core/harness-environment.ts)
distinguishes supervised launch variables from ordinary operator environment.

## 2. Model-facing contracts disagree with domain state — P1/P2

### Confirmed cases

- B:111 submits three `grant_edge` actions with `push`, `tag`, and `release`.
  All three fail at execution. A also tries `destructive` before correcting it to
  `destructive.fs`.
  [goal.ts](../../packages/coding-agent/src/core/tools/goal.ts) advertises edgeClass
  as a free string with allowed values only in its description, while execution
  uses the closed domain registry. A source-level probe confirms `push` passes
  schema validation but is rejected by execution; `git.publish` passes both.
- A's blocked task is reopened following harness guidance around A:3963.
  [task-contract-monitor.ts](../../packages/coding-agent/src/core/tasks/task-contract-monitor.ts)
  treats every nonterminal step, including blocked steps, as requiring an active
  step. [task-state.ts](../../packages/coding-agent/src/core/tasks/task-state.ts)
  independently tells the model to start the first open step, also including a
  blocked step. A synthetic all-blocked state reproduces both instructions.
  Active and completed states are negative controls and emit neither warning.

### Required invariant and design

Generate schema enums from `EDGE_CLASSES`; represent action-specific required
fields with discriminated contracts. Share the action registry between schema,
validation, and repair diagnostics. Keep provenance and authorization checks at
execution; schema validity does not establish permission. Operation classification
should be host-owned so a model need not guess a publication class from English.

Compute work eligibility once at the task lifecycle owner. `open` and `runnable`
are different predicates: blocked work stays visible without becoming runnable.
The monitor, context renderer, task advancement, and goal continuation consume
that decision. Preserve the three-turn blocking policy while eliminating advice
to invent progress. A known external wait carries its reason and wake condition;
resumption requires an event or relevant user input. Do not add another independent
progress counter or periodic model turn to work around this mismatch.

## 3. Worker scope and deliverable ownership are not the same contract — P1

A records 15 worker identities and 22 terminal lane records: 2 succeeded, 14 failed,
and 6 were canceled. These include follow-up turns, not 22 independent workers.

A:1412's worker request says not to edit `memory/providers/file-store.ts`, but the
claim includes that file. Its envelope has `allowedPaths: ["/"]` with particular
denied paths, despite describing the route as path-scoped. The worker transcript
also shows attempted edits to the excluded file. Parent ownership therefore
exists in prose while the execution grant permits much broader writes. This is
not proof that the path authorization implementation ignored its actual grant.

The session also exposes invalid intermediate TypeScript and repeated integration
repairs. Shared mutable files make failed worker attempts costly even when a final
claim honestly says failed. A worker dependency at A:1867 names `worker-6`; it is
canceled against a failed earlier task while a follow-up is in play. `dependsOn`
names durable tasks, so automatically retargeting it to the latest agent turn
would be an incorrect fix.

Extend [worker-execution-policy.ts](../../packages/coding-agent/src/core/delegation/worker-execution-policy.ts)
and existing grant compilation with explicit task write sets, intersected with the
parent grant. Use those same paths for reservation and changed-file review. Process
tools must satisfy the same boundary; a file-tool-only restriction is insufficient.
Where process containment cannot enforce the requested scope, use an isolated
checkout or withhold that capability, with an explicit admission result.

For parallel work sharing an interface, freeze the interface first and admit
nonoverlapping work against it. Stage worker changes and validate their diff,
focused regression, and affected compilation before promotion to the parent's
working tree. Promotion must check base revisions, cancellation, and stale attempts.
Failed attempts retain a bounded, reviewable patch; they do not leave an implicit
successful deliverable in shared files.

Keep persistent agent identity distinct from task, attempt, and deliverable IDs.
Follow-up dispatch returns the exact task/attempt handle. Dependencies bind that
immutable handle and, when needed, its verified deliverable. Preserve existing
reservation, authority fencing, and event-driven terminal handoffs.

## 4. Failure diagnosis and admission need evidence at the correct scope — P1/P2

Several failures are external or model-originated: OpenRouter reports exhausted
quota at A:2195; later Codex attempts receive explicit unsupported-model HTTP 400s
at A:2392, A:2405, and A:2444. Configured credentials and a model catalog entry do
not prove that the account can use that model. Changing a foreground model also
does not prove an intentionally pinned worker profile changed.

Two failures are specifically reported as `worker_protocol_error` (A:1412,
A:1520): a provider preflight authority epoch had no consuming assistant.
Worker 7's persisted tail additionally contains `output runaway: the last 200
characters repeated 6 times`. Worker 3 ends after an invalid edit and recovery
record. These establish mixed diagnostic evidence, not the exact request-level
ordering that produced the unmatched epoch. That causal ordering remains open.

[worker-provider-turn-protocol.ts](../../packages/coding-agent/src/core/delegation/worker-provider-turn-protocol.ts)
enforces legitimate reservation and accounting invariants. Preserve them. Reproduce
provider error, runaway termination, retry preflight, callback failure, and abort
sequences before changing consumption rules. Give each admitted request an explicit
terminal disposition: assistant committed, failed before assistant, or canceled.
Never synthesize assistant evidence to consume a reservation.

The mandatory guidance in
[worker-terminal-handoff-coordinator.ts](../../packages/coding-agent/src/core/delegation/worker-terminal-handoff-coordinator.ts)
says completion errors are never harness failures. A delivered notification proves
delivery, not correctness of admission, accounting, or the tool adapter. Replace
categorical causal claims with structured facts: component, failure code, affected
scope, retryability, reset time, source request, and retained evidence. Keep delivery,
execution, and artifact verification as separate outcomes.

Extend existing model binding and retry owners rather than add provider-specific
retry loops. Cache observed entitlement failures and quota cooldowns at the
provider/account/model scope supported by the response, with expiry and invalidation
on credential/configuration changes. An unknown entitlement remains unknown; do
not issue paid probe calls just to populate the cache. Report the effective worker
model and its selection source before dispatch. A known exhausted binding must not
be repeatedly selected for sibling work; unrelated healthy siblings remain eligible.

## 5. The release candidate exists outside the release workflow — P1

Live read-only GitHub checks during this audit confirm:

| Item | Observed value |
| --- | --- |
| Origin repository | `Caupulican/pi-adaptative` |
| Remote main | `ad76e5fdf74bae92c02b972511b01d5712f19264` |
| Local-only implementation | `8fac41531` — memory storage/prompt budgets and reversible ICM |
| Local-only documentation | `9573bd59f` — ICM automatic-learning documentation |
| Local-only candidate | `ef610235f` — Prepare local 0.99.21 release candidate |
| Latest published GitHub release | `v0.99.20` |
| Remote `v0.99.21` tag | Absent |
| GitHub Actions runs for exact candidate SHA | None returned |

The candidate is not released. B ends with `Operation aborted`, after failed grant
arguments and release-path inspection; it contains no successful push or publication.
The reason for that abort is not established. The historical authorization to publish
is evidence about B, not an instruction executed by this audit.

Unqualified `gh repo view` currently resolves to upstream `earendil-works/pi`;
explicit `-R Caupulican/pi-adaptative` resolves the intended repository. B initially
made the same repository-context mistake and queried an obsolete npm package.
The official release script already derives its repository from origin; reuse that
owner rather than add a competing repository resolver.

[release-staging.mjs](../../scripts/release-staging.mjs) recognizes only
`Release v0.99.21` or `Repair release v0.99.21`. The current candidate title matches
neither. [release.mjs](../../scripts/release.mjs) searches origin/main for that marker;
repair also requires the original Release commit. Therefore pushing the existing
commits alone will not make promote or repair recognize the candidate. Running
release:patch would advance the already-bumped tree to 0.99.22.

### Recovery design

1. Review the three unpublished commits and run the required local check gate and
   targeted affected regressions. This audit has not certified that implementation
   or its release metadata. Preserve 0.99.21; do not rename a commit merely to fool
   candidate discovery or create a tag manually.
2. Extend the existing release owner with an explicit **adopt existing candidate**
   transition, supported by a read-only status/plan operation. Validate lockstep
   version, intended changelog sections, clean candidate tree, ancestry, target
   repository, unused tag, and exact source SHA. Adoption performs no version bump
   and records the candidate through the same persistence/discovery path as prepare.
3. When publication is requested, push the reviewed source and require the complete
   exact-SHA GitHub `ci.yml` matrix. Adoption must not obtain the metadata-only CI
   shortcut without recorded full-suite evidence for the underlying tree.
4. Promote the adopted candidate through the existing CI and destructive gates;
   then verify `build-binaries.yml`, standalone archives, both installers, and
   checksums. Keep published, packaged, and running-runtime versions distinct.

Longer term, make candidate identity explicit data containing repository, version,
source SHA, preparation state, and gate receipts. Commit subjects are labels, not
the durable release state. Design retries as idempotent transitions in the existing
release owner. Audit local-tag resume and rollback branches separately: this audit
did not execute their failure paths or approve their behavior.

## Implementation order and proof obligations

Implement small vertical changes at the existing owners. Do not introduce a global
"harness manager" or another parallel evidence ledger.

| Order | Boundary | Required regression and negative controls |
| --- | --- | --- |
| 1 | Bootstrap → shell → receipt → obligation | Poisoned launch metadata; direct/env-prefixed equivalent tests; real assertion failure remains failed; collection repair clears only the intended obligation; no receipt cannot pass; wrong cwd/env/revision, forged output, truncated output, duplicate and out-of-order terminals remain rejected |
| 2 | State → schema and guidance | Invalid edge class rejected before execution; valid authorized class accepted; missing/false provenance refused; all-blocked state never requests activation; pending runnable work still advances; mixed blocked/pending and repeated block/reopen sequences |
| 3 | Worker admission → isolated changes → deliverable | Write outside task scope rejected through file and process tools; stale base and canceled promotion refused; exact follow-up dependency succeeds while old failed task stays failed; no duplicate terminal or reservation leak after restart |
| 4 | Provider attempt → failure disposition | Deterministic faux-provider quota, unsupported account/model, runaway, stream failure, abort at every reservation stage, stale callbacks, and shutdown; usage conserved, one terminal disposition, unrelated sibling remains runnable |
| 5 | Existing candidate → GitHub release | Adoption does not bump; wrong repository/SHA/version fails; missing/skipped matrix evidence blocks; tag collision fails; interrupted adoption/promotion resumes idempotently; metadata shortcut cannot bypass source CI; assets tied to promoted SHA |

For each change: establish the failing invariant first, fix its lowest authoritative
owner, remove replaced competing paths, run focused tests, then run `npm run check`.
Use the suite harness and faux provider for session regressions. No real provider
tokens are needed. Run broader release tests in GitHub Actions per repository policy.
Validate the packaged runtime as well as source tests; a newer checkout cannot
silently prove behavior in an already-running older runtime generation.

## Original audit validation and remaining uncertainty

- **Confirmed, still unfixed:** poisoned package import ordering; missing verification
  classification for environment-prefixed tests; failed collection classified as
  unconfirmed; unreconciled obligation on transcript replay; schema/domain edge
  mismatch; all-blocked task activation guidance; candidate-title mismatch.
  Each was reproduced with a deterministic comparison or negative control.
- **Historical evidence with design implications:** worker scope wider than prose
  ownership, invalid intermediate edits, failed dependency selection, quota exhaustion,
  unsupported models, and unmatched preflight epochs. Live worker concurrency and
  provider-request ordering were not reproduced end to end.
- **Baseline:** four focused files passed, 99 tests total:
  `vitest-verification-output`, `shell-verification-classifier`,
  `task-contract-monitor`, and `worker-provider-turn-protocol`.
  The selected bundled-jscpd metadata test failed during import against a synthetic
  package and passed against the repository package (1 selected test, 8 intentionally
  skipped by the name filter).
- **Duplication evidence:** the production clone gate passed: 1,018/1,027
  eligible/owned files covered, 987 sources in the 50-token detection pass, zero
  textual clones. Limits and exclusions were inspected: 20,000 lines, 2 MiB,
  minimum 5 lines/50 tokens, explicit generated/vendor exclusions. This does not
  refute the reproduced semantic duplication in command interpretation and task
  eligibility. No claim of repository-wide semantic uniqueness is made.
- **Rejected conclusions:** background delivery failure does not explain receipts
  omitted by classification; phase-only repair does not resolve the replay;
  an available-model listing does not prove entitlement; a dependency on an old
  task must not silently follow the newest worker turn; a local version bump or npm
  archive does not prove GitHub publication. The later session did correctly state
  that the candidate was not shipped.
- **Incomplete:** cause of the final abort and a missing memory-file read, exact
  preflight/runaway ordering, release rollback/tag-resume behavior, full memory/ICM
  implementation review, full CI and standalone asset verification. No full build
  or full test suite was run. No production fix, commit, push, tag, or release was
  performed by this audit.

## Implementation evidence

The following changes now live in the package, with focused regressions:

- Test launch variables are sanitized by an ESM dependency evaluated before config imports.
  A child-process negative control still reproduces poisoned package metadata without that bootstrap.
- Projection and verification use the existing shell-prefix parser, including `env.exe` and
  executable paths. Environment changes remain in both receipt and repair identity. Review
  rejected erasing workspace-contained `PI_PACKAGE_DIR`: containment does not prove package
  identity, and execution cwd can belong to another test workspace. The bootstrap fixes future
  poisoned launches without that override; rerunning the original command produces matching
  evidence. Historical environment-changing runs are not automatically reconciled.
- A validated failed file-collection summary plus no tests permits setup repair. Passed-file
  contradictions are aggregated across summaries, independently of line order. Assertion
  failures, partially executed compounds, and unknown outcomes keep their obligations.
- The goal schema derives its edge enum from `EDGE_CLASSES`. The task monitor and context
  renderer reuse `findNextPendingStep`; tool guidance no longer requests blocked work. The
  selected runnable step stays visible with its id even beyond the bounded context window.
- A new worker regression reproduces `worker_protocol_error` when a terminal error contains
  a partial tool call. The executor now persists and accounts that actual terminal response
  immediately. Existing missing/overlapping preflight, callback failure, retry, cancellation,
  and shared-budget controls still pass. This proves one cause, not the exact ordering of
  both historical failures. Handoff guidance no longer equates delivery with overall health.
- `release:status` inspects local/remote state. `release:adopt` validates the already prepared
  version across workspace manifests and lock metadata, merges pending notes into that
  untagged candidate, and uses the existing prepare publication and promotion path without
  bumping again. Temporary-repository execution tests prove red source CI prevents mutation
  and successful adoption retains the version. GitHub publication still requires its existing
  full-matrix provenance, destructive and standalone-asset gates.

- Execution defaults now resolve every registered edge class as standing YOLO authorization.
  Explicit restricted lists retain their meaning; malformed or unreadable policies cannot widen
  grants. Settings load errors remain diagnostic and do not block ordinary provider requests.
  Foreground execution, worker projection, and provider authority context use the existing
  grant owner. Competing approval prose was removed from self-modification and Python guidance;
  learning presets are explicitly independent of execution authority.
- The shared release CI proof requires both platform jobs and all eight distinct coding-agent
  shards, including successful test steps. Preflight proves exact source HEAD; metadata promotion
  verifies its parent diff before inheriting that source proof. The binary workflow consumes the
  same implementation. Proof runs before destructive dispatch. A pre-existing local tag must
  name the discovered candidate and pass both gates before it can be pushed.
- Adoption recovers only byte-exact changelog transformations of HEAD after an interrupted check.
  Failure-injection controls reject unrelated edits, mismatched versions, skipped matrix steps,
  and tag collisions. Changelog folding is idempotent; historical sections remain intact.

No historical receipt was rewritten. Worker write-set isolation, entitlement-specific admission,
and exhaustive multi-process release interruption coverage remain design work. Those historical
observations do not establish a currently reproduced grant-enforcement or admission defect.
Account cooldown/exhaustion and automatic limited-account avoidance already
have provider-neutral owners; adding another quota cache would duplicate those mechanisms.
Implementation tests use faux providers and temporary repositories. Actual publication follows
the separate GitHub gates after the owner-authorized commit and push.

Validation: `npm run check` passed, including TypeScript, installer/binary regressions,
architecture checks and the coverage-validated zero-clone scan (1,018 eligible files).
The verification coverage slice passed 643 tests with 8 skipped, including an existing
explicitly skipped pipeline test and platform-specific cases; every configured per-file
coverage threshold passed. Executor/protocol tests passed 48 tests, handoff/status tests
passed 43, and release adoption passed 8 tests against temporary repositories and fake CI.
The poisoned-launch bootstrap/receipt slice passed all 8 tests with `PI_PACKAGE_DIR=/tmp`.
Additional task/schema/parser and memory regression slices passed. A pre-existing test-only
string-concatenation lint finding was fixed without changing its fixture value.

Local validation used Node 24.18.1, below the repository's 24.20.0 target. The installed npm
emitted its existing `globalignorefile` configuration warning. These are environment
limitations, not suppressed gate results. No release-ready claim is made without the
supported-runtime GitHub matrix and packaged-artifact verification.

Follow-up review: 24 autonomy regressions cover default grants, explicit restrictions, reload,
compaction, all policy-file layers, malformed policies, worker intersections, and diagnostic
requests after failed settings loads. The additional parser/context review slice passed 96 tests.
Release proof and recovery tests exercise missing/failed/skipped CI, exact shard identities,
metadata-parent proof, interruption, unrelated edits, version mismatch and local-tag bypass.
Claude reviewed through the persistent Herdr agent launched with
`claude --dangerously-skip-permissions`. Its unpushed-candidate finding was rejected: discovery
reads only `origin/main`. Broader historical ordering remains unproven, not silently classified
as fixed.
