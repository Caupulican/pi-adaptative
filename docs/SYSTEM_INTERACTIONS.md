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

### Published 0.104.56, live findings, and journey coverage correction

Version `0.104.56` was published at `2026-11-12T12:21:44Z`, exact tag commit
`0e2501baf2ad4906e482faad3c733ab0e5ef793e`. Release workflow `43214220810` and binary
workflow `43214484078` succeeded. Both platform logs in
`/tmp/pi-v0.104.56-final-release-logs.zip` explicitly report ten journeys, 145 focused harness
Vitest cases, six Node cases, 32 AI provider cases and eight coding-agent provider cases passing.
The Linux archive matched published SHA-256
`a71879cd9bb9fb2b673d22ffa110b96299e358754380e758d6741d806dfc789b`;
the extracted immutable executable reported `0.104.56`.

The full selected live run failed: 15 of 18 scenarios passed, with s15, s16 and s43 failing and
no selected scenario skipped. Report:
`.git/pi-audits/live-validation/2026-11-12T12-24-07-445Z/report.json`; preserved evidence:
`/tmp/pi-live-gate-7TP9jX`. Startup on the read-only runtime succeeded, closing the earlier
capture failure on this published binary. Both configured providers replied. This is not an
overall live pass. Published 0.104.56 remains immutable; further production fixes need a new patch.

**H-20261112-16 — public zoom ranges force needless navigation.** The root asked for `(0,9)`
and received a power-of-two refusal. Aligned replacement reads returned only unmerged references,
requiring thirteen further navigation calls to recover a tiny history. Public contiguous range
navigation now decomposes into dyadic storage coverage and descends absent summaries within the
same bounded call. Storage remains binary. Remaining message IDs provide a stable continuation
while summaries merge and messages arrive. The composed J1 witness must cover root and worker
results in the next provider request, complete ordered coverage across publication, bounded output,
single-message clipping/images and cancellation. Focused navigation cases remain diagnostic.

**H-20261112-17 — host FFF provisioning appears as worker protected-path changes.** The worker
edited only `util.ts`; the host's post-edit duplicate review triggered a cold npm install under
the agent's `bin/fff-node`. Nine resulting findings contaminated its claim and parent review.
An initial time-window wrapper was rejected and reverted: root-prefix overlap could also hide
unrelated, concurrent or later same-run mutations. The repair must publish known staged artifacts
through exact transition attribution. Its composed worker-to-parent journey must retain those
negative controls, including no-op staging. No broader path exemption is acceptable.

**H-20261112-18 — live evaluation lacks task and native input boundaries.** s15 counted after
file presence plus eight seconds, while its first task's worker review was still running. Its
second count therefore included first-task calls. Neither timed-out s16 nor s43 prompt appears
in its canonical session, so those runs do not establish routine or remote-ask production defects.
The driver now passively observes the actual editor and existing canonical busy/queue predicates,
confirms exact persisted owner input in its owning session, and waits for final owner response plus
worker claim/outbox settlement before freezing counts. It neither injects via a model API nor
blindly resends. Missing admission preserves editor, screen, input-event and session evidence.
Watch creation uses the same settlement boundary. The ordinary `alpha` fixture permits one final
line ending, and the edited `slugify` module is exercised inside a bounded VM in the native journey.

The first focused native watch run using the observer passed in 331 seconds on the pinned
published 0.104.56 binary: both event baselines, a 39-second idle interval without watch model
use, one occurrence per external change, delivered notifications and deletion were verified.
Report: `.git/pi-audits/live-validation/2026-11-12T13-12-27-677Z/report.json`; preserved evidence:
`/tmp/pi-live-gate-jhM8MB`. This run precedes the final change from journal-silence settlement
to canonical settlement. It is one scenario, not a fresh full gate or proof of new production code.

The owner's explicit correction requires **shipped composed journeys** as acceptance evidence.
Earlier focused counts prove their narrower owner checks; they cannot substitute for interacting
runtime boundaries. The following is the current integration ledger, not a claim that the expanded
journeys passed:

