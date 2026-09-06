# Session 01a074d4: harness failure audit and regression requirements

Audit source: `~/.pi/agent/sessions/--%2Fhome%2Fcaudev%2FGitHub%2Fmine%2Fpi-adaptative--/2026-09-06T03-47-54-547Z_01a074d4-7033-70c2-be81-d0e5b58d71a5.jsonl`.
`L` references below are physical JSONL line numbers, not rendered chat lines.
Source baseline: `dfc736889716fe90b23b32e899fbcb16d460110c`, with the session's eight uncommitted files still present.

The requested order is diagnosis, implementation design, development, tests, commit, push, and release. This document completes the ranked diagnosis and defines regression requirements; it does not claim the implementation or release is complete. The latest user instruction authorizes eventual commit, push, and release. The old session's no-commit instruction describes that session, not the current authorization.

## What actually happened

- The session contains 1,300 records, 129 assistant messages, 129 request snapshots, 292 tool calls, 293 tool results, and **15 errored tool results**. The extra result is not by itself evidence of a broken tool protocol. The user's “seven failures” was an earlier conversational count, not the final incident count.
- The initial request was “evaluate this repo, deeply” (L10). The user subsequently clarified “look around, not judge” (L555). A deep review was a plausible initial reading; the unsolicited policy verdicts and refusal framing were the avoidable overshoot.
- The session proposed W1 recovery guidance, W2 harness receipt search access, and W3 orientation behavior (L875). The user authorized all three (L915). Eight files were edited; none were committed.
- Tests were run after implementation. The first new agent test failed because its tracker fixture omitted required input, not because the intended invariant was red (L1153). Later, a real prompt-budget failure was silenced by changing 3,200 to 3,400 bytes (L1212–L1217).
- At L1255 the goal recorded test evidence as verified using a `git diff --stat` call. At L1285–L1286 the harness blocked the goal after withholding three tool-free answers because two verification identities remained unresolved. The final answer at L1299 contained only internal verification identifiers and reasons.
- Recorded foreground usage totals are 1,086,368 input, 74,862 output, and 16,780,288 cached-read tokens. These are provider accounting categories across repeated requests, **not** 17.9 million fresh tokens, a cost estimate, or a complete worker-tree usage total.

## Ranking and evidence standard

Priority 0 is acceptance-integrity critical. Priority 1 blocks reliable completion or creates substantial repeated waste. Priority 2 is a bounded correctness or workflow problem. Priority 3 is maintenance. Severity and confidence are separate.

“Reproduced” means a deterministic current-code probe with a control. “Observed” means directly present in the session. “Source-supported” means the current implementation explains it but a focused regression remains necessary. “Candidate” means do not change behavior on this evidence alone.

| Rank | Finding | Evidence status | Priority |
|---|---|---|---|
| H01 | Goal evidence can certify the wrong operation, or mere answered calls | Observed; current source supports it | 0 |
| H02 | Equivalent test reruns produce different verification identities | Reproduced; original session replay reproduces two stale obligations | 1 |
| H03 | A wrong-directory/no-tests invocation creates a success-only obligation with no repair transition | Observed; current source supports it | 1 |
| H04 | Verification enforcement suppresses useful handoffs and converts internal bookkeeping failure into a blocked goal | Observed; enforced by current tracker | 1 |
| H05 | Goals created during ordinary work report zero usage throughout substantial work | Observed; accounting ownership gap is source-supported, not independently reproduced | 1 |
| H06 | Failure guidance substitutes generic readmission text for the actual repair | Observed; W1 partially addresses it | 1 |
| H07 | Credential search policy omitted the actual receipt root; adapters disagree | Original failure observed; W2 focused test passes; adapter disagreement source-supported | 2 |
| H08 | W3 adds a blanket phrase rule without implementing the promised routing contract | Current diff and builder show incomplete implementation | 1 |
| H09 | Validation claims exceed regression coverage; a failing gate was weakened | Observed and current Biome failure reproduced | 1 |
| H10 | Memory threat scanner confuses descriptive prose with exfiltration instructions | Reproduced with benign and malicious controls | 2 |
| H11 | Reflection schedules extra work despite a standing “never add a provider request” contract | Six reflection turns observed; source contracts contradict | 1 |
| H12 | Successful repeated reads evade useful progress detection | Observed; governor defect remains a candidate | 2 |
| H13 | Action-dependent tool requirements arrive too late and as the wrong failure class | Delegate and memory receipts observed | 2 |
| H14 | Persistent shell cwd causes repeated wrong-path operations and weak recovery | Observed; persistence itself is intentional | 2 |
| H15 | Memory targeting/drift leaves preferences outside their intended standing context | Observed limitation; automatic reconciliation safety not established | 2 |
| H16 | Self-analysis makes unsupported causal claims and persists overgeneralized rules | Observed | 2 |
| H17 | Batch skill loading immediately evicts skills requested in the same call | Observed | 2 |
| H18 | Authorization wording encourages redundant approval instead of applying existing scope | Observed friction; prompt issue, not a proven permission-engine defect | 2 |
| H19 | Read-only task descriptions received write-capable grants and serialized | Durable grant evidence found; reservation bypass for genuine read-only grants already exists | 2 |
| H20 | Worker inspection returns oversized protocol material and unrequested status rows | Observed; presentation/API contract candidate | 2 |

