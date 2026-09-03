# Doctrine

The invariants this harness enforces on itself. Each entry names the rule, why it holds, and the
contract test that pins it. A contract test listed in `contracts.json` may only change in a commit
that also changes this file (`npm run check:contract-doctrine` refuses anything else), so a
superseded rule is superseded here, in words, before its test moves.

Behavior tests, everything not listed in `contracts.json`, follow the design and may be rewritten
freely when the design changes.

## Turn economics

**Every provider request is a byte-append of the previous one.** Host transients (memory evidence,
goal context, skill context, the failure ledger, the alias legend) are durable records appended
once per change, never rebuilt at the tail; the only rewrites are context-GC packs and compaction
summaries the harness makes on purpose. Why: the provider prefills against the longest
byte-identical prefix, and a rewrite anywhere re-prefills everything after it; measured on real
sessions, losing this took cache reuse from 0.97 to 0.11. Pinned by
`packages/agent/test/provider-request-prefix-stability.test.ts`,
`packages/coding-agent/test/provider-prefix-stability.test.ts`, and the long-session contract gate
(`PI_PROFILE_GATE=1` on `test/profiling/host-long-session.profile.test.ts`: reuse p50 at or above
0.98, and no more rewrites than grid crossings of the context-GC boundary plus one). The gate's
cache report prices rewrites rather than counting them: bytes the provider could not serve from
its prefix cache, overall and on rewrites, each rewrite's depth before the previous request's end,
and packed stubs replaced by their original, because a rewrite 30 messages deep and one 300
messages deep are not the same cost.

**Sent bytes are never rewritten.** Deduplication and erasure act only on history the provider has
not seen (`sentPrefixCount`); host records are opaque to path aliasing so their bytes are the same
on the request that introduces them and every request after. Pinned by
`packages/agent/test/provider-request-prefix-stability.test.ts` and
`packages/coding-agent/test/path-alias-session.test.ts`.

**A host record carries only what changed, and the sent prefix survives a new prompt.** Append
once per change was not enough: measured on the owner's 0.97.25 sessions the alias legend was
re-persisted as its whole cumulative table on every change (91 copies, 2.7 times all tool output),
the goal context changed every request because it embedded running counters, and the failure
ledger was re-appended in full whenever ordinary growth displaced it from the tail. The rule is now:
the legend rides as a cumulative delta (only lines an accepted plan has not committed, no
superseding note, never packed); the goal context is byte-identical while the goal is unchanged
(budget as a 10 percent bucket, no counters); a trailing kind displaced without a content change
reclaims the tail with a one-line pointer, and the full record returns only when its content
changes. The sent-prefix mark is carried across runs, so a user, reflection or continuation turn
appends to the cached prefix instead of letting context GC repack the whole previous run (the
measured prompt halving and head miss); context GC still rewrites below the mark, but only at a
grid crossing of its quantized recent boundary, as one batch of everything that aged out, and a
message it packed once stays packed while frozen. Deep supersessions (an older read of a re-read
file) join a crossing batch once they save `deepPackMinTokens`. Rewrites therefore happen once per
stride, never per turn and never because a run started; the long-session gate counts them against
the number of crossings instead of a flat append share. Compaction summarizes the packed
projection, and a deterministic checkpoint is recorded as `fallback` with its cause, never
`success`. Pinned by `packages/coding-agent/test/path-alias-session.test.ts` (delta and budget),
`packages/agent/test/transient-records-index.test.ts` (pointer and cumulative kinds),
`packages/coding-agent/test/context-gc-frozen-prefix.test.ts` (crossing batches, frozen stubs, deep
floor), `packages/coding-agent/test/compact-goal-context.test.ts`, and
`packages/agent/test/session/lifecycle-ledger.test.ts` (fallback outcome).

**Per-request host work is bounded.** Every request-time scan resumes from the history prefix it
already covered; the profiler's last decile of pre-request time may not exceed twice its first.
Pinned by the long-session contract gate and `packages/agent/test/tool-failure-memory.test.ts`.

**Every request carries an output cap.** `maxOutputTokens` narrows the model's registry limit, the
capability tier narrows it further, a goal budget further still; nothing widens a model's limit.
Why: one full-class model streamed a single sentence for twenty-three minutes against a 500,000
token limit. Pinned by `packages/coding-agent/test/agent-session-retry.test.ts`.

## Tool surfaces

**A slip the harness can absorb normalizes; only real ambiguity refuses, and the refusal names the
rule.** Refusals per hundred assistant turns are the measure (`scripts/refusal-census.mjs`); the
ceiling on the frontier tier is one. Pinned by
`packages/coding-agent/test/delegate-exact-input-corrections.test.ts`,
`packages/coding-agent/test/task-state.test.ts`,
`packages/coding-agent/test/goal-tool-core.test.ts`,
`packages/coding-agent/test/goal-evidence-verification.test.ts`, and
`packages/coding-agent/test/bash-search-guard.test.ts`.