| Repair family | Composed acceptance boundary | Current state |
| --- | --- | --- |
| Summary accounting, crash/ACK retention, shared admission, UTC cost | J1 summary accounting: actual root turns, physical replies, exact sidecars, meter replacements, virtual process death, next physical dispatch and shared-account peer | Prepared; expanded journey unrun |
| Validated UTC decision sample | Same J1 paid-cap flow with a fixture clock-read cut, retained cap and forward-day control | Prepared; exact read cut unrun |
| Contiguous zoom, append/merge, worker budget, images, cancellation | J1 range navigation plus existing J1 clipped n1 and J2 worker post-read revocation | Prepared; expanded journey unrun |
| Knowledge request custody and dispatch freshness | J1 physical provider context after durable snapshot, privacy withdrawal, request terminal and healthy control | Prepared; expanded journey unrun |
| Own versus other shared-tree reservation headroom | J7 real leader/child lifecycle and provider preflight reservations | Prepared; expanded journey unrun |
| Changed mutation payload and exact successful replay | J1 real text tool transport, file mutations, replay/collision receipts in next provider request | Prepared; expanded journey unrun |
| Abort listener cleanup | J1 actual owner runs: failed planning, failed stream delivery, retained caller listener and healthy cancellation | Prepared; expanded journey unrun |
| Nested lane relocation and reuse | J9 existing X2 rerun now requests `src`, edits within that workspace and reuses it with unchanged base files | Prepared; expanded journey unrun |
| Host provisioning attribution | Actual worker edit through duplicate review, installer, watcher, durable claim and root review | Implementation and journey in progress |
| Read-only runtime capture | Published-binary native startup s1 crosses snapshot capture | Passed on 0.104.56; retain new full-gate check |

Scheduler release/recovery identities now have an explicit J1 summary-recovery phase; omitted custom pricing is exercised through a real models.json registry in J1; final tree-attempt materialization is in J7. The new phases require aggregate execution. The live driver identity/scope negative controls retain their focused diagnostic gates. Keep focused diagnostic gates while closing those gaps. No clone
sensitivity, coverage cap, test assertion or release gate may be weakened to make this ledger green.

**H-20261112-19 — discarded context plans retain undispatched worker reservations.** The planner
awaits preflight, then legitimately loops when a sibling reservation changes the accepted knowledge
headroom. Its rejected-plan cleanup previously discarded only the context plan. The worker protocol
still held the first preflight reservation, so its next preflight refused an apparent overlap despite
zero physical transport. The repair gives the planner an exact-epoch undispatched cleanup capability,
invoked on rejected-plan cleanup and preflight narrowing failure. It preserves the ordinary overlap
guard, makes stale/duplicate cleanup harmless, refunds the successful-preflight counter exactly once,
and runs plan cleanup even when reservation cleanup throws. Independent source review found no
blocker. The literal-sibling J7 witness subsequently passed in both modes; the final aggregate remains pending.

A focused native remote probe failed s14 and skipped s43 in
`.git/pi-audits/live-validation/2026-11-12T13-21-12-000Z/report.json`.
Durable link records on both sides said connected, and the remote pane reported the join. The main
pane was hidden at its 12-row split height: its status output showed only the last line. Activating
that same pane exposed `Machines: lab connected.` without another join or status command.
This is a confirmed evaluator viewport failure, not a failed transport. Native typing now activates
the task-owned pane and observes a fresh snapshot before sending text. The failed evidence is
preserved at `/tmp/pi-live-gate-XocHx5`; its synthetic panes were closed after capture. A fresh
s1/s14/s43 probe is running in `/tmp/pi-v0.104.56-native-ask-focused.log`.

The first expanded J1 execution failed before later new phases: it reported one failed journey and
nine intentionally filtered journeys. The text replay check looked only at the last native
`toolResult` in the model view; text transport can carry its current receipt in another projected
message. Its next-provider assertion now inspects the complete physical message context for the
exact refusal, retaining the filesystem and canonical receipt checks. The fresh expanded J1 run
is `/tmp/pi-composed-expanded-second.log`; it is not a passing result until it terminates.

The focused native s1/s14/s43 rerun passed all three selected scenarios, with no selected skips:
`.git/pi-audits/live-validation/2026-11-12T13-31-42-604Z/report.json`. It proves the published
0.104.56 link, one ask lane with one applied answer/terminal notification, and the negative control
that owner words in the remote chat create no job or lane. The earlier s43 timeout remains rejected
as evidence of a remote-ask subsystem defect. Its preserved evidence is `/tmp/pi-live-gate-Qf3fHe`;
both task-owned panes were closed afterward. This does not replace the next patch's full live gate.

The second and third expanded J1 runs also failed before later memory/accounting phases. The
native receipt selector and expected collision wording were fixture mismatches: the actual write
owner retains the new payload and reports `PI_FILE_MUTATION_RETARGET write_collision`, and text
transport projects the current receipt into its wire messages. The fixture now asserts the canonical
receipt and that exact collision code in the next physical provider context, preserving file bytes.
An early terminal assertion prevents a scripted provider failure from cascading into later lifecycle
phases. Tool-free failed instructions require exact backlog intake judgments on the next owner
submission; independent source review confirmed those phase scripts and their owner-word binding.
These evaluator corrections still need execution; no prior failure is counted as a pass.

