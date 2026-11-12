# Harness interaction register and investigation ledger

## Scope and evidence: 2026-11-11

The investigation covers November 11 in `America/Sao_Paulo`:
`2026-11-11T03:00:00Z <= timestamp < 2026-11-12T03:00:00Z`, through the available
recorded activity at `2026-11-12T01:47:44.520Z`. Harness filenames use UTC, so both
`~/.pi/agent/logs/harness/harness-2026-11-11.jsonl` and `harness-2026-11-12.jsonl`
were inspected. Session inclusion used entry timestamps, including older resumed sessions.

Luna scanned 271 foreground session files; three had activity in the window, all in this
repository. Their IDs are `01a1cbe1-4f88-7689-85e7-b24a9344704e` (286 entries),
`01a1cbee-dbfc-79ef-b944-96d68db950ae` (4,116), and
`01a1cd65-5372-7f16-943a-777cc79a3908` (353). Private evidence remains in the
existing Pi agent directory; no session, state, credential, or runtime installation was modified.
The decision ledger was opened read-only.

The 545 harness records include 281 cache-prefix warnings, 167 parked chat items, and
52 bounced tool calls. These counts are observations, not 500 separate defects. The cache
warnings name assistant (253), user (24), tools (3), and system (1) divergence. Of the parked
items, 165 report missing measured usage. Provider refusals, invalid arguments and expected
cancellations were distinguished from harness defects.

## Shared things and ownership

| Shared thing | Owner | Participants and signal | Required invariant |
| --- | --- | --- | --- |
| Current request-only knowledge and wire position | Kernel request materializer; knowledge owners supply a current projection | Root memory controller and worker knowledge broker supply `HOST_REQUEST_ONLY_DETAILS`; provider planner converts, measures and dispatches the same sequence | Unchanged knowledge stays in place as history grows; correction/forgetting/withholding takes effect immediately; projected values never become durable history or compaction input |
| Summary response accounting and subsequent dispatch | Completion usage owns receipts; shared summary spend owns persistent admission; adapter coordinates physical settlement | Physical response settlement updates the exact durable token; runtime reads `dispatchHold`; physical admission checks spend under the same lock | Each identity has one physical request; unknown/unretained usage holds new work across restarts; old completions cannot clear newer failures; validated physical cost counts once |
| Worker writable scopes and execution workspace | Reservation owner defines applicability and confinement; shared worker admission applies them before creation | Execution-plan admission, worker creation and reservation persistence consume the same scope rule | A forbidden scope requiring reservation is refused before worker creation; the existing machine-authority exemption remains; diagnostics retain the actionable reason |

The intended precedence is explicit: current knowledge and privacy override cache reuse;
an accounting hold refuses undispatched work while dispatched receipts settle with their original
owner; execution-workspace confinement overrides model-supplied mutation paths.

## Action pairs and handoffs

| Action A | Action B on the same shared thing | Source-reviewed outcome |
| --- | --- | --- |
| Append assistant/tool messages | Rebuild the same live knowledge | Confirmed positional conflict when knowledge occupied the tail; materializer now inserts it after the fixed host head and before growing history |
| Correct or withhold knowledge | Reuse the previous projection | Replacement remains immediate; it is not persisted or pinned to a stale value |
| Fail a physical summary's accounting | Claim another queued summary | Confirmed cross-node admission gap; the shared circuit now holds claims and physical dispatch |
| Recover after a hold | Admit several concurrent jobs | Only one physical recovery request acquires the half-open slot; other undispatched jobs are released |
| Complete an older request successfully | Keep a newer accounting failure held | Recovery can clear only the exact circuit generation its request acquired |
| End logical work | Receive a late physical accounting failure | Physical settlement still updates the captured owner and lane circuit |
| Accept an absolute worker mutation path | Reserve it under a confined execution root | Shared admission now refuses invalid scopes before worker creation; persistence retains its own check through the same rule |

These are source-reviewed scenarios and prepared regression coverage, not executed composition
proof. Negative controls are listed with each finding below.

## Findings and repairs

### H-20261111-1: summary backlog continues after usage accounting fails

**Evidence.** UTC November 11 harness lines 17–182 contain 165 distinct node failures between
18:40:07.909Z and 18:42:35.559Z. Each has `attempts: 1` and the reason
`The provider ended without reporting measured usage.` This is fresh work across the backlog,
not 165 retries of one node. The records do not establish how many requests incurred a charge.

**Witness.** A physical response fails `CompletionResponseUsage` validation; its durable receipt
remains unresolved. `continuous-chat-runtime` finishes that item's failure and asks the scheduler
for another item. Previously `ContinuousChatCompactionAdapter.dispatchHold()` saw only measured
daily spend and provider admission refusals, so the accounting failure did not inhibit the next
physical dispatch.

**Repair.** `core/cost/completion-response-usage.ts` exposes typed physical settlement with the
available measured cost and original failure cause. `core/memory/continuous-chat-spend.ts` owns a
versioned bounded file under its existing shared lock. Every physical request claims a durable
token for the session/provider/model/API/base-URL identity before transport. Daily spend is checked
under the same lock; validated measured cost and token settlement are written atomically, including
unhealthy and late responses. Schema 2 freezes the host's physical-response observation time before
journal I/O, charges that UTC day across retries, and retains earlier known charges as a bounded
aggregate rather than inferring lifetime spend. It reads legacy and schema 1 state without inventing
earlier amounts. A backward clock that precedes the active day refuses admission. The earlier
aggregate-success-only charging path was removed.

One physical request per identity runs at a time, replacing the former up-to-eight concurrent
summary requests for that identity. The final protocol distinguishes a durable reservation from
an attempted physical request. A proven-dead, undispatched reservation retires its matching usage
admission before entering a 120-second hold. An attempted request with no recoverable receipt
remains an account-wide unresolved hold. Foreign or uncertain ownership also refuses new summary
spending; a healthy unrelated reply does not settle an unknown bill.

