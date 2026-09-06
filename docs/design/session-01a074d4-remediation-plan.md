# Harness remediation design

Status: candidate prepared for final staged checks and GitHub release gates. Baseline and ranked findings are in [the session audit](session-01a074d4-harness-audit.md). Commit, push and release are authorized after the fixes and their gates. The original eight pending files were reviewed as inputs to this change.

## Observable outcome

A repository orientation stays proportionate to the request. When a tool fails, its repair is immediately understandable and legal repaired calls remain executable. Test outcomes have authoritative identities and provenance. Corrected invocations can resolve the failure they actually repair without clearing unrelated failures. The user receives a useful, honest handoff even when verification remains incomplete. Goal accounting and background work remain attributable, bounded and restart-safe.

No model-written claim may promote an arbitrary successful command into a passed test, invent a user confirmation, erase a real failure, or broaden a worker's authority by prose. No user-level runtime patch is part of the delivered implementation.

## Architecture decisions

1. **Evidence has a type and an origin.** Extract branch evidence resolution from `RuntimeBuilder` into a named goal-evidence owner. RuntimeBuilder supplies session and background-task ports. The resolver returns a typed verdict and the exact originating receipt; it never accepts a substring in arbitrary arguments as verification. Generic tool evidence may prove that an operation returned a result, including a negative result, but its outcome remains explicit. Test evidence requires a successful trusted verification record. User evidence requires an actual user-plane record; a model-selected `kind: user` is not authority.
2. **Attempt identity and verification identity are different.** A process attempt keeps its exact command, effective working directory and outcome. A verification identity uses parsed, conservatively canonicalized executable/argv, execution location and relevant environment. Cosmetic wrappers may normalize only when the parser proves equivalence. Different projects, filters, environments and incomplete command chains remain distinct. Capture execution context through the process adapter; do not reinterpret the final cwd as the starting cwd of an earlier relative `cd`.
3. **Setup failure is not an executed failing test.** Retain setup/discovery failure as an unsuccessful attempt. An explicit host-validated supersession can associate the corrected invocation with that failed setup attempt. A reported successful verification may then resolve that setup failure. No arbitrary ID supplied by the model can clear an executed test failure. Unknown runner output stays unresolved rather than guessed. Prefer structured runner metadata when available; text classifiers must be bounded, runner-specific and covered by adversarial controls.
4. **Completion status is machine-enforced; useful prose is preserved.** Keep unresolved verification in authoritative session/goal state. Reject successful goal completion while it remains. Preserve the model's handoff and provide the host's verification status separately; do not erase all answer content or spend repeated provider turns forcing opaque-ID grammar. The host must not fabricate a model-authored success or silently remove diagnostic evidence.
5. **One goal execution owner.** Extend the existing goal lease lifecycle to goals created during the current foreground run. Adoption starts at the authoritative creation boundary. Earlier unrelated responses do not become goal usage. Completion, cancellation, steering and final usage flush use the same lease; cache weighting and background attribution remain with their existing owners.
6. **Repair is structured input to recovery.** Tool adapters identify validation, policy refusal, tool execution failure and completed negative outcome distinctly. A shared recovery projection retains the adapter's actionable correction on first failure and exact replay. Credential-specific behavior does not belong in a generic agent-loop conditional when the adapter can supply it. Execution admission continues through the existing recovery gate.
7. **Search authorization has one owner.** Bash, direct process and builtin grep use the same scope assessment after adapter parsing. The bounded context-session root comes from `agent-paths`. Protected-path rules take precedence. Preserve lexical guard limits and existing output redaction; do not present the guard as process isolation.
8. **Task proportionality is a coherent standing contract.** Replace the blanket “evaluate this repo means map” rule with an intent-sensitive contract: orientation is a local map; explicit evaluation may rank evidence; implementation activates engineering gates. Integrate the exception into lifecycle, delegation and skill guidance across capability profiles without rebuilding the standing system prompt every turn. A scout remains available, not mandatory extra work for a simple map.
9. **Reflection has one explicit schedule.** Retain the intentional dedicated reflection mechanism, reconcile the contradictory standing wording, and make its admission bounded and evidence-driven. Do not run a post-failure memory sweep while the task is blocked on verification. No recursive reflection or repeated provider turns solely to re-read unchanged memory. Any further scheduling change must preserve cancellation, cue ownership and restart guarantees.
10. **Batch skill load is transactional.** Add a vault-owned batch admission path that validates all requested bodies, pin limits and aggregate capacity before committing. The final receipt describes the actual retained set. It must not report a skill as pending activation and evict it later in the same request. Single-skill loading delegates to the same owner. Do not raise capacity to mask the defect.
11. **Worker access comes from the grant.** The historical supposedly read-only workers held `filesystem.write` and `process.exec`; the reservation system correctly treated them as writers. Expose effective authority and provide a typed way to request a read-only subset during fresh admission. This can only narrow existing authority. Persistent-agent reuse must retain its admitted grant and reject attempted widening. Do not infer permission changes from words inside the task.
12. **Worker evidence projection is separate from provider replay.** Keep raw replay data in the conversation store. Project model-facing transcript pages without opaque provider signatures, preserving tool identities, results, final claims, byte bounds and cursor semantics. Status filtering either obeys its typed input or rejects it; it must not silently ignore a selector.