The focused J7 sibling-reservation journey passed in **both** System One modes (one test passed,
nine other journeys filtered) in 21.74 seconds. `/tmp/pi-j7-headroom-reviewed.log` is its authoritative
result. It exercises the real leader and two children, own-reservation exclusion, the other child's
exact headroom reduction, a stale plan's epoch cleanup/re-preflight, stale cleanup after the new
epoch, and terminal handoff/teardown. Later H9 tree-attempt controls are added to that journey but
were not present in this passing run; they need their own refreshed execution.

**H-20261112-20 — a same-lane rerun loses workspace focus.** Extending the existing J9 X2 flow
to a genuine `src` workspace exposed E14 followed by E14r, rather than the expected successful
rerun. Initial report evidence also needed to be relative to that workspace; correcting it preserved
the genuine authority refusal. The actual admission comparison in
`/tmp/pi-j9-h20-authority-before.log` shows the original profile focused on `lane/src`, with
read scope `[lane/src]`; reconstruction retains the same cwd but drops focus and compiles read
scope `[/]`. The authority digest correctly refuses that widening. The reconstruction owner now
preserves the focus distinction for same-lane retries and retains unfocused behavior. The fresh-lane variant also reproduced focus loss. Reconstruction now resolves the registered lane root, retains the cwd-relative focus and grant offsets, and includes explicit focus and non-root workspace placement in the authority digest. Existing unfocused-root digest material remains unchanged. Historical focused reruns without that provenance fail closed. The focused J9 journey passed both modes in `/tmp/pi-j9-placement-negative-v5.log`, including same-lane and fresh-lane success, a redirected `src` to `other` refusal with equal relative grant shapes, and joined removal of the clean unused lane. The final aggregate remains pending.

**H-20261112-21 — a durable unknown settlement keeps retrying after session disposal.** The
new accounting journey exposed repeated two-second alarms after an unknown physical response.
`settle` had saved the exact unknown token, then called all-account reconciliation, whose unresolved
bill correctly blocks admission but incorrectly makes the adapter retain the completed local
settlement as a failed storage write. A known peer can finish its acknowledgement and suffer the
same problem when another key is unknown. The spend owner now uses one reconciliation path with
an optional exact key/token scope for local receipt/ACK completion; admission retains the full
account scope and final locked check. A durable unknown completes its local disposition and keeps
its durable usage evidence/admission fence. Local meter-write and ACK failures still retain retries.

The reviewed H21 journey controls require zero alarms after unknown-owner disposal, one known
peer charge/ACK while another project remains unknown, a real subsequent long input still blocked,
and actual local write/ACK retries surviving disposal until storage recovers. Source review approved
the repair. The first post-repair J1 run still failed in a fixture assumption about global timer
allocation while two real sessions were active. Accounting now drives its shared quiet clock and
awaits the actual provider, receipt, log and scheduler boundaries; it does not infer one session's
quiet alarm from the global handle count. Existing single-owner retry and final zero-alarm checks
remain strict. Full two-mode J1 acceptance is still pending.

The interim production clone gate covered 2,229/2,259 eligible/owned files and detected one genuine
predicate clone between `accounting-fragments.ts` and `host-tree-publication.ts`; it failed rather
than suppressing that clone. File-size ratchets also failed for the added wiring/provisioning in
`agent-session.ts`, `sdk.ts` and `tools-manager.ts`. The required owner extractions and shared
nanosecond-accurate file-version comparison are being applied, with no raised ceilings or weakened
scanner sensitivity. These are blockers until the final static gate passes.


The H9 final tree-attempt journey now runs inside J7: real leader dispatch and admission,
concurrent peer materialization, refusal at the filled cap, and a healthy one-slot control.
It passed both modes in `/tmp/pi-j7-h9-optional.log` (one journey passed, nine filtered).

The redirected J9 control also identified a source-level cleanup defect: discard received a
nested workspace cwd but looked up only exact lane roots. It now resolves the registered root
before applying the existing bound-lane and dirty-lane safety checks. Early cleanup failures
were fixture artifacts (a shared-directory admission, then synthetic dirty files); they are not
runtime proof of a leak. The corrected real fresh-lane control removes only its synthetic files,
awaits actual discard and asserts directory removal. No forced deletion bypasses the safety guard.

The later static clone run passed with 2,231/2,261 eligible/owned production files, 2,132 detection
files, zero clones, the existing five-line/fifty-token detection floor, independent one-token
coverage, and unchanged size caps. FFF installation now has a dedicated owner; nanosecond file
version comparison has one shared implementation. File ceilings were lowered for the extracted
owners. Final static/type and all-ten-journey gates still need a frozen-tree run.