Known receipts reconcile across session/model keys before the shared daily-cap decision. The
existing semantic sidecar retains summary evidence until both canonical persistence and exact-token
spend acknowledgement succeed; the meter keeps its token fenced through that acknowledgement.
Day rollover preserves obligations and archives only known measured amounts. State read/write
errors refuse new work, and ambiguous atomic replacements retry without duplicate cost. A retained
retry alarm continues after logical retirement without keeping the process alive. Capacity pruning
removes only fully settled or expired-held tombstones, never a pending acknowledgement or receipt.

`continuous-chat-compaction-adapter.ts` coordinates these effects and uses the spend owner's injected
timer port, so backoff and admission share one clock. `continuous-chat-compaction.ts` releases
undispatched work refused by this typed hold rather than failing unrelated nodes.

**Controls.** Measured retained responses do not arm a hold; an older success cannot clear a newer
failure; admission refusal/cancellation does not invent a paid response; a failed recovery admission
cannot repeatedly reopen the whole backlog. Regression coverage is prepared in
`packages/coding-agent/test/continuous-chat-accounting-circuit.test.ts`.

Additional regression coverage is prepared in
`packages/coding-agent/test/continuous-chat-spend-durable.test.ts` for independent owner instances,
dead/foreign/unknown ownership, day rollover, atomic admission limits, strict legacy migration,
corrupt/newer versions, capacity, and injected post-rename claim/settlement failures.

**Limits.** Legacy unknown receipt evidence stays unknown: old records lack enough endpoint identity
to reconstruct exact historical circuit keys. New linked claims can replay known receipts, while a
genuinely unmeasured or unavailable receipt cannot be assigned an invented amount. The daily limit
admits against measured settled/recovered spending, not projected reservations
for all outstanding identities, so responses already dispatched can settle above it. A live or
unverifiable owner is not reclaimed by a timeout. Fix verification is source/static only, unproven at
runtime. Stop pre-fix runtimes before using the new shared spend format: their old writer replaces
the file with `{day,usd}` and would erase new admission records. This task changed repository code,
not installed or running Pi processes.

### H-20261111-2: unchanged live knowledge shifts with every history append

**Evidence.** The last foreground session records its first request at line 9 with five messages,
then requests at lines 19 and 26 with eight and eleven messages and first differences
`assistant@4` and `assistant@7`. UTC November 12 harness lines 4–5 record the same warnings.
The source mechanism is shared by root `memory-controller.ts` and
`delegation/worker-knowledge-context.ts`: both supply request-only knowledge, which
`kernel/transient-records.ts` formerly passed through to the request tail.

**Witness.** Request N sends `[history, live knowledge]`. A new assistant/tool result extends
history. Request N+1 sends `[history, new messages, same live knowledge]`, replacing an already
sent knowledge position with an assistant/user message despite no knowledge change.

**Repair.** The transient adapter partitions explicitly marked request-only projections separately
from unidentified fallback transients. The provider materializer inserts those projections after
the fixed carried/frame head and before compactable history. Its measurement and admission envelope
use the exact converted counts, including text-protocol guard offsets. The live projections never
enter pending durable records; unmarked fallback transients retain their existing tail behavior.

**Controls.** No-frame worker requests and framed root requests both preserve the unchanged prefix.
Corrected and withheld knowledge replaces the previous projection immediately. Non-compactable
admission includes live knowledge and trailing obligations; measurement uses the dispatch layout.
Coverage is prepared in `packages/coding-agent/test/request-only-context.test.ts` and
`packages/coding-agent/test/request-snapshot-fingerprints.test.ts`.

The follow-up repair carries the exact final-wire request-only range into the shared snapshot owner.
Only when exact system, tools, reasoning and all previous non-projection history match does custody
sanction a projection replacement. Normal history append is allowed; simultaneous unrelated edits
are not. The recorded `prefixIntact` stays false so cache-survival statistics remain honest. Exact
JSON-visible, property-order-preserving hashes supersede truncated comparison when available;
unsupported hooks, accessors, cycles or excessive traversal decline proof. Tool hashes reuse the
registered immutable tool objects; message hashes invalidate with content revisions. Coverage includes
prompt tails beyond 32 KiB, more than 256 blocks, nested argument order, changed revisions, removal,
and simultaneous unrelated edits.

**Limits.** This explains a reachable source defect and the recorded divergence shape, not every
one of the 281 warnings. Proved knowledge-only changes are now sanctioned; incomplete proof and
unrelated turn-frame, history, tool, reasoning or system changes remain visible. Actual
knowledge changes now invalidate a larger suffix because the live slot precedes growing history;
observed cache reuse was already often about 0.98. No cost reduction is claimed or measured.
Fix verification is source/static only, unproven at runtime.

### H-20261111-3: invalid worker write scope creates a lane before refusal

**Evidence.** The last foreground session line 220 assigns a worker with
`files: ["/tmp/pi-explainers/pi-adaptative-repo/index.html"]` for copying an explainer and opening
a browser. Line 224 cancels that worker for `write_reservation_scope_invalid`; UTC November 12
harness lines 29–31 record the refusal as `TypeError` without actionable scope guidance.
The advertised `assign.files` description did not state execution-workspace confinement.

**Witness.** Tool schema accepts an absolute mutation path; shared worker admission resolves it and
creates a worker; the reservation store rejects it because it lies outside the execution root.
The model receives a late generic cancellation instead of an early actionable refusal.

**Repair.** Keep workspace confinement where a reservation is required. Shared admission and durable
reservation use the same scope validator, and admission preserves the reservation owner's existing
write-enabled, empty-scope and machine-authority applicability rules. The tool describes that boundary.
Invalid scopes are refused before lane creation; reservation errors preserve bounded original diagnostic
detail for later failures.