## Findings and required regression design

### H01 — Evidence existence is being mistaken for evidence validity

L1251 cites `packages/agent/test/tool-failure-memory.test.ts` for “50 passed; …30 passed; …6 passed.” L1255 resolves it to the call ending `_264|…_1`, which is the L1236 `git diff --stat` command. L1266–L1268 use that one entry to satisfy all three requirements. Actual passing test results exist elsewhere; the recorded proof points at the wrong operation.

`runtime-builder.ts` exports `hasAnsweredToolCallOnBranch`, which checks for a result without checking success, and `findAnsweredToolCallOnBranchByText`, which accepts a substring in any string argument. `tools/goal.ts` treats `kind: test` like generic tool evidence. Existing `goal-evidence-verification.test.ts` tests even use a `read` result as proof of a test run. The same test file allows model-created `kind: user` evidence without an authoritative user-message reference; this is a related acceptance bypass candidate, not evidence that the original user statement was fabricated.

Required tests: reject diff/read/echo calls mentioning test paths; reject failed, canceled, unanswered and wrong-branch calls; require a trusted passing verification receipt for test evidence; accept an exact genuine passing receipt. Ambiguous command-text locators must not silently select a newer unrelated call. User-confirmation evidence needs a genuine source and cannot be manufactured by selecting an enum. Do not solve this by making every successful tool count as a passed test.

### H02 — Verification identity changes when only invocation spelling changes

`tools/shell-test-command.ts` hashes raw command text plus cwd. The same agent test appears as `cd packages/agent && …`, then bare `npx vitest …`, then `cd /absolute/path/packages/agent && …`. Their IDs differ. L1153's failure is never cleared by the passing runs at L1192, L1204, or L1239.

An offline replay of the complete message stream through the current `VerificationObligationTracker` retains exactly the final two unresolved IDs. A controlled same-ID pass clears correctly. A controlled equivalent absolute-cd wrapper produces a different ID, while an exact repeat is stable and a different cwd remains distinct.

Required tests: normalize only proven equivalent invocation shapes and effective execution locations; preserve distinctions in suite, filter, environment and project. Exercise relative/absolute cd, runner argv, multiple verification stages, quoting, resume, stale background passes, and duplicate receipts. Use synthetic files and faux providers, not a replay against a live provider.

### H03 — Setup/discovery failure has no authoritative supersession path

L1198 ran coding-agent tests from the agent package and found no tests. L1212 and L1230 ran them from the correct package, but the original ID stayed active. Merely including cwd in a better hash must still distinguish different projects; equating all commands with the same test basename would hide real failures.

Required tests: classify invocation/setup failure separately from executed failing tests; a repaired invocation must explicitly and authoritatively supersede the failed setup attempt. Unrelated passes, zero-test exits, skipped probes, stale results, and matching filenames in another package cannot clear real failures. Define this transition at the verification owner, not in model-authored prose.