**Tool output is a shorter version of the real output, never a different one; the original is one
read away.** Every reducer only removes lines, collapses repeats or regroups what the command
printed (a search hit keeps its path and line, a diagnostic its file, position, code and message);
an unknown shape passes through untouched; the raw output is persisted and named in the notice
whenever lines were dropped, and the model bypasses every stage with `fullOutput: true`. Reduction
is byte-stable: the same output reduces to the same bytes, so a re-sent result never re-prefills.
Measured on live sessions (`scripts/output-reduction-census.mjs`): search results save a quarter of
their bytes, compiler reports three quarters. Pinned by
`packages/coding-agent/test/output-reduction.test.ts`,
`packages/coding-agent/test/generic-output-reducer.test.ts`,
`packages/coding-agent/test/search-output-reducer.test.ts`,
`packages/coding-agent/test/diagnostics-output-reducer.test.ts` and
`packages/coding-agent/test/json-output-reducer.test.ts`.

**The tool list never changes mid-session.** It sits before the messages in every prompt; any
change re-prefills the whole conversation. Disclosure happens at session start per caller. Pinned
by `packages/coding-agent/test/context-composition.test.ts` (schema token ceilings, only lowered).

**A tool failure record resolves after two later calls of the same tool executed without
retrying it; one later call keeps it.** Why: one corrective call may precede the retry a record
asks for; a record kept forever re-appended the trailing ledger on every request. Pinned by
`packages/agent/test/tool-failure-memory.test.ts`.

**The sanitizer keeps a rejected attempt out of the agent's context.** Measured on the request
after an omission, the server prompt cache still hit almost fully; the omission costs one request
without the transport delta, not a re-prefill. Pinned by `packages/agent/test/tool-failure-memory.test.ts`
and `packages/coding-agent/test/phone-filesystem-workflow.test.ts`.

## Guards

**Protocols are mechanisms, prose points at them.** The readmission gate and the ledger resolution
enforce the failure protocol; the protocol text lives once in the stable system prompt and an
active record carries one pointer line (the constrained tier keeps the full text). Pinned by
`packages/agent/test/tool-failure-memory.test.ts`.

**A degenerate output loop ends before the cap.** The stream guard ends a response whose trailing
window repeats the tier's number of times, classified as a runaway, never retried unchanged.
Pinned by `packages/agent/test/reliability/stream-idle.test.ts`.

**A tool-loop runaway is evidence.** A repeated tool call, a stagnant tool cycle, or the
provider-turn limit records a runaway stop, demotes the model to the strong tier for thirty days,
and the goal continues on a recovery path. An output runaway from the stream guard ends the
response and leaves the goal to change approach, but does not demote on its own: the guard is
measured against one real loop and a legitimately repetitive output must not cost a model a month.
Pinned by `packages/coding-agent/test/agent-session-runaway-escalation.test.ts` and
`packages/coding-agent/test/capability-tier.test.ts`.

## Workers

**Workers deny by default and never exceed the parent's surface.** A worker's tools come from the
parent's active tool set; root-only tools and nested delegation are refused with the rule named.
Pinned by `packages/coding-agent/test/worker-authority-resolver.test.ts` and
`packages/coding-agent/test/native-worker-autonomy.test.ts`.

**An explicit wait is never handed off.** A tool declares which calls are foreground waits; such a
call blocks up to its own timeout. Pinned by
`packages/coding-agent/test/background-tool-task-controller.test.ts` and
`packages/coding-agent/test/tool-task.test.ts`.

## Structure

**The coordinator only shrinks.** `agent-session.ts` has a line ceiling in
`scripts/check-coordinator-boundaries.mjs` that is lowered with each extraction and never raised.

**One call failing identically ends the run on the ledger's own count.** The failure ledger
counts every occurrence of a failure key; when one key reaches the tier's repeat count the run ends
as a `repeated_tool_call` runaway, whatever else the model mixed into the same turns. The batch
fuses stay: the stagnant-cycle detector compares results with the ledger's per-occurrence stamp
removed, so an identical failure is identical. Why: measured live, one invented `task_steps` id
failed 28 times in 22 minutes inside batches whose other calls varied, and no guard fired. A slip
the resolver can name normalizes instead of refusing: an ordinal prefix followed by uuid-like or
parenthetical noise resolves to the one step carrying that number and the result says so; a short
numeric fragment still refuses with the open-step list. Pinned by
`packages/agent/test/runaway-loop.test.ts`, `packages/agent/test/tool-failure-memory.test.ts`
(envelope-stable signatures, corrective diagnostic tail) and
`packages/coding-agent/test/task-state.test.ts`.

**An alias names a path that exists, or it does not exist.** A candidate is minted only when it
resolves to something on disk from the table's cwd; git refs, revision ranges, numeric or
timestamp directories and extension-only fragments are never candidates; and only path-typed tool
parameters can be refused as unminted aliases, never code, commands or prose. Model-facing
listings print absolute paths. Why: measured live, a repo-root-relative git line became
`p/Engine.cpp=(Release/Source/Engine.cpp` and three reads failed with ENOENT, a memory listing's
root-relative names did the same, `ls` output minted 759 legend lines nothing mentioned, and a
Python `f = p/name` was refused as an invented alias. Pinned by
`packages/coding-agent/test/path-alias-table.test.ts`,
`packages/coding-agent/test/path-alias-tool-wrap.test.ts` and
`packages/coding-agent/test/path-alias-session.test.ts` (existence gate).