**Controls.** Relative and absolute in-workspace scopes remain valid, including scopes resolved
through a worker's execution plan. External scopes remain refused. No broader filesystem authority
is granted by this repair. Coverage is prepared in
`packages/coding-agent/test/worker-write-reservation-scope.test.ts`. Fix verification is
source/static only, unproven at runtime.

## Rejected candidates and unresolved observations

- The parent supplied transcript cursor `1500` after a read starting at `1000`. No evidence shows
  the store issued `1500` as `nextCursor`. The explicit durable-length rejection is retained;
  a fabricated offset is not evidence of transcript loss.
- Anthropic `provider_limit` refusal and lane parking are intended quota enforcement. The
  investigation found no evidence of starvation after eligibility returned.
- The later Windows browser launch failed because the invoked PowerShell `Start-Process -FilePath`
  argument was null or empty. Available evidence supports a command-invocation error, not a
  demonstrated harness browser-launch defect.
- Two empty compaction replies, individual tool bounces, model-pool refusals and worker report
  review failures do not independently establish harness defects. No fallback or guard was weakened
  merely to suppress them.

## Escape gaps and verification

| Escape | Missing interaction | Regression boundary |
| --- | --- | --- |
| H-20261111-1 | Per-response accounting failure versus admission of fresh backlog nodes | Physical usage observer, adapter circuit and compaction outcome |
| H-20261111-2 | Ephemeral knowledge placement versus durable history append | Real materializer, dispatch capture, admission envelope and measurement |
| H-20261111-3 | Tool path contract versus shared worker admission and confined persistence | Common scope validator and pre-creation refusal |

The baseline production clone gate passed at the repository's pinned five-line/50-token sensitivity:
2,226 eligible of 2,256 owned source files covered, 2,127 sources in the detection pass, zero clones;
largest source 6,563 lines / 297,619 bytes. Coverage has an independent one-token pass, explicit
20,000-line/2-MiB caps, symlink refusal, and four generated/vendored exclusions with ownership checks.
The 30 files below five lines are separately accounted for by the gate. Root and workers also
reviewed repeated rules and source owners; no paid semantic model scan was run.

- [x] Scope and invariants recorded for the three affected owner families.
- [x] Scanner caps, exclusions and independent coverage pass inspected.
- [x] Before-change scanner evidence preserved under `/tmp/pi-harness-investigation-2026-11-11-clones-before`.
- [x] Semantic searches covered both knowledge producers, physical accounting/admission paths and reservation entry points.
- [x] Findings classified separately from expected refusals and model argument errors.
- [x] Accounting dispatch was prioritized for its cross-node spending impact, followed by cache and admission diagnostics.
- [x] Repairs extend existing owners and share the reservation rule rather than adding competing policy.
- [x] Final TypeScript, ownership, size, architecture, clone and diff checks passed; architect review found no remaining blockers.

The initial repair's final clone gate covered 2,226 eligible of 2,256 owned files, with 2,127 detection-pass
sources and zero clones (largest source 6,563 lines / 297,707 bytes). General worker-admission
logging remains in the delegation controller, whose line count did not grow. Final verification
also includes repository-wide Biome, kernel/coordinator boundaries, relative TypeScript imports,
header comments, sealed directives, immutable released changelog sections, and the generated
architecture map. Follow-up verification below supersedes these initial counts where relevant.

### Follow-up repair verification

The remaining restart, cost-projection and custody-classification findings were implemented in the
same owners. Full-repository `node scripts/run-tsc.mjs --noEmit` passed, along with Biome over 2,330
files, file-size and kernel/coordinator boundaries, header comments, generated architecture and
sealed-directive checks. The production clone gate covered 2,226 eligible of 2,256 owned files,
2,127 detection-pass sources, and zero clones at the unchanged sensitivity; largest source remains
6,563 lines / 297,707 bytes. Evidence is retained in
`/tmp/pi-harness-followup-2026-11-11-clones`. `git diff --check` is clean.

The exact proof hash and bounded diagnostic fingerprint intentionally differ: the former preserves
JSON-visible property order, refuses incomplete proof and invalidates message-content revisions;
the latter remains a bounded sorted telemetry summary. Their responsibilities were reviewed rather
than merged. Spend admission, token transitions and physical cost settlement have one owner; receipt
validation, transport coordination and the injected clock retain separate explicit responsibilities.

Prepared regression coverage also includes actual injected post-rename failures on claims and
settlement, expiry-only capacity pruning and exact-only prefix changes beyond the prior truncation
limits. The retained retry alarm after logical retirement was source-reviewed; no prepared
alarm-driven regression currently covers that lifetime. No regression result is claimed from preparation.
Luna, Terra and the architect reviewed source; runtime behavior remains unverified until tests are
explicitly requested. No commit, deployment or live-state migration was performed.

No local tests, executable probes, provider/model trials, browser runs or benchmarks were run.
Regression tests were added after the implementation and prepared for later execution. Static
verification and final architect review are recorded by the task handoff; they do not prove runtime
ordering, actual provider-cache savings, browser behavior, or cross-restart recovery.
The aggregate `npm run check` was not run: its `check-machine-models --static` step performs bounded
executable model exploration despite its name. Direct non-test checks were used instead.


## Additional interaction audit: 2026-11-12

This pass follows the same recorded session evidence into additional source boundaries. No newer
session activity was available at the start of the pass. The findings below are confirmed by source
control flow, independently reviewed by the architect; they are not runtime reproductions or new
incidents inferred from the earlier log counts. Luna owns lane identity and relocation, Terra owns
scheduler and shared-budget transitions, and root owns provider dispatch and successful-tool replay.

### H-20261112-1: released summary claims spend the failure budget

**Witness.** Claiming increments `work.attempts`. Previously a cancellation/admission release returned
that running row to ready without refunding the attempt. Repeated nonfailure releases could exhaust
six attempts before the first actual failure. Interrupted running rows recovered the same inflated
counter; legacy running imports also invented one failure.