## Verification transitions

| Input | Required state effect |
|---|---|
| Executed test failure | Open/refresh the exact verification obligation |
| Trusted pass of equivalent verification, newer attempt | Resolve that obligation |
| Different suite/project/filter/environment passes | No effect on the failed verification |
| Setup/discovery failure | Retain unsuccessful setup attempt with repairable invocation context |
| Validated replacement of setup attempt followed by trusted pass | Resolve only the linked setup failure |
| Zero tests, skipped required probes, timeout or unknown exit | Never a passing verification |
| Stale/duplicate background terminal | Idempotent; cannot clear a newer failure |
| Model prose or arbitrary `kind: user` assertion | No verification-state mutation |
| Honest partial handoff | Preserve answer; keep unresolved state and prohibit successful goal completion |
| Restart/compaction | Restore the same obligations, attempt relationships and ordering evidence |

Canonical identity must not become a catch-all fuzzy matcher. Old raw-command receipts need an explicit restoration path from their original trusted call/result context. If the required context is absent, keep the limitation visible; do not silently declare the obligation passed.

## Implementation sequence and gates

Each phase begins with a focused failing regression and negative control. Finish the phase's smallest tests before expanding. No full local vitest or `npm test` run.

| Phase | Findings | Existing owners / target tests | Acceptance |
|---|---|---|---|
| 1. Evidence provenance | H01 | `runtime-builder.ts`, `tools/goal.ts`, goal state trust; `goal-evidence-verification.test.ts`, goal-tool tests | Diff/read/failed/sibling calls cannot certify tests; genuine receipts work; fabricated user authority fails |
| 2. Verification lifecycle | H02–H04, H14 | `shell-test-command.ts`, `bash.ts`, `verification-obligations.ts`; shell classifier, bash verification boundary, verification obligation gate, faux session regression | Exact incident sequence resolves correctly; unrelated/stale passes cannot clear; useful partial handoff survives |
| 3. Goal attribution and progress | H05, H12 | `GoalSessionController`, foreground lifecycle, existing progress governor | Mid-run creation charges once; changed/reordered read loops have measured handling; useful rereads remain legal |
| 4. Tool repair and search scope | H06, H07, H13, H14 | Recovery protocol/memory/gate, credential guard, delegate validation, memory tool | Action-specific errors are classified before mutation; repair survives projection; all search adapters agree |
| 5. Prompt and reflection contract | H08, H11, H16, H18 | Provider contracts, system prompt builder, reflection controller | Original 3,200-byte core budget restored; orientation/review distinction coherent; existing grants respected; reflection scheduling matches prompt |
| 6. Memory and skill lifecycle | H10, H15–H17 | Context threat scanner, file-store/OKF, skill vault/tool | Exact benign text accepted and malicious controls blocked; scoped memory discovery; drift preserved; atomic skill batch |
| 7. Worker admission and inspection | H19, H20 | Authority resolver/admission, worker control and transcript projection | Read-only subset is real; writers remain fenced; bounded useful transcript and honest selectors |
| 8. Integration and release | H09, relevant F3 | Doctrine, package changelogs, check/clone gates, release scripts/workflows | Every finding has a disposition and matching evidence; exact-SHA GitHub gates and release assets verified |