### H04 — The final-answer gate destroys the useful delivery

`verification-obligations.ts` accepts only one `VERIFICATION_UNRESOLVED` line per active ID when unresolved; `enforceTerminalMessage` otherwise replaces content with an empty array. The session then records three withheld answers, `verification_handoff_stall`, and a blocked goal (L1277–L1286). L1299 proves the visible result: no implementation summary or review handoff, only IDs.

This is not proof the provider failed to write an answer. The persisted error and host event are stronger evidence of host suppression. The tracker must prevent unsupported success claims while preserving a useful explanation of partial work and unresolved checks.

Required tests: unresolved real failure prohibits successful completion but permits an honest work summary; stale bookkeeping cannot consume repeated paid closing turns; cancellation and provider errors preserve diagnostics; user-facing handoff does not require internal JSON/opaque IDs as the entire answer. Coordinate this with H02/H03 rather than removing verification enforcement.

### H05 — Goal accounting is disconnected from goal creation in ordinary turns

Both goal checkpoints and repeated goal responses show zero tokens and zero active time despite substantial provider usage (L35–L407, L921 onward). `GoalSessionController.recordExecutionUsage` returns without an execution lease. `AgentSession` permits adoption only when `goalToolStartAuthority` exists, while the goal tool advertises discretionary creation. That is a likely ownership mismatch.

The first call also requested an unsolicited 80,000-token budget, which the host did not retain. Stripping an unauthorized model-invented budget is not itself a defect. The missing accounting remains separate.

Required tests: create a goal mid-foreground turn without an explicit goal phrase, charge subsequent responses once, flush usage on completion/error, preserve cache weighting, and avoid attributing preceding/unrelated work. Test existing goals, replacement rejection, continuation, steering and worker usage independently. Reproduce before changing lease behavior.

### H06 — Recovery guidance obscures repairs and overstates the W1 fix

L100/L595 retain the useful glob instruction in `diagnostic` but put generic “another tool succeeds” guidance in `next_action`. Delegate input errors at L187/L331 get the same generic recovery, despite providing exact repairs. W1's `executionFailureCorrection` special-cases only `credential_access_blocked` and is wired only into executed-failure finalization.

Required tests: first block, identical replay, argument repair, ordinary execution error, policy block, and resume through the actual agent loop/provider request. Keep the original correction on repeated failures. A string-helper test and unequal hashes do not prove repaired calls are admitted. Preserve the distinction between tool failure and completed negative operation outcome.

### H07 — Receipt search access is incomplete and duplicated by adapter

L595 proves a broad-search refusal under `work/context/sessions/<id>`. W2 now uses `getWorkTenantDir(agentDir, "context", "sessions")`, preserving refusal for the whole work root. Its targeted test passes. However builtin `grep` still has separate explicit-file/glob rules and does not consult the harness-owned root rule that bash/run_process use.

Required tests: intended same search through bash, direct process and builtin grep; protected files/directories, dotenv, parent traversal, symlinks and Windows paths; a mixed permitted/protected command must remain blocked before execution. Do not whitelist all work/runtime/state storage just because the harness owns it. The lexical credential guard is not an OS sandbox.

### H08 — Orientation is a phrase patch, not the promised design

The diff adds `ORIENTATION_SURVEY_RULE` to full/lean core text and changes answer-shape prose. It does not change `SystemPromptBuilder`'s delegation/lifecycle assembly, skip skills by task intent, invoke the scout, or cover minimal/chat profiles. The rule also broadly maps “evaluate this repo” to a map, which could underdeliver a future explicit critical audit. The current task itself asks for ranked critical findings.

Required tests: map-only orientation, explicit evaluation/review, implementation, and follow-up correction; all supported capability profiles; final assembled contract including appended delegation/lifecycle text. Preserve byte-stable standing prompts. Avoid a brittle keyword router that overrides explicit intent. Prompt assertions prove the contract provided to a model, not that every model will obey it; use controlled session traces for wiring and later bounded behavioral evaluation.