**Repair and controls.** The scheduler refunds only a still-running claim's reservation inside its
transaction and exact claim fence. Duplicate release acknowledgements and stale claims cannot refund
again. Recovery refunds running reservations once; importing legacy running work records zero proved
failures. Six actual failures still exhaust the budget. Existing historical counters are not rewritten:
their retained rows cannot distinguish past releases from genuine failures. Prepared cases cover
release replay, stale claim rejection, recovery, legacy import and six true failures.

### H-20261112-2: absent recovery identities create permanent holds

**Witness.** A recovery-only failure without a key matched an absent configuration row because
`undefined === undefined`. It entered `recovery_only` with an effectively infinite retry deadline;
normal arrivals without a key could never change that configuration identity.

**Repair and controls.** Recovery-only parking requires a defined, nonblank key equal to the current
configuration. Missing, blank and mismatched identities take ordinary failure backoff. A concrete
matching identity still waits until configuration changes. These transitions share the scheduler
owner and prepared regression fixture with H-20261112-1.

### H-20261112-3: explicit worker workspace paths escape lane relocation

**Witness.** `authority.path` sets the worker workspace/cwd. Fresh isolation relocated only write paths
and saved intent, so an explicit in-workspace path still pointed into the original checkout when
re-admitted. Required isolation refused it; default isolation could discard the new lane and keep the
shared checkout. A nested cwd also differs from the registered worktree root: reusing it as the target
root would append the nested suffix twice, and exact-root lane lookup missed lifecycle operations.

**Repair and controls.** The lane owner translates workspace selection and write scopes with the same
mapping, while external paths stay external for containment refusal. It resolves a nested directory
through its actual containing Git checkout and active lane registration, preserving the authoritative
lane root separately from execution cwd. Cwd-facing binding, finding and lifecycle operations use
that same lane identity; exact destructive backend helpers retain their root-only contract. Nested
independent repositories cannot borrow an outer registration. Prepared cases cover relative/absolute
paths, external paths, repeated nested relocation and the real containing-checkout resolver seam.

### H-20261112-4: successful replay detection drops changed tool payloads

**Witness.** Text-protocol success signatures reduced `edit` and `write` arguments to the path. A
second patch to the same file was refused as an already successful call. A separate path/phase
fallback repeated the same mistake even when signatures differed. Conversely, argument preparation
could change the stored signature so an identical raw model replay missed the prior success.

**Repair and controls.** Ordered batch signatures use the shared exact execution-key owner, including
mutation payloads and exact values. Resource-envelope fields retain their existing equivalence.
The coarse path/phase fallback is removed; runaway heuristics remain separate. Both original model
and validated batch signatures identify replay candidates. Every candidate validates/prepares its
arguments before its canonical operation key and execution scope can authorize refusal. The old
unbound-tool shortcut is removed. Stable prepared defaults still identify an unchanged model replay;
changed host preparation or execution scope permits the changed operation.

The guard retains whole-batch candidate semantics: a different raw batch that matches neither prior
model nor canonical batch runs in full, even if arbitrary many-to-one tool preparation would later
make it semantically equivalent. It does not promise to eliminate every semantically equivalent
operation. Prepared controls cover exact repeats, changed edit/write payloads, changed ordered
batches, timeout equivalence, execution-scope changes and stable/changing argument preparation.

### H-20261112-5: exceptional assistant streaming leaks abort listeners

**Witness.** The loop attached abort forwarding before awaiting provider planning and removed it only
after normal stream iteration. Planning rejection or a throwing event sink skipped cleanup, retaining
the captured controller on the caller's signal.

**Repair and controls.** The complete response lifecycle has `finally` cleanup. Normal terminal
cleanup retains its original timing; repeated removal is harmless. Prepared tests inspect the actual
outer signal's listeners on planning failure, assistant event-delivery failure and success, preserving
an unrelated caller listener.

### H-20261112-6: knowledge becomes stale after plan acceptance but before transport

**Witness.** The planner validated currency, committed and adopted the plan, then awaited the snapshot
hook. Knowledge could be corrected or withheld during that wait. Later redaction/admission wrappers
can also await work before physical dispatch. Precommit predicates cannot simply be called again:
committing reflection/brief cues intentionally consumes some of their state.

**Repair and controls.** `AgentContextPlan.isDispatchCurrent` is a separate pure, nonconsumptive
contract, composed through root runtime and worker knowledge plans. Current ICM memory reuses its
nonconsumptive memory predicate; consumable plan validators stay precommit. Present callbacks must
synchronously prove true through the shared planner helper. A guard-only kernel wrapper converts
refusal into an ordinary error stream with the accepted request id, without repeating commit.
It deliberately forwards the original guard and response observer through later stream wrappers:
the deepest existing handoff rechecks currency and begins physical accounting. Consuming the observer
in the kernel would incorrectly account for work refused later during asynchronous redaction.

Prepared native/text controls revoke after an asynchronous snapshot or downstream wait, assert no
physical transport/accounting start, preserve the accepted id and single commit, and permit healthy
requests whose precommit predicate was intentionally consumed. Missing dispatch predicates preserve
the legacy contract; malformed present results refuse. Worker knowledge composition has a direct
prepared revocation case. Static source evidence does not prove these runtime interleavings.

### H-20261112-7: a worker's own reservation invalidates context headroom

**Witness.** Knowledge fitting captures a worker's remaining token allowance. Preflight reserves that
request's tree budget; the old aggregate free-capacity projection subtracts its own new reservation,
so the post-preflight currency check sees less headroom and rejects its own admitted request. Sibling
reservations must still reduce the next request's allowance.

**Repair and controls.** Next-request context headroom is distinct from aggregate unreserved capacity.
The attempt-bound budget projection excludes only its own reservation; actual pooled admission and
aggregate-capacity consumers retain their existing accounting. Both worker knowledge fitting and
lane memory capacity consume the context projection. Prepared controls distinguish own and sibling
reservations, with source review of settlement, cancellation and wrapper propagation.

### Verification for the additional audit