Names of new regression files will follow repository issue naming when an issue exists; otherwise use descriptive tests next to the authoritative owner. Session tests under `test/suite` use the faux provider and test harness. Do not add production code solely to satisfy assertions that mirror its implementation.

## Candidate closure rules

- H12 requires a deterministic progress/governor reproduction before changing stop policy. A successful read is not automatically progress, but rereading is not automatically a defect.
- H15 requires tests of actual file-store/OKF targeting and revision behavior. Do not overwrite external USER.md edits or turn a historical report into blanket permission to mutate user memory.
- H16 is partly model reasoning quality. Enforce provenance and supersession mechanically; label residual semantic judgment as a limitation. Do not promise that unit tests prove arbitrary prose true.
- H19's reservation-removal hypothesis is rejected by the durable grant and source evidence. Fix grant selection/visibility if the focused admission test reproduces the mismatch; preserve write fencing.
- Original F1–F7 remain documented. Do not remove provider integrations, change licensing attribution, merge upstream, refactor unrelated large modules, or reorganize all documentation merely to enlarge this repair. F3's duplicate manifest entry and doctrine consistency are directly relevant to the verification gate and will be handled with the changed contracts.

## Release proof

1. Review all touched production files for competing ownership and textual/semantic clones; verify scanner coverage and size ceilings.
2. Run each changed test and adjacent boundary tests. Restore the prompt-size invariant, fix every diagnostic, and run the full `npm run check` output once the implementation stabilizes.
3. Audit and update affected `[Unreleased]` changelogs and doctrine. Review the complete diff and exact file ownership before staging explicit paths.
4. Commit and push the candidate. Require every expected job of the exact-SHA `ci.yml` run to finish green.
5. Choose the release bump from the final public behavior/API changes, not from the word “fix.” Use the repository prepare/promote flow once; a failed gate does not justify another version bump.
6. Require release-commit CI and destructive workflow success, then the tag's binary/installer workflow. Verify archives, both installers and `SHA256SUMS` are published. Report the final version, commit, links and remaining non-automated limits.

## Implementation evidence and disposition

The following evidence supersedes the implementation journal. Every confirmed defect was reproduced with a focused failing regression and a negative control before its authoritative owner changed. Counts below describe separate focused runs, not a disjoint total. No paid provider or live user-session replay was used.

