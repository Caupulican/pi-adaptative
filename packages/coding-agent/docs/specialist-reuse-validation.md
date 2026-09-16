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

The candidate that implicit resource selection alone breaks an unchanged named-task replay was not
reproduced. Its negative control passes; no speculative correction was made for it.

The Claude Code binary-analysis evidence supports stable conversation identity, single execution per
specialist, event-driven idle state, and cleanup before releasing concurrency. It does not establish
automatic cross-parent ownership transfer. The implementation keeps Pi's own authority and lifecycle
owners; extracted binary code was not executed or copied into the runtime.

## Remaining boundaries

- Native project transfer now has exclusive claims, transcript/mailbox fencing, and birth-bundle
  deletion protection. Refused controls release only newly acquired, quiescent claims. Interrupted
  allocation recovery still needs dedicated failure-path validation before release.
- Managed Herdr teams reuse compatible idle teams within a parent. Transferring their parent
  ownership remains separate work; live CLI parent/task flags cannot simply be relabeled.
- Goal materialization and mailbox persistence span separate files. Deterministic admission refusal
  has no goal side effect, but an actual I/O failure between the two writes is not an atomic rollback.

This is source-level validation, not an official release or a rebuilt installed binary. The earlier
local IPC repair remains installed separately.