The final allocation review distinguished a live cancellation from crash recovery. New J1
summary-recovery flows hold a real claimed leaf at its store read, dispose its owner after stop
begins, assert `running/attempts=1` becomes `ready/attempts=0`, then reopen and require physical
publication. Another flow captures an absent key while summary settings are invalid, changes the
actual settings during that read, and receives a measured empty physical response: it must retain
finite backoff without a recovery-only row and retry after real owner arrivals. The matching-key
control must remain held with unchanged settings, then publish through a newly selected summary
model. No direct scheduler call manufactures those transitions. Architect source review found no
causal blocker; execution is pending.


The corrected pre-H22 tree passed all ten composed journeys in both System One modes
(`/tmp/pi-followup-all-journeys-adapter-fixed.log`, exit 0, 801.56 seconds), together with the full
static gate (`/tmp/pi-followup-adapter-fixed-static.log`). Earlier failures exposed fixture lifecycle
and ordering assumptions: actual worker reports needed changed-file evidence; cross-phase request
counts needed phase boundaries; simulated global crashes needed prior owners joined and certified
before capture; and retention age scenarios needed final explicit mtimes after marker creation.
The fixtures retain their strict warning, script-consumption, resource and expected-policy assertions.

**H-20261112-22 — mixed host-journal formats disagree on retention.** The legacy settings appender
truncated only by line count after crossing the byte cap, while managed publication batches applied
both limits. A near-cap batch followed by a legacy settings transition could leave the journal above
2 MiB with fewer than 512 rows; attribution then read it whole. Both formats now share one locked,
atomic, whole-line compaction owner. Reads use a stable bounded tail, remove partial record boundaries
before decoding and provide no attribution when the snapshot cannot be proved. Older oversized
journals can recover through an ordinary successful host write without an unbounded read.

The same review found the batch reader accepted valid subsets of malformed batches. It now shares
one transition validator with legacy records and accepts a batch only when every entry validates and
its cardinality is within the publication limit. This preserves format integrity; the journal is
observational evidence, not protection against a process able to forge an entirely valid record.

J1 adds actual persistent settings writes beside worker B's real FFF publication and protected-path
watch: recovery of a historical oversized journal, a legacy byte-cap crossing below the line cap,
whole current-batch/settings-chain retention, and a malformed batch that must not hide the actual
detached-write finding in the final claim. Atomic journal failure still must reach the exact rename
boundary and roll the publication back. Source review and type checking pass; H22 journey execution
and the final release/live gates remain pending.


The first H22 aggregate passed the other nine journeys in both modes but failed J1's new recovery
oracle (`/tmp/pi-h22-all-journeys.log`, exit 1): the fixture inspected immediately after `setPlain`,
which queues persistence. The corrected flow awaits the real settings `flush` and checks its stored
errors before inspecting bytes and exact transition identities. J1 then passed in both modes
(`/tmp/pi-h22-j1-flush-fixed.log`, exit 0, 550.44 seconds; nine other journeys intentionally filtered).
This is composed evidence from the real settings storage, publisher, worker watch, report and handoff.

The final parser review also requires the known batch discriminator to select batch validation
before legacy shape matching. A malformed declared batch cannot fall through as a legacy record
because extra top-level fields happen to match it. The existing detached-write witness now carries
those fields as well. That final narrow guard is source-reviewed and will be verified by the exact
source commit's complete Linux/Windows CI before release preparation; it is not counted as covered
by the preceding local J1 execution.

The first exact-source CI (`43260598691`, commit `410e01f935fd1b5088e7ff773dd9931916f26e63`)
passed nine Windows journeys but failed J1 because its assertions searched serialized JSON for
native paths: Windows backslashes are escaped in JSON. The journey now checks decoded journal
transition paths and the actual parent-facing user handoff text. Its required protected findings,
clean cold-install claim, rollback and whole-batch retention assertions remain unchanged. This
fixture correction passed formatting and type checking; the complete corrected Linux/Windows CI
is still required before release preparation.

The corrected source commit `273e8a59da93449a2f5ed91c49e8366b28c123ac` passed all ten journeys
on Linux and Windows in CI `43263349200`, with none filtered. Release `v0.104.57` at
`6ed2b76b4bb980cd7f11d04bfafa95f44e0f1a15` then passed the exact-tag journeys and release-only
provider/dependency gates; all nine binary workflow jobs succeeded. Release preparation checked
43 immutable changelog tags, compensating for the explicitly skipped history subcheck in normal
shallow source CI. Published archive and extracted executable hashes were verified independently.