| Finding | Disposition and evidence |
|---|---|
| H01 | Fixed branch-local receipt and user-evidence provenance in `session-goal-evidence.ts` and canonical goal trust. Wrong-operation, failed, sibling, stale and fabricated-user claims reject; genuine passes and complete user quotations work. 251 adjacent tests; the final evidence file passes 47 including malformed persisted arguments. |
| H02, H14 | Fixed initial-cwd capture at serialized shell execution, literal argv identity, empty arguments, and hook/CDPATH mismatch certification. 96 parser/classifier/Bash/shell tests cover queueing, restart, changed filters/projects and opaque expressions. Historical migration and ambient-environment attestation remain limitations below. |
| H03 | Fixed direct-Vitest outcome observation and explicit setup supersession. A bounded raw-output observer rejects zero/all-skipped/incomplete/error runs regardless of display projection. Matching host scope, execution phase, provenance and ordering govern `repairOf`; compaction retains eligibility. 44 agent tests, 102 Bash/classifier/observer/recovery tests and 48 session/background tests pass. |
| H04 | Fixed destructive handoff retries. The original answer remains visible with unsuccessful host status; active obligations still block goal completion. Removed the obsolete retry option and runaway reason. 85 loop tests, 70 tracker/runaway tests and the faux-session failed-check/follow-up regression pass. |
| H05 | Fixed mid-run goal lease adoption and response/end accounting, including cancellation and final flush. Earlier unrelated usage stays excluded. 65 budget/continuation tests pass. Admission does not mutate time-only state, avoiding provider-plan revision churn. |
| H06, H07 | Fixed adapter-owned correction loss on first failure and replay, and search-adapter scope disagreement. Six focused correction tests, 138 loop/memory tests, 40 adjacent recovery tests and 18 credential/session tests pass. Direct argv does not inherit shell-variable exceptions. |
| H08, H18 | Fixed contradictory orientation/review and repeated-approval instructions across execution profiles without increasing the 3,200-byte core budget. 77 prompt/capability tests plus adjacent delegation tests; final authorization wording passes 48 prompt/stability and 31 capability/default tests. |
| H09, F3 | Removed duplicate contract registration and added a deterministic manifest gate with unique-entry control. Doctrine and changelogs describe the final behavior. Final staged coupling and exact-SHA release evidence are still required. |
| H10 | Fixed the exact benign-memory false positive at sentence/clause boundaries while retaining malicious controls. Scanner and actual memory write/retrieval tests pass; lexical limits remain explicit. |
| H11 | Reconciled the intentional host-scheduled reflection turn and blocked cancelled submissions from claiming a previous completion. Error/abort controls and 46 adjacent reflection/default tests pass. |
| H12 | Confirmed and fixed unchanged reads evading batch-cycle detection through reordered/shrinking batches. The provider-neutral tracker retains bounded operation/result hashes, not payloads. Actual file changes remain a negative control; malformed receipts and history expiry reset evidence. 141 tests pass across tracker, runaway and loop suites. Two older cycle fixtures intentionally stop one turn earlier; repair and handoff assertions remain intact. |
| H13 | Fixed action-dependent schema preflight for memory and delegate. Invalid calls report `invalid_arguments` before execution; corrected calls execute once in faux sessions. Default start, task aliases and plural wait remain valid. Storage drift/security refusals retain their existing completed-refusal semantics. |
| H15 | Fixed explicit hot-memory target selection and selected-project OKF discovery starvation under a one-document bound. Global fallback, project isolation, duplicate avoidance, symlink boundaries, drift protection and user-preference restoration into standing context pass 36 tests across four memory suites. This reproduces concrete defects, not every historical memory complaint. |
| H16 | Mechanically addressed through H01 provenance and H03 supersession. Arbitrary semantic correctness of reflection remains outside deterministic proof. |
| H17 | Fixed skill batch admission transactionally at the vault. Capacity, pin, missing/revoked member and byte failures leave prior eligible state intact; accepted batches commit once and retain every requested member. 71 skill/context/scanner/memory tests and final scanner controls pass. |
| H19 | Fixed authority selection and visibility: fresh `readOnly` only subtracts inherited authority; explicit write/process conflicts reject; reuse cannot override the admitted grant. Compiled grants contain no write/process paths. Missing, malformed or foreign-attempt grant metadata is never presented as read-only. 163 admission/projection/reservation/delegate tests pass. Write reservation removal is rejected: historical workers genuinely held write/process grants. |
| H20 | Fixed model-facing transcript projection before output sizing, including cold persisted payloads. A real lifecycle/store/coordinator test preserves useful text beside a 24-KiB opaque signature within a 2-KiB page; raw replay is exact, oversized input/output still advances cursors. 142 inspection/control/store tests pass. Unsupported status/review selectors reject before inspection or acknowledgement. |

