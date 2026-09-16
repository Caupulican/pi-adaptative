# Specialist reuse and process lifecycle validation

Ordinary native delegation now compares the compiled grant before allocating an identity. An idle
compatible specialist receives the next task through its existing mailbox and conversation. Busy,
unreadable, or ambiguous compatible contexts produce a bounded refusal. Naming a compatible worker
resolves ambiguity. An independent copy requires explicit `parallelWork` intent and a justification.

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

## Evidence

The latest regression set contains 29 tests. Thirteen assertions failed on Linux and native Windows
before the production corrections; 16 controls passed on Linux. Windows additionally encountered an
`EPERM` during scratch-directory teardown. That environmental failure is separate from the 13
reproduced assertions. Test and fixture hashes were frozen before production edits.

After correction, all 228 newly added coding-agent tests pass on Linux, including the unchanged 29
tests. Type checking passes. Production clone coverage is 1,028 eligible files out of 1,037 owned
files; the 50-token pass covers 997 files and reports zero clones. No scanner exclusions or limits
were weakened. Native Windows results for the committed revision are recorded separately.

The Claude Code binary-analysis evidence supports stable conversation identity, single execution per
specialist, event-driven idle state, and cleanup before releasing concurrency. It does not establish
automatic cross-parent ownership transfer. The implementation keeps Pi's own authority and lifecycle
owners; extracted binary code was not executed or copied into the runtime.

## Remaining boundaries

- Automatic matching currently applies to native specialists owned by the current parent session.
  Project-wide transfer between parents needs an exclusive durable claim and fencing on every
  transcript and mailbox writer, plus protection against deleting the original session bundle.
- Managed Herdr workers retain explicit follow-up routing. Automatic matching and transferring their
  parent ownership are separate work; live CLI parent/task flags cannot simply be relabeled.
- Replay comparison still needs stronger coverage for changed dependencies and declared fork mode.
- Goal materialization and mailbox persistence span separate files. Deterministic admission refusal
  has no goal side effect, but an actual I/O failure between the two writes is not an atomic rollback.
- Windows scratch-directory cleanup errors remain an unresolved platform probe, not a proven fix.

This is source-level validation, not an official release or a rebuilt installed binary. The earlier
local IPC repair remains installed separately.