The first full published-binary live run is preserved at
`.git/pi-audits/live-validation/2026-11-12T17-28-35-249Z/report.json`: 15 passes, three failures,
no skipped selected scenarios. It found two further H18 verifier boundary defects. Repository-cwd
launch classified the repository-hosted observer as a project instruction and correctly excluded it
under the default policy. Observer registration now stages the unchanged passive extension once
inside each isolated agent directory, an existing trusted instruction root; project instruction
admission remains unchanged. The remote ask was durably applied with `81`, but the model then held
an explicit-replies-only inbox wait for 120 seconds. The terminal handoff arrived at the next safe
boundary, after the verifier's independent 120-second screen deadline. This is evidence of late
parent delivery, not a lost remote result. The verifier now uses its existing bounded owning-turn
settlement before requiring exactly one canonical handoff for that lane/attempt, its answer, its
durable delivery receipt, the succeeded lane and visible reply. All canonical records for that
identity count before status validation, so a conflicting duplicate cannot be hidden. Existing
timeouts and the owner-chat negative control are unchanged. The model's unnecessary inbox wait
remains an observed inefficiency; this correction makes no latency guarantee.

The third failure is retained as a model task failure: the root preserved the one-line JSDoc
requirement but supplied a contradictory three-line example, which its worker followed. The root
then read the file and inaccurately described it as one line. No harness rewrite or omitted
requirement was found. The one-line oracle and original prompt remain unchanged. This run did not
reach S15's subsequent worker-start control or S43's owner-chat negative control; neither is counted
as covered. Corrected full live acceptance remains pending.

The first staging correction exposed another interacting boundary before bot creation: startup
migration archives noncanonical files placed directly at the agent root. The observer bytes were
found intact under `state/legacy-layout/root-files`, so no snapshot could be produced at the supplied
path. That run was stopped after explicit fresh-observer failures, not treated as an acceptance
pass; its partial log/evidence remain in `/tmp/pi-v0.104.57-corrected-live-acceptance.log` and
`/tmp/pi-live-gate-sSVIzZ`. Staging now uses `agent/state/live-acceptance`, which survives the existing
migration and remains inside the trusted agent root, without automatic extension discovery.

The corrected placement passed the focused native journey `s0,s1,s2,s8` on the pinned published
`v0.104.57` binary: providers, cold startup, observed main-editor bot creation and a grounded
repository answer from the second pane. Report:
`.git/pi-audits/live-validation/2026-11-12T17-53-19-887Z/report.json` (four passes, no selected skips).
Both pane observations were fresh and error-free after completion, and the staged bytes matched
the observer source. The full eighteen-scenario run and final corrected source CI remain pending.

The next full published-binary run, with verifier `8a6818dd624575cc69bff3c6486ba060d2f27468`,
passed 17 scenarios and failed S15's settlement wait, with no selected skips. Report:
`.git/pi-audits/live-validation/2026-11-12T17-55-14-429Z/report.json`. Observer placement and S43's
exact terminal/negative-chat controls passed. S15's original one-line JSDoc oracle passed; its
second root input also performed a successful live `zoom` for `id:8,n:7`.

The alpha worker correctly reached a blocked outcome when it reported file reads/writes as
command checks, then mismatched a real shell receipt. The host preserved those rejections. The
same logical task explicitly escalated to a second attempt, whose real command receipts were
accepted and whose generation-2 outcome was `succeeded/host_verified`; both terminal notifications
were delivered and the file contained exactly `alpha`. The verifier nevertheless demanded success
from every historical attempt, so the correctly rejected predecessor made settlement impossible.
This current-task versus attempt-history mismatch is being repaired in the existing settlement
owner. Rejected history must remain visible, task/generation lineage and receipt proof must be
verified, and root-call counts must include the recovery. S15's exact file, zero root-bounce and
eight-call requirements are unchanged. S9 reads the main agent, so its separate historical-health
assertions are unaffected by this default-agent finding and remain unchanged.

The corrected recovery proof passed source review and a read-only retrospective assessment through
the same verifier function over that preserved native journey. It verified task `worker-2`'s ordered
generation-1 rejected result and generation-2 accepted result, exact receipt acknowledgment and
terminal deliveries, seven root calls, zero root bounces, exact `alpha` and the original slugify/
one-line JSDoc contract. Diagnostic: `/tmp/pi-v0.104.57-recovered-journey-inspection.json`.
This reanalysis is supplemental evidence, not a new live acceptance pass; the original failed report
is unchanged. A new complete native run is still required.

Release evidence must distinguish the unchanged `v0.104.57` binary from the corrected live verifier
revision on main. The release tag includes the production fixes and composed harness regressions,
but predates these live-verifier corrections; checking out that tag alone uses the obsolete verifier.

### H-20261112-23 — remote reply finalization and shared bot-store contention