## Rejected candidates and corrected probes

- Removing write reservations would broaden unsafe concurrency; the historical grant evidence instead requires honest authority selection.
- Broadly overwriting USER.md or scanning all memory trees is not a repair. Revision protection remains intact; explicit targeting and project-priority discovery address reproduced defects.
- A nonexistent OKF type initially made a schema test reject for the wrong reason. The fixture was corrected and independently rerun red before implementation.
- A delegate reuse fixture initially returned no result; a valid-result negative control then reproduced the ignored override. Missing attempt identity and foreign-task controls also failed the first grant projection and drove the final binding check.
- A handoff integration fixture initially omitted the goal capability and never reached the provider. Registering the verification tool as an extension exercised the intended path; the setup failure was not counted as a product defect.
- TypeScript caught malformed test tables and one expected call used the wrong arity. Corrected fixtures preserve the intended product invariants.
- The first goal timing change mutated admission revisions and failed deterministically. Time commits now occur only at response/end boundaries.
- Earlier root runs with truncated output are not full review evidence. A later complete root run must cover the final tree and staged doctrine.
- Windows CI exposed a simulated POSIX verification adapter using host-default Windows routing. The fixture now pins its backend and asserts both invocations executed; this is not evidence of a production receipt defect.

## Limits and release gate

The first exact-candidate GitHub run (`34022232537`) rejected two outdated fixtures, a missing
coverage-suite entry, and prompt/schema budget overruns. The fixtures now exercise unqualified
memory listing and trusted oversized evidence. The setup-repair suite is included in its coverage
gate, with an unknown-phase negative control; all obligation line/function thresholds pass.
Equivalent action branches compact at the shared provider projection only, preserving authoritative
local validation and repair text. Core prompt wording is shorter; the 3,200-byte, 4,500-token total,
and 875-token delegate ceilings remain unchanged. New exact-SHA CI evidence is required.

Final local review found and fixed a same-batch evidence-selection defect: an exact command
citation could choose an earlier pass over a later failed call in the same assistant message.
Both focused cases failed before `findLast` replaced `find`; explicit call-ID controls remained
valid. All 114 tests across evidence, goal core/tool and panel suites pass after the correction.
The preceding complete root check passed all stages, including 2,145 Biome files, TypeScript,
browser smoke, 34 installer/binary tests and zero clones across 937/946 eligible/owned files
(907 above the detection floor). The commit hook must rerun that gate on the final staged tree.

Historical raw-command receipts are not rewritten or silently migrated: they lack a trustworthy initial execution directory and environment snapshot. The new canonical identity prevents recurrence for supported literal commands. An old unresolved receipt remains unresolved rather than being guessed equivalent; no live transcript was edited. Automatic recovery of those old receipts is not delivered by this change.

Command identity attests literal invocation and observed execution location, not all ambient shell state, test configuration or code contents. Explicit setup repair proves a previously empty invocation was replaced by an executed pass with matching arguments within the workspace; it cannot attest the adequacy of test coverage. Other runners and opaque wrapper scripts retain their existing exit-status semantics. These are remaining verification risks, not passing probes.

Credential and memory threat checks are lexical, not OS isolation or semantic intent recognition. Source provenance is not cryptographic human attestation. Prompt tests prove emitted instructions and budgets, not model obedience. Reflection tests prove scheduling and mechanical gates, not arbitrary learning quality. Out-of-process worker cost completeness is unchanged.

The production clone gate validates owned/eligible coverage and the unchanged 50-token floor and 20,000-line/2-MiB ceilings. Final full check, staged doctrine, candidate CI, release CI/destructive gates and tag asset workflow must be recorded before release completion. The installed npm emits an external `globalignorefile` warning from its own npmrc; repository diagnostics are handled separately and no user-level configuration is modified.