All regression cases in this section are prepared, not executed. No local tests, ad-hoc probes,
provider/model trials, benchmarks or remote runs were executed. Current-tree full TypeScript
checking passed, as did repository-wide Biome (2,336 files), kernel/coordinator boundaries, file-size,
header comments, generated architecture, sealed directives, relative TypeScript imports,
released-changelog immutability (41 release tags) and whitespace checks. Shrinking the loop and
delegation controller lowered their existing file-size ceilings; no gate was weakened.

The final production clone gate covered 2,226 eligible of 2,256 owned files, with 2,127 sources in the
five-line/50-token detection pass and zero clones. Largest source is now 6,552 lines / 297,413 bytes.
The unchanged 20,000-line/2-MiB caps, independent one-token coverage pass, 30 below-floor sources and
four generated/vendored exclusions remain accounted for. Final evidence is retained under
`/tmp/pi-harness-audit-2026-11-12-clones-final`.

The architect's final combined source review found no remaining blockers. The changed lane,
dispatch, retry and headroom rules each have one existing authoritative owner; alternate projections
retain their distinct purpose rather than becoming competing admission paths. Different raw
batches with arbitrary many-to-one preparation remain outside replay detection's promise, as
documented above. Old retry counts and older unresolved accounting charges cannot be reconstructed
from their retained state, so no historical counters or live state were rewritten. Changes remain
local source work: no commit, runtime restart, deployment or remote run was performed. The earlier
rollout requirement for older spend-state writers still applies. Persisted lifecycle pairing,
actual concurrency and cross-restart behavior remain unverified by execution.

## Release goal and executed verification: 2026-11-12

The owner's follow-up authorizes task-focused test execution and a patch release, followed by live
tool validation. The earlier unrun-test statements describe those earlier passes; they are not the
status of this release goal. The release remains unpublished while any confirmed finding or required
proof below is open. The existing GitHub Release workflow remains the version/tag owner.

### Additional findings from execution and the next source pass

**H-20261112-8 — retrying accounting across UTC midnight changes the charge day.** A response
observed before midnight was added to the day when its failed storage replacement finally retried.
The spend owner now retains active-day USD plus an archived known-cost aggregate. Physical host
observation time is captured before journal I/O and retained through retry. Rollover transfers the
previous active amount to that aggregate; an old-day settlement does not change today's amount.
Strict migration preserves only known existing numbers. Backward-clock observations refuse rather
than erasing or reallocating money. Focused controls include a nonzero new-day amount, multiple old
receipts, duplicates and a replacement that committed before reporting failure.

**H-20261112-9 — prepared worker tree admission can become stale.** Async preparations shared an
earlier tree count, while materialization rechecked only fleet slots. The synchronous materialization
step now calls the same authoritative tree-attempt rule before persistence. A root-task `attemptOf`
rerun also derives its existing root tree rather than bypassing the rule when no parent is supplied.
The real `WorkerLifecycle` regression checks capped child and root rerun starts leave the durable
projection unchanged, with a larger-budget control reaching the next admission step.

**H-20261112-10 — a journaled charge can be stranded outside the shared cap after a crash.**
Reproduced with real disk session state: a canonical semantic receipt retained $0.25, the shared
settlement replacement failed, and reopening all owners after proven process death left the shared
cap at zero. A live in-memory settlement alarm cannot close this crash window. This finding blocks
publication until an exact receipt acknowledgement protocol closes the cross-store handoff.
The agreed repair extends the existing semantic sidecar retention and spend token owner; it must
not add a second receipt journal or count an unproven charge as zero. The initial failing diagnostic
is `continuous-chat-restart-cost-witness.test.ts`.

**Completed mechanism and focused proof.** Meter tokens link the exact usage receipt and immutable
ledger identity before transport. A durable reserved-to-attempted transition distinguishes proven
undispatched crashes from unknown physical outcomes. Recovery cancels a dead reservation's matching
usage admission before re-parking; cancellation failures retain its exact token and locator.
An attempted unknown charge globally fences new summaries. Known receipts, including already
retained live-owner receipts, reconcile across all session/model keys before shared-cap admission.

The existing semantic sidecar is an acknowledgement outbox: canonical confirmation and spend
acknowledgement are monotonic independent proofs. The meter retains a paid token through journal
acknowledgement; ambiguous acknowledgement and cleanup writes retry without counting money twice.
A canonical-only receipt from an unopened old session is restored asynchronously through the
existing session reader, with two active scans and a bounded FIFO queue. Strict recovery checks
every row, fatal UTF-8 decoding, complete tail, same-descriptor header, stable complete snapshot,
exact token and accounting identity, and conflicting duplicates. Only a completed proof can promote
the receipt under its journal lock, rechecking the unresolved request or matching standing record.
No journal/meter lock is held while scanning or while acquiring the other store's lock.

The focused accounting/journal suite passed 45 tests, including an actual injected sidecar-write
failure with a real persisted canonical row and new-session recovery without reopening the old
session. Eleven strict-reader controls and four actual asynchronous journal controls also passed.
The latter use the real reader with a post-scan barrier: a different valid header, conflicting
receipt token, and concurrent ACK/cancel cannot invent or resurrect a receipt. The initial red
witness is now green. The shared writer used by strict and quarantine journal paths was extracted
after the clone gate found their identical publication bodies; their corrupt-input policies remain
separate. The frozen 132-case regression target and unchanged clone gate both passed after that extraction.

**H-20261112-11 — live acceptance can prove the wrong executable or an empty scope.** The installed
version probe and herdr server could resolve different `pi` commands through their PATHs, while
a misspelled `--only` ID could select nothing and report PASS. Live acceptance now supports one
absolute standalone binary whose version, SHA-256 and resolved release tag/commit are pinned and
rechecked; every direct/pane launch uses that same quoted command. Unknown scope IDs refuse.
Selected and excluded scenarios are recorded. Pinned binary validation explicitly excludes source
scenario s10, and this task excludes unrelated private-data scenarios s11/s12. Six Node controls
passed for executable identity/replacement and scope selection. Archive checksum verification is
an operational prerequisite before pinning the extracted executable.