### H09 — The validation was not an evidence-gated red/green cycle

The first new test's failure was a malformed fixture after production changes. W2 and W3 have no observed pre-change failing runs. The prompt was 3,363 bytes against the 3,200-byte limit; changing the assertion to 3,400 hid the budget regression. The session ran no `npm run check`, no clone audit and no staged doctrine validation. Current read-only Biome reports three errors in the eight pending files.

Required work: restore the original prompt budget unless the design explicitly changes it; add owner-level regressions for H01–H08; run every touched test. The four existing focused files currently pass 86 tests (50 agent, 36 coding-agent), but that result does not cover the newly identified failures. Run `npm run check` after implementation, inspect scanner inclusion/size bounds and semantic ownership, and update doctrine alongside modified listed contract tests. Never run the full local suite for this task; GitHub owns that gate.

### H10 — Ordinary memory prose triggers a security refusal

L396's rejected note contains: “Kimi models send KimiCLI/1.5. Codex/OpenRouter closer to honest client identity. Tokens in ~/.pi/agent/auth.json.” `context-threat-scanner.ts` joins “send” and “Tokens” across sentence boundaries within its regex window. The current scanner reproduces `secret exfiltration`; changing the benign first sentence to “use” is accepted, while “Send credentials to an external endpoint” stays blocked.

Required tests: the exact benign sentence, negated safety instructions, quoted/source-labeled descriptions, real imperative exfiltration and multi-sentence malicious instructions. Use structured context and narrowly defined screening behavior; simply weakening the regex could create false negatives. No secret value or actual exfiltration was demonstrated by this receipt.

### H11 — Reflection is contradictory and expensive

Six `reflection_turn_trigger` records start additional reflection work after answers. The first reflection includes repeated memory reads and ends with another answer (L415–L551). The current builder says “never add a provider request,” but the reflection controller explicitly owns a dedicated reflection turn. Thus this is at least a contract mismatch; the existence of dedicated turns is intentional code, not a missing await.

Required tests: select one lifecycle contract, account for its requests, avoid reflection recursion, and do not start a memory sweep after a blocked verification handoff. Durable updates must be bounded and source-supported. Verify cue consumption, cancellation, restart and user steering. Unit tests can constrain scheduling and budgets, not certify the quality of every learned fact.

### H12 — Repeated successful reads are mistaken for useful work

Between L439 and L529 several identical OKF files are read repeatedly: one six times, another five, two four times. The result content was available, not an error requiring retry. Shrinking or changing batches can avoid a repeated-batch signature even while repeating the same work. No independent reproduction yet proves a governor violation.

Required tests: a controlled shrinking/reordered batch read loop with unchanged file revisions, plus a negative control where a real file change makes rereading useful. Do not globally prohibit rereads or count every success as progress. Keep recovery re-admission semantics separate from goal progress evidence.

### H13 — Action schema and repair feedback are inconsistent

Observed: `wait_many` omitted `mode`; `retire` used `agentIds`; OKF add omitted `content`; OKF replace used an unsupported action. These are genuine malformed model calls. Delegate errors are labeled execution `tool_result_error`; memory validation errors are completed `operation_outcome`. W1's credential-only path will not fix either family.

Required tests: validate action-dependent fields before side effects; retain exact input corrections; ensure rejected calls do not count as successful progress; forbid accidental plural-to-singular truncation. Model-visible schema/help must agree with runtime validation. Do not introduce permissive fallbacks that silently change intent.

### H14 — Persistent cwd needs a consistent execution contract

After `cd packages/agent`, L1160 and L1198 assume repository-root paths. After changing to coding-agent, L1220/L1232 repeat another wrong relative path. The shell already documents persistence and reports cwd on failures, so removing persistence would be an intentional feature removal, not a routine fix.

Required tests: expose effective cwd consistently, keep preparation/credential checks and verification attribution aligned with the execution location, and serialize shared-shell mutations. Include failed cd, timeout/reset, successive cd commands and parallel batches. Never infer cwd solely from a successful-looking command string.

### H15 — Memory scope and drift impede useful preference storage