The next full native run on verifier `b61329baa37b097077c523b95f9208f7fbd60cca` passed 16 of
18 selected scenarios and failed S15 and S43, with none skipped. Its original report remains at
`.git/pi-audits/live-validation/2026-11-12T18-19-45-469Z/report.json`. In S43 the remote model
answered `81` in three seconds and the hub persisted that answer, but the ask stayed accepted
without an applied outcome. The exact failing branch remains unproved. Independently, source review
confirmed that the receiver wrote the shared bot preview before completing the ask: contention on
that lock could throw after chat persistence and prevent finalization. A roster tick also performed
a persistent bot upsert solely to notify its observers, exposing an unnecessary contention failure.

The hub now completes the ask after durable chat append and before preview projection. Presence,
roster ticks and durable chat changes publish in-process notifications. The bot store owns a
conditional projection on existing active remote bots; under its shared lock it reads the newest
durable chat suffix, so append order resolves equal timestamps and an older pending update cannot
replace a newer reply. The chat owner bounds this stable tail read and refuses incomplete or
malformed newer records. Only acquisition errors classified by the kernel lock owner schedule a
coalesced preview retry; permanent failures are reported and session stop cancels retries before
yielding. Startup may repair previews from chat, but never invents ask completion from legacy chat
records that lack a final/interim discriminator. Subscription and memory-file responsibilities were
extracted into their existing delegation subsystem; file-size ceilings were lowered.

The existing composed J10 now holds the real shared bot-store lock while actual sealed replies,
task completion, one parent terminal and chat notifications proceed. It checks that roster ticks
acquire no store lock, the transport stays connected, two equal-timestamp replies retain durable
append order, one preview retry converges to the newer reply after release, and a chat-only reply
creates no job. Shutdown cancels its pending retry without rearming it. Its only clock seam pins
the two original synchronous receiver calls and restores the clock immediately. No isolated test
entry point or fake lock substitutes for this chain. The first execution exposed an unsupported
verification claim in the new synthetic reply, which had performed no check. Its distinct factual
configuration-status reply now avoids that assertion; strict judgment and warning guards remain
unchanged. The original failure and the separate missing-module-header static failure are preserved.

Frozen source `3884563b8a303b5a88b5ae1a19ae1ae66181f99c` passed all ten composed journeys in
both System One modes locally (842.04 seconds), and CI `43293168068` passed all ten on Linux
(611.62 seconds) and Windows (481.19 seconds). Full static checks covered 2,233 eligible production
files, with zero detected clones, and checked 44 immutable changelog tags. The normal shallow CI
history subcheck explicitly skipped; it is not counted as a pass. The release workflow's exact-tag
gates, published-artifact provenance, and fresh native acceptance are tracked separately in
`.git/pi-audits/releases/v0.104.58/verification.json`, alongside the preserved source logs.

A separate fatal contention record belongs to auditor PID `140642`, not the detached daemon.
Its lock target/caller is absent from the old vendor-only stack, so it cannot be attributed to the
roster tick as a historical fact. Kernel acquisition failures now retain the original error and
errno while adding the lock target and harness caller before vendor frames. Native S9 and S44
inspect bounded fatal-crash records across every participating agent; the old health pass missed
this process death. The failed report and fatal record are preserved under
`.git/pi-audits/releases/v0.104.57/latest-failure/`.

S15's first edit retained a reviewed `partial/unverified` outcome with rejected unsettled receipts,
despite an accepted host report and a cleared parent-review notice. The plain-edit contract checks
its artifact and root-call budget; it does not require that optional worker to be accepted. The
verifier now returns operational facts separately from strict accepted-worker proof. The second,
explicit worker task still requires completed accepted receipts and their durable acknowledgment,
or the verified same-task recovery chain. A retrospective assessment through these exact owners
retained the actual partial/rejected facts, returned strict acceptance false, and checked the
one-line JSDoc and three ES2022 artifact samples. Unspecified package-target compatibility remains
unproved. That diagnostic is supplemental, not a fresh live pass, and leaves the original report
unchanged. The previous diagnostic's wrong artifact-path error is recorded with its corrected run.

### H-20261112-24–27 — bounded transport, paired parent inputs, and terminal teardown

Published `v0.104.58` is immutable at `9c1303108bcfbe91ba5379137b3c231336b65afc`.
Release and all nine binary-workflow jobs passed; Linux and Windows exact-tag journeys passed
10/10 in both System One modes. Its fresh native report remains a failure: 15 passes, S15/S16/S43
failed, no selected skips (`.git/pi-audits/live-validation/2026-11-12T20-28-59-479Z/report.json`).
S15 retained valid report rejections for a wrong workspace-relative path and an unrecorded command;
the parent interrupted a later attempt after seven calls. The correct artifact does not make those
claims accepted. Its second explicit worker task was not reached. The report schema now makes the
existing working-directory path basis explicit; the judge and acceptance limits remain strict.