The pre-recovery capacity candidate was rejected: recovered attempts were already counted, and
new verifier work has a separate root identity. The root memory-headroom candidate was also
rejected by source review: its estimator uses the same captured message extent and current model,
tools and settings; snapshot bookkeeping does not subtract an own tree reservation as workers did.
The relocation fixture's POSIX-only expectations were a test portability defect and now use native
paths for both release platforms.

**H-20261112-12 — omitted custom pricing can erase unknown summary cost.** Source review found
that a custom model with omitted rates gets zero defaults and `costDefaulted: true`, but summary
configuration accepted it. The completion and recovery paths then treated its nonzero-token
response as known $0 spend. Explicit configured zero rates are legitimate; absent rates are not
price evidence. The repair belongs to the existing summary admission and receipt accounting
owners. Configuration rejects omitted rates, the final physical admission refuses a bypass, and
recovery requires explicit declared-price proof rather than a catalog-name label. A legitimate
zero-price positive-token response still settles. The focused six-file suite passed 53 tests,
including direct bypass, local unknown pricing, explicit zero pricing and catalog-name override
controls. The architect reviewed the frozen repair and found no issue.

### Proof already executed for this goal

- Kernel replay, listener, projection and dispatch fixtures: five files, 48 tests passed.
- Persisted post-snapshot/downstream refusal: six native/text controls passed through the real
  Agent, foreground lifecycle adapter and disk SessionManager, reopened read-only with exactly
  one matching request/assistant/terminal and a balanced ledger. Healthy consumed-commit controls
  also passed. The model-router dependency was narrowed to the two methods this owner uses.
- Worker lane, scope, context headroom and tree materialization fixtures: four files, 16 tests
  passed. The lane case binds a nested workspace, reports its dirty finding and preserves the
  active dirty lane on guarded release; an independent nested repository is not adopted.
- Accounting/scheduler fixtures reached 31 passing cases, including an alarm-driven late physical
  settlement after logical retirement, exact old/new session fencing, schema migration, date
  attribution, ambiguous writes and pruning that preserves active/archived known cost.

The first combined release-regression run overlapped an in-progress worker edit: 100 tests passed
and one saw a transient undefined local variable. The frozen worker family subsequently passed all
16 tests. Final combined execution must occur on the frozen tree; this intermediate run is not a
green release result. Its JSON is `/tmp/pi-harness-release-regressions-2026-11-12.json`.

`check:harness-regressions` explicitly lists every new focused fixture, including the initially red
restart witness, and is called by the existing release-only `check:provider-regressions` step.
Normal CI retains its journeys-only policy. The exact-tag Linux/Windows release matrix must execute
these fixtures; no pass-with-no-tests option or skipped-file exception is allowed.

### Remaining release requirements

1. H-20261112-10 and H-20261112-12 are closed by the owning mechanisms, executed negative controls
   and independent source reviews above.
2. The final repository check after the pricing repair passed, including type checking and the
   unchanged clone gate. The reviewed changelog and authorized changes are ready to commit/push.
   The frozen aggregate passes 136 Vitest tests in 17 files plus six Node tests, with no skips.
3. Dispatch `release.yml` with `target=patch`, follow its live run and the exact-tag binary workflow,
   and verify the required platform/provider/installer evidence and published assets. A tag alone
   is not a released patch.
4. Drive the published version through the available herdr live control, verify the executable and
   runtime identity, use isolated test state, and record actual live results. Installed Pi was
   `0.104.54` at the start; it is not evidence for the new patch. No paid live trial has run yet.

Before H-20261112-12, the frozen combined target passed 132 Vitest tests across 17 files and six
Node checks, with no skipped or pending cases. The complete `npm run check` passed, including type
checking, and the unchanged clone gate covered 2,227 eligible of 2,257 owned files with 2,128 files
in its detection pass and zero clones (largest: 6,550 lines / 297,557 bytes). Detection remains at
five lines / 50 tokens, with independent one-token coverage, 30 below-floor files and four validated
generated/vendor exclusions. The report is `/tmp/pi-harness-release-2026-11-12-clones-after-journal-owner`;
regression JSON is `/tmp/pi-harness-release-regressions-2026-11-12-publish.json`. These results precede
the final pricing repair, whose affected gates must pass again. Release and live execution remain
unproved until their authoritative results are recorded.

The final pricing repair's aggregate result is
`/tmp/pi-harness-release-regressions-2026-11-12-final.json`. The architect's subsequent source review
found no remaining confirmed issue in the repaired families. Luna's independent release procedure
review found a contradictory historical authorization sentence; the workflow documentation now
distinguishes ordinary journeys-only CI from an explicitly owner-authorized exact-tag release.

The final `npm run check` completed successfully after the pricing repair; its clone coverage and
limits match the preceding report. No guard baseline, scanner sensitivity or size ceiling was raised.

### First release candidate: held-request evaluator mismatch

The authorized repair commit is `dd135c909aad31e5c43a29b0f7fbb2daa9360b70`. Release workflow
`43160544691` prepared `v0.104.55` at `e1da569a359694dd25238dfa8e0854ea82ff20e0` and dispatched
binary workflow `43160738528`. No GitHub release was published (the release API returned HTTP 404).
Standalone build, Linux benchmark, Windows x64/ARM64 native checks and the Windows performance
gate passed. The Windows exact-tag harness journeys reported nine passes and one failure, so this
candidate is not green. Required provider checks were skipped after that failure, not passed.

The failing R10s evaluator assumed no scheduler alarm while its retry response was deliberately
held at the provider. The new exact-key single-flight rule correctly parked further admission and
armed a two-second accounting poll. Independent source review showed the scripted 503 responses
already contain 24 measured tokens at explicit zero rates; they are not unknown-cost responses.
The first investigation hypothesis conflated those states and was rejected. The fixture must
prove no overlapping physical request during this hold, then preserve the separate two/four-second
transport-backoff controls after releasing the response. The production accounting fence stays.