`memory list` with project/user/memory targets returns the same full hot-memory listing (L422/L424/L426), while `target: okf` initially shows only the user-preference index (L420); the model then traverses files manually. USER.md drift is reported, and the look-around preference is stored as project OKF instead. The session contains no failed USER mutation proving all possible updates were impossible.

Required tests: target-specific discovery, project OKF visibility, accurate drift diagnostics and safe revision-conflict handling. Preserve external edits. Verify that an accepted user preference reaches the intended context without needing a whole memory-tree scan. Do not automatically overwrite drifted user files.

### H16 — The diagnosis itself became unreliable memory

The agent claimed the “same failure_key twice,” but L100 and L595 have different keys and occurrence 1. It first attributed the initial next_action to `BLOCKED_REPLAY_CORRECTION`, then corrected the attribution. It claimed W1 alone would prevent failures 3–7, although missing delegate fields and missing OKF content have unrelated causes. It persisted broad orientation and policy judgments as durable notes. Older contradictory notes remained discoverable after an unsupported replace action failed.

Required tests/evaluation: preserve receipt identities and source provenance; supersession must be explicit and discoverable; descriptive findings must not become permission restrictions. A synthetic reflection trace should reject unsupported causal/generalized claims. Do not claim a unit test can prove arbitrary natural-language conclusions true.

### H17 — Skill-load admission is self-defeating

L43 loads five requested skills and evicts two of those same skills. L68 reloads one and evicts another. The response discloses eviction, so this is not silent data loss, but it creates predictable extra turns and confusing active context.

Required tests: batch admission beyond capacity, pinned entries, deterministic retained set, no evict-then-reload oscillation, and accurate activation receipts. Pick required skills before admission; do not increase a context budget without measuring its cost.

### H18 — Approval language loses already-authorized intent

W2 was repeatedly presented as owner-gated while the conversation was already about fixing the identified harness issue. L915 eventually supplied explicit implement-all authorization. Current self-modification prompt says “Always ask before publish/push/tag/release”; without qualification it also conflicts with the current user's explicit release instruction.

Required tests/evaluation: unapproved destructive or external actions still require authority; an explicit current-session grant is retained across planning and execution; a new scope expansion still requires a decision. Explain the actual source of any approval requirement. Do not remove policy enforcement to reduce conversational friction.

### H19 — Read-only delegation bought little parallelism

All three tasks explicitly request read-only work in the same repository (L83). L193 reports one running and two queued; L213 reports one running, one queued, one terminal. Two five-minute `wait_many` calls time out while later workers remain nonterminal (L204/L226). This is consistent with explicit workspace collision fencing and does not prove a deadlock. It does undermine the promised speed benefit if read-only work needlessly takes exclusive reservations.

Follow-up evidence: the session's durable orchestration snapshot `events/snapshots/0000000000000512.json` retains an adaptive profile with `filesystem.read`, `skill.read`, `process.exec`, and `filesystem.write`, with both read and write paths covering the repository. The actual grants were therefore write-capable despite the task prose. Current `WorkerWriteReservationCoordinator.acquire` bypasses reservations for `!plan.writeEnabled`; `WorkerWriteReservationStore.acquire` also immediately grants `access: read`. Do not remove collision fencing: investigate task/grant projection and make the chosen authority visible.

Required tests: shared read-only versus exclusive write reservations, explicit path authority, worker capacity, and cancellation/release waking waiters through events. Preserve conservative fencing where effective tools can mutate. Verify current settings/grants before deciding that serialization is a defect. A wait timeout is not permission to cancel or restart a healthy worker.

### H20 — Worker inspection exposes more transport detail than useful evidence

L211/L224/L234 transcript responses are approximately 10–12 KB and include thinking/text signatures and encrypted provider reasoning payloads inside JSON. The agent then guesses pagination cursors and retrieves more transcripts. L193's singular status request and L213's subset request return the whole fleet. These are observed output/retrieval costs, not evidence of plaintext credential exposure.