S16 and S43 exposed H25: an owner-note binding overwrote a detached-wake binding for the same
provider request. The index combined the note's binding and selected input with the wake's mode and
authority. Canonical receipt `87c78a0d` on request `01a1d179-0994-70ea-91bb-09200fa065fe`
proves this exact hybrid. Its strict resolver correctly rejected it, blocking the later owner input
before canonical admission. The repair keeps separate per-mode request bindings and terminal proof
slots. Note publication remains atomic with its terminal; wake publication remains atomic with its
settlement. Exact legacy reconstruction shares one matcher, verifies both actual bindings and the
terminal-to-settlement-to-receipt chain, and retains original bodies and source keys. Arbitrary
missing, changed, duplicate, foreign-branch or unsuccessful evidence remains refused. The composed
J1 flow includes actual routine notices, owner steering, ingestion, reopen, replay and legacy copies.

The final pane cleanup then produced H26: PID 174669 threw `setRawMode failed with errno: 5`
during process exit after its PTY had disappeared. The startup exit hook still attempted restoration.
Startup and TUI stop now share a lightweight restoration owner. It classifies synchronous error
emission inside only that call, checks the live device rather than cached `isTTY`, and preserves an
error while the terminal remains attached. Enabling raw mode remains strict. Native S45 now adds a
real canonical turn, identified runtime, direct PTY closure, process disappearance, matching declared
non-forced end and shared fatal-record scan. The selected core acceptance scope becomes nineteen
scenarios; earlier eighteen-scenario reports are not relabelled. A temporary mistaken edit of the
main checkout during the v58 run was restored; the executable and verifier hashes were rechecked.
That incident and the original failures remain in `.git/pi-audits/releases/v0.104.58/`.

Release logs also generated dependency candidates. The certificate codec is already a source-pinned
patched fork. The separate Mistral SDK imports Zod v4 and buffers provider responses before Pi sees
an event; H24 guards raw SSE per frame and bounds other bodies through its HTTP adapter, preserving
backpressure, cancellation, HTTP metadata and existing error handling. Its composed J1 phase uses the
actual SDK and root lifecycle, including fragmented delimiters, aggregate streams above one frame's
limit, overflow, HTTP errors, abort and healthy continuation. It proves canonical request terminals
and reported usage, not maintenance-accounting receipts or fabricated usage for failed requests.

The dependency policy verifies Mistral's actual workspace resolution to Zod 4.6.6 and keeps sandbox's
compatible Zod 3 branch distinct. The Pi sandbox extension does not invoke the sandbox CLI's Zod
config loader; that separate upstream v3 behavior is not claimed repaired. Runtime Undici and
filesystem matcher pins address the reviewed transport/cancellation advisories. Glob 14.0.2 and
minimatch 11.0.1 satisfy the configured two-day package-age cutoff; newer suggested patches did not.
The security gate caught npm retaining old cached consumer resolutions, so only those parent lock
records were invalidated and npm regenerated them. No replacement integrity/resolution record was
hand-authored. npm audit is not claimed clean: sandbox graph metadata and development-tooling
advisories remain distinct from the repaired runtime paths. Tooling advisories are outside this
runtime repair scope.

Routine shutdown also owns the completion of its active watch observations. The runtime starts
watch, scheduler and intake stops together, joins their settlements, and reports cleanup failures
after the join. The monitor retains observation custody even when watcher setup removed its armed
entry. The composed J1 cancellation phase holds actual glob filesystem enumeration, begins session
disposal, releases that I/O and checks the joined cancellation and healthy continuation. Its small
tree establishes cancellation ordering; it is not a matcher stress or maximum-capacity trial.
The already-issued read and its actual glob callback finish before an exact filesystem-operation
check excludes descendant reads; logical iterator cancellation alone is not treated as evidence
that the filesystem callback has returned.
Failed watcher setup closes its partially acquired handles, retains failed closes for shutdown,
and rejects callbacks from a watch that is no longer armed. The intended one-shot baseline remains
separate from filesystem-event rearming.
The same journey replaces a watch while one old handle refuses closure, delivers that old handle's
error, and requires the replacement's actual baseline, occurrence and worker terminal to survive.

Source review and isolated dependency bootstrap are recorded separately from execution. The next
patch's source, release and nineteen-scenario native verdicts belong in
`.git/pi-audits/releases/v0.104.59/verification.json`; a source review or prior binary's pass does not
establish them. New regression coverage ships in composed journeys; existing policy-test changes
only maintain fixture values for the updated required pins.