Failed evidence is retained in `/tmp/pi-release-v0.104.55-windows-quality.log` and
`/tmp/pi-release-v0.104.55-initial-evidence.json`. The remaining work in the failed binary run was
cancelled to prevent an active publisher during same-version recovery. The unpublished tag may be
freed only after both workflows are inactive; the existing `release.yml target=repair` then owns
the corrected candidate and tag without another version bump.

The stronger evaluator distinguishes actual transport retry arms from accounting polls using the
existing `TimerOptions.keepAlive` metadata in the fixture timer adapter, retaining handles and
remaining deadlines while preserving real callbacks. It yields before negative request assertions
and requires the exact next provider step at the retry boundary. A source-confirmed detached idle
helper also needed owned cancellation after timeout; its waiter and driver must end together.
These are fixture repairs, not changes to production retry timing or accounting admission.

A quiet diagnostic interval was initially suspected to be a disposal hang. Per-step evidence in
`/tmp/pi-r10-dispose-diagnostic.log` showed final idle, abort, foreground idle and disposal all
completed; subsequent journey phases were still running. That production-hang candidate is rejected.
Reporter silence alone is not a timeout or a stalled owner. Final fixture execution and release
repair remain pending until recorded below.

The diagnostic ran for 242 seconds through the first mode's later journey phases; its reported
failure was teardown classification of the R10 notice already asserted by that phase. It reported
one failed test and nine skipped tests; it was not a green journey result or proof of both modes. The final
fixture consumes only that exact asserted warning occurrence. It adds no journey-wide allowance,
changes no production rule, and retains the normal warning gate elsewhere. The architect approved
the scoped timer, cancellation and warning changes with no finding. A fresh final execution uses
`/tmp/pi-r10-scoped-final.log`; the superseded partial allowance run is not verification evidence.

**Final scoped fixture result:** the standalone composed journey passed in both System One modes
in 477.08 seconds. The focused command reported one passed test and nine intentionally filtered
journeys, not ten passes. `/tmp/pi-r10-scoped-final.log` is the authoritative result for the frozen
scoped-warning version. The refreshed full `npm run check` also passed, including type checking
and unchanged zero-clone coverage. The evaluator mismatch and fixture lifetime repairs are closed;
publication and post-release live acceptance still require their own authoritative results.

Before committing the fixture repair, daily catalog commit
`7fd8b53c6a0d0da47d2028a9c90fb8bc2d936210` landed on main. It was fast-forwarded and preserved;
it changes only the generated model catalog. The harness regression aggregate was rerun on the
combined tree and passed all 136 Vitest and six Node tests, with no skips. Its JSON is
`/tmp/pi-harness-release-regressions-2026-11-12-catalog-final.json`. The 477-second composed journey
result above precedes that generated catalog update; exact-tag release CI must verify the final
combined candidate rather than treating those local results as publication proof.

### Published 0.104.55 and post-release findings

The repaired patch was published at `2026-11-12T06:23:31Z`, tag `v0.104.55`, exact commit
`f524efb9ab33f0b163df487ef28c2531f6eeff87`. Release workflow `43165615043` and binary workflow
`43165865098` succeeded. The exact-tag Ubuntu/Windows quality jobs completed their harness-journey,
provider-regression and dependency-installation steps; native Windows x64/ARM64, Linux benchmark,
installer, provenance and publication jobs also passed. The nine expected release assets are
published. JSON evidence is `/tmp/pi-release-v0.104.55-published.json` and
`/tmp/pi-release-v0.104.55-final-evidence.json`. Runner logs were unavailable through the attempted
completed-job endpoints. The full workflow log archive subsequently resolved that access gap:
`/tmp/pi-v0.104.55-release-logs.zip` contains the Ubuntu and Windows runner logs. Each platform
explicitly reports ten journey tests, 136 harness Vitest tests across 17 files, six Node tests,
32 AI provider tests and eight existing coding-agent provider tests passing. Extracted evidence is
`/tmp/pi-v0.104.55-linux-quality-archive.log` and its Windows counterpart.

The downloaded Linux archive matched its published SHA-256
`cf49905c786ca911b982bb22b88fb29491beae09483c22dbf34776cd68cda83e`.
Its executable, `/tmp/pi-released-v0.104.55-7v0k9wd0/extracted/pi/pi`, reported `0.104.55` and had
SHA-256 `62a770944fed00f2812ec43314b73a2b9194d0979278e7cac3b3a040bd4b62ad`.
The extracted input was made read-only before acceptance. The pinned live report is
`.git/pi-audits/live-validation/2026-11-12T11-01-26-220Z/report.json`: s0 passed with actual replies
from both configured providers; s1 failed before the prompt, and the sixteen dependent selected
scenarios were skipped, not passed. Source-only s10 and private-data s11/s12 remained explicitly
excluded. This is a failed live gate, not completion. Its preserved task evidence remains at
`/tmp/pi-live-gate-COX0VX` (the preservation marker prevents automatic deletion by a future run).

**H-20261112-13 — a reserved summary can bypass an intervening shared hold.** The compaction adapter
reserves before asynchronous request preparation. Reusing that token skipped the ordinary guard,
and the meter's final reserved-to-flight transition checked only token ownership. A second request
could establish an unknown charge, pending acknowledgement or reached cap while the first waited,
and the first could still dispatch. The shared spend owner now applies one account-admission rule
at both reservation and physical transition, atomically with that transition; cross-store receipt
reconciliation remains outside the meter lock. Four barrier controls cover a reached cap, unknown
usage, pending acknowledgement and a healthy dispatch control, including exact undispatched-token
cleanup and zero refused transport. The focused accounting suite passed 36 tests and independent
source review found no blocking issue. The narrower concurrent receipt publication interval remains
within documented outstanding-flight exposure; this is not a prepaid or cross-store atomic cap.