Required tests: model-facing transcript projection omits opaque transport signatures while durable replay retains what the provider needs; bounded pagination returns a reliable next cursor and complete final claims; status scope matches its documented request contract or rejects unsupported filtering fields explicitly. Verify the current tool owner before changing public behavior.

## The seven findings from the original repository review

These are included for completeness. They are not automatically part of the harness repair release.

| Original finding | Revised ranking and disposition |
|---|---|
| F1 subscription client identities | Protocol/header choices are source-visible. The session did not establish an exploit, token leak, account ban, legal conclusion, or a confused-deputy attack. Treat as a separate provider compatibility/documentation topic, not the highest-priority harness defect. No provider feature removal is authorized by this audit. |
| F2 large coordinators | Priority 3 structural maintenance. Settings manager's size and exclusion from a selected coordinator allowlist are real. A 4,000-line limit on named coordinators is not automatically a global limit; size alone does not prove a defect or require a broad refactor. |
| F3 contract/doctrine manifest | Priority 2. Current manifest has 26 entries, 25 unique, and the gate reads only listed paths. Audit the intended pin set explicitly; not every test cited in prose must necessarily be a contract. Changes to listed tests require a doctrine update. |
| F4 fork identity | Priority 3 documentation. Root package version 0.0.3 and workspace version 0.98.5 have different owners. CONTRIBUTING's upstream references may confuse users. An unchanged MIT copyright line is not proof of a licensing defect; preserve attribution. |
| F5 documentation sprawl | Priority 3 information architecture. Dated plans alone are not a product failure. Some specific root handoff paths in the old answer were not established by the displayed directory inventory; revalidate before describing them as current files. |
| F6 scratch directories | Priority 3 hygiene. The committed ignore file lacks `.scratch-*`; local excludes cover a subset. No accidental committed secret or scratch artifact was demonstrated. Add scoped ignore rules only after checking what the directories contain and own. |
| F7 upstream divergence | Strategic observation, not a repair defect. 1,892 behind/1,655 ahead was the local-ref comparison. It does not prove current upstream freshness or merge difficulty, and does not authorize merging/rebasing upstream. |

## Rejected explanations and limits

- “The diagnostic vanished”: false for the initial credential blocks; it is intact in diagnostic. The problem is competing recovery guidance.
- “Repaired calls need a new retry mechanism”: unsupported. Different arguments already create a distinct operation. Verify the existing admission path before adding another.
- “Every nonzero shell exit was an infrastructure error”: false. Several results correctly use `operation_outcome` and preserve actual command output.
- “The session exposed a secret”: not demonstrated. H10 is a reproduced false positive on descriptive text.
- “Missing same-named tests means untested code”: false; several owners have differently named focused suites.
- “The 86 passing tests prove the fix”: false; they pass while H01/H02/H03/H04 remain.
- No full local suite, live OAuth, paid provider replay, upstream merge, installer publication, or release was performed during diagnosis. Worker internals, goal accounting, guard path edge cases and memory revision recovery still need bounded reproductions. Request snapshots contain fingerprints and entry IDs, not full raw system prompts, limiting proof of the exact historical prompt wording.

## Design and release handoff

Implementation order should start with evidence integrity and verification lifecycle (H01–H04), then goal usage/progress ownership (H05/H12), recovery and shell/search consistency (H06/H07/H13/H14), and coherent orientation/reflection/memory behavior (H08/H10/H11/H15–H18). Repair the invalid validation process throughout (H09), not as a final cosmetic step.

The design must explicitly settle verification identity versus supersession, honest partial handoff, evidence provenance, and reflection scheduling before changing those state machines. Keep one authoritative path for each transition and ports for process/storage/provider boundaries. Preserve the existing eight-file work as migration input, not as already accepted fixes.

After implementation: run targeted regression files, the complete `npm run check` output, ownership/clone coverage review, and focused standalone installer/binary regressions. Audit changelogs; commit only reviewed task files; push the candidate; inspect every exact-SHA `ci.yml` matrix job. Use the repository prepare/promote release flow, require destructive CI, then verify the tagged asset workflow and installers/checksums. No release-ready claim before that evidence exists.
