# Harness interaction register and investigation ledger

[Current scorecard](#working-tree-rating) · [Product rating](#product-rating-2026-11-20)

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

### H-20261112-30 — terminal hangups, bounded cleanup and exit evidence

Published `v0.104.59` remains immutable at `934d934b2db443f2586107d9c7178f499419e3e5`,
whose sole parent is reviewed source `0a8f6a9ce`. Both exact-release quality jobs passed all ten
composed journeys; provider regressions and fork installation passed on both platforms, and
dependency hardening passed on Windows. Release preparation checked all 45 prior tags. The shallow
reusable-CI checkout could not establish that history comparison independently, so main commit
`012c1a405` gives CI full history. Its two jobs passed all ten journeys and Linux explicitly checked
all 46 tags. These are distinct evidence paths, not interchangeable gate results.

The fresh nineteen-scenario native run failed S45 after eighteen passes:
`.git/pi-audits/live-validation/2026-11-13T00-40-08-407Z/report.json`. All 3,023 source hashes
and the pinned executable stayed unchanged. S15 settled the first edit in six root calls and the
explicit worker task in five with accepted proof. The first edit's worker report remained partial,
unverified and rejected; the independent artifact check covers the stated ES2022 examples and
JSDoc, not unspecified package-target compatibility. Retrospective transcript inspection found
24 actual zoom calls, all with matching successful tool results and no postprocessing failure;
bounded/clipped replies retain their ordinary continuation semantics.

The identified S45 runtime, PID 238671, recorded `SIGHUP` starting graceful shutdown at
`00:52:35.062Z`, then another `SIGHUP` forcing exit 129 two milliseconds later. It wrote no fatal
crash record. This is evidence of immediate repeated-signal escalation, not a cleanup timeout or
the former raw-mode crash. Herdr's verified v0.9.5
[close path](https://github.com/herdrdev/herdr/blob/v0.9.5/src/pane.rs#L1757-L1800) queues
[PTY shutdown](https://github.com/herdrdev/herdr/blob/v0.9.5/src/pty/actor/unix.rs#L359-L369) and also
[sends SIGHUP](https://github.com/herdrdev/herdr/blob/v0.9.5/src/platform/linux.rs#L798-L837) to the
session's processes before later TERM/KILL deadlines. Those overlapping mechanisms
explain how one close can produce multiple hangups, but the sender of each observed signal is not
proved. The failed run and its signal records are preserved. Its four owned panes were closed,
its daemon lease released and post-cleanup fatal health was empty; the original pane was retained.

The repair changes the old repeated-HUP contract explicitly: a hangup during cleanup joins the
same disconnect operation. TERM and INT retain explicit force behavior. `SignalLifecycle` owns
the total ten-second asynchronous cleanup deadline, kept alive while cleanup is pending, and one
terminal outcome. Timeout, force, dead-terminal, crash and success retire the alarm; late cleanup
cannot start another step or reclassify the result. Deadline expiration remains a failed end.
This fits the existing lifecycle owner; it does not require a separate shutdown coordinator.

Source review also found a proof gap: the process recorder deduplicated by reason alone, so a
provisional `signal-graceful` declaration suppressed the later invoked exit-code record. The
recorder now distinguishes reason and exit code. The native reader requires the latest matching
record's expected explicit code and refuses a provisional or forced record without falling back
to an earlier declaration. That establishes exit invocation plus identified process disappearance;
it does not claim independently observed OS exit status. Composed J1 coverage holds real runtime
extension cleanup across signals and the deadline; native S45 retains the actual PTY close and
persisted-answer checks. New execution and publication evidence belongs in
`.git/pi-audits/releases/v0.104.60/verification.json`; no H30 pass is inferred from source review.

The first built Node-source S45 run retained the performed forced-exit record but failed after
Herdr sent TERM roughly 263 ms after HUP. That host deadline is distinct from Pi's ten-second
cleanup deadline; the exact blocking cleanup stage was not established. The native fixture now
uses a pane anchor to attest the real PTY and lets the independent gate spawn and retain Pi in a
separate OS session. Closing the actual pane removes the PTY, then the gate sends HUP to the
identified runtime. This covers signal handling against dead terminal I/O; it does not establish
natural terminal-generated HUP or job-control behavior in the isolated session. The strict
cooperative performed-exit, persisted-answer and fatal-record checks remain mandatory.

The gate validates PID/start ticks/session identity and PTY device identity before detachment,
keeps child custody from spawn through physical close, and bounds failure cleanup. Cleanup
attempts every safely identified member and reports ambiguity rather than signaling an unproven
process. Linux identity reads and signals are separate operations, so the fixture retains a small
identity-check-to-signal race without pidfds. Its negative proof controls reject newer provisional,
ambiguous and forced records even when an older completed record exists.

The first H30 composed J1 run failed an obsolete fixture barrier: forced/crash cleanup waited for
a second successful exit that the single-terminal-outcome rule correctly prevents. The fixture
now joins actual runtime disposal and lifecycle listener cleanup, asserts the original sole
outcome, and releases its virtual children even when an assertion fails. The failed run remains
preserved; the corrected composed run is separate evidence.

The corrected-quit J1 run on `a8f1b84ab` completed System One enabled and failed later in the
disabled run while waiting for an ICM store to become idle. Its 3,023 source hashes stayed
unchanged. The trace narrows the wait to legacy parent-input import/reopen during routines, but
the old generic timeout does not identify the pass or blocked condition. It does not establish a
production ingestion defect. The composed wait now records bounded root, scheduler, migration,
alarm and provider diagnostics while retaining its predicates and sixty-second deadline.

Independent source review confirmed that this fixture selected only the first alarm in insertion
order. A pre-existing nonquiet alarm could hide an already-armed quiet-delay alarm, leaving the
driver waiting for a future arm. The driver now selects the matching alarm with the nearest due
time. Its event-driven wait remains and does not drain arbitrary alarms. It retains the existing
quiet-delay heuristic; a matching delay alone does not establish an alarm's purpose. This fixes the demonstrated fixture ordering case, while attribution of the
recorded timeout remains unproved until further evidence. The complete composed journey remains
the execution boundary for this correction.

The complete passive-witness J1 run on `f26131025` passed both System One modes with all
3,025 source hashes unchanged. The historical timeout's exact cause remains unproved; the
successful run does not reclassify it. Source review separately confirmed redundant fixture
notifications: every queued callback re-read the same latest state. Virtual IO now batches those
notifications into one pending turn, clearing its scheduling flag before evaluating predicates
so a mutation during evaluation schedules another turn. Waiter error isolation and all journey
deadlines remain unchanged. This test-side change must pass the normal cross-platform
journeys separately from the immutable v0.104.60 artifact.

## Continuous-chat and delegation follow-up, 2026-11-17

Pi session `01a1eb49-a3a4-7f3a-8407-943dfee2b619` ran against checkout `0c98c4e4e`. Its canceled worker left a partial implementation. The following evidence guided the resumed work.

| Observed in the session | Work assigned |
|---|---|
| The foreground analysis counted 1,678 consecutive single-message pending lines, about 64 KB. The harness log for session PID 678333 recorded a 120-second summary hold. | Collapse pending siblings into addressable ranges, retain recent role cues, and make deterministic compaction eligible during model holds. Log the reason for a hold. |
| Five delegate calls failed before the first successful start. A later follow-up also used the wrong action and payload field. | Align routing guidance, tool examples and worker identity with the advertised start and follow-up contracts. |
| Five numeric `zoom({id})` calls passed the root tool schema and were rejected by the navigation parser for missing `n`. | Give a numeric ID the same single-message meaning across schema, parser and worker navigation. |
| Three successful tool searches each loaded five tools. All three were followed by a WebSocket input-prefix mismatch on an otherwise intact foreground request. | Exclude synthesized tool outputs from the saved assistant-response baseline so the next delta carries the actual search result. |

Two questions remain for measurements from a subsequent session. Compare pending bytes and foreground latency while the local compactor drains a held backlog. Check whether repeated paid summary replies improve retained content enough to justify their cost. This session has no `history_summary` usage receipt. Its seven fresh-turn snapshots with a divergent prefix are distinct from the three within-turn tool-search cases. A full-request fallback alone does not establish a provider cache miss.

### Worker dispatch, handoffs and cost baseline

Across 158 historical transcript files for this checkout, 44 contain a model's first worker start attempt. The host admitted 32 and refused 12. Counting only `delegate start`, its default-action form and the observed invalid spelling `spawn` previously gave 30 of 41. The corrected measurement includes the one-call `assign` tool and matches each result to its tool name and call ID. In the incident above, about 54 seconds elapsed between the first refused call and admission. Four attempted starts and one profile inspection failed in that interval. Admission includes queued work. A worker request or terminal is separate evidence that execution began.

There were 97 worker attempts with identifiable terminal lane records. For 53, the same file contained a displayed handoff with the same lane, attempt and terminal status. For 44, that specific record was absent. Older data also contained 80 terminal rows without an attempt ID. A missing match calls for checking other delivery paths, intentional suppression and legacy data before counting a lost result. The incident itself had three matching handoffs. Their host outcomes were blocked, partial and canceled. The partial worker's own claim of completion would have given a false success.

Use `node --conditions=pi-source scripts/delegation-session-stats.mjs --sessions-dir <project-session-directory> --since <date>` on transcripts started after an upgrade. The report scans the physical files including branches, deduplicates handoff observations per file and separates conflicts, legacy rows and missing results. It reports recorded display events. Whether the parent model acted on an event requires separate evidence. Reading transcripts adds no prompt bytes or provider calls.

The incident's three tasks on the same Sol agent accounted for $1.309922 of recorded worker cost across 73 receipts, with zero host-accepted tasks. In `/cost`, the direct worker subtotal includes unsuccessful work and retries from retained tasks whose latest attempt ended. Unit cost divides that subtotal by distinct accepted tasks. Missing cost evidence, a missing outcome or zero acceptances withhold the estimate. Foreground and Jev calls belong to separate budgets. Reported amounts can be API-equivalent estimates.

For the next deployed cohort, compare first-call admission with this baseline and reconcile missing terminal matches by delivery path. Compare direct cost per accepted task only across comparable workloads, recording how many tasks had usable pricing and outcomes. Scripted CI can exercise failed starts, genuine edits and cancellation. Only subsequent operating traffic can establish a change in these rates.

### Local Grok measurements on 2026-11-18

On the installed v0.104.70 Linux binary, Grok 4.7 Build Fast completed the plain edit and explicit worker journey in 77 seconds. The router selected Claude Haiku 5.5 for both workers. Both tasks earned host acceptance. The recorded total was $0.42370. Regular Grok 4.7 wrote the requested edit through a worker, but both attempts ended blocked on the same logical task. The worker reported a repository-relative path from a package working directory, and its report included checks without matching command receipts. The gate timed out after 342 seconds, including the wait for an accepted handoff. The recorded total was $0.25223.

On the follow-up source checkout, regular Grok completed the journey in 120 seconds for $0.18311. It edited directly and delegated the explicit worker task, which earned host acceptance. A focused regression reproduces the earlier path mismatch and verifies the corrected path against the same host verdict. The different execution paths make these totals unsuitable for estimating savings from the change. The three totals include foreground, direct worker and semantic usage at recorded or API-equivalent prices.

All five automatic handoff requests across the three runs changed the provider-visible prefix at message index 1. Each retained the same system and tool fingerprints as its predecessor. A further change occurred at the next owner turn in the Build Fast run. Some requests with an intact prefix also received only 1,152 cache-read tokens. The snapshot proves a change in Pi's input where marked, while provider reuse on intact requests requires separate measurement. A fresh window currently protects against stale or unaccounted arrivals. Reusing history across handoffs requires proving which new host records are visible and appending them exactly once.

### Prefix reuse across a live worker handoff

A completed worker can add two different records to the parent. The foreground receives a bounded completion notice. The continuous chat can also contain a longer report at a new chat ID. The next request keeps the preceding provider-visible messages when the live host can account for every new arrival on the current branch, under the same visibility and provider context. It appends the notice and the exact pinned chat rows covering the new reports. Each report has a zoom address. Tool follow-ups reuse the planned bytes. Replayed attempts, edited notices, revoked visibility, and unaccounted arrivals make the planner open a fresh window.

A fourth pre-change Grok run brought the baseline to seven automatic handoffs across four journeys. Every handoff changed the prefix. In the first two live source runs with this change, all three handoffs and all nine tool follow-ups preserved the prefix. xAI reported cache reads for 92.9% to 95.8% of the handoff inputs. Each run still had one intact tool follow-up with only 1,152 cache-read tokens.

The Build Fast journey took 93 seconds for a recorded $0.30047. The regular Grok journey took 136 seconds for $0.17317. Measured from the persisted user message to the last parent response for each task, the small edit took 27 seconds directly on Build Fast and 73 seconds with a worker on regular Grok. The second task explicitly required a worker and took 27 and 25 seconds respectively. Both produced the required file and an accepted worker receipt. Elapsed journey time also includes starting the isolated agent and waiting for the test driver. The sample measures two execution paths and does not establish an average latency or a monetary saving.

A third source run preserved the prefix through a blocked handoff. The worker wrote the requested five bytes. It submitted file operations as command checks, then ran a command and reported an abbreviated version. The host could not verify the claimed check. The parent had answered within 28 seconds of the second prompt. The live driver nevertheless ran to its 300-second settlement timeout and the journey took 379 seconds. The other three worker attempts across the first two runs had also needed one report correction, costing 2.8 to 3.7 seconds per correction.

Workers can now cite an attempt-scoped command receipt by the ID printed in the tool result. The host supplies the command digest and checks the outcome. Unmatched checks still block acceptance. For a required worker, the native benchmark reports a blocked result once the durable outcome requires owner action, its notification was delivered, the parent answered the matching handoff, and two fresh idle observations agree. Replay of the failed session reached that failure on the second poll. Automatic recovery and missing delivery evidence still require the driver to wait.

Build Fast then completed the same journey in 190 seconds for $0.36156. It delegated both tasks. The small edit took 90 seconds and the explicit worker task took 25 seconds. Both workers earned acceptance after correcting file paths they had reported relative to the repository instead of the package working directory. The first also removed a file read from its command checks. This run exercised file-only reports. The composed recovery journey separately exercised a worker copying its command receipt ID from the actual tool result and validated the ID after reopening the transcript.

Following the two path corrections, the edit and write results also give the worker the exact path persisted by its mutation recorder. The composed journey checks what reaches the worker, and the focused regression covers a failed persistence attempt. Live timings above predate this file-path hint.

Across these four source runs, all six automatic handoffs and all nineteen tool follow-ups retained their prefix. The provider reported 92.9% to 95.8% cache-read input on handoffs. The two direct edits took 27 and 40 seconds, and the two delegated edits took 73 and 90 seconds. Different provider responses and local tool timings contribute to these observations. These runs establish behavior on small edits and one-file worker tasks only.

### Local work per harness action

The following bounds come from the loops and data structures in the source. They do not estimate provider latency or cache-hit rates.

| Action and owner | Work removed | Invariant and control |
| --- | --- | --- |
| Order the ready queue in `FleetQueue.ordered` | The old selection scanned the remaining flows and entries for each emitted worker. Sorting each flow once and merging its heads with a heap costs O(N log N) for N queued entries. | Use the same time for the whole ordering pass. Shares, critical-path and aging priorities, arrival tie breaks, and charging an admitted non-head keep their original meaning. |
| Evict inline images in `applyProviderRequestImageBudget` | A message with B blocks could require O(B²) searches and array shifts. For each affected message, the planner selects the eviction count, scans its blocks a constant number of times, and copies its content once. Capability filtering also allocates replacement arrays only on a change. | Preserve image order, user placeholders, the existing tool note, the exact byte threshold, and durable history. Multiple occurrences of the same image block still count separately. |
| Check retained message dependencies in `ContinuousChatMessageDependencies.isCurrent` | Repeated checks over D tracked objects cost O(1) each while the dependency set and the kernel content epoch stay unchanged. The first check after invalidation can cost O(D). Retaining a new provider frame also avoids a second copy of its historical prefix. | An imported history dependency can already be stale. Adding it invalidates the cached verdict. Per-message token estimates also compare the individual content revision after the fold invalidates. |
| Rebuild compacted session text in `session-context-builder.ts` | Carried records are selected and emitted in branch order without searching the branch from a sort comparator. Gap recovery indexes the latest summary owning each ID. Legacy boundary lookup stops at the preceding request or compaction. | Respect scoped sections, per-kind supersession, pending input, prepared-summary barriers, and whether a later summary already covered a gap. |
| Resolve a worker tool invocation | The active session lifecycle index looks up the call by ID and name. An append updates the index from the new assistant's tool blocks. | Ambiguous calls are refused. Reopening a session or moving to another branch can rebuild the index. |
| Read the owner’s model pool policy | The router asks the session index for the newest policy entry. Ordinary appends walk back only to the previous leaf. | A malformed entry falls back to the preceding valid policy on that branch. |
| Estimate usage and covered characters | Prefix folds over Agent-owned history skip prior rows after an append. The token memo checks the message’s published content revision without comparing or copying a prior transcript. | Removal, replacement and content edits invalidate the corresponding proof. Unversioned projections still require comparison. |
| Seed tool failure recovery | The tool tracker uses the active records the accepted request’s sanitizer already produced. A tool-free response allocates no tracker. | A replacement context discards the prior tracker. A stale admission candidate cannot seed the next tool batch. |
| Disclose tool schemas | The planner supplies a lazy activation history. Eager disclosure does zero transcript reads for activation. | Deferred disclosure still consumes historical activations to retain tools enabled before compaction. |
| Resume a worker conversation | Before planning, the worker checks its branch, resolved provider/account/model, source prompt and projected tool definitions. A scope mismatch drops both marks before walking history. | Matching handoffs compare only the extent present on both sides and rewind at the first changed row. A published edit to an accepted object invalidates that row even if the new view aliases it. |

Foreground refresh, verification replay and worker handoffs use versioned row ownership. Supported edits carry their earliest changed index. A mutable extension, an unclassified listener, a disk-backed payload accessor or a filtered legacy tool-failure history can require a full pass. History-work observations expose those fallbacks. Native Responses requests retain encoded items across append and retry, including the provisional end of an interrupted tool exchange. A credential or request-scope change invalidates reuse.

The release provider regression suite invokes `npm run check:history-work` with 100, 1,000 and 10,000-row fixtures. They count source reads, payload loads, recompression, row conversions, reference copies and emitted items separately. The Responses fixture makes both old row access and repeated redaction of old wire text throw. In the foreground fixture, with path aliases enabled and one historical tool result, policy evaluation visited that result once at every size and the planner converted one new row. In the persistent-worker fixture the same two-row suffix required five source visits, zero cold loads and zero old bytes recompressed at all three sizes. The synthetic transport still received a complete message array, requiring 104, 1,004 and 10,004 reference copies respectively. A separate 1,000-row case sends a large Bash result through context GC. Its first wire representation is under one tenth of the original text size. Appending one row reuses the same packed tool result and converts one new row. Continuous-chat handoffs certify the actual previously dispatched array before extending it. A network request serializes the full native input.

One synthetic two-request measurement through the planner and native Grok adapter used `grok-4.7-build-fast`. The initial request reported 5,208 uncached input, 1,152 cache-read and 57 output tokens ($0.022668 calculated). The follow-up reported 163 uncached input, 6,272 cache-read and 28 output tokens ($0.007260 calculated). The first request already had provider cache reads. Both output length and cache reuse affect the observed cost difference.

### Live-session findings, 2026-11-19

| Observed interaction | Change and evidence boundary |
| --- | --- |
| AGY authentication and Gemini history | The installed 1.5.12 Linux executable was matched to the reviewed build. Its OAuth flow retained the 1.5.9 hosted callback and S256 challenge. Pi now identifies as 1.5.12, validates a pasted callback against the current login, and refreshes credentials carrying an older client identity. A Gemini 400 followed a response with two parallel calls. Pi now carries the signed first call across effort changes. Imported unsigned history uses the first-call marker on the AGY JSON transport. |
| Plans, dispatch and worker mail | A permanent local scope or authority refusal holds the plan step for replanning. A capacity refusal waits for room. Local dispatches and follow-ups accept up to 262,144 UTF-16 code units. Above the existing inline threshold, the dispatch or mailbox record owns the complete body, byte count and digest. Recovery verifies and decodes that record. Encoded bytes count toward storage quotas. Linked jobs still enforce their 16 KiB transport limit before placement. Version 4 plan records admit a 4,096-character step. |
| Tool recovery and worker supervision | A declared field-removal repair can retire the failure when the corrected invocation succeeds in the same scope. Optional filesystem probes treat overlong path candidates as misses. Worker reports resolve a cited command against the host receipt for that attempt. Only a recognized verification command or a typed verification receipt can support a claim that checks passed. Targeted checks, differing commands, and an interval of healthy progress no longer count as repeated broad validation or continuing failure after a steer. |
| Review and background work | An unsettled soul review identifies the clauses involved. When a claim exceeds the review budget, a consult can identify a complete tool result for the judge, including the producing command and subsequent results. An ambiguous or clipped citation stays unsettled. An unset summary model holds model work before the scheduler claims individual nodes. |

In the foreground runtime, composing the request plan discarded its compression policy and the callback that publishes accepted packed rows, so provider history could diverge between requests. The runtime now forwards both through normal dispatch and composes acceptance with any earlier plan. A regression through the installed foreground planner checks that a packed delegate result keeps its spelling on the next request. Disk-backed rows whose contents cannot be retained safely stay in their original form. This can increase input size after reopening a session. Debug logs now record the differing row fingerprints, a hashed tool-call ID and both message counts.

With the optional prompt-enforcement setting enabled, a successful provider response now publishes the exact artifact previews used in that conversation. A frozen follow-up reuses a preview while its source, incoming projection and retrieval handle still match. A query needing additional evidence gets it at the request tail. Accepting raw history retires the previews. A late completion cannot restore a view superseded by a newer accepted request.

| Boundary | Repair |
| --- | --- |
| Command output and replay | Command output can quote a password in a free-text field. Command output, streamed previews and saved output blocks mask that form. Provider projection applies the mask to historical tool-result text and details. Existing transcript files still require separate remediation. |
| Delegation and owner knowledge | A worker could receive the memory directory as its workspace and write grant and change the knowledge store directly. A stored revision proves the change occurred. It cannot establish that the owner confirmed each proposal. Worker admission and grant compilation now refuse this scope, including an explicit enclosing write grant. File tools and private-path command checks cover the memory directory and SQLite companions. The operator reviews and confirms proposals through `/taste`. Arbitrary same-user subprocesses retain their OS filesystem permissions. |
| Plan progress | The model could describe workers as running after a start returned zero starts and only waiting steps. Receipts and status now derive running work from executing attempts and completed work from accepted outcomes. Queue admission, suspension and cancellation have distinct meanings. |
| Summary accounting | A watchdog can return before a dispatched summary physically settles. The queue preserves the obligation for replay. Only matching authoritative usage can clear it. |
| Wake replay | An unrelated owner turn could finish before Pi retried an existing wake. The replay now places that wake's manifest at the request tail and requires a successful terminal bound to the same delivery before settlement. |

The OAuth comparison covers native flow construction. Provider acceptance of a new login, rotated credentials and account entitlements require a live account.

## Product rating, 2026-11-20

The last assessment of the published v0.104.72 release was **8/10 overall**. The working-tree assessment below uses the installed upgrade, independently graded coding trials and composed journeys. The target requires at least 9 in every area and evidence that the same release can complete work across those boundaries.

Here, friction means the owner has to intervene again to get an already-authorized outcome. Examples include repeating a correction after restart, rescuing a worker the harness could have recovered, or checking the filesystem because a success message was wrong. The measurements distinguish those interventions from new requirements, deliberate stops and decisions that genuinely need the owner.

| Area | Published baseline | Interaction needed to reassess it |
| --- | --- | --- |
| Direct coding and tool execution | 9 on the four measured tasks | Complete the requested edit through public tools, preserve an owner's existing edit, and independently grade the resulting checkout. |
| Worker dispatch, handoff and recovery | 9 on exercised paths | Restore an interrupted parent, accept the correct worker attempt once, and finish the original request without a second owner prompt. |
| Adaptive planning, model routing and cost | 7 | Compare direct and automatic routing on matched tasks. Include failed attempts, interventions, wall time and complete pricing. Include both tasks that benefit from delegation and tasks that the main agent can finish directly. |
| Context, caching and continuity | 8 | Reopen a long branch with a pending task. Check that steering, receipts and worker reports survive compaction, the old branch stays isolated, and prefix reuse and token counts are measured. |
| Permissions, credentials and progress reporting | 7 | Carry the owner's grant through a delegated task. Confirm that a refusal or a queued start is reported accurately, that credentials stay out of durable output, and that the worker stays inside its authorized scope. |
| Providers and OAuth | 8 | Observe an authorized sign-in and a provider or account change while work is outstanding. Check the resumed request, credential handling and usage attribution together. |
| Memory, learning and proactive work | 8 | Recall a prior owner decision on a later task, honor a correction or revocation, and deliver a watch result without granting it authority over unrelated work. |
| Bots, schedules, phone control and paired machines | 9 in simulation | Deliver a scheduled or phone request across a disconnect. Match its result and permissions to the original sender and verify the physical delivery and cancellation paths. |
| Workbench, extensibility and distribution | 8 | Upgrade an installed build with a representative extension and pending work. Reopen it, inspect accurate progress, and finish the task through the workbench. |

The joined acceptance scenario starts with an owner decision saved in memory, then an owner-channel request for a code change. The root chooses the execution route, the tools and workers honor the grant, and the owner steers the active work. A provider change and parent restart occur before the worker's result returns alongside an unrelated result. The installed workbench must show which task finished, what remains, and how much usage has been priced. The originating channel receives the correct answer once. Capture the build, task, route, receipts, final checkout and interventions for the same run. Separate simulations and live observations establish only the boundaries they exercised.

The matched coding study and planning calibration inform the published baseline. A review of historical owner follow-ups across several coding agents counted the times the owner had to repeat an assigned outcome, reopen a settled decision or correct a demonstrated error, separately from new requirements, status requests and genuinely missing permissions. Most confirmed interventions followed a partial or unclear delivery or corrected the result or target. The sample, its counts and its per-turn verdicts stay in the local acceptance database. Those historical cohorts predate the ordinary-work repairs and do not measure steering after them. The available reasoning-effort attributions were too few to compare intervention rates by effort. [Coding measurements](../packages/coding-agent/docs/coding-evaluation.md) · [Prior live-session findings](#live-session-findings-2026-11-19)

The 34-second Optimus-1.2 demo shows successive snapshots of a running swarm. Agent activity, token use, elapsed time and merge counts change while branches of work continue. For Pi the relevant question is whether the harness can tell which result advanced the owner's request, report what that progress cost and stop attempts that no longer help. The video supplies a design reference. The linked assessment above supplies Pi's measurements. [Optimus-1.2 demo and announcement](https://x.com/0xDevShah/status/2123660419227361465)

Two implementation references informed the recovery design. Ratio keeps a SQLite journal of requests, decisions and verification receipts. Its staged workflow checks the merged result before a reviewer can approve publication. Pi-durable records unanswered inputs and distinguishes interrupted tools from work declared safe to replay. Pi uses its existing decision database to retain each ordinary request and the number of continuations already spent. A restart can recover the obligation without automatically repeating the operation. The host enforces a lifetime limit of three continuations across restarts. [Ratio at the reviewed revision](https://github.com/19h/ratio/blob/cde88fb889cb8c530a08aa4354385f84d8abb4ed/README.md) · [Pi-durable at the reviewed revision](https://github.com/earendil-works/pi/blob/fe8a6f5dc741e9214a20f70f359c68c72b494d1e/packages/durable/README.md)

### Offline acceptance on the November 20 checkout

All 12 public harness journeys passed with System One enabled and disabled. This includes foreground tools, recall and extension reload, delegated work and dirty worktrees, plan votes and merge checks, budget holds, bot and phone sessions, sealed pairing, model transfer and parent restart. The journeys use scripted model transports and simulated devices. Separately, a focused journal replay, compaction and restart regression passed with long attached worker instructions, including rejection of a corrupted snapshot hash.

The installed upgrade and live trials below add evidence about these paths. The local remote registry contains this installation's identity and no paired machine. The channel directory has no configured physical delivery destination. These journeys cover the simulated send, reconnect and cancellation paths. [Public harness journeys](../packages/coding-agent/test/harness-interactions.test.ts) · [Measured coding trials](../packages/coding-agent/docs/coding-evaluation.md)

### Ordinary-work interaction findings

| Interacting owners | Failure and control | Working-tree repair |
| --- | --- | --- |
| Branch selection and SQLite enrollment | After branching from a shared opening, a second lookup could revive the sibling's request. Returning to its original branch should restore it. | The controller verifies the recorded frontier before caching the opening. |
| Waiting checkpoint and worker, plan or tool delivery | An already-delivered result could remain unseen indefinitely after a restart. An unrelated result in the same batch could count as evidence. | Foreground settlement and startup recovery use the same request-scoped projection. It distinguishes retained evidence from new results and uses the launch identity of each worker or detached tool. |
| Process ownership and database recovery | PID reuse could strand an interrupted request. A different machine could mistake the recorded PID for a dead local process. | New leases retain the kernel's process identity. Reclaim requires evidence of a dead owner. Existing PID-only records use the kernel's legacy local-owner rule. |
| Session storage and ordinary stop review | Reviewing a recent request hydrated cold messages all the way back to the start of the session. A sibling or an earlier task contributes no evidence. | The session manager stops at the opening before materializing payloads. Review applies the same bounded receipt projection to a restored and a live request. |
| Cost receipts, routing evaluation and operator reports | A priced call could conceal a second, unpriced call on the same model. The aggregate looked complete. | Pricing completeness is recorded per call before grouping and consumed by the coding evaluator and cost views. A known zero price remains valid. |

The five focused recovery, settlement, receipt, branch and status regression files passed all 21 checks. Status reads use the current branch and an already-open database. They expose a reason code and the spent continuation count. Disposal releases an existing lease and a later abort cannot reopen it.

The restart handoff journey follows **one owner request** from the initial read-only worker through a model transfer and a parent restart. The same SQLite opening survives. With System One enabled the matched successor report wakes the parent once, the final answer fulfills the request, and status shows zero automatic continuations. With System One disabled the report is still delivered and the request remains unverified. The successor has a priced zero-cost fixture rate. This exercises recovery, provider attribution, permissions, status and delivery on the same task. [Restart and handoff journey](../packages/coding-agent/test/fixtures/harness/journeys/journey-12-restart-handoff.ts)

The plan journey reproduced an invalid partial vote outcome that retried until the process exhausted its heap. Partial votes now carry a root decision and preserve the candidate reports. Seven focused vote and merge checks passed. They cover a failure to save a hold, an explicit revision becoming runnable and a superseded landing losing permission to mutate a worktree. The composed plan and worktree-lane journeys passed in both System One modes. [Join settlement](../packages/coding-agent/src/core/plan/joins.ts) · [Recovery regressions](../packages/coding-agent/test/plan-join-error-hold.test.ts) · [Merge revision regressions](../packages/coding-agent/test/plan-merge-version.test.ts)

The ordinary-work state checker exhausted 247 base states with a bound of two host crashes. Five injected faults violated their designated properties, including a provider dispatch after steering superseded an approval and a tool executing during an answer-only turn. The other properties cover independent reviewer assent, the lifetime limit of three and eventual closure under a responsive host. Semantic judgment and provider behavior require separate evidence. [Ordinary request lifecycle](../packages/coding-agent/docs/system-one.md#when-an-ordinary-owner-request-stops) · [State model](../packages/coding-agent/src/core/ordinary-work-model.ts) · [Composed journeys](../packages/coding-agent/test/harness-interactions.test.ts)

### Installed and live acceptance on the November 20 checkout

An isolated Linux installation upgraded from v0.104.71 to a locally built v0.104.72 candidate. The session identity, name, history and pending input survived the installer. The older release had no ordinary-work row to recover. A new pending request on the candidate survived process termination and reopened with a visible judge-unavailable hold, zero automatic continuations and no replay. A subsequent ordinary owner prompt produced a reply. The extension command executed on both sides of the upgrade.

The installed check uncovered two ways explicit extension authority could be lost. Auto-discovery metadata hid an explicit CLI selection when both named the same file. Startup also filtered a CLI extension's provider differently from its commands. On the repaired binary all nine installed checks passed. They exercised a shipped TypeScript extension, provider selection before the first model call, an inactive discovered extension, and profile and user exclusions. The install checks used a loopback model fixture. The separate native OAuth check used an existing login, two successful requests, an actual file read and a reply containing the fresh marker and its filename. In a joined source-code trial the OpenRouter root read a fresh value from limits.ts and was interrupted before delivery. Reopening the same SQLite task on Codex OAuth led to an independent review and one answer-only continuation. Both OAuth requests advertised zero tools. The owner received the correct filename and value from the retained receipt, with one owner prompt and no second read. The daily spend rollup was still pending when the run stopped. A fresh sign-in and physical device delivery remain unverified. [Extension import authority](../packages/coding-agent/src/core/extension-import-authority.ts) · [Extension authority regressions](../packages/coding-agent/test/extension-cli-authority.test.ts)

With the citation check enabled, a fresh TypeScript setting and the exact synthetic marker from a previously failed run both recovered across the OpenRouter-to-Codex transition. Each had one owner entry, one retained read, one continuation, a correct answer and a fulfilled SQLite row. The reproduced marker reached the existing 0.85 provisional band. That band can invite independent answer-only review. The reviewer supplied a matching result citation before reservation. Another fresh marker scored 0.80 and initially remained unverified with zero continuations. Its recorded sufficient-evidence score was 0.86. This exposed a case where the independent model never saw a complete read. [Recovery policy and thresholds](../packages/coding-agent/docs/system-one.md#when-an-ordinary-owner-request-stops)

Two further joined trials seeded a harmless reporting preference in memory and then in the owner persona. The live requests to both foreground providers contained the preference. In each case the model reported the right numeric value, but omitted the preferred label and source filename. The independent reviewer had also supplied a draft answer without the preference. Answer-only continuations now let the foreground compose its answer from the original request, the retained results and the active owner preferences. The reviewer still checks the cited evidence. Repeats on the identical values recovered the filename in the persona run. The label was still missing in both, even though Pi marked the requests fulfilled. On the persona run the asynchronous daily cost rollup settled. This is a measured gap between recalling a preference and following it.

After removing the reviewer’s draft from the continuation, the isolated upgrade and all nine installed extension and provider cases passed again. The 2,552 source hashes stayed stable through the build and checks. All 481 installed payload files matched the build. The tested Linux binary has SHA-256 `19be484d3aff5c27fbdfa64bff8cb5bf4da8d246d4ed64733ae8314e0285effd`.

The same failed marker was rechecked after routing an ambiguous reporting judgment with soft-pass overall evidence to one independent answer-only review. The first live recheck reached the review and encountered a transport error. Pi had been parsing an error terminal as a reviewer reply. The shared consultation now discards every non-normal terminal, including an incomplete reply containing valid-looking assent. A second fully live recheck scored report readiness at 0.83 and evidence at 0.86. The independent reviewer cited the receipt, and the OAuth foreground delivered the exact marker and filename with one owner entry, one read, one continuation and zero advertised tools on both OAuth calls. Separately, replaying the original 0.80 Jev decision on the matching evidence also reached fulfillment with the live reviewer and foreground.

Six controlled reviews fixed the Jev inputs at the original 0.80 and 0.86 readings and used the real independent reviewer. It held all five cases requiring a pending result, a change, a missing input, unrelated evidence or a revoked report. It approved the answerable control. These six cases exercise the reviewer's semantic judgment. The bound and zero-tool turn are enforced by the host.

Two counterbalanced pairs exercised a long conversation with a synthetic ledger, an explicit owner correction and a final request for the corrected value and source. One session in each pair reopened before the final request. OpenRouter Luna at low thinking and an independent Flash Lite grader agreed on all four answers. Each leg used the same three planned owner prompts with zero corrective retries. Both reopened final requests reported 32,002 cached input tokens out of 32,061. The 12 foreground calls and four blind grades reported $0.01949538 combined. Sixteen Jev calls had no provider-reported dollar amount.

All four final ordinary-work rows nevertheless remained unverified. Jev selected fulfilled with probabilities between 0.66 and 0.73. The final answer referred to a correction from the preceding owner opening. The stop review reads the final request and answer from its own opening. The independent grader received the expected corrected record. These are measurements of delivered continuity, cache reuse and an unresolved discrepancy in completion status. No compaction or physical-device delivery occurred in this study.

A separate 20-request Jev comparison held the grading questions and thresholds fixed. Supplying the matching historical correction as a separate field left all four correct final answers unverified. Mean probability assigned to fulfilled was 0.728 with the original state and 0.703 with the added correction. All twelve negative controls also stayed unverified. The comparison used two distinct target records across the four legs and reconstructed the original review scope. Adding prior owner text alone did not improve grading in this sample.

A separate blinded Flash Lite reviewer saw the final request, one earlier owner statement and the candidate answer. It received no answer key or prior grades. Its eight decisions matched six predeclared labels. It verified both correct answers and incorrectly verified one of six negative controls when the only earlier statement was obsolete. It classified the other obsolete control as contradicted rather than unverifiable. These results leave the historical-excerpt verifier unsuitable for completion. Walking the recorded parent chain afterward showed that neither obsolete excerpt was the complete immediately preceding owner message. That check establishes where an excerpt came from. An adjacent owner message can still answer a different question, so it supplies no independent completion verdict.

Pi therefore uses earlier owner corrections to help the foreground answer. To mark the current request fulfilled, the verifier needs evidence attributable to that request. When it cannot establish the link, Pi records the delivered answer as unverified and preserves the existing continuation limit. This preserves a useful answer without certifying a superseded instruction.

The cache audit found a separate timing defect. Pi could send a supported one-hour Anthropic cache breakpoint and later assume a five-minute lifetime when deciding whether to rewrite the prompt or compact. Provider adapters now capture the effective policy after payload hooks. The SQLite cache observations associate it with the account, model and conversation. A fixed expiry estimate needs a matching policy, a reported cache read or write, and trustworthy request timing. A routed model mismatch, an old observation without those fields or an automatic retention policy leaves expiry unknown. The terminal clock shows a conservative countdown and suppresses it while expiry is uncertain. The 32k-token live study above used OpenRouter Luna and short gaps. Anthropic cache behavior over a full hour was not measured. The estimate describes the last captured request. An account or policy change before the next dispatch has no new wire observation yet. [Cache regressions](../packages/coding-agent/test/cache-expiry-policy.test.ts) · [Anthropic cache lifetimes](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [OpenAI cache retention](https://developers.openai.com/api/docs/guides/prompt-caching)

Eleven focused checks cover this policy, including SQLite reopen and the public simple-stream entry. A second counterbalanced study exposed a loss between the request planner and the native adapter. All four answers were correct and the two restarted calls each reported 32,008 cached tokens out of 32,067. All twelve foreground SQLite observations lacked the account-scoped policy. The common adapter now retains the admitted account identity in memory. A public-stream regression checks the resulting SQLite observations and the outbound payload. On OpenRouter a static OpenAI model can report automatic caching without a fixed expiry. A model alias with unknown routing retains an unknown policy. A payload hook that attaches a breakpoint to a text block also prevents a false disabled classification. [Simple-stream adapter](../packages/ai/src/providers/simple-options.ts) · [OpenRouter cache behavior](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

After the account fix, four fresh live sessions delivered the corrected value and its source. Both reopened final calls reused 32,010 of 32,069 input tokens. The SQLite ledger captured the automatic policy on all twelve foreground calls and retained the matching account and measured policy on all four final calls. It recorded no fixed expiry. The twelve foreground calls and four independent grades reported $0.01947672. Sixteen Jev calls supplied no price. All four final ordinary-work rows remained unverified with zero additional turns.

Cache observations recorded before policy capture carry no policy. The previous survival query returned historical rows for every provider and filtered them in JavaScript. The measured-history query now uses a partial SQLite index and matches the exact provider field before decoding rows. The unmeasured history remains available for audit. Recent measured observations for one busy provider can still grow with its traffic. The migration, exact-provider match and legacy audit read are exercised in the SQLite regression above.

The latest matched control and restart each returned the corrected value and source. Both independent grades passed. Their SQLite records show the more precise `answer_recorded_unverified` reason with zero continuations. A recorded normal answer and a missing answer now have distinct status messages in English and Brazilian Portuguese. Both cases still use the same completion and retry rules. The restarted final call reused 32,008 of 32,067 input tokens. The six foreground calls and two grades reported $0.00970913. Eight Jev calls returned no price. [Settlement](../packages/coding-agent/src/core/ordinary-work-settlement.ts) · [Status regression](../packages/coding-agent/test/ordinary-work-status.test.ts)

The previous isolated Linux candidate passed the v0.104.71 to v0.104.72 upgrade, interrupted-work reopen and all nine installed extension and provider controls. All 12 public interaction journeys passed on that previous source with System One enabled and disabled. The cache, settlement and status suites passed all 84 focused checks. Its 2,553 source and bundled-resource hashes stayed stable throughout acceptance, and all 481 installed payload files matched the build. The candidate binary SHA-256 is `d371633efd692b5f83fc3a66889509de9fea16eceefa9492a91a4afec4cba85c`. The daily installation pointer and binary digest stayed unchanged.

### Corrections through compaction and restart, November 21

A matched live study reproduced a failure in the small-budget fallback. Four planned owner messages supplied a record, corrected its value and source, introduced unrelated archive material, then requested the corrected record. The uncompacted session gave the right answer after reopening. The compacted session returned null fields. The correction had fallen before the cut, the fallback made no summarizer call, and the eventual provider request no longer contained the correction. Standard compaction with a larger summarizer budget succeeded on the same task.

Foreground compaction now carries up to eight recent whole owner statements from the selected branch. Each statement must match its canonical owner evidence and fit the size bounds. The new section preserves source order and labels the records as history. A new run at each budget put the exact correction into the final provider request and returned the requested value, source identifier and superseded record. All four control and compacted legs passed the independent grade. The two studies used 17 foreground or compaction calls, four independent grades and 20 Jev calls. OpenRouter reported $0.032359295. The affected continuity owners were stable during those calls. A concurrent session-wiring edit changed the small study's wider source fingerprint. A subsequent correction to pre-compaction token accounting has a reopen regression. These results establish answer continuity for this fixture. All four ordinary-work records remained unverified with zero continuations. [Compaction owner context](../packages/coding-agent/src/core/compaction/owner-context.ts) · [Reopen regressions](../packages/coding-agent/test/compaction-owner-history.test.ts)

A separate synthetic study exercised owner-confirmed reporting on a compound rule about a retry setting. An early reviewer accepted an answer that supplied the source but omitted the required label. Pi now requires positive component citations from the rule and the actual answer. Only a current owner statement can override a rule. The final nine-case comparison used the same production parser and reviewer instructions with two real routes. Luna matched eight expected decisions and held one unrelated task. Flash Lite matched five, held three and incorrectly requested an edit on a current-owner override. Neither reviewer accepted an incomplete reporting answer in this set. These are diagnostic cases on one compound rule, with no claim about the broader distribution of owner preferences. [Reporting review](../packages/coding-agent/src/core/system-one/ordinary-reporting.ts) · [Settlement and recovery regressions](../packages/coding-agent/test/ordinary-work-stop.test.ts)

In two joined SDK studies an ordinary request reopened a real owner-confirmed knowledge record, read its source once, and reached a real provider. The record and its text survived in all four legs. The genuinely generated first answers met the format. The two controlled omissions used a scripted initial response so the failure could be repeated. All four decisions ended unverified with zero continuations. The subtype classifier returned an uncertain decision on the compound owner rule and SQLite contained no positive classification. Jev separately chose fulfilled with probability 1 on both first-study legs, scoring substantive evidence 0.92 and 0.91. Those fall below the hard completion threshold. The repair path now allows a separately checked presentation revision when the chosen disposition is decisively fulfilled, the host has a complete attributed receipt and the evidence is provisionally sufficient. Satisfying presentation alone leaves the substantive verdict unverified.

The reporting and compaction candidate passed the isolated Linux upgrade and the nine installed extension and provider controls. All 2,561 source and resource hashes stayed stable through the successful build and checks. The 481 installed payload files matched the build. The tested binary SHA-256 is `f0d121ddf0079a8ba037e52e61aa6bd18bc6aba16a41a3d84f0c07ea94b2fa20`. The ordinary-stop model exhausted 283 host states within its two-crash bound and exposed all seven injected faults. Its reporting-revocation variant sent a reserved request after the owner had withdrawn the rule. The real host guard refuses that dispatch. [Ordinary-work model](../packages/coding-agent/src/core/ordinary-work-model.ts)

The long-conversation check also found a cost that the earlier all-read fixture missed. When context garbage collection packed an old delegate result, appending two new rows copied a 201-row retained prefix twice on a 100-result history. At 10,000 results the counter reached 40,004 copied rows. The GC pass now copies the accepted prefix once and appends the two new rows. Provider conversion can reuse that frozen array when every row has independently established identity conversion. A request that adds temporary messages gets a writable copy. Subsequent warm requests, filtered images, custom conversion and rejected replans have regression coverage. The 100-, 1,000- and 10,000-result checks pass. These are row-operation counts. Wall-clock speedup was not measured. [Projection](../packages/coding-agent/src/kernel/provider-message-projection.ts) · [Long-history regression](../packages/coding-agent/test/foreground-history-work.test.ts)

In eight predeclared preference cases, the first isolated SDK profile omitted model favorites. Jev settled four cases, the other four stayed unknown, and the router sent no independent model requests. A transport-disabled diagnostic traced that result to an empty eligible reviewer pool. Repeating the same cases with both intended models in the profile’s favorites produced eight correct classifications. Pi requested independent review on the four cases Jev left uncertain. The four positives covered a required label, a compound format, a reply language and units. The four negatives covered coding practice, artifact format, personal taste and visual taste. This measures whether Pi recognizes a reporting rule. The joined SDK study below separately checks what happens when a reply omits one.

On the configured SDK profile, one early omission run accidentally fed the scripted foreground reply to the reviewer and made zero fixture reads. That leg is excluded from the end-to-end comparison. In the corrected pair both arms reopened the exact owner rule, ran the authorized read once and made one owner request. The control answered with the filename, label and correct value. Independent review accepted the presentation, and the substantive verdict stayed unverified. In the omission arm only the original foreground read request and incomplete answer were scripted. The real reviewer recognized the omission in prose but returned an object without the required verdict field. The host held the work with `reviewer_invalid_response` and spent zero continuations. All review calls had zero tools. This pair demonstrates a remaining source of steering on this Flash Lite route.

A matched reviewer-format study compared the same four inputs across two models and two prompt versions, for 16 physical requests. The cases covered a satisfied answer, an omission, a current owner override and an unrelated task. Supplying complete JSON examples for each verdict changed Flash Lite from zero correct decisions to two of four. It correctly assessed the satisfied answer and the omission. It still requested an edit on the override and gave an invalid citation for the unrelated task. Luna scored four of four with both versions. The predeclared omission case named the outcome “omission”, while the protocol calls that outcome `missing`. The original outputs and the corrected score are both retained in the audit database. Pi now uses the compared examples with the same parser and evidence checks.

The final joined run used the measured reviewer prompt on a stable source snapshot. Each arm reopened an owner-confirmed rule, received one ordinary request and executed one source read. The naturally generated control gave the correct value, label and filename, and its reporting review passed. Its substantive result remained provisionally supported and the database recorded an unverified answer. In the other arm the initial read request and answer `1012` were scripted to reproduce the omission. Jev and the independent reviewer were live. The reviewer returned `missing`, and Luna sent one real answer-only correction with zero exposed tools. It reported the correct label, value and filename without another owner message or read. On the subsequent check, Flash Lite quoted a parenthesized filename that did not occur verbatim in the revised answer. The host rejected that citation and recorded `reviewer_invalid_response`, with one of three continuations used. The corrected delivery and its unverified completion status are separate outcomes. All 15 physical requests returned HTTP 200. OpenRouter reported $0.001141255 for this pair.

The preceding isolated Linux upgrade covered the reviewed output format, reporting classification and retained-history copy repair. The first installer harness supplied an aliased session path and Pi refused that write. The rerun with a canonical physical path passed. All 2,562 source and bundled-resource files held their digests throughout acceptance. All 481 installed payload files matched the build, pending work reopened without a duplicate provider call, and all nine installed extension and provider checks passed. The daily installation stayed on its previous binary. The tested candidate SHA-256 is `d6a68f283bb6a6a1ad9fd516bb06fdd8e17fb79b330908af7234ad279892ae73`. The repository-wide static gate passed, including TypeScript and the production clone check. All twelve public journeys passed in both System One modes across two complementary runs. Of 2,727 source and harness files, one changed five seconds into the run. Reconstructing both recorded file hashes showed that the only difference was how the same reviewer prompt string was assembled. Both expressions produced the measured prompt byte for byte. The final installed build and the live pair used the later source.

### Ordinary-request lookup and account rotation, November 21

A long-session fixture measured how much history Pi traversed to register and checkpoint a new ordinary request. With 10,000 older entries, enrollment materialized 20,002 branch references and checkpointing materialized 10,002. Walking from the leaf to the current opening reduced these counts to one and two respectively. The same counts held with 100 older entries. A cold lookup of that near-leaf request now uses one parent lookup and an indexed opening lookup. Neither implementation hydrated old message payloads in this fixture. A cold search can still walk farther when the matching request lies deeper on the branch. Regressions cover sibling branches, terminal requests and checkpoint ordering. [Recovery controller](../packages/coding-agent/src/core/ordinary-work-controller.ts) · [Regression](../packages/coding-agent/test/ordinary-work-recovery-branches.test.ts)

The opposite case has 10,000 older owner messages on an unenrolled branch. A first repair performed 10,001 SQLite reads before ruling out a sibling request. The final lookup used one read when the session had one sibling opening. With 1,000 sibling openings it used 159 selective reads and returned 65 opening IDs. The previous bulk query used one read and transferred all 1,000 full request records. These counts establish bounded transfer on that fixture. Elapsed time was not measured.

The reporting settlement now records a specific reason when a reply exists but the reporting reviewer returns an invalid decision or citation. Both English and Brazilian Portuguese status views distinguish that condition from a generic reviewer failure. A historical owner-evidence record can still provide context, but only a complete record carrying its canonical session and entry identity can substantiate a quoted owner instruction. Tests cover current records, older records without that identity and truncated records.

One compound saved rule required a label and a source filename. The owner waived only the filename. The previous host accepted a review that waived the entire rule even when the answer also lacked the label. The host now keeps such answers unverified. A comprehensive waiver can consequently leave a correct answer unverified as well.

A live comparison tried asking the independent reviewer to judge each component separately. Luna met the predeclared criteria on nine of nine completed requests. Flash Lite met them on zero of eight and proposed an unnecessary correction in the partial-waiver case. Four of its eight classified every component correctly but merged components that the protocol required to be separate. Of 24 planned observations, 17 received completed replies, two returned HTTP 429 and the spending guard stopped five before transport. This candidate was rejected.

A separate eight-case Jev study asked whether the current owner restricted additions to the answer. The existing decisive threshold flagged all three explicit restrictions. None of five controls reached it, including the same instruction quoted from a manual. All five control readings lay between the two decisive thresholds. The deployed rule uses only a decisive positive reading to veto a proposed correction. A missing reading holds the review. The question shares the existing stop evaluation and can never certify completion. A single current restriction can therefore preserve the recorded answer even when another addition would have been permissible. The focused recovery, provenance, reporting, compaction and status checks passed 153 of 153. The stop model exhausted 283 baseline states across its two-crash bound and detected eight injected faults. [Settlement policy](../packages/coding-agent/src/core/ordinary-work-policy.ts) · [Formal model](../packages/coding-agent/src/core/ordinary-work-model.ts)

Four paired offline SDK cases exercised confirmed memory, the stop judges, foreground completion and the SQLite work record through session disposal. They replayed the observed Jev readings and a previously recorded Flash omission verdict. Both the digits-only instruction and the filename waiver preserved the recorded answer with zero continuations. A normal omission caused one tool-free revision. A request with no exposed rule skipped both the restriction question and the reporting reviewer. Each case used one owner entry and one read. The scripted responses exercise the host decision after a model judgment. They provide no additional measurement of model accuracy.

Two offline reproductions used synthetic credentials. In the OpenRouter fixture, account B passed its key check after account A received a model refusal, yet routing still excluded the model. In the Codex fixture the request sent account B's ID, B explicitly listed the model, and Pi still found no default. Three controls passed for same-account renewal, ordinary refresh and an older response arriving late. These are catalog-level tests of an open defect. The repair requires moving both refusal writers to the request boundary that owns the sending account. [Account rotation regressions](../packages/coding-agent/test/account-model-rotation.test.ts)

The isolated Linux upgrade of this candidate preserved pending work through a restart and passed all nine extension and provider checks. All 481 installed files matched the build and all 2,562 source and resource digests stayed stable. The tested binary has SHA-256 `5709f935ae71936edfcde629149494df5e8dec4107c199b888b71deaa7cc9ea4`. All twelve public journeys on this candidate passed with System One enabled and disabled. The 2,729 source and harness files matched their initial digests throughout the two runs. The repository static gate passed. The daily installation still runs its previous binary.

### Reporting scope and cost evidence after restart, November 21

In an offline reproduction, a scripted reviewer judged a saved retry-reporting rule inapplicable by citing an unrelated subject from a pasted example. With a fulfilled substantive judgment, the previous host accepted that citation and marked the answer fulfilled. Replaying the same decision with a quoted example or an unidentified source also reached completion. The host now requires the cited subject to appear in identified, owner-stated words. For a request covering several genuine subjects, the reviewer still decides which rules apply. A four-case offline SDK replay exercised normal submission, memory restoration and SQLite settlement with scripted model judgments. The pasted and quoted cases stayed unverified. Both owner-authored unrelated subjects reached fulfillment, including a sentence containing inline code. Each case needed one owner entry and one read, with no continuations. In a separate parser replay, all 58 retained reviewer decisions from prior calibration studies kept their earlier outcomes. This includes review responses that were already invalid. [Reporting verifier](../packages/coding-agent/src/core/system-one/ordinary-reporting.ts) · [Source controls](../packages/coding-agent/test/ordinary-work-stop.test.ts)

The earlier regrade of the corrected filename failed an exact quotation check. The stored answer included the word `source:` inside parentheses. The reviewer dropped that word and supplied the remaining characters as a contiguous quotation. The answer itself was delivered correctly. Exact validation still rejects that citation. A separate constructed example showed that a reviewer can cite the filename alone and omit evidence for the required label. The host can validate the text of every supplied citation, while complete coverage of an arbitrary natural-language rule remains a semantic judgment. No new provider calibration was run for either case.

A failed model consultation could leave one unresolved usage record in the session journal while the public cost summary displayed only a rounded $0.0000. An offline SDK reproduction disposed the session, reopened it and read the same cost summary the interactive reports consume. The repaired summary shows a missing receipt on both sides of the restart. When a measured zero-cost receipt arrived, the count cleared and stayed clear through another reopen. The known total in that fixture was $0.00000084 throughout. A journal that cannot be read reports incomplete accounting without assigning a request count. Conflicting receipts for the same request retain the uncertainty. [/cost projection](../packages/coding-agent/src/core/session-analytics.ts) · [Usage journal](../packages/coding-agent/src/core/cost/semantic-usage-delivery.ts)

The frozen working tree passed all twelve public journeys with System One enabled and disabled. All 2,729 source and harness files retained their hashes. The Linux upgrade preserved pending work, passed nine installed extension and provider checks, and matched all 481 payload files. Its binary SHA-256 is `754566cf128898bfeae81226ebe5b6db9fd11697bf9c22e41808e4efa9b8b364`. The reporting and recovery checks passed 157 of 157 and the repository-wide static gate passed. The two account-rotation failures above remain open in their separate regression suite. These checks used fixtures and added no paid requests.

### Saved reporting rules across memory failure and restart, November 21

An offline SDK replay submitted an owner rule, reopened the session and forced a read failure while the model answered. SQLite previously recorded the answer as fulfilled even though the active rule was absent from the request. On the repaired build, the same answer was delivered and its row recorded `reporting_unverified` with zero continuations. A negative classification with no positive rules, an intentionally disabled prompt projection, and ordinary healthy reads all allowed completion. Both faulted sessions fulfilled a fresh request after recovery. A separate file-backed session used a seeded owner proof and an actual filesystem error during activation. It also delivered the answer and withheld certification. In the file-backed disabled control, the already-loaded static USER text remained in the request and the reporting check was disabled. These checks used scripted judgments and real storage. [Reporting exposure](../packages/coding-agent/src/core/memory/reporting-requirement-exposure.ts) · [SQLite proofs](../packages/coding-agent/src/core/memory/owner-preference-attestations.ts)

A proof can also arrive after Pi has selected memory for a request. The host now rechecks the set of confirmed candidate revisions at settlement, including revisions whose classification was pending at selection. If knowledge rendering fails while the underlying store is readable, the host can still rule out unrelated proofs using the current project scope. When the whole source is unavailable, a historical positive whose scope cannot be established can leave the answer unverified. [Exposure regressions](../packages/coding-agent/test/owner-reporting-exposure.test.ts)

Two further SDK cases produced false fulfillment. One owner asked for a label and a source filename. A scripted reviewer cited only the filename, and SQLite accepted an answer that omitted the label. In the other case, 100 newer behavior records displaced a still-active rule from the bounded knowledge page. The actual owner command and classification paths retained the original rule, but the completion check saw zero requirements. Stores with exactly 100 and 201 unrelated records correctly allowed completion. These cases establish reachable outcomes. Their frequency in normal use is unknown.

An offline replay compared earlier provider replies with a human-specified list of the parts of a compound rule. Eight of nine Luna replies and zero of eight Flash Lite replies matched the exact expected parts and verdicts. Neither provider had received that list or its identifiers when generating those replies. This experiment leaves automatic interpretation of a newly admitted rule and the behavior of a reviewer given its parts unmeasured.

The memory repair passed all 153 focused checks and all twelve public journeys with System One enabled and disabled. The 2,729 source and harness files retained their hashes during the journey run. Its isolated Linux upgrade preserved pending work and passed all nine extension and provider controls. All 481 installed files matched the build. The binary SHA-256 was `4c2828ba7f9f5332eb7fb41590cb8b7469bac53fd25f11d9ac16580bf7787082`.

### Owner and peer messages after reopening, November 21

One SDK peer message got a normal answer and opened an ordinary owner task. When the session closed, that answered message appeared interrupted. The submission had carried its peer origin throughout. Pi now uses that origin when assigning the input to the existing extension path. Four public SDK cases delivered one answer each. Only the actual owner request created owner evidence and an ordinary work row. The three peer cases covered an omitted source and two conflicting source labels. [Submission](../packages/coding-agent/src/core/prompt-submission-controller.ts) · [SDK regression](../packages/coding-agent/test/prompt-peer-origin.test.ts)

On reopening, the evidence ledger now checks the stored source entry before accepting an old owner mark. Ordinary-work lookup skips a contradicted opening and can still find an earlier genuine one on the same branch. Historical owner records that predate origin stamps and verified owner-channel messages remain usable. A read-only reopen of the original peer fixture found one raw evidence mark and one interrupted row. The canonical readers returned zero owner sources and no current or recoverable task. A genuine owner control retained its source and held reporting status. Both copies preserved their session bytes and raw database rows. [Archive and recovery regressions](../packages/coding-agent/test/owner-archive-source-compat.test.ts)

The final candidate passed 181 focused checks, the repository static gate and all twelve public journeys with System One enabled and disabled. All 2,729 source and harness file hashes held throughout the journey run. The finite ordinary-stop model exhausted 283 states within its declared bounds and detected all eight injected faults. The isolated Linux upgrade recovered pending work without duplicating a provider call, passed nine installed controls and matched 481 files to the build. Its binary SHA-256 was `e257ff16b663f89e7f589df05d6d9251a58d045dd994b3ad9aafa086325aaa44`. The daily installation stayed on its prior version.

### Provider readiness and final delivery to the requesting chat, November 21

When credentials changed during an account check, waiting submissions could start routing while the replacement check was still running. In the reverse order they could wait for an obsolete credential lookup after the replacement had already reported a rejection. The same events reproduced both failures with and without a submission cancellation signal. Changing OpenRouter credentials also started a new Codex lookup and held back the OpenRouter result. Pi now tracks each provider’s current check, bounds credential resolution and listing together, and discards late results. A cancelled submission can leave the waiter while other submissions continue. The general router waits for all current checks. A Codex request choosing its service tier waits only for Codex. [Account catalog](../packages/coding-agent/src/core/model-router/account-models.ts) · [Readiness regressions](../packages/coding-agent/test/account-model-readiness.test.ts)

All 16 readiness regressions passed. A second driver exercised all 420 event orders for three successive OpenRouter lookups and one independent Codex lookup, comparing actual availability and readiness with an independent expectation at each of 3,360 event boundaries. The limits of this check are four lookups and the specified start and completion events. Two further cases exercised the public SDK prompt. When the obsolete credential resolved first, routing waited for the replacement. In the reverse order, the owner received one reply while the obsolete lookup was still pending. Only the replacement credential reached the simulated listing endpoint. Both sessions used one owner message and zero continuations.

In a separate offline journey, the owner's Telegram request started a worker, the parent reopened, and the successor read the file and returned the correct value with its filename. The original chat received one intermediate “Noted.” and zero final answers. Replaying the same Telegram update added zero sends, tasks, or model calls. Asking for status reported no running turn and no held action. These results held with System One enabled and disabled. With it enabled, the same task row recorded fulfillment. With it disabled, the answer was recorded with verification unavailable. The check used the shipped Telegram adapter, a simulated Bot API and a same-process session reopen. The chat journal currently closes the batch on the first assistant reply. [Batch outcome](../packages/coding-agent/src/core/channels/batch-outcome.ts) · [Channel settlement](../packages/coding-agent/src/core/channels/session-channels.ts)

On the readiness candidate, all twelve public journeys passed with System One enabled and disabled. All 2,729 source and harness files kept their hashes. The ordinary-stop model exhausted its 283-state baseline and detected all eight injected faults. The repository static gate passed. The isolated Linux upgrade recovered pending work, passed nine installed controls and matched all 481 payload files. Its binary SHA-256 was `bf45aeb195628f469c7bfa60997fb07e864bc44d55fd3331c58e3f0196ebf415`. The daily installation retained its prior binary. The separate account-refusal suite still has two failing rotations and three passing controls.

### Status in the requesting chat after handoff, November 21

Once the session has loaded recovery, the original private chat can read the current task’s recorded lifecycle state, safe host reason and continuation count. Pi checks the canonical opening on the active branch and matches the channel, unique batch, execution session, sender, conversation and return address. The daemon records the separate phone session on newly accepted owner batches. A legacy batch can still prove a same-session match. A legacy split-session batch without an execution identity supplies insufficient evidence for this readout. [Status admission](../packages/coding-agent/src/core/channels/owner-control.ts) · [Channel journal](../packages/coding-agent/src/core/channels/channel-journal.ts)

In the combined Telegram and worker-recovery check, the original chat saw fulfillment with System One enabled and the unavailable-judge reason with it disabled. A second listed sender saw no task state. Each arm retained one owner input, one task, seven scripted model calls and zero continuations after replay and both status inquiries. Neither status contained the task text, source file, final answer or internal receipt. Automatic final-answer delivery after the intermediate acknowledgement is still open. The public handoff regression now exercises both direct SDK and channel ingress. [Joined handoff regression](../packages/coding-agent/test/fixtures/harness/journeys/journey-12-restart-handoff.ts)

A separate fixture changed the sender list after Pi received a verified control and before the queued control executed. The old host still processed both a status inquiry and a stop. The current host checks the serving adapter, current sender admission and the original sender’s identity again at execution. All twelve focused controls passed, including valid status, stop and denial during an emergency hold. [Queued control regressions](../packages/coding-agent/test/owner-control-readmission.test.ts)

In a separate process, the first owner chat status after a clean shutdown omitted the task state. The original process had saved one task, its recorded answer and its channel batch. The fresh process received only the owner’s status request. It made zero model calls, left the existing row untouched and omitted its `unverified` state and `judge_unavailable` reason. A second cold SDK reopen after a worker handoff reproduced the omission in both modes. Running the normal resume hook as a separate operation made the stored result visible in both settled cases. That hook can also restart unfinished work. A status inquiry uses the passive read path.

Both supported SQLite engines opened an existing audit fixture read-only, rejected a write, saw a concurrent writer’s new commit and left the main file’s bytes intact. Opening a missing database failed and left the directory empty. On a cleanly checkpointed WAL database, reading the single task created SQLite’s `-wal` and `-shm` files on Node 24.20.0 and Bun 1.3.10. Those files remained after closing. An explicit cold status lookup would need a defined storage contract. The background status read currently opens no database. [SQLite read-only WAL behavior](https://sqlite.org/wal.html#read_only_databases)

On this candidate, all twelve public journeys passed with System One enabled and disabled. All 2,729 source and harness files kept their hashes. The seven focused suites passed 82 checks, and the repository static gate passed. The bounded ordinary-stop model explored 283 baseline states and detected all eight injected faults. The isolated Linux upgrade preserved pending work, passed nine installed controls and matched all 481 installed payload files. The candidate binary’s SHA-256 is `e76686f8a70e4bd2cad1c425af8e18f6ac133e5c9b80824358f89da3ab48c179`. The daily installation retained its previous binary. The cold-status witnesses above exercised additional startup conditions outside these passing journeys.

### Reporting confirmation at commit and long active requests, November 21

Pi could certify an answer while the exact reporting rule it had shown the model was being confirmed. At the start of review the rule’s classification was pending, so the substantive reviewer received zero reporting requirements. In one SDK replay the classification finished while the reviewer was answering. In a second replay another process committed the classification after the last host check and before the ordinary-work checkpoint took its SQLite write lock. In both cases the earlier host recorded fulfillment. The second process held its own classification lease and left the ordinary worker’s lease intact.

The host now retains the accepted request’s original reporting snapshot through the checkpoint. Inside the existing write transaction it checks that snapshot before recording fulfillment or reserving a presentation revision. A changed proof records `unverified/reporting_changed` and releases the lease. A stale revision uses zero continuations. The serialization guarantee applies to classifications in the shared decision ledger. File-backed preference content and knowledge revisions live under their respective storage owners. [Checkpoint and reservation](../packages/coding-agent/src/core/ordinary-work-store.ts) · [Settlement](../packages/coding-agent/src/core/ordinary-work-settlement.ts)

Nine final-source SDK cases used production delivery and SQLite with scripted model replies and controlled scheduling. Both exact positive changes before the write lock withheld certification of the already delivered answer. A stable pending classification, a negative decision and confirmation of an unrelated rule allowed fulfillment in both replays. In the ninth case a separate writer attempted to classify after the host took the lock. It timed out, the host fulfilled, and the writer succeeded on a fresh attempt after commit. Every case used one owner entry, one tool call and zero continuations. The ordinary-stop model now includes classification between reviewer acceptance and commit. Its full bounded search exhausted 373 baseline states and detected all nine injected faults, including one that checks the reporting snapshot too early. [Model](../packages/coding-agent/src/core/ordinary-work-model.ts) · [Transaction regressions](../packages/coding-agent/test/ordinary-work-durability.test.ts)

A separate cost check kept one ordinary task active for 100 and 10,000 appended entries. Validating its current leaf previously collected arrays of 101 and 10,001 branch entries respectively. In both fixtures the repaired checkpoint and warm read needed one indexed lookup of the original owner entry and collected zero branch entries. The same held after another connection advanced the stored frontier to the leaf. A distant invalid frontier still required 10,001 point reads in the longer fixture. No fixture hydrated message payloads. These are operation counts. [Branch validation](../packages/coding-agent/src/core/ordinary-work-controller.ts) · [Long-request regressions](../packages/coding-agent/test/ordinary-work-recovery-branches.test.ts)

A failed first lease write left the owner’s input pending after SQLite had already inserted its task row. A second session opened the persisted transcript, claimed that row, appended a descendant and recorded its progress. The first session’s next provider admission looked up the existing row and previously treated that unseen descendant as validated. It claimed the task without another owner delivery. Enrollment now caches only the owner entry it actually validated. The retry leaves the second session’s row intact, and a fresh owner request can proceed independently. Reopening the transcript to include the descendant lets the original request resume after one delivery. Separate regressions cover a genuinely divergent sibling frontier. [Enrollment and branch regressions](../packages/coding-agent/test/ordinary-work-recovery-branches.test.ts)

The final checkout passed 161 focused checks and all twelve public interaction journeys with System One enabled and disabled. All 2,729 source and harness files kept their original hashes during the journeys. The separate 10,000-entry operation counter first exceeded its 30-second fixture deadline during concurrent checks. An isolated repeat passed in 21.3 seconds with the same operation counts. The repository static gate and isolated Linux upgrade passed, including nine installed controls and all 481 payload hashes. The candidate binary’s SHA-256 is `afc5eb885f1e019a994d07c5a53d72b200464d52cc2b89328abceb353f2f6989`. The daily installation kept its prior binary.

The two account-rotation failures reproduced on this checkout, alongside three passing account controls. The SDK also still recorded false fulfillment for a confirmed requirement outside the bounded knowledge page and for a compound rule whose review covered only the filename. The control with a fabricated quotation stayed unverified. The timing repair addresses classifications that change after the host captures its reporting evidence.

### Progress text, final answers and verifier turn limits, November 21

The OpenAI Responses adapter retains each text item's phase. The default terminal showed the final answer, while the Telegram adapter sent a progress message and the answer together. A JSON payload marked as commentary also reached the chat. Separately, bot mail wrote commentary into a real local inbox, and the claim checker and goal-intent judge received it as previous answer text.

The kernel now uses the provider's phase when projecting an answer. Telegram, bot mail, the copy command, the public last-answer API, ordinary completion, isolated reviewers, and worker completion and recovery use that distinction. Raw messages retain their signatures and usage for replay. Unsigned responses and legacy item IDs keep their earlier behavior. A channel can wait past a commentary-only response while the owner’s batch holds the foreground. A new outside input ends that attribution. A genuinely unphased acknowledgement can still settle the batch before a later worker result. [Answer projection](../packages/coding-agent/src/kernel/assistant-answer.ts) · [Channel reply selection](../packages/coding-agent/src/core/channels/batch-outcome.ts) · [Worker recovery](../packages/coding-agent/src/core/delegation/worker-recovery-coordinator.ts)

On 2,563 frozen production files, seven offline Telegram cases used the public session and shipped adapter with a simulated Bot API. The native Responses translator supplied phase metadata for the signed inputs. The default terminal, copied answer and outgoing Telegram reply agreed on the final text. Commentary alone yielded the existing empty-answer notice. In a separate recovery scenario, two routing passes after the first stop observed the original owner’s foreground and sent nothing. Scripted Jev and reviewer decisions led to one continuation. Its final answer reached the original chat exactly once, with one owner entry and three model requests. A second sender’s status request exposed none of that task and received its own status. The focused baseline recorded the original wrong sends before failing an unrelated full-journey coverage assertion. The repaired standalone fixture passed its own checks. [Telegram journey](../packages/coding-agent/test/fixtures/harness/journeys/journey-4-telegram.ts) · [Owner delivery](../packages/coding-agent/src/core/channels/session-channels.ts)

In an offline SDK replay, commentary containing a well-formed positive review could certify a reporting requirement even when the reviewer supplied no final answer. A mixed response with the opposite final verdict could leave the decision unknown. Across three isolated completion paths and the reporting admission path, the original code matched 20 of 36 expected outcomes. The repaired code matched 36. Nine separate consumer checks covered the grader inputs and durable bot inbox, including a malformed signature and a change of sender. Fifteen branch checks covered the originating chat, a second owner input, a peer, an extension, an abort and expiry. [Isolated completion](../packages/coding-agent/src/core/reflection-controller.ts) · [Bot mail journey](../packages/coding-agent/test/fixtures/harness/journeys/journey-7-bot-mail.ts)

An explicit child turn limit had relied on a callback the kernel skips while a verification obligation is open. With a limit of one, a failed check led to two provider calls. The isolated runner now uses the kernel’s request counter. Both failed-check controls stopped at one call, preserved the failed receipt, and produced zero foreground runaway events. After a successful tool turn, a caller that requested a tool-free summary could still receive one. A summary containing only commentary produced an empty answer without a third call. The ordinary owner request’s separate limit remains three continuations across restarts. [Kernel limit](../packages/coding-agent/src/kernel/agent-loop.ts) · [Bounded investigation journey](../packages/coding-agent/test/fixtures/harness/journeys/journey-1-proactivity-investigation.ts)

The final checkout passed the repository static checks, 143 focused regressions and all 12 public interaction journeys with System One enabled and disabled. All 2,730 source and fixture hashes stayed stable during the journeys. The ordinary-stop model exhausted 373 baseline states and detected all nine injected faults. An earlier run of the root journey timed out in its System One off memory-reader leg. The worker reported an expired lease before its first scripted provider call. Its lease and heartbeat timestamps were unavailable. The isolated Linux upgrade matched all 481 installed payload files and passed nine installed controls. The candidate binary SHA-256 is `891878ecdf27854378644123602478f42ae4f44b750781bf9bba6afc7ac34f7e`.

On this checkout two of five account-rotation controls still failed. The seven reporting controls also reproduced false fulfillment for a hidden requirement and for an omitted part of a compound requirement. The visible-rule and fabricated-citation controls stayed unverified. The final checks used synthetic data and added zero provider spend. [Account rotation controls](../packages/coding-agent/test/account-model-rotation.test.ts) · [Reporting requirement exposure](../packages/coding-agent/src/core/memory/reporting-requirement-exposure.ts)

### Model changes while provider requests are outstanding, November 21

An owner selected B while a request on A was still running. When the provider removed A, its late refusal disabled B’s speed tier. A late quota error could also exhaust B or replace it with fallback C. The foreground now records the exact provider and model from the failed response and checks the current selection before moving the work. Eight public SDK regressions exercise the switch and the legitimate A-to-C retry. Two additional offline cases used a real registry rename of a `:free` model. The replacement kept its tier and the retired ID retained its failure. [Foreground regressions](../packages/coding-agent/test/foreground-late-model-failure.test.ts)

Account discovery could pair a runtime credential with an endpoint chosen from an older OAuth configuration. Pi now binds the endpoint and credential together and checks them immediately before a read and again before publishing the result. Across 20 offline catalog and SDK startup cases for OpenRouter and Codex, the original matched four expected outcomes and the repaired reader matched all 20. Each transport used synthetic credentials and intercepted requests. Fresh sign-in and account-specific handling of runtime model refusals are still open. [Account readiness](../packages/coding-agent/test/account-model-readiness.test.ts) · [Account read implementation](../packages/coding-agent/src/core/request-auth.ts)

An ordinary quota retry now checks the selected model and the exact failed message after acquiring the foreground and preparing the chat turn. If either changed, Pi retains the failed transcript and lets the wait lapse. Eight foreground cases exercised acquisition, preparation, chat-turn cleanup and genuine retries. Moving the check back before acquisition caused four of six comparison cases to replay the wrong work. Separately, the Codex credit notice now follows the account that the read checked. The archived implementation passed three of seven offline cases and the repair passed all seven, including renewal, redemption during a pending read and disposal. [Replay regressions](../packages/coding-agent/test/usage-reset-continuation-race.test.ts) · [Credit notification regressions](../packages/coding-agent/test/usage-reset-credit-rotation.test.ts)

The repository static gate and 193 focused checks passed. All 12 composed journeys passed with System One enabled and disabled, across 2,719 unchanged files in the source and harness manifest. The ordinary-work model exhausted 373 baseline states and detected all nine injected faults. The isolated Linux upgrade preserved pending work, passed nine extension and provider controls, and matched all 481 payload files. Its binary SHA-256 is `5e78e9770293f7d3a57cae4bbc6c54b837651a98f4e09fd3a4bb8ba724b355d6`. Two of five separate account-rotation checks still failed. The SQLite acceptance database holds the receipts under `provider-identity/`. These checks added zero provider spend.

### Fresh sign-in, cancellation and credential storage, November 21

The original terminal could report a saved sign-in when the credential file had never changed. A failed logout removed the retry from the menu even though a new process still loaded the old account. An older sign-in could also finish after a newer logout and restore its credential. In 27 offline cases the original owners passed seven and the repaired owners passed all 27. The cases include both completion orders for overlapping sign-ins, cancellation, stale terminal feedback, same-account replacement and an unrelated provider refreshing a token. In an isolated Linux directory, denying permission to create the credential lock reproduced the save and removal failures. Restoring permissions and retrying logout in the same process removed the saved credential, as confirmed by a fresh reader. [Command and storage regressions](../packages/coding-agent/test/auth-command-persistence.test.ts)

The credential store now distinguishes session-only access from a durable save. It preserves an unsaved account across another provider's refresh, and an expired session-only token requires a fresh sign-in. A later explicit operation on the same storage instance supersedes its pending sign-in. A Codex browser check cancelled a pending sign-in, rebound the actual callback port, completed a second sign-in over loopback, and rebound the port again. The token exchange was synthetic. A separate SDK check still lets an old account’s refusal disable a model for a new account. Fresh upstream sign-in remains unverified.

Five further checks started with an inaccessible credential directory or an invalid credential file. All five failed on the earlier implementation. All 32 command and recovery cases passed after Pi began reading and validating the current file under its existing lock on an explicit retry. The checks confirmed that correcting the file or restoring directory access allowed the same instance to save again and preserved unrelated credentials. Across Codex, Copilot and OpenRouter, 21 of 28 cancellation and cleanup cases failed before the adapter repairs. All 28 passed afterward, including successful sign-in controls. The fresh-sign-in fixtures made zero upstream calls.

### Confirmed reporting rules outside the first memory page

An SDK session answered a configuration question while an owner-confirmed reporting rule was outside its 100-record memory page. The answer omitted the rule, yet the original settlement recorded fulfillment. On the repaired path the same answer was delivered and the database recorded it as unverified, with zero continuations. The visible-rule control also remained unverified. Unrelated sets of 100 and 201 records still allowed fulfillment. Discovery uses the existing knowledge and classification stores and checks scope, revision and validity when a decision is committed. [Reporting exposure regressions](../packages/coding-agent/test/owner-reporting-exposure.test.ts)

On three ordinary SDK requests with 10,000 records and a confirmed classification, the first repair made four memory plans, each reading 101 pages in 1.97–2.33 seconds. The final implementation reuses the proof while the visible projection, scope, store and classification evidence stay current. Its first plan read 101 pages in 2.81 seconds. The next three read zero pages and took 3.23, 3.65 and 5.20 milliseconds. Each still checked knowledge revisions and classification membership. With no positive classification, an indexed absence check avoided overflow pages even at 10,000 records. These are local observations with scripted inference. Cold reads remain proportional to the applicable records.

A separate joined SDK check used an actual credential file, a saved owner rule, foreground dispatch and session reopen. An unsaved sign-in supplied the credential used at dispatch. After credential replacement, the hidden-rule answer stayed unverified. In the 100-unrelated-record control, a failed logout could be retried and the valid answer stayed fulfilled. Both outcomes survived a same-process reopen from the saved session and SQLite records with zero additional inference. The installer exercise separately covered a process restart.

On the final candidate, 256 focused checks passed across the auth adapters, credential handling, owner evidence, ordinary-work recovery and settlement. All 12 composed journeys passed with System One enabled and disabled. The 2,719-file source and harness manifest was identical before and after execution. The ordinary-work model exhausted 373 baseline states and caught all nine injected faults. The isolated Linux upgrade preserved pending work and matched all 481 installed payload files to the build. Its nine extension and provider controls passed. The binary SHA-256 is `2017470914a1b93dc48896298aabb09c2dbc6533ac1e89f20761b4281cd513b3`. Two of five separate account-rotation checks still failed. The compound-rule SDK witness also reproduced false fulfillment when a reviewer omitted a required label from its assessment. The local SQLite acceptance database holds the receipts under `auth-reporting/`.

### Refused models across account changes and worker edits after restart, November 21

A native Codex request on account A was still pending when Pi switched to B. Both accounts listed the primary model. Before the repair, A’s delayed rejection disabled the primary on B and caused a second HTTP request on B’s fallback. The same error from a background summary could also disable B’s model. The account catalog now remembers which model and account sent a refused request. It checks that specific model’s current credential before applying the refusal. Switching back to A restores its refusal. A provider-wide quota still follows its existing policy. [Account catalog](../packages/coding-agent/src/core/model-router/account-models.ts) · [Account rotation controls](../packages/coding-agent/test/account-model-rotation.test.ts)

The provider transport attaches evidence in memory to the terminal response for each invocation. An opaque client, a conflicting credential header, a change of model in a payload hook or an error generated by local middleware leaves the provider diagnostic available. A verified refusal can change routing while the sending account and model still apply. Pi checks them again after model-selection handlers return, since a handler can change the account or select another model. When a model leaves the registry its current account becomes unknown. Restoring the same model and credential makes its recorded refusal visible again. [Dispatch evidence](../packages/ai/src/provider-request-guard.ts) · [Foreground controls](../packages/coding-agent/test/foreground-late-model-failure.test.ts)

The Telegram restart journey now includes a granted worker edit, an unrelated worker completing first, credential rotation and a successor reading the edited checkout. The successor observed seven retries, preserved the adjacent owner edit and recorded 1,025 tokens and $0.06 of simulated usage. The original project still contained three retries because the phone grant had expired before the parent could apply the change. The owner received the initial acknowledgement and had to ask for status. English and Portuguese status now identify the foreground owner-turn and command spend covered by the displayed budget. The worker receipt remains independently attributable. [Joined restart journey](../packages/coding-agent/test/fixtures/harness/journeys/journey-12-restart-handoff.ts)

A separate replay gave the original sender one fresh work instruction. The normal edit tool applied the worker’s verified change to the tracked file and preserved uncommitted owner changes in that file and its neighbor. One private answer reached the sender. The Git branch still pointed to the same commit. With judging enabled, SQLite recorded the fresh request as fulfilled and retained the earlier request’s owner-needed state. With judging disabled both remained unverified. This replay used the same 2,563 packaged source files, a simulated provider and a simulated Telegram peer.

All 321 distinct focused checks and the repository static gate passed. The 12 composed journeys passed across 18 scenarios with System One on and off, with all 2,719 source and fixture hashes stable. The ordinary-work stop model exhausted 373 baseline states and caught nine injected faults. The isolated Linux upgrade matched 481 installed files and passed nine installed extension and provider checks. Its binary SHA-256 is `2e73537703329e61adfd46f9ed7233a97567a43f8a2b1f5e88b03226f418b9d5`. The account, model-selection and summary comparisons used intercepted native SDK requests with synthetic credentials. No paid calls or physical phone were used in this comparison.

### Live model discovery, endpoint changes and the first phone status, November 21

Codex returned 13 models to the real account, but Pi discarded the successful 893,483-byte response because the generic account reader stopped at 256 KiB. Pi now allows 2 MiB for the model list and keeps the existing smaller limit for usage and credit reads. On the frozen checkout, the same account exposed 11 available models in Pi’s 12-model registry and selected `gpt-6.2-sol` as its default. OpenRouter separately accepted the existing key. Six read-only requests across diagnosis and verification added zero inference calls. The live checks used existing credentials. [Codex account reader](../packages/ai/src/providers/openai-codex-account.ts) · [Response size regressions](../packages/ai/test/codex-account-models.test.ts)

Pi also applied one account’s listing or refusal to a model using a different credential or endpoint. In one SDK replay Pi warned about a model that succeeded on the actual sending account. In another it sent a fallback to endpoint A even though the requested model worked on B. The catalog now checks the credential, API and effective endpoint before applying that evidence. If Pi cannot establish the match, it leaves account-specific availability unknown. Across eight offline comparisons, the repaired checkout retained warnings and fallback on the refused route and sent the requested model on the other route. Returning from B to A restored A’s recorded refusal. The scale regression queried 1,000 models on the same route and two on foreign routes with one credential lookup and one account read. [Account readiness](../packages/coding-agent/test/account-model-readiness.test.ts) · [Runtime refusals](../packages/coding-agent/test/account-model-rotation.test.ts) · [Provider route controls](../packages/ai/test/provider-response-route.test.ts)

Bedrock exposed a separate case. A native AWS SDK request can choose its own bearer credential and region. In two offline replays a compaction request received measured usage followed by a model refusal. Pi kept the model unavailable after the bearer or verified region changed, although a direct request to the model succeeded. A second compaction then chose a fallback that could not supply the required thinking level. The shared receipt owner now leaves Bedrock account attribution unknown and preserves the provider error. In both replays the second compaction sent the requested model and succeeded. The tested foreground request already continued on that model. Both replays used synthetic credentials and intercepted SDK sends. [Native route regressions](../packages/ai/test/provider-response-route.test.ts)

The original sender’s first authenticated Telegram status after a restart now shows the saved request. In the native two-process replay, that first reply reported an unavailable stop judge and zero of three continuations spent with one owner entry, zero additional model calls and no change to the task row. The ordinary-work reader reuses the decision-ledger connection the channel already opened. A direct SDK status on a wholly unopened ledger still reports that storage is unloaded. The replay used simulated Telegram transport. [Status regressions](../packages/coding-agent/test/ordinary-work-status.test.ts) · [Joined restart cases](../packages/coding-agent/test/fixtures/harness/journeys/journey-12-restart-handoff.ts)

In a paired restart study, the original owner confirmed one reporting rule and sent one Telegram task. Before settlement, the resumed worker, foreground agent and independent reviewer sent their requests to a replacement endpoint with a new credential. Both answers gave the correct retry count. The same scripted positive review cited `src/limits.ts` in both runs. Only the answer containing that filename fulfilled the original task. The other stayed unverified. While the worker was pending, a second authenticated sender’s status poll exposed no task, started no model call and left the original SQLite row waiting. Both arms used zero automatic continuations. These offline arms used the 2,564-file production snapshot preceding the Bedrock-only change. The study exercised a foreign status poll and one required filename.

The checkout used for the model-discovery and Bedrock comparisons passed 350 focused regressions, the repository static checks and all 12 public interaction journeys. All 18 scenarios ran with System One on and off. The 2,720 source and harness hashes matched before and after. The ordinary-stop state model exhausted 373 baseline states and caught all nine injected faults. An isolated Linux upgrade preserved pending work, matched all 481 installed payload files and passed nine installed extension and provider checks. The candidate binary SHA-256 is `c478a362e4ce6bd8d5329c9d5a78ca1b300e61ed6dae3adaeb3fcd6705d444fc`. The database holds the live account, channel and listing comparisons under `provider-phone/` and final acceptance under `native-route/`.

### Telegram delivery of corrections and interrupted replies, November 21

A Telegram owner asked for the retry count and had a confirmed rule requiring the filename. The first answer was “There are three retries.” The independent review requested a correction, and the foreground model added “in sample.conf.” SQLite recorded the task fulfilled, but the channel had already sent the first answer. A separate length-limited request sent “The two items are quartz and” and dropped the completed answer.

Pi now waits for the foreground turn that received the original verified message. A later answer can replace the first when the host reserved a continuation for that same request and session. If the replacement encounters a transport error, the next request snapshot identifies the exact failed response it retries. A new input ends the original chat’s claim on subsequent answers and spend. When no replacement finishes, Pi labels usable length-limited text as partial in the active language. Scheduled bot status uses the same formatting. [Channel reply reader](../packages/coding-agent/src/core/channels/batch-outcome.ts) · [Channel regressions](../packages/coding-agent/test/channel-batch-outcome.test.ts)

During verification, a scheduled bot recovered from a denied tool and answered, yet the channel mistook the tool-failure ledger for a message from an extension. Pi now records when the request planner itself committed context. The reader can pass those entries without treating them as new instructions. Historical records whose names were available to extensions and whose producer cannot be established still end attribution. [Origin handling](../packages/coding-agent/src/core/turn-origin.ts) · [Scheduled-bot journey](../packages/coding-agent/test/fixtures/harness/journeys/journey-4-phone-tasks.ts)

In four paired reporting scenarios using Pi’s SDK and the shipped Telegram adapter, a corrected answer reached the original sender once without a repeat prompt. Its channel receipt now includes both foreground responses ($0.02 and $0.03 in the fixture). A separate two-owner run delivered two different private answers and recorded $0.05 and $0.04 against the respective chats. Independent reviews used their own accounting.

Twelve other paired scenarios exercised complete answers, output limits, Brazilian Portuguese and English notices, competing inputs, provider failures, and phone steering of a scheduled bot. A successful transport retry returned the finished answer with $0.4375 in synthetic foreground use. A terminal failure or another owner’s steer preserved the marked fragment at $0.1875 and excluded the unrelated $0.50 response. These fixtures used an offline Telegram peer and scripted providers. A detached worker finishing after the original acknowledgement has already been sent remains a separate open case.

Nine fresh processes read saved session and channel journal bytes from three SDK scenarios. At the first point where the corrected answer was on disk, the batch was still accepted and the simulated peer had received nothing. The cold reader recovered the finished answer and its $0.4375 fixture cost. A later cut showed the channel had claimed the reply before the transport accepted it. Pi’s existing at-most-once send policy can therefore lose delivery across a crash in that interval. [Channel delivery contract](../packages/coding-agent/docs/channels.md)

The channel reader also matched 8,452 expected outcomes across 808 intermediate branches. The bounded check inserted four different outside inputs at every tested stage of a correction, including the interval between a transport error and its retry. It compared the selected answer, truncation flag and attributed cost. The separate ordinary-work model exercises whether Pi may start a continuation.

On this checkout, 397 distinct focused checks and all 12 public interaction journeys passed. Each of the 18 scenarios ran with System One on and off. The repository static gate passed, including coverage of all 17 changed production files in the clone scan. The ordinary-stop model exhausted 373 baseline states and caught all nine injected faults. The isolated Linux upgrade matched all 481 payload files and passed nine installed extension and provider checks. The candidate binary SHA-256 is `9498f527df62bbccf3678960b7b4171d0ba5429ace823363e9e21c03357a5657`. The acceptance database contains this checkout’s manifests and observations under `same-turn-reply/`.

### Owner corrections during a request and Telegram draft status, November 21

While Pi was reading `sample.conf` for a weather question, the owner replaced that question with a request for the retry setting. Pi returned “12” even though a saved reporting rule required the filename. An independent reviewer quoted “weather forecast” from the earlier instruction to excuse the omission. SQLite recorded the task as fulfilled. After the repair, the reporting reviewer receives the latest owner input separately from earlier inputs in the same request. A reviewer claiming a rule falls outside the current subject must cite words the owner actually stated in that latest input. The host checks their source and rejects quoted or pasted material as justification. [Settlement](../packages/coding-agent/src/core/ordinary-work-settlement.ts) · [Reporting regression](../packages/coding-agent/test/ordinary-work-stop.test.ts)

Twelve paired public SDK cases used a restored project rule, an owner steering message during a real file read, scripted model judgments and a fresh read of the SQLite outcome. A reviewer that still cited the superseded weather question left the reply unverified. A reviewer that recognized the missing filename prompted one tool-free revision to “It is 12 in sample.conf.” Each run read the file once. The eleven pairs using fixed reviewer decisions had the same call counts before and after. A genuine restatement of the weather subject qualified even when the same words also appeared in a paste. When the owner only said “keep going,” the answer “Rain.” was delivered and its exemption stayed unverified at zero continuations. When the latest input names more than one subject, the reviewer still has to judge which one the owner wants.

The installed Linux binary reproduced the obsolete-subject, restated-subject and missing-filename cases with thinking off. The fixture supplied a previously confirmed project rule and scripted local endpoints for the foreground model, Jev and the independent reviewer. Pi accepted the steering message through its public RPC interface while a read tool was working. In the correction case, the read ran once, the revision had zero tools available, and SQLite recorded the finished reply at one of three continuations. Each case then reopened in a fresh process. The answer and task status survived. The local model’s configured loopback route received a prefix warmup before any RPC command. Reading status twice and retrieving the answer added zero requests. The three runs had no external network route or paid inference.

Separately, Telegram returned HTTP 503 while sending a completed answer. The terminal had the draft, but the original sender’s status said only that the task was fulfilled and there was no held action. Status now also tells the original sender that full delivery is unconfirmed and where to review the draft. The hint requires a unique owner batch in the answering session, for the same sender, conversation and address. English and Brazilian Portuguese replies, another sender, a different project, a selected bot and terminal dismissal were exercised with simulated Telegram transport. Dismissing the draft cleared the notice without starting a model turn. A status lookup with 256 batches and 128 unrelated open drafts read at most 256 batch IDs. Ambiguous IDs stayed ineligible even when an owner batch appeared twice around a non-owner batch. A worker finishing after an acknowledgement still leaves its answer in the transcript. A crash between claiming a send and storing a draft still leaves delivery unknown. [Status control](../packages/coding-agent/src/core/channels/owner-control.ts) · [Scope regressions](../packages/coding-agent/test/ordinary-work-status.test.ts)

The checkout passed all 12 public interaction journeys, with the expected 18 scenarios each running with System One on and off. All 2,720 source, fixture and configuration file hashes matched before and after. The formal stop model explored 373 baseline states and detected all nine injected faults. The repository static gate passed, including clone coverage for all ten changed production files. Across the change, 402 distinct focused checks passed. After final formatting, the 110 checks covering the changed owners passed again. The 12 paired SDK cases and six Telegram cases ran before that formatting change. The other 2,563 production files matched exactly and the formatted module emitted identical JavaScript. The isolated upgrade matched all 481 installed payload files and passed nine extension and provider checks. The three installed RPC cases used that same binary, SHA-256 `b15fcc1de2437d2220090076e26ebdd6e21a92de3582271d58330e48681ae15f`. The acceptance database stores the reports and manifests under `steer-and-draft/`.

### Cancellation when two processes share a saved request, November 21

Two installed RPC processes opened the same saved session. The first process was running a shell tool. The second was idle. Sending `abort` to the idle process marked the first process’s SQLite task cancelled and cleared its lease. The shell continued and the first process delivered its answer. Simply opening or closing the idle process preserved the lease. Sending the abort to the actual executor stopped the tool. The public RPC command addresses the receiving process’s current operation. The cancellation path now uses the same ownership and revision checks as the other ordinary-work checkpoints. [RPC contract](../packages/coding-agent/docs/rpc.md#abort) · [Controller](../packages/coding-agent/src/core/ordinary-work-controller.ts) · [Ownership regressions](../packages/coding-agent/test/ordinary-work-recovery-branches.test.ts)

On the repaired installed binary, aborting the idle process preserved the running process’s exact lease and SQLite revision. The tool finished once and returned “copper.” With Jev deliberately disabled, the recorded state accurately reported that the stop judge was unavailable. Aborting the executor itself stopped the tool. In a fifth run the executor was killed while its lease still existed. The other process could then cancel the outstanding request. Its cancellation stopped recovery of that request. The shell child survived its parent and completed when the fixture released it during cleanup. A cancelled task row on its own cannot prove a previously launched external operation has stopped.

A bounded comparison ran every ordering of five actions across two SQLite connections. Those actions were the original executor releasing its lease, the second controller claiming it, each controller receiving an abort, and the original executor attempting to finish from its original revision. All 600 observations across 120 orderings matched the expected state, owner and revision. In a separate race, another controller acquired the lease after cancellation passed its eligibility check and before its SQLite write. The write preserved the newer lease.

Five installed reporting controls on the preceding build also narrowed the compound-rule finding. When the label and filename were separate owner-confirmed rules, dropping the second check left the task unverified. Citing “retry setting” as evidence of the required label “retry ceiling” instead produced false fulfillment. Both substrings came from valid sources, but the answer omitted the label. A reviewer that identified the missing label triggered one tool-free correction. The five runs used scripted inference, one actual file read each, and a new process to verify the SQLite result. Splitting a rule into records alone cannot establish that the words cited by a reviewer prove each requirement.

A separate blind trial used the locally installed LFM3 1.7B quantized model with thinking off and a 300-token output cap. It produced zero usable verdicts on eight cases with the current reporting prompt and zero on the same eight with reviewer-visible, hand-authored component descriptions. Four current-format and seven component-format responses reached the token limit. The five remaining review responses failed the output contract. Three further requests asked the model to extract the requirements before seeing any candidate answer. All three omitted or misinterpreted a part. When the applicable scope was supplied, deterministic checks against the hand-authored requirements distinguished all six applicable cases. Blind application would also have flagged the unrelated request and the explicit override. All 19 requests completed in 465 seconds on CPU. These observations measure one local model under a shorter output limit than the installed reviewer’s 600 tokens.

The installed candidate then used its normal 600-token review budget and 60-second stop deadline. A scripted foreground supplied either a correct answer containing `sample.conf` or an answer missing the filename. The real local LFM3 reviewer received both. With a custom fixture that incorrectly declared the model incapable of reasoning, the reviewer emitted reasoning until both reviews timed out. With the machine’s actual `pi-lfm3-1.7b-q4_K_M:ctx32768` registration, Pi sent `reasoning_effort="none"`, and the same weights returned both answers with zero reasoning text and a normal provider stop. Both review responses were invalid JSON. The host left both tasks unverified and spent zero continuations. The complete answer therefore encountered a false hold, and the omission remained unrepaired. The registered pair took 40 seconds. The four runs used loopback only and scripted Jev judgments. [Local-model registration](../packages/coding-agent/src/core/models/local-registration.ts) · [Ollama’s thinking controls](https://docs.ollama.com/api/openai-compatibility)

A final local diagnostic requested schema-constrained JSON from that same model and alias. All five responses stopped normally and satisfied the declared structure. Only one led the shipped verifier to the expected decision. The reviewer invented supporting text for the complete and incomplete answers, requested an unnecessary correction on an unrelated weather question, and mishandled an owner override. It correctly identified the omission when a receipt falsely claimed that the answer contained the filename. The host accepted zero false fulfillments. The two original installed request bodies had to be reconstructed because the initial proxy retained selected fields. All retained fields matched. The other three controls were predeclared. These five direct model calls took 67 seconds. This study exposed a semantic problem that survived enforcement of the output format.

The cancellation repair passed 405 distinct focused checks and all 12 public interaction journeys. The 18 scenarios ran with System One on and off, and all 2,720 source and journey hashes matched before and after. The ordinary-work model exhausted 373 baseline states and caught all nine injected faults. The static, type and production-clone checks passed. The Linux upgrade matched all 481 installed files and passed nine installed extension and provider checks. The candidate binary’s SHA-256 is `250b156018f5bb26d6d870ebcbcc32e0bb1bae4fd3d483e0d5da09e4dacbd9ae`. The acceptance database holds the evidence under `lease-cancellation/`.

### Phone status during execution and before the first reply, November 21

A scheduled bot had already started the owner's follow-up. In both linked-machine runs, the journal recorded `running` while Telegram still said “Steering queued”. The selected-task status now reads the running state ahead of the saved acknowledgement. The composed journey checked a running command, a second command queued behind it, and the second command's final answer through the same chat. The phone-control and linked-machine journeys passed with Jev on and off using the simulated transport. [Status projection](../packages/coding-agent/src/core/channels/owner-task-controls.ts) · [Linked-machine journey](../packages/coding-agent/test/fixtures/harness/journeys/journey-10-away-scheduled-job.ts)

In a separate reconnect study, a simulated journal write failure kept the original chat's first reply unclaimed. The worker finished and the root saved the correct answer. After reopening, the first and only outgoing message in each run was “Noted.” With Jev on, the original request was already marked fulfilled. With Jev off, it remained unverified. Neither later answer carried a reservation connecting its foreground turn to the original chat reply. The SQLite acceptance record holds the pre-claim evidence and the different selected-task status result under `selected-task-status/`. [Reply attribution](../packages/coding-agent/src/core/channels/batch-outcome.ts)

The original dispatch identified the chat that launched the worker in both runs. On reopen, Pi’s input-consumption resolver examined all 48 active-branch entries with Jev on and all 41 with it off. It found no receipt connecting the worker result to the request that produced the final answer. Each run involved one authenticated sender. That bounds what this study can establish about forwarding answers between chats.

### Refused file operations in a local coding task, November 21

The owner asked Pi to edit the project-relative file `util.ts`. On the local LFM3 model with thinking off, both the direct and automatic sessions invented absolute paths outside their checkouts. All eight operations were refused. Both sessions reached the 210-second cutoff with the seed file untouched, and the independent grader rejected both. The foreground journal described the first refused read as a completed execution error. Its guidance told the agent to report the path to the owner. The file was already available inside the grant.

The file and shell guards now use the kernel's policy-refusal receipt. It records that the operation did not start, and the file guard directs the agent to use the relative path the owner actually named. A nested refusal passes the same correction to its caller. In the public SDK regression, a scripted provider read the requested file on the same owner turn. The refused sibling write preserved that file's contents, and the refused private symlink read exposed no file contents. [Read guard](../packages/coding-agent/src/core/autonomy/read-scope-admission.ts) · [SDK and nested-call regressions](../packages/coding-agent/test/session-confinement-recovery.test.ts)

On the frozen candidate, the same real 1.7B model read the correct file in the direct run but never edited it. In the automatic run it received the new refusal, searched the refused path again and supplied malformed edit arguments. Both arms exhausted 210 seconds with the seed file unchanged. Across the two snapshots the independent grader accepted zero of four submissions. Each arm had one owner message and zero worker attempts. The baseline shared its CPU runner briefly across arms, so these timings do not support a speed comparison. [Coding evaluation](../packages/coding-agent/docs/coding-evaluation.md)

All 12 public journeys passed, covering 18 scenarios with Jev on and off. The strengthened delegation journey and both confinement regressions also passed in a focused run. The repository static gate passed. The isolated Linux upgrade preserved pending work, matched all 481 installed files to the build, and passed all nine extension and provider checks. Its binary SHA-256 is `89d714e3d24544dba37b178ffdfb4725a5d699b939dfb03560b64a4d4e852adc`. The SQLite evidence prefix is `session-confinement/`.

### Final answers after a phone acknowledgement, November 21

A phone request answered with an acknowledgement while a worker it launched still ran used to leave its final answer in the session transcript. The chat batch closed on the first reply, and nothing tied the later answer to it. The channel journal now records the entry of a sent owner reply when the request is still active or waiting. Once the request settles, the channels core reads the last final answer after that entry, up to the next owner or third-party input, and sends it to the same chat through the owner reply path. That path applies the sender listing, secret and running-channel draft rules. The mark is cleared before the send, as a reply is marked replied before it is sent. A crash can lose the late answer, but it is never sent twice. A cancelled request, or one that settled with nothing after the sent reply, clears the mark without sending. The restart handoff journey now waits for that answer in the original chat with System One on and off. A follow-up owner message sent while the worker runs still opens a separate request. The first request then stays waiting, and its answer stays in the transcript. [Late answer](../packages/coding-agent/src/core/ordinary-work-late-answer.ts) · [Owed answers](../packages/coding-agent/src/core/channels/owner-late-answers.ts) · [Restart handoff journey](../packages/coding-agent/test/fixtures/harness/journeys/journey-12-restart-handoff.ts)

### Working-tree rating

The integrated working-tree assessment is **8/10, provisional**. Each rating identifies the workload or environment observed. The local acceptance database at `.git/pi-audits/2026-11-20-friction-acceptance.sqlite` contains the nine area ratings and integrated score in `ratings`, the reviewed interventions in `steering_samples`, and supporting trial summaries, provider accounting and installer manifests. Back up this local SQLite file to retain the scorecard and trial evidence. The database also records the study's provider charges and reservations against its spending ceiling. The daily profile still runs its prior installation.

| Area | Current judgment | Evidence and remaining limit |
| --- | --- | --- |
| Direct coding and tool execution | 9 on graded tasks with the measured Luna route | Independent graders checked the Luna answers and resulting files. The local 1.7B model left Slugify untouched in both modes before and after the refusal repair. Flash Lite had upstream failures. |
| Worker dispatch, handoff and recovery | 9 on exercised handoffs | An interrupted parent recovered the correct worker and worktree. A successor read the requested edit after a credential change. An unrelated completion left the request open. Local cancellation now checks the executing process’s lease. Applying the result to the main checkout still required valid owner authority. |
| Adaptive planning, model routing and cost | 8 | Automatic routing completed four corpus cases without owner correction. Plan joins and merge guards passed. Offline requests kept a newer model selection after a late quota failure and used the configured fallback for a genuine refusal on the sending account and endpoint. All four local Slugify arms timed out. Each study ran one pair. A separate CPU-only LFM3 1.7B diagnostic produced no usable review verdict in eight matched cases at a 300-token cap. |
| Context, caching and continuity | 8 | All six long sessions after the cache policy was bound to the sending account delivered the corrected value and source. The three restarted finals reused more than 32,000 input tokens each with the matching policy. The final pair distinguished recorded answers from verified completion. Both compaction budgets retained the correction in the matched reopen study. Longer idle gaps, more subjects and historical-answer verification remain gaps. |
| Permissions, credentials and progress reporting | 8 | The original sender receives same-turn corrections and can query the saved reason and continuation count on the first phone status after restart. Status also tells the original sender when a reply is saved as a draft. Another sender’s status reveals neither the task nor the draft. An idle RPC process can no longer report a live executor’s request as cancelled. Pre-execution file and shell refusals now record that the operation never started. The scripted SDK recovered within one owner turn. The real local model did not finish the edit. A direct SDK status with a wholly unopened ledger still reports that storage is unloaded. Live checks cover a small set of grants. |
| Providers and OAuth | 8 | Live reads recovered the Codex account’s model list and default and confirmed an existing OpenRouter key. An earlier OAuth session completed a tool round-trip. Native fixtures kept delayed refusals with the sending account and endpoint through replacement and return. Two Bedrock compactions recovered after a change of bearer or region. Fresh sign-in ran over real loopback with a synthetic grant. A live fresh sign-in and a live account change during an outstanding request with usage attribution remain unverified. |
| Memory, learning and proactive work | 8 | A retained owner rule reached the transferred worker and both live foreground providers. A reopened run corrected a controlled omission with one tool-free turn. The host withholds certification on a failed read with an outstanding proof, and rechecks late confirmations inside the SQLite checkpoint. A subject cited only from an earlier input can no longer excuse an omission after the owner steers during the request. A fabricated citation can leave a correct answer unverified. A hidden confirmed rule now keeps completion unverified. A reviewer can still omit a component or cite the subject as proof of a missing label, even when that label is a separate confirmed rule. |
| Bots, schedules, phone control and paired machines | 8 | Simulated Telegram delivered same-turn corrections and distinguished queued, running and finished scheduled follow-ups. An acknowledged phone request now sends its final answer to the original chat once it settles. A follow-up owner message sent while the worker runs still leaves the first request waiting, with its answer only in the transcript. Physical device delivery remains unverified. |
| Workbench, extensibility and distribution | 9 on the exercised Linux upgrade | The installed candidate preserved pending work and a working extension. The nine installed extension and provider checks covered explicit selection and exclusions. |