**H-20261112-14 — interactive capture cannot stage a read-only runtime tree.** The controlled
published-binary startup probe captured `EACCES` creating a nested `bundled-resources/extensions`
directory inside its runtime generation. `RuntimeArtifactStore` inherited each read-only origin
directory's mode before creating its children. Provider print-mode calls do not cross this capture
boundary, explaining why s0 passed. The complete exception is
`/tmp/pi-v0.104.55-startup-debug-terminal.txt`; the task-owned debug pane was closed after capture.
The fix belongs to owned snapshot directory construction and must preserve origin contents/modes,
containment and generation retirement. Its regression owner is included in the release target.

Version 0.104.55 is already published and immutable. These follow-up repairs require a new patch;
its publication and a complete pinned live run remain required before this goal can finish.

### Follow-up patch verification

The read-only capture repair adds owner access only to privately staged directories. Pool and
non-pool controls verify nested bytes, traversal/write behavior, launch-target remapping, unchanged
observed source modes, retirement and pool retention. Exact POSIX permission assertions are
qualified on Windows while the behavior checks remain active. The owner-focused tests passed
2/2, and the architect approved the final combined production/test diff without a blocking finding.

The frozen combined regression target passed 142 Vitest tests across 18 files plus six Node tests,
with no skipped or pending cases. JSON: `/tmp/pi-harness-release-v0.104.56-regressions.json`.
The full `npm run check` passed, including type checking and unchanged clone coverage:
2,227/2,257 eligible/owned, 2,128 detection-pass files, zero clones, largest 6,550 lines / 297,557
bytes. No baseline, sensitivity or file-size ceiling was raised. Exact-tag publication and a new
pinned live run remain outstanding.

### UTC decision sample repair before publication

The first follow-up candidate was prepared as `v0.104.56` at
`1a1f4a2fa8cd8ff71cde75527452b77cef388f16` by release workflow `43208080464`; binary workflow
`43208305113` started. A further bounded clock audit found a source-supported defect before
publication, so that binary run was cancelled and the outer release concluded failure. The release
API returned HTTP 404; both workflows are inactive. The unpublished tag was retired after saving
its exact SHA and `/tmp/pi-v0.104.56-initial-candidate-evidence.json`. This is same-version recovery,
not a failed test presented as green or a rewrite of published 0.104.55.

**H-20261112-15 — mixed UTC samples can erase an established cap.** A locked decision validated
stored day D against one clock sample, then hold/admission sampled again. With a reached cap on D
and a rollback to D-1 between samples, the second comparison treated spend as zero/not current.
There is no valid admission point: the reached cap refuses before the rollback, and backward-clock
policy refuses afterward. The lock owner now passes one validated day to hold and the mandatory
claim/physical-admission rule. Settlement-day rollover is unchanged. Three controls force the
actual sample gap and preserve next-day admission. The focused accounting suites passed 39 tests;
independent source review found no blocking finding. Combined gates and repaired publication remain
required below.

The live fixture also selected a remote summary model while leaving its required external-summary
permission at the product's false default. The validator would therefore refuse that test model.
The isolated synthetic fixture now explicitly grants summary egress to its configured test provider,
so ordinary background summaries can participate in acceptance. This changes only the live test
settings; no owner history or private integration data is loaded. `node --check` passed after this
configuration correction. The default-setup scenario continues to exercise untouched defaults.

The frozen clock repair's combined target passed 145 Vitest tests across 18 files and six Node
tests, with no skips or pending cases. JSON: `/tmp/pi-harness-release-v0.104.56-clock-final.json`.
The complete static/type/architecture check also passed; the clone gate remains zero with the
same 2,227/2,257 coverage and unchanged limits. The live-fixture egress-setting correction received
its separate syntax check after this run. The repaired exact tag must still execute all required
release gates and published-binary live acceptance.

### Cross-platform virtual-clock evaluator repair

Candidate `a610db485b38077cc817a443c4b95f2f0835d812` completed binary workflow `43210406826`
with Ubuntu quality success and Windows quality failure. Ubuntu runner logs explicitly report ten
journeys, 145 focused Vitest tests across 18 files, and six Node tests passing. Windows reported nine
journeys passing and R10s failing on an accounting poll delay of 1999 ms versus an expected 2000 ms;
subsequent provider regressions were skipped, not passed. Evidence is
`/tmp/pi-v0.104.56-clock-fixture-run-logs.zip` and the extracted platform logs. Release workflow
`43210096647` concluded failure; no GitHub release exists (HTTP 404). Both workflows were inactive
before the unpublished tag was retired, with its exact SHA preserved here.

This is a confirmed evaluator clock mismatch, not a production timing defect: `alarmAt` legitimately
re-reads time after constructing an absolute two-second deadline, so one millisecond may already
have elapsed. The fixture used wall time plus virtual advancement for `now()`, but virtual time
alone for alarm firing. Only its `continuous-chat` clock is now anchored at owner creation and then
advanced virtually. The exact two-second poll, two/four-second transport and no-overlap assertions
are retained, without tolerance widening. Independent source review approved the scoped change.
The focused two-mode journey is running against this frozen fixture in
`/tmp/pi-v0.104.56-clock-journey.log`; its outcome is not yet a passing result.

The frozen clock-coherent fixture passed the standalone journey in both System One modes in
482.11 seconds: one test passed and nine unrelated journeys were intentionally filtered. Its full
log is `/tmp/pi-v0.104.56-clock-journey.log`. The combined target again passed 145 Vitest tests in
18 files and six Node tests, with no skipped/pending cases, in
`/tmp/pi-harness-release-v0.104.56-virtual-clock-final.json`. Full `npm run check` passed, including
type/architecture/immutability checks and unchanged zero-clone coverage. Source review found no
blocking issue; the scoped change alters fixture time only. The repaired release and published
binary's complete live scope remain outstanding.