### H-20261112-28 — provider bootstrap must preserve custom routing

The first H24–27 composed run on `15d45cd6e` passed nine journeys and failed J1 before its
Mistral fetch boundary. The diagnostic captured a canonical request and error terminal: the lazy
built-in provider loader attempted module I/O inside the virtual filesystem. That is evaluator
loading evidence, not a provider transport pass. The phase now eagerly imports the real Mistral
functions and registers them through the actual API registry for its composed session lifetime.

That exposed a separate production interaction: `createAgentSession` refreshes built-in APIs, and
the former registry put those registrations above an existing custom provider. Actual model
registrations use named stream owners, so SDK initialization could change their request routing.
The shared registry now distinguishes explicit base values from ordinary custom layers. Base
refresh cannot shadow named or anonymous custom registrations; ordinary custom ordering and owner
retirement remain intact. API bootstrap and OAuth seed/restore paths use that base boundary, while
explicit reset still clears the registry. Selection and enumeration share one precedence owner.

The attempted fixture repair also demanded the exact old built-in wrapper object after cleanup.
SDK bootstrap legitimately rebuilds that object, so its identity was not a restoration invariant;
that assertion masked the body failure. The composed phase instead verifies retirement of its own
layer and restoration of the latest underlying owner, and preserves body and cleanup failures
together. Its real SDK/root request remains the witness for custom routing across session creation.
The failed local and Windows runs, diagnostic and source-review evidence remain in the v59 audit
ledger. Transport, parent-input, watch, release and native verdicts remain pending their final runs.

The next frozen J1 run on `d73144c75` reached the parent-input overlap checks after all six actual
Mistral request/terminal assertions, but remained a failure. Its new provider phase lacked explicit
System One owner-intent judgments, and the overlap predicate compared append-command keys with
persisted unit keys, omitting their final unit index. Both are evaluator defects; the latter does
not establish an ingestion failure. The corrected fixtures keep System One enabled, retain the
strict judgment guard and twenty-second deadline, and still require exact-once bodies and legacy
replay. All 3,021 frozen files remained unchanged during that failed run; its original report is
preserved rather than promoted to a partial journey pass.

Later ingestion diagnostics found the evaluator decoding every virtual file for each ICM predicate.
Its snapshot reader now selects the store directory before decoding, preserving the actual file
ordering and contents. The next frozen run reached the ingestion, replay and legacy checks, then
failed later watch assertions. That run remains failed: two new-store summary scripts competed with
the original store's scripts, a closure assertion used an offset into a capped history, and a
zero-read expectation installed a fault whose global guard requires a hit. The fixtures now give
the imported store its own summary actor, identify closures by handle and path, and inspect actual
post-callback reads. The global fault guard and exact-once assertions remain unchanged.

### H-20261112-29 — shell acquisition must retain shutdown custody

The Windows diagnostic CI run on `2cea21aa5` identified a surviving child as an `engine-daemon` in
`runtimes/pi-shell-engine`. It establishes the process class, not the original caller or exact
interleaving. Source review independently confirmed that pool acquisition can grant a lane before
its awaiting caller resumes; disposal in between retires the lane, after which the caller used to
create a process under its removed key. Engine execution, engine prewarm and PowerShell-floor
prewarm share that admission boundary. A deferred automatic warmup could also look up a fresh pool
after its original owner had shut down.

The pool now validates the live lease immediately before resource construction. Deferred warmup
keeps its original owner, and a small scheduling owner centralizes deferred context resolution and
best-effort error handling. Its callback is awaitable so the composed journey can join the actual
warmup after releasing a shutdown barrier. Normal command failures retain their strict behavior.
The existing J1 shutdown journey includes public root warmup, real delegated-worker automatic
warmup, disposal between grant and delivery, physical child custody and healthy command execution.
Windows-specific controls are explicitly platform-scoped; a Linux skip does not establish their
execution. Final source, cross-platform journey, release and native verdicts remain in the v59
verification ledger.

The frozen `ca1bd08b7` local run passed nine journeys and failed J1's final guard because the
watch-replacement response omitted explicit answer-claim judgments; its 3,023 source hashes stayed
unchanged. Windows additionally refused the new warmup fixture's worker dispatch; its boolean
assertion did not preserve the reason. Source review found that ordinary direct dispatch of the
fixture's verifier profile is explicitly refused. The fixture now uses an explorer for that ordinary
worker, retains the same shell capability, and reports the actual bounded dispatch refusal instead
of hiding it behind a warmup timeout. The next Windows run must establish the outcome. These are
evaluator corrections; the admission and claim-check guards remain strict.
