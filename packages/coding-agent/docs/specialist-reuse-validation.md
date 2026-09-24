# Specialist reuse and process lifecycle validation

Ordinary native delegation now compares the compiled grant before allocating an identity. An idle
compatible specialist receives the next task through its existing mailbox and conversation. Busy,
unreadable, or ambiguous compatible contexts produce a bounded refusal. Naming a compatible worker
resolves ambiguity. An independent copy requires explicit `parallelWork` intent and a justification.

Native discovery also spans parent sessions sharing the agent directory and physical project. The
project directory reserves allocation; the original transcript owns its exclusive execution claim.
An importing parent gets its own local handle while retaining the transcript's birth identity.
Mailbox mutations validate the captured claim under the transcript lock. Successful execution
publishes availability while holding the mailbox admission lock; failed cleanup retains ownership.

The comparison includes model, thinking, tools, paths, budgets, workspace identity, resource selection,
and immutable initialization. Identical explicit parent snapshots reuse context; changed snapshots or
materialized resource contents require a distinct specialist. Completed tasks leave their specialist
available for reuse; the active roster excludes idle specialists without deleting their transcripts.

## Confirmed corrections

- Queue cancellation remains pending after failed persistence and cannot turn back into execution.
- Start observers receive running records; a returned promise alone is not evidence of startup.
- Mailbox byte and replay bounds are checked before a newly accepted task materializes its goal.
- A resumed process cannot close a same-PID record with different parent, task, or agent ownership.
- Managed lane closure rejects stale generations while preserving genuine persistence failures.
- Directory identity resolution has a deadline and honors cancellation.
- A text-similarity advisory cannot veto a task with a different admitted grant.
- Replayed starts preserve their declared fork mode and dependencies. Retrying an unchanged start
  remains inert after the parent's transcript grows; changing the recorded intent is refused.
- Context projection after session disposal cannot reopen the SQLite path-alias index.
- Interrupted initial setup recovers only after proven owner exit and absence of leases, registration,
  pending mailbox work, or active transcript writes. The exact abandoned task is cancelled with its
  bounded parent notification before the allocation is released.
- A lost preparation or enrollment receipt preserves durable task identity and reusable context;
  abandoned instructions are not replayed.
- Registered initial work that remains queued and has never held a lease resumes its accepted task
  after proven owner exit. Claim recovery rechecks the durable history under the transcript lock
  and advances the ownership generation. A competing live or unknown controller cannot cancel
  that work through failed dispatch or shutdown.
- Herdr teams transfer their effective controller across project parent sessions without changing
  launch provenance. Same-session process restarts refresh the supervisor, and generations fence
  stale controllers while original authenticated peers can report the current turn.

## Evidence

The direct implementation followed three frozen regression batches on Linux and native Windows:

| Batch | Tests | Reproduced assertion failures before correction |
| --- | ---: | ---: |
| Admission, cancellation, ownership, and specialist selection | 29 | 13 |
| Replay dependencies and declared fork mode | 5 | 4 |
| Storage disposal | 3 | 1 |

The remaining cases serve as negative controls. An additional Windows scratch-directory teardown
failure reproduced in the full slice and an isolated run. Its remaining files belonged to the SQLite
path-alias index. A deterministic probe confirmed that late projection could reopen that index after
disposal. After correcting this owner, the unchanged selection test and the complete new-test slice
pass on Windows. This establishes the observed correction; it does not prove every possible Windows
file-lock failure has the same cause.

At production commit `e0e1d1ad016a64a9588b21c2bf671b077a8582ab`, all 236 newly added coding-agent tests
in 35 files pass on Linux and native Windows. The 27 new agent tests in four files also pass on both
platforms; Linux agent validation preceded the final coding-agent-only fixes. Only the new tests ran.
Test and fixture hashes stayed frozen across each red/green cycle and match between checkouts. Normal
commit hooks, including project type checking, pass. Production clone coverage is 1,028 eligible files
out of 1,037 owned files; the 50-token pass covers 997 files and reports zero clones. No scanner
exclusions or limits were weakened.

At `8fed042ff`, all 310 new coding-agent tests in 51 files pass on Linux and native Windows.
The added project-transfer cases cover retained provider context, colliding local handles, busy
admission, stale mailbox writers, cleanup failure, and serialized idle publication. Their assertions
remain unchanged from the failing baselines. The full repository check passes with 1,033/1,042
eligible/owned production files covered and zero clones. Subsequent refused-control regressions
reproduce claim retention after empty and oversized messages on both operating systems.

At production commit `b24f6d4db`, all 379 newly added coding-agent tests in 68 files and 27
agent tests in four files pass on Linux and native Windows. The registered queued-owner regression
first failed five assertions on each platform while its original-owner control passed; all six
cases then passed without assertion changes. Additional checks reject previously leased history
and foreign-parent claims and prevent a stale transcript view from writing after recovery.
Production clone coverage is 1,035/1,044 eligible/owned files, with zero clones. The larger Windows
slice also exposed timing-sensitive existing worker-session fixtures; their event synchronization
is tracked separately from the frozen ownership regressions.

The full CI matrix also exposed acquisition fixtures that assumed 25 event-loop ticks proved a
backend request had started. Pane and workspace regressions now await explicit backend-entry
events; their lifecycle assertions are unchanged. Existing description tests now check the approved
automatic-reuse wording instead of the superseded `fresh=no agentId` instruction. This is fixture
alignment, not a new production correction or a relaxation of the ownership regressions.

The candidate that implicit resource selection alone breaks an unchanged named-task replay was not
reproduced. Its negative control passes; no speculative correction was made for it.

Observed Claude Code behavior supports stable conversation identity, single execution per specialist,
event-driven idle state, and cleanup before releasing concurrency. It does not establish automatic
cross-parent ownership transfer. The implementation keeps Pi's own authority and lifecycle owners.

## Remaining boundaries

- Native project transfer now has exclusive claims, transcript/mailbox fencing, and birth-bundle
  deletion protection. Refused controls release only newly acquired, quiescent claims. Recovery
  distinguishes abandoned unregistered setup from registered, never-started queued work. Previously
  leased or uncertain work remains excluded from queued-context takeover; owner death alone does
  not prove resource cleanup. Older receipts without preparation evidence remain excluded.
- Managed Herdr ownership transfer is covered through the real job store, authenticated peer context,
  filesystem watcher, and process-matrix composition. Native provider inference remains untested;
  no paid provider calls were made. Historical lane records remain evidence of prior tasks, not
  evidence that a retained CLI is currently working for that parent.
- Goal materialization and mailbox persistence span separate files. Deterministic admission refusal
  has no goal side effect, but an actual I/O failure between the two writes is not an atomic rollback.

This is source-level validation, not an official release or a rebuilt installed binary. The earlier
local IPC repair remains installed separately.