**A skill on disk is loadable in the session that wrote it.** A `skill` load, read or search that
misses re-scans the skill roots once before refusing, the refusal says the roots were re-scanned,
and search names the skills the loader could not index. Why: measured live, a skill written by
`skillify` mid-session was refused twice, 45 minutes apart, while its SKILL.md existed the whole
time. Pinned by `packages/coding-agent/test/skill-vault.test.ts` and
`packages/coding-agent/test/resource-loader.test.ts` (refreshSkills).

**A refusal names a real ambiguity or a real risk, never a shape the harness can absorb.** The
credential guard accepts a literal filename prefix as a narrow glob, treats the harness's own
memory, skills and sessions as searchable without a glob, judges a multi-line script line by line
when the whole does not tokenize, and treats a shell variable as one file it cannot resolve. A
command that ran and timed out reports an operation outcome, like a non-zero exit. Evidence,
requirement satisfaction and progress are accepted on a blocked goal; only lifecycle changes stay
owner-controlled. A union of action shapes is validated against the branch the supplied `action`
names, so coercions run and the repair text speaks about that branch. On Windows the bundled
shell engine answers the coreutils surface the sessions use (`ls -l/-t/-d/-h/-S` and several
operands, `find` depth bounds, `-iname/-path/-o/-not/-prune/-print0/-printf/-exec`, `wc` with
several files and combined flags, `head`/`tail -c` and several files, `grep -r/-A/-B/-C/-o/-q/-x/
--include/--exclude`), reads heredocs and here-strings, and spawns nested shells and scripts as
external processes; there is no cap on the emulated surface, an unsupported construct names
itself. Why: measured live, refusals rose to 12 to 30 per 100 turns on the new versions and 132 of
5,049 Windows bash calls were refused for ordinary flags. Pinned by
`packages/coding-agent/test/credential-exposure-guard.test.ts`,
`packages/coding-agent/test/goal-tool-core.test.ts`, `packages/ai/test/validation.test.ts`, and
the `packages/coding-agent/test/pi-shell-engine` suite (conformance, commands-fs, commands-search,
commands-text).

**The general memory holds facts true in any task; a project's facts live in its own file.**
`<agentDir>/MEMORY.md` (1,200 chars) carries cross-project facts; each project has
`<agentDir>/memory/projects/<key>/MEMORY.md` (2,200 chars), keyed like OKF; `USER.md` stays
global. The `memory` tool defaults to `project` inside a project, `memory` (general) stays
explicit, a general write that names a path, ticket or branch gets a hint (never a silent
reroute), `list` shows all three with their budgets, an over-budget general file puts a triage
note in the memory block (move project lines, never delete), and workers cannot write any project
memory. Why: on both owner machines the single global file was full of ticket and build facts,
refused writes four times in a row, and sent every project's facts to every other project's
sessions. Pinned by `packages/coding-agent/test/memory-subsystem.test.ts` (project-scoped hot
memory), `packages/coding-agent/test/file-store-memory-provider.test.ts` (project scope search)
and `packages/coding-agent/test/lane-private-paths.test.ts`.

**A feature earns its tokens or is gated by tier, never removed.** `scripts/feature-ledger.mjs`
measures each subsystem's cost and benefit from session files; a subsystem without a benefit
measurement gains no new surface.

## Changes to this file

| Date | Change |
|---|---|
| 2026-09-02 | First edition: the invariants proven live on v0.97.24 and the ratchet model's gates. |
| 2026-09-02 | The output-repetition guard also watches the string values of a streaming tool call's arguments (a live probe looped inside a step selector). |
| 2026-09-02 | Demotion is evidence from tool-loop guards only; an output runaway ends the response without demoting. |
| 2026-09-03 | A host record carries only what changed (legend delta, goal bucket, ledger pointer); the sent prefix survives a new prompt; compaction summarizes the packed projection and names a deterministic checkpoint `fallback`. |
| 2026-09-03 | A call failing identically the tier's repeat count ends the run on the ledger's own occurrence; stagnant signatures ignore the occurrence stamp; ordinal-prefix selectors normalize. |
| 2026-09-03 | Aliases are minted only for existing paths; refs, listings and fragments never mint; only path parameters can be refused as unminted; listings print absolute paths. |
| 2026-09-03 | A skill lookup miss re-scans the roots once before refusing; search lists skills the loader could not index. |
| 2026-09-03 | Refusal false positives: prefix globs, harness roots, variable targets and line-wise scripts pass the credential guard; timeouts are operation outcomes; evidence lands on blocked goals; unions validate on the named branch; the Windows shell engine covers the full coreutils surface, heredocs and nested shells. |
| 2026-09-03 | Memory is scoped: the general MEMORY.md holds facts true in any task, each project has its own hot MEMORY.md under the agent home, the memory tool defaults to the project file, and workers cannot write project memory. |
