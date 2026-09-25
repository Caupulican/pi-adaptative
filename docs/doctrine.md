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
the legend rides as a cumulative delta (only lines no legend record in the history carries, no
superseding note, never packed); the goal context is byte-identical while the goal is unchanged
(budget as a 10 percent bucket, no counters); a trailing kind displaced without a content change
reclaims the tail with a one-line pointer, and the full record returns only when its content
changes. The sent-prefix mark is carried across runs, so a user, reflection or continuation turn
appends to the cached prefix instead of letting context GC repack the whole previous run (the
measured prompt halving and head miss). A sent message is part of the provider's cache, so context
GC rewrites below the mark only as a priced cache break: at a grid crossing of its quantized recent
boundary, every packable message below the mark (what aged out, plus deep supersessions such as an
older read of a re-read file) is offered as one batch, and it packs only when the tokens it saves at
the cache-read price over the remaining requests (the fewer of the requests left before the compaction
trigger and the median further requests recorded lineages of this length went on to make, learned from
the decision ledger; the lineage's own elapsed requests when none that long has ended) exceed
re-prefilling the suffix behind it at the cold price, on the executing model's catalog prices. Every
verdict is recorded as a `gc_pack` cache decision. Without prices the sent prefix stays as sent. A
declined batch stays as sent and is offered again, larger, at the next crossing; a message packed once
stays packed while frozen. Rewrites therefore happen at most once per stride, never per turn and never
because a run started; the long-session gate counts them against the number of crossings instead of a
flat append share. Compaction summarizes the packed projection, and a deterministic checkpoint is
recorded as `fallback` with its cause, never `success`. Pinned by `packages/coding-agent/test/path-alias-session.test.ts` (delta and budget),
`packages/agent/test/transient-records-index.test.ts` (pointer and cumulative kinds),
`packages/coding-agent/test/context-gc-frozen-prefix.test.ts` (priced crossing batches, frozen stubs,
declined batches staying as sent), `packages/coding-agent/test/compact-goal-context.test.ts`, and
`packages/agent/test/session/lifecycle-ledger.test.ts` (fallback outcome).

**A cache break passes the custody gate, or it is a defect.** Every foreground and worker request is
classified against its lane's previous one: an append, the lane's first request, a break the gate
sanctioned for that request, or an unsanctioned break at a kind and index. Sanctioned breaks are the
ones the harness makes on purpose: a priced context-GC batch, a compaction, a side trip's own small
brief, a safety removal the loop declares (the runaway-stop closing request withholding every tool),
and a surface change applied at a cold moment. Both kinds are recorded as `cache_break` decisions in
the decision ledger; an unsanctioned one names the defect. A surface change that is not mandatory
waits for a cold moment (the turn's lane and the talker's lane have no warm cache, or a compaction
rewrote the history): an extension's system prompt (unless it returns `systemPromptUrgency: "now"`)
and the prompt's date, which is pinned per session and advances only then. Reasoning is surface too:
a lane keeps the level it last sent against a host adjustment (host-turn and bookkeeping lowering)
while its cache is warm; the owner's own level, a return to it, and the owner's cost ceiling always
pass. Why: measured on the owner's sessions a reasoning-only change made a cold cache five times as
likely (47% against a 9% baseline). Pinned by `packages/coding-agent/test/cache-custody-contract.test.ts`
(a tool loop, a 12-call parallel batch, a bookkeeping turn and an extension prompt change leave every
request an append, one reasoning level, and no unsanctioned break in the ledger; a worker's tool loop
leaves no unsanctioned break and is observed on its own conversation).

**Every owner message reaches the selected root model.** Greetings, substantive requests and
toolkit names enter the root's full conversation with its tool surface. The host does not pre-route
them to a cheap tier or run a toolkit script before the root decides. Internal turns stay on that
root; `/model` or a hard provider failure can move it. The root may delegate bounded work under
worker authority, and a worker reads a brief instead of silently becoming the owner-facing model.
A selected local root boots its managed runtime or fails visibly; it is not silently replaced by a
configured cloud tier. An explicitly routed local model may use the configured tier fallback when
its runtime is unavailable. Why: automatic foreground model swaps re-send the conversation and
override the owner's selected root. Pinned by
`packages/coding-agent/test/agent-session-model-router.test.ts`,
`packages/coding-agent/test/agent-session-local-runtime.test.ts`, and
`packages/coding-agent/test/interactive-mode-ollama-install-smoke.test.ts`.

**Every agent runs the conversation mechanics; only the head orchestrates.** A worker plans each
request with root's own request-context controller (context GC on its own lane, path aliases, the
authority context), pays its early compaction and GC rewrites by root's prices on its own cache facts,
summarizes on its own warm lane, records its cache observations, tool choices and compaction outcomes
into the same stores root learns from, and shares root's tool mechanics (output reduction, shell,
encodings, artifact packing; never credential injection). What stays with the head is command:
model routing, System One intake and report acceptance, spawning, goals, reflection and
self-adaptation, memory writes, extensions and the owner surface. A worker prices on its own lane's
inputs, never on root's. A routed worker whose account runs out of quota moves to its next routing
candidate on retry (its contract's ordered-fallback policy), and the attempt records the model it ran on.
Pinned by `packages/coding-agent/test/cache-custody-contract.test.ts` (the worker leg).

**Per-request host work is bounded.** Every request-time scan resumes from the history prefix it
already covered; the profiler's last decile of pre-request time may not exceed twice its first.
Path aliasing resumes from the message contents it already scanned (fingerprints persisted in
`path_alias_scanned`), not from a timestamp mark: a mark skipped a message stamped in the same
millisecond, a replaced message, and an older unscanned message reached by a branch switch or
restart. A message sent while minting is paused is not marked scanned. Pinned by the long-session
contract gate, `packages/agent/test/tool-failure-memory.test.ts` and
`packages/coding-agent/test/path-alias-session.test.ts` (scan cursor).

**A profile measures executed work, not skipped or failed synthetic actions.** Valid scripted
actions must execute with zero tool errors and the exact expected foreground action count. Each
configured delegation must perform its assigned read, return a valid claim, be accepted, and reach
the succeeded state. Summary requests use their own response path; consuming foreground or worker
responses during compaction would silently remove work from the measurement. This strengthens the
workload evidence without changing the cache or latency thresholds. Synthetic runs do not prove
real-provider behavior or indefinite memory boundedness. Pinned by
`packages/coding-agent/test/profiling/host-long-session.profile.test.ts` and
`packages/coding-agent/test/profiling/host-response-script.test.ts`.

**Every request carries an output cap.** `maxOutputTokens` narrows the model's registry limit, the
capability tier narrows it further, a goal budget further still; nothing widens a model's limit.
Why: one full-class model streamed a single sentence for twenty-three minutes against a 500,000
token limit. Pinned by `packages/coding-agent/test/agent-session-retry.test.ts`.

**A turn the host starts for itself runs one rung cheaper, and the live row says where the time
went.** The request that answers a host-delivered completion (`background-tool-completion`,
`background-worker-completion` - recognized on the durable agent messages, never on the wire
context, where `convertToLlm` has already flattened every custom message into a `user` one) is
requested one thinking rung below the session level, floored at `low`, never above the session
level and never raising effort; `reasoning.hostTurnThinking` sets an explicit level (clamped to the
session level) or `"inherit"` to switch the policy off, and the session's own level never moves.
Its expected work is bookkeeping: read the delivered result, cite it, continue. The same policy
covers the model's own bookkeeping: the request that answers ONLY `goal` / `task_steps` results (the
assistant message called nothing else) runs at `low`, clamped to the session level
(`reasoning.bookkeepingThinking`: a level, or `"inherit"` to switch it off); a message that mixed a
`task_steps` update with real work is real work, and the request after the next real tool result is
back at the session level. Separately, the
interactive live row marks the turn's first token - the same `isFirstTokenEvent` predicate that
stamps `AssistantMessage.firstTokenAt` and splits the model perf profile - and shows
`(9s, no token yet)` then `(23s, first 9s)` once the wait passes three seconds, so a fast provider
renders exactly the elapsed figure it always did. Why: on a slow-first-token provider the first
token is p50 11.5 s, about 40 % of a turn's active time, and the operator could not tell "waiting
for the provider" from "generating" while paying full reasoning effort for a turn that only had to
quote a finished result. Pinned by `packages/coding-agent/test/host-turn-reasoning.test.ts`,
`packages/coding-agent/test/suite/agent-session-host-turn-reasoning.test.ts`,
`packages/coding-agent/test/activity-lane.test.ts` and
`packages/coding-agent/test/interactive-event-controller.test.ts`.

**The agent sees its context gauge and hands itself off at a clean checkpoint.** The root reads
its usage and three lines through `self_compact` without a note and `context_audit`: notice and
warning are fractions of the first host compaction trigger (the cost-priced early trigger when it is
configured below hard, else hard), so they are reached before the host compacts on its own; forced
is a fraction of the hard trigger. Guidance is a transient host record whose text is stable per
level (a configured prompt renders once per crossing), so it is appended once per level and never
churns the cached prefix; the cleared marker is sent only when a guidance record exists. A note is
admitted only at or above notice, or after the owner asked (`/self-compact-now`) and before the
agent finishes its next reply, and only when
there is history to compact; it is kept byte for byte. Siblings of an admissible note in the same
batch are refused before any runs, in either order; an ordinary parallel batch is untouched. At
forced every other tool is refused only while there is history to compact, so nothing strands the
agent. The handoff runs through the host's own compaction (`AgentSession.compact`: summary model,
retry ladder, deterministic fallback, cache and pricing unchanged) after every foreground run the
owner did not interrupt; a compaction tagged with the note's id carries it, the exact note comes
back as the next message and the agent continues without a user turn. State is derived only from
branch entries, so restart, rebind and branch switch rebuild it, in interactive, print and RPC
modes alike (print mode finishes a handoff before its first prompt and before it prints); an answered or owner-aborted
handoff never replays, a transport failure after delivery continues without re-sending the note,
failed or cancelled compactions retry within three attempts, and a compaction that does not carry
the note ends the handoff instead of looping. Host early, idle and hard compaction are never
cancelled. `self_compact` is root-only: worker compaction is inline in the worker's request planning
with no idle checkpoint, so the tool is in the worker forbidden set rather than silently inert.
Its projected schema has a separate 140-token allowance (aggregate 5,953 = 5,813 + 140 self_compact).
Pinned by `packages/coding-agent/test/context-composition.test.ts`,
`packages/coding-agent/test/self-compaction.test.ts`,
`packages/coding-agent/test/self-compaction-controller.test.ts` and
`packages/coding-agent/test/suite/self-compaction.test.ts`.

## Tool surfaces

**A slip the harness can absorb normalizes; only real ambiguity refuses, and the refusal names the
rule.** Refusals per hundred assistant turns are the measure (`scripts/refusal-census.mjs`); the
ceiling on the frontier tier is one. Catalog `grep`/`find`/`ls`/`repo_read` requested for a worker
whose parent surface has `bash` are lent natively (read authority, never `bash` in their place); a
sibling such as `write` that is not on the parent surface still refuses and names the rule. A
delegate spelling with exactly one reading is absorbed and reported — `task` on `follow_up`/`send`
is the message, `agentId` on `status`/`review` is that agent's latest lane, `message` on
`interrupt` is queued for the paused worker, `retire` with undelivered control messages lists them
and takes `force: true` — while a plural on a singular action or two selectors still refuse. An
invented `sN-<slug>` or `sN-<uuid>` task-step selector names the one step carrying that number; a
trailing numeric fragment (`s1-2`) still refuses. When an exact `step-N` is absent and not archived, an
ordinal position selector resolves to the open step at that 1-based index. Pinned by
`packages/coding-agent/test/delegate-exact-input-corrections.test.ts`,
`packages/coding-agent/test/worker-authority-resolver.test.ts`,
`packages/coding-agent/test/task-state.test.ts`,
`packages/coding-agent/test/goal-tool-core.test.ts`,
`packages/coding-agent/test/goal-evidence-verification.test.ts`, and
`packages/coding-agent/test/bash-search-guard.test.ts`.

**A cited command matches its producing call on what was executed, and a miss says what to cite.**
Tool evidence compares the citation and the call's `command` (bash, `run_process`) or `code` /
`scriptPath` (python) after normalizing layout only: surrounding and internal whitespace runs and
one trailing `;`. Case, flags, ordering and every other character stay significant, so a
paraphrase cannot select a call it did not produce; a `toolCallId` still matches exactly and wins.
A miss names the newest producing call ids with a 60-character excerpt each, or says no producing
call is recorded. `add_evidence` accepts `requirementId` / `requirementIds`: once the evidence
verifies, the same call satisfies those requirements through the satisfy reducer, citing the new
evidence id, and the reply names what it satisfied; evidence that does not verify satisfies
nothing; an unknown requirement keeps the evidence and the satisfies that already landed and names
the miss. A directory cited as file evidence is refused naming a file inside it. Why: a re-typed
command with a collapsed run of spaces cost a rejected goal turn each time, and every verified
evidence entry cost a second request just to satisfy its requirement. Pinned by
`packages/coding-agent/test/goal-evidence-verification.test.ts` and
`packages/coding-agent/test/goal-tool.test.ts`.

**Tool output is a shorter version of the real output, never a different one; the original is one
read away.** Every reducer only removes lines, collapses repeats or regroups what the command
printed (a search hit keeps its path and line, a diagnostic its file, position, code and message;
the diagnostics reducer keys on the location grammars every compiler and linter prints, not on a
list of tools, so an unknown toolchain reduces the same way or passes through whole);
an unknown shape passes through untouched; the raw output is persisted and named in the notice
whenever lines were dropped (for a JSON document the notice ends with a jq projection over the
persisted file, so the omitted records are one jq call away, never a full read), and the model
bypasses every stage with `fullOutput: true`. Reduction
is byte-stable: the same output reduces to the same bytes, so a re-sent result never re-prefills.
Measured on live sessions (`scripts/output-reduction-census.mjs`): search results save a quarter of
their bytes, compiler reports three quarters. Pinned by
`packages/coding-agent/test/output-reduction.test.ts`,
`packages/coding-agent/test/generic-output-reducer.test.ts`,
`packages/coding-agent/test/search-output-reducer.test.ts`,
`packages/coding-agent/test/diagnostics-output-reducer.test.ts` and
`packages/coding-agent/test/json-output-reducer.test.ts`.

**A NUL never reaches a text file through `edit` or `write`.** U+0000 in a replacement or in
written content is a transport defect, not content: an editing model has been observed sending it in
place of a space next to multi-byte characters, and once it lands git reports the file as binary and
every importer breaks, invisibly, because a NUL renders as nothing. Both tools refuse it in their
validation phase, before the mutation queue, before the file is read and before anything is created,
so a missing target still reports the NUL rather than a path failure. The diagnostic names the
1-based edit index, the code point, the character offset counted in code points and twenty
characters of context on each side with the NUL escaped as `\0`, and it demands the same replacement
re-sent without that character, never the file written through a shell instead. Neither tool repairs
the string: guessing which character the NUL replaced is how a corrupted space becomes a corrupted
file. `edit` skips the check for a replacement whose own `oldText` also carries U+0000, so this guard
never becomes the layer that refuses a NUL-bearing source; that stays the edit encoding contract's
decision. Repair codes `nul_in_replacement` and `nul_in_content` carry the guidance. Pinned by
`packages/coding-agent/test/edit-nul-guard.test.ts`,
`packages/coding-agent/test/write-nul-guard.test.ts` and `packages/ai/test/tool-repair.test.ts`.

**The tool list stays stable between explicit runtime or provider transitions.** It sits before
the messages in every prompt, so ordinary turns must not churn disclosed schemas. Explicit reload
commits a new tool generation, and provider-specific tools follow the active model; those intentional
transitions can invalidate the prompt cache and do not promise a cache hit. The root default surface
includes `runtime_update` and `webfetch` within their existing schema-token ceilings. Persistent
multi-project control deliberately adds `task_directory` (132 measured tokens against its separate 350
ceiling): every status or mutation response pages whole rows within 128 KiB instead of returning the
reproduced 1,970,171-byte registry, and the byte budget retains a complete maximum-size JSON-escaped
active path and a full row. Cursors identify the snapshot, task and session; changed state requires
restarting the listing, while unchanged cursor replay is read-only. Task-local deterministic automation
deliberately adds `task_automation` (681 measured tokens against a dedicated 720 ceiling) covering
action-discriminated contracts (`spec`, `validate`, `run`, `bind`, `status`). Deliberate feature additions
recalibrate individual tool budgets: `skill` rises from 105 to 160 (150 measured tokens, 6.7% headroom)
for `inspect`, versioned `repair` with `versionToken`, and session-wide `exclude` with `reason`; `goal` rises
from 280 to 305 for narrow toolkit selectors (`toolkitScript`, `toolkitArgs`) and then 333
(323 measured tokens, retaining 10 tokens of headroom) for the six literal `edgeClass` values.
The latter adds exactly 28 tokens; schema annotations are already removed and unions compacted,
so retaining those validation values is deliberate. Explicit independent specialist work adds the
`delegate.parallelWork` object: its projected field costs at most 75 tokens, measured separately
from the unchanged 875-token ceiling for the prior delegate surface. The 4,500-token combined
base-tool ceiling stays fixed. This is a deliberate new control for mandatory specialist reuse;
it does not permit unrelated description growth. Live provider projection measures 5,059 total schema tokens against an aggregate ceiling
of 5,570 (4,500 base + 350 task_directory + 720 task_automation), while core tools excluding automation
and directory measure 4,246 tokens, strictly under the unchanged 4,500 base limit. The additions address
reproduced wrong-directory execution and safe task automation without widening worker grants or introducing
per-turn schema churn. Pinned by
`packages/coding-agent/test/context-composition.test.ts`,
`packages/coding-agent/test/session-task-directories.test.ts`,
`packages/coding-agent/test/task-directory-status.test.ts`,
`packages/coding-agent/test/suite/runtime-update.test.ts`, and
`packages/coding-agent/test/suite/image-generation-provider-surface.test.ts`.

**Equivalent action branches compact only at the provider boundary.** Identical `anyOf` branches
may share an enum discriminator when every other validation constraint matches. Exclusive unions
remain intact; local validation retains the original branches and their actionable repair text.
This preserves the schema budgets without weakening execution validation. Pinned by
`packages/agent/test/provider-tool-projection.test.ts` and
`packages/coding-agent/test/suite/regressions/delegate-action-preflight.test.ts`.

**A tool failure record resolves after two later calls of the same tool executed without
retrying it; one later call keeps it.** Why: one corrective call may precede the retry a record
asks for; a record kept forever re-appended the trailing ledger on every request. Pinned by
`packages/agent/test/tool-failure-memory.test.ts`.

**A cancelled call never enters the failure ledger.** An abort (operator interrupt, send now,
compaction, dispose) stops a call that was doing what it was asked; a tool that throws while the
run's signal is aborted finalizes as `aborted` with the abort's name in its text, is not a kind
mistake, and is not an active failure. Why: a 30-minute hang ended with two killed siblings charged
to the model as mistakes with no diagnostic. Pinned by `packages/agent/test/agent-loop.test.ts`
(cancellation cases) and `packages/agent/test/tool-failure-memory.test.ts`.

**A background command occupies neither the exclusive mutation barrier nor the agent's shell
session.** `background: true` waits only for the file writes its own message emitted before it,
releases the barrier the instant its body starts, and runs in its own child shell started from the
session's current directory (its cd and exports do not persist; on Windows a throwaway engine
coordinator); a clock or manual handoff releases the barrier the moment the call becomes a session
task; a call still queued on the barrier unwinds at once when its signal aborts. Why: a background
`svnproject` held the process-wide writer lock AND the one-command-at-a-time persistent shell for
its whole life, every sibling bash/python parked behind it, the turn hung 30 minutes and Escape did
nothing; the shell half was only found by a live run after the barrier half was fixed. Pinned by
`packages/coding-agent/test/bash-edit-write-race.test.ts`,
`packages/coding-agent/test/background-handoff-barrier.test.ts` and
`packages/coding-agent/test/bash-background-shell.test.ts`.

**Commands emitted together run together.** Foreground bash calls take lanes from an elastic pool
of reusable persistent shells (three kept warm per session, more created on demand up to eight,
idle extras retired after a minute; the pool owns the working directory so a `cd` on any lane
moves the next command wherever it runs, exported variables reach every lane through the export ledger), and the
mutation barrier is a group lock: announced command runs hold it together, file mutations hold it
together, the two groups never overlap, admission is in emission order, and an unannounced run stays
exclusive. Why: one persistent shell plus a FIFO writer lock turned three commands emitted in one
message into three sequential waits. Pinned by `packages/coding-agent/test/shell-lane-pool.test.ts`,
`packages/coding-agent/test/bash-concurrent-lanes.test.ts` and
`packages/coding-agent/test/bash-edit-write-race.test.ts`.

**The group lock belongs to the worktree; emission order belongs to the session; the per-path
queue belongs to the process.** The barrier's holders and waiters live in a scope keyed by the
canonical directory a session or worker lane works in (`worktree:<realpath>`), so every session in
one tree interlocks: a lane's write waits for the parent's running command and the reverse, exactly
as one session's own calls do. Announcements are per announcer inside that scope: a reservation
wave switch retires only the announcing session's older announcements, and "an earlier call" is
measured only among one session's emission indexes, so a parent and its lanes never order or retire
each other's calls. The per-path mutation queue stays process-wide: two sessions writing one file
take turns whatever tree they think they are in. A scope is held open by every session and lane
constructed in it and disposed when the last one leaves; callers that name no scope share one
default scope, which is what a single-session process always had. Why: every piece of that state
used to be a module global (a parent and its lanes shared one announcement table), and a first
per-session cut removed the interlock along with the bug. Pinned by
`packages/coding-agent/test/mutation-lock-scope.test.ts` and
`packages/coding-agent/test/bash-edit-write-race.test.ts`.

**An export on any lane is an export of the session.** Every bash lane reports its `export -p`
listing in the command sentinel (frame v2) only when the listing changed since that lane's previous
command, compared in the shell against an unexported snapshot variable (one `$(export -p)` subshell
per command, no external process, payload only on change). The session's export ledger merges the
DELTA each lane's command produced (set, changed, unset) into the session set, so two lanes finishing
in either order both contribute and a sibling's stale snapshot can never erase an export; a lane
behind the ledger replays the `declare -x` lines it lacks and `unset -v` for names the session no
longer exports before its next command. Windows engine lanes share one `WindowsShellState` and need
no ledger; the PowerShell floor stays lane-local. Why: with the lane pool, `export FOO=1` in one
command and `$FOO` two commands later could land on different shells. Pinned by
`packages/coding-agent/test/shell-export-sync.test.ts` and
`packages/coding-agent/test/bash-concurrent-lanes.test.ts`.

**A file's encoding is the harness's problem, never the model's.** Read and edit resolve it in
this order: the `encoding` argument, the `fileEncodings` setting (glob to codec), the nearest
`.editorconfig` charset, a BOM, strict UTF-8, and finally the managed Python codec's detection
(UTF-16 by NUL pattern, otherwise the total windows-1252 / latin-1 decode). Every edit of a
non-UTF-8 file is a byte splice through that codec: untouched bytes are copied verbatim, each
replacement is encoded in the resolved codec, the write is verified by re-reading, and a
replacement the codec cannot represent fails before any byte is written and names the character.
The only encoding failure a model can see is "Python is unavailable". Why: eleven read failures in
one live session told the model that "exact UTF-8 replacement is unsafe" and it abandoned the tool
for shell decoding; the owner's rule is that Python is applied to do the edit safely, mandatorily.
Pinned by `packages/coding-agent/test/edit-detected-encoding.test.ts`,
`packages/coding-agent/test/read-encoding-recovery.test.ts`,
`packages/coding-agent/test/edit-byte-preservation.test.ts` and, for the ledger guidance text,
`packages/agent/test/tool-failure-memory.test.ts`.

**The sanitizer keeps a rejected attempt out of the agent's context.** Measured on the request
after an omission, the server prompt cache still hit almost fully; the omission costs one request
without the transport delta, not a re-prefill. Pinned by `packages/agent/test/tool-failure-memory.test.ts`
and `packages/coding-agent/test/phone-filesystem-workflow.test.ts`.

**A read miss locates; it does not invite create.** `read` file_not_found publishes
`filesystem.file.exists` plus ancestor locate evidence. Write-create is
`filesystem.file.missing.create` and is not loaded from that observation. A later same-path write
is still a different tool and can re-admit the read. Pinned by
`packages/coding-agent/test/phone-filesystem-workflow.test.ts` and
`packages/coding-agent/test/tool-failure-recovery-contract.test.ts`.

## Guards

**The edge asks once; instructions, the session or the machine grant it, and nothing else in the
tool layer ever asks.** Six class names remain for grants. Classification asks only for
`destructive.fs` (deleting the repository, a directory that contains it, its `.git`, the home
directory, a filesystem root, or a disk, including `gh repo delete`) and `toolkit.script`
(executing a registered dangerous toolkit script). Git, including push, tag, reset, and commit,
package publish and install, settings edits, and every other delete run without asking. Anything
unknown is ordinary work and runs.

**System One judges every operation that can reach beyond the task; no pattern list decides it.**
A shell command or a script says what it does in any language and any spelling, and a model blocked
on one reaches for another (measured live: a blocked `curl` POST came back as Python `urllib`), so
pattern gates are bypassed more easily than they control anything. The only deterministic decisions
are by tool contract and exact path: tools that cannot have effects (reading, searching, planning),
typed writes inside the task or the temp directory, and the edge's literal extreme-destruction rules.
Every shell or code call (`bash`, `run_process`, `powershell`, `python`) and every write outside the
task goes to System One as one batched request: does it leave the machine, can it not be undone, does
it touch files outside the task, does it acquire external code, does the owner's request ask for it.
The reading scales with what an interruption costs: an effect is established at 0.8, unsettled above
an even chance, absent below (live: `npm test`, `git status`, a build script and a `sed` edit stay at
or below 0.22 on every effect; `pip install` reads 0.99 acquires external code; a Python POST 0.93
leaves the machine). The irreversible row of the authority line then decides: no likely effect runs
silently; an established effect runs when the request asks for it (0.8), is refused when it clearly
does not (0.2), and otherwise goes to the operator as `operation.irreversible` at the edge, as does
an unsettled effect or a System One that cannot answer within 8 s; a worker is refused instead of
asking. A standing `operation.irreversible` grant authorizes, and what System One found is shown
either way. Verdicts are cached for identical calls within a turn; a session without System One keeps
the deterministic gates alone. Pinned by `packages/coding-agent/test/edge-policy.test.ts` and
`packages/coding-agent/test/system-one/operation-gate.test.ts`.

**System One checks a plan when it is published or changed.** After a `task_steps` set, intake or
add, the whole current plan and the owner's request go to System One as three questions, each naming
one defect: a requested part no step does, a step that needs a later step's result, no step that
checks the result. A defect at the noul hard-fail band (0.8) is appended to the tool result as a
steer, so the model revises the plan before working from it; a defect above an even chance is a
doubt shown to the operator; a failing System One is a doubt, never a block. Status updates are not
reviewed. Pinned by `packages/coding-agent/test/system-one/plan-review.test.ts`.

**One classification is conditional on live state, not on the command alone.** Several pi sessions
share one worktree, so `git reset --hard`, `git clean -f`, `git checkout -- …`, `git restore` and
`git stash` (push, save, drop, clear) can delete another session's uncommitted work with no reflog
to recover it. They stay ordinary work whenever every dirty path in the tree is one this session
wrote; they classify into `destructive.fs` only while the tree also holds changes it did not. The
classifier never touches the filesystem: it emits the operation with a `condition`, and the session
layer resolves it once per call against `git status` and the objective's own mutation ledger. A
directory that is not a repository has no worktree to discard and resolves to no condition, and a
discard of the session's own work never reaches the operator. A status that cannot be read (a timeout,
an oversized status, a lock) resolves to *the condition holding*: the discard is irreversible, so on a
state nobody could establish the operator decides, the authority line's rule for an irreversible
operation. Toolkit script authority is a host-owned edge: dangerous
toolkit script operations are classified into `toolkit.script` with a narrow scope key derived
cryptographically from `(cwd, scriptPath, runner, scriptName, argv)` (`toolkit:<scriptName>:<digest>`).
A narrow grant persists across session compaction and reload, but changing script registration
(altering script path or runner under a fixed script name and argv) invalidates the scope key and denies
unconfirmed execution until restored. Explicit owner authorization is reused directly without artificial
model confirmation prompts. A class granted by the
task instructions (`goal grant_edge` with the operator's exact words, verified verbatim against a
user message on the branch — a paraphrase grants nothing, and scoped toolkit script grants match on
their derived scope key), by the operator in this session (`/edge allow <class…|all>`, or *allow for
this session* at the prompt) or by the machine (`edge.allow` in settings) never asks. An omitted
`edge.allow` resolves to all registered classes as standing edge authority, independently
of the learning preset. `edge.mode` remains `guarded` unless set to `yolo`, which bypasses routine harness
execution permission checks for foreground and delegated lanes without deleting guarded paths. YOLO
still blocks catastrophic machine commands and explicit command denies; repository deletion needs a
fresh owner decision and cannot inherit a standing class grant.
An explicit edge class list, including `[]`, replaces the default grants. Malformed or
unreadable policies withhold standing grants while ordinary diagnostic requests remain available;
reload and compaction preserve the resolved authority. Provider context reuses those grants and
tool/self-modification prose cannot introduce another confirmation. The edge contract's restricted
fixtures now explicitly select `edge.allow: []`; they still prove that missing authority blocks and
that worker grants remain bounded. A session or
instruction grant is a durable record on the session branch and lasts until revoked, so a full grant
covers the whole work, and a commit is ordinary work that never asks. An ungranted `destructive.fs`
or `toolkit.script` asks the interactive operator once with one key and the tool call waits for the
answer; a headless or child session blocks it with a reason that names every way to grant. The former keyword `risk_assessment`
gate (regular expressions over command text that turned "token", "clean", "delete" or a Python
`subprocess`/`shutil` mention into a block under a capability envelope) is gone on purpose: it
asked questions the owner had already answered with the handoff. What remains is structural — the
capability envelope (a tool without its capability, a denied or unlisted tool, a path outside the
allowed roots) and the literal edge classes above — and `bash`/`python` stay explicit host-trust
execution boundaries (`session-role.ts`): no gate reads Python source or shell text for intent, and
none claims to contain arbitrary process code. The session proof of an ungranted class uses
`npm publish` (`package.publish`). Root bash refuses a git invocation before the edge confirmer,
so that proof is not a git command. Pinned by
`packages/coding-agent/test/python-tool-registration.test.ts`,
`packages/coding-agent/test/edge-policy.test.ts` and
`packages/coding-agent/test/agent-session-edge.test.ts` and
`packages/coding-agent/test/autonomy-default-authority.test.ts`.

**A failed admission cannot erase already-executed work.** The scheduler drains dispatched siblings
before terminating after reservation failure or cancellation. Completed tool results remain in
source order, agree with message callbacks, and precede the unsuccessful terminal signal. Calls
whose bodies never started are not fabricated as successful results. A cancelled batch never
issues another provider request. This supersedes the old scheduler characterization that returned
only one synthetic abort and discarded earlier evidence. Pinned by
`packages/agent/test/tool-batch-settlement.test.ts` and `packages/agent/test/agent-loop.test.ts`.

**Progress observation cannot change execution.** A listener throwing or rejecting cannot interrupt
the tool body or erase its returned result. Admitted observations drain before finalization; late
callbacks cannot emit after settlement. The engine retains only bounded delivery status, not raw
listener diagnostics or delivered-update history. `piToolInvocation` separates execution state
and operation status from progress/after-hook failure tags. A generic throw leaves effects unknown;
an explicit operation-outcome exception is completed-negative. Foreground delivery failure stops
after retaining results. Background persistence and notification retain request-bound execution
facts; unavailable completion remains unknown. Tools and hooks cannot manufacture those facts.
Pinned by `packages/agent/test/tool-progress-delivery.test.ts` and
`packages/agent/test/tool-progress-settlement.test.ts`.

**Reporting dimensions keep their scope.** `ToolInvocationReport` owns receipt classification and
replay reconciliation. A background terminal updates the original call and cycle, not a second
action. Completed-negative operations, unknown effects, rejection, postprocessing faults, and raw
error results remain distinct. The workbench labels cycle calls separately from retained error
results; their quotient is never a failure rate. Bounded retention discloses saturation as partial,
and missing or conflicting evidence never certifies success. Pinned by
`packages/agent/test/tool-invocation-report.test.ts` and the workbench controller regressions.

**Verification is a typed host receipt, not a claim in prose.** Goal test evidence must resolve
to a passing receipt on the active branch; complete user quotations resolve only to user-role
records. An unrelated successful command never clears a failed test. Literal argv and actual
execution directory identify a check; opaque shell expressions retain their exact source.
Direct Vitest and Node TAP/spec output must confirm nonempty executed tests through one bounded
raw-output lifecycle. Goal test citations require explicit executed-test evidence; opaque command
success and historical receipts without that witness remain ordinary tool evidence, not test proof.
This closes the gap where a successful wrapper or a Node command that never ran tests could certify
a test requirement. Verification path syntax comes from the executing backend, never a guessed
drive or the operator's ambient directory. Only an explicitly linked, newer
executed pass with matching host-derived scope can supersede an empty-test setup failure;
executed or unknown failures cannot be downgraded into setup failures. Compaction retains those
relationships. Historical receipts without that proof remain unresolved.
The executor's receipt is captured before hooks and survives hook mutation, replacement, failure,
and background handoff. A hook cannot turn an executed failure into a passing witness or invent
a witness for an opaque result; ordinary content and policy overrides remain available. Pinned by
`packages/coding-agent/test/goal-evidence-verification.test.ts`,
`packages/coding-agent/test/bash-verification-boundary.test.ts`, and
`packages/agent/test/tool-terminal-evidence.test.ts`,
`packages/agent/test/verification-setup-repair.test.ts`,
`packages/coding-agent/test/node-verification-boundary.test.ts`, and
`packages/coding-agent/test/test-verification-output.test.ts`.

**An unresolved obligation marks the run that produced it and blocks completion; it never
errors a later answer.** The host preserves the answer of the run whose own check failed and
marks that run unsuccessful; obligations inherited from earlier runs stay listed with their
command and directory and block goal completion; goal continuation keeps going with a repair
directive (`verification_repair_required`: read the red output, find why it broke, fix, rerun), since a
failing compile or test mid-work is ordinary iteration and the runaway guards bound it. A user
message delivered mid-run opens a new subject, so that subject's answer is ordinary even while the
earlier subject's checks are red; a later root answer is an ordinary answer. The operator resolves an
obligation with `/verify dismiss`, a user-plane record the tracker honours and goal evidence never
counts as a pass. The host does not erase prose or spend extra provider turns demanding opaque-ID
grammar. Reflection cannot claim a cancelled submission or unsuccessful terminal turn, and it buys
no turn while goal work is open (an active goal or an in-progress task step): the cue stays due
until the work closes. Pinned by
`packages/coding-agent/test/suite/regressions/unresolved-verification-handoff.test.ts` and
`packages/coding-agent/test/reflection-turn-lifecycle.test.ts`.

**A repair survives first failure and replay.** The adapter supplies the bounded correction;
the shared recovery path retains it independently of optional diagnostic text. Action-dependent
required fields reject before execution and report the missing field. Pinned by
`packages/agent/test/tool-failure-replay-correction.test.ts`,
`packages/coding-agent/test/suite/regressions/credential-repair-projection.test.ts`, and
`packages/coding-agent/test/suite/regressions/delegate-action-preflight.test.ts`.

**Reordering unchanged results does not create progress.** A bounded history of matching
operations and result signatures detects stagnant batches even when their order or membership
changes. New operations and changed results reset the counter. Existing recovery admission and
call fuses remain authoritative. Pinned by `packages/agent/test/tool-result-progress.test.ts`
and `packages/agent/test/runaway-loop.test.ts`.

**Protocols are mechanisms, prose points at them.** The readmission gate and the ledger resolution
enforce the failure protocol; the protocol text lives once in the stable system prompt and an
active record carries one pointer line (the constrained tier keeps the full text). Pinned by
`packages/agent/test/tool-failure-memory.test.ts`.

**A degenerate output loop ends before the cap.** The stream guard ends a response whose trailing
window repeats the tier's number of times, classified as a runaway, never retried unchanged. The
comparison collapses ordered-list markers, so an enumerated loop whose only change is its number
is still a loop, while rows that differ only in their numbers are still output.
Pinned by `packages/agent/test/reliability/stream-idle.test.ts`.

**A tool-loop runaway is evidence.** A repeated tool call, a stagnant tool cycle, or the
provider-turn limit records a runaway stop, demotes the model to the strong tier for thirty days,
and the goal continues on a recovery path. An output runaway from the stream guard ends the
response and leaves the goal to change approach, but does not demote on its own: the guard is
measured against one real loop and a legitimately repetitive output must not cost a model a month.
Pinned by `packages/coding-agent/test/agent-session-runaway-escalation.test.ts` and
`packages/coding-agent/test/capability-tier.test.ts`.

**A stall budget belongs to a model class, never to every provider at once.** Local and
pi-managed models draw on `retry.stall.local` (the legacy top-level `connectMs` / `activeIdleMs` /
`quietIdleMs` keys are that budget, a `local` entry overrides them field by field) over the
generous `DEFAULT_STREAM_IDLE` bounds; every hosted provider draws on `retry.stall.cloud` over
`DEFAULT_CLOUD_STREAM_IDLE` (connect 120 s, active 120 s, quiet 300 s). An unset field keeps its
class default rather than falling through the HTTP clamp to the local default. While legacy keys
are set without a `cloud` entry the settings diagnostics say so once at startup. Why: a CPU-served
local model legitimately sits silent for minutes while it loads, a hosted stream silent that long
is dead, and one shared budget raised for the first left dead cloud streams running for fifteen
minutes. Pinned by `packages/coding-agent/test/stream-stall-model-class.test.ts` and
`packages/coding-agent/test/settings-manager.test.ts`.

**An expired credential is never reported as a missing one.** A stored OAuth credential that is
past its expiry and cannot be refreshed fails as `OAuthCredentialUnusableError`: the provider,
the expiry date, the redacted refresh failure and `Run pi login <provider>`; lower-priority key
sources never stand in for the credential the user chose, and only a provider with no stored
credential at all reads `No API key`. Why: a four-day-stale token surfaced as "No API key for
provider: xai", which points at the wrong fix. Pinned by
`packages/coding-agent/test/auth-storage.test.ts`,
`packages/coding-agent/test/auth-storage-oauth-only.test.ts` and
`packages/coding-agent/test/agent-session-oauth-credential-expired.test.ts`.

## Workers

**Workers deny by default; the shell is the one host guarantee.** A worker's other tools come from
the parent's active tool set; root-only tools and nested delegation are refused with the rule named.
Read is read: a parent with `bash` lends the catalog read tools (`grep`, `find`, `ls`) and read-only
git (`repo_read`, capability `repo.read`) natively. Every worker also receives `bash` and
`process.exec`, including `readOnly: true`, named profiles, narrow tool lists, and a foreground
session without bash. A `readOnly` grant, persisted on the worker's profile, holds that shell to
commands that edit nothing that exists: output may still be redirected or `tee`d into a new file,
while a redirect onto an existing path and every command the shared read/write line calls mutating
are refused with the reason. `readOnly` also drops write, interpreter, script, network and service
tools, holds in YOLO, and defaults the worker's role to `explorer`. A profile that grants process
execution without file writes keeps an unrestricted shell: only `readOnly` restricts commands. In guarded mode a worker's shell and code calls go through the same System One
operation review as the root's, except under the standing `operation.irreversible` grant, where the
verdict could only authorize; a held or refused operation is refused and reported to the parent,
because only the root reaches the owner.
`repo_read` runs git with an argv allow-list: no shell, no hooks, pager or diff
drivers, only output-shaping options, pathspecs and object paths inside its directory, credential
files model-blind like `read`. A plain `log` request returns at most the requested number of concise
one-line commits; explicit log options retain their own formatting. Prose cannot narrow a grant.
Persistent reuse retains its existing grant.
Named starts route their complete options, including `readOnly`, through host admission: equivalent
compiled options may select that specialist, while changed authority is refused before dispatch.
The tool must not preempt that decision or silently discard options. Compatible idle specialists
are reused automatically; independent parallel identities require an explicit justification.
One tool-call replay key identifies the same admitted task across branch-leaf changes.
Status exposes only validated permission names bound to the selected
attempt, never permission guesses or raw resource grants. Inspection pages omit opaque provider
replay signatures before output sizing; raw replay remains exact and both input and output are
bounded. Unsupported status selectors refuse instead of expanding the selection.
Pinned by `packages/coding-agent/test/worker-authority-resolver.test.ts`,
`packages/coding-agent/test/native-worker-autonomy.test.ts`,
`packages/coding-agent/test/repo-read.test.ts`,
`packages/coding-agent/test/worker-task-view.test.ts`, and
`packages/coding-agent/test/worker-transcript-inspection.test.ts`.

**A fresh worker captures the task directory without re-anchoring authority.** Native delegate and
goal dispatch inherit the caller's admitted task cwd before queueing. An explicit relative worker
path resolves from that cwd; a configured relative preset remains anchored to its configuration
scope. Default permission roots remain anchored to the granting session, including when task
selection moves to a UNC share. Queued and reused workers keep their admitted cwd, and unavailable
foreground directories cannot block status or cancellation. Why: resolving every fresh request from
the launch directory dispatched work into the wrong project; treating the execution directory as
the grant anchor could silently add a new share. Pinned by
`packages/coding-agent/test/worker-authority-resolver.test.ts`,
`packages/coding-agent/test/worker-execution-policy.test.ts`, and
`packages/coding-agent/test/session-worker-directories.test.ts`.

**A fresh, unpinned worker runs on another account than the foreground when one is authenticated,
and inherits the foreground thinking level one notch down; authored choices are never moved.**
Routing (`workerDelegation.account`, default `other`) takes the first candidate of
`routeProviders` (`provider` or `provider/modelId`), then every other authenticated provider in
catalog order, skipping the foreground's provider, models lacking background-lane capability (`backgroundLanesEnabled`), exhausted models and accounts with a live
machine-wide limit, and falls back to the foreground model when nothing else is authenticated (a simulated `faux` foreground provider never routes away to external accounts); a
`routeProvidersByRole` list replaces the order for one role. An authority model, a model pin and a profile
binding stay exactly as written. Why: measured 2026-09-11, a worker wave landed on the same
account as the owner's turn and competed with it for one subscription's budget. When neither the delegation authority nor the profile binding pins a thinking level, the
worker runs one step below the owner's live level (`xhigh` -> `high`), with `minimal` as the floor
and `off` staying off; `workerDelegation.thinking: "inherit"` restores the copy. An authority pin,
a profile binding and a model pin are authored choices and are applied exactly as written. Why:
measured on the owner's sessions of 2026-09-04..11, workers inherited `xhigh`, and a wave of five
to seven workers each spending the foreground's full reasoning budget at once was the largest
single source of shared-account load (277 of the 334 xAI requests that overlapped another were
workers), while the owner's own request waited behind them. Pinned by
`packages/coding-agent/test/worker-authority-resolver.test.ts` and
`packages/coding-agent/test/native-worker-autonomy.test.ts`.

**A provider limit one process learns is a limit every process honours; the owner's foreground
request never waits for capacity or the stop; workers and background lanes yield at the provider's
machine-wide cap.** Every pi process on the machine registers each in-flight provider request under
`state/provider-admission/` (one file per request, released when its stream settles, pruned by any
reader once its owner's pid is gone or its heartbeat is stale). The first process to see a 429, an
overload, or a fully used subscription window records the reset time under
`state/provider-admission/limits/`; the latest windows are kept per provider under
`state/provider-admission/usage/`, with the account's credits when the provider reports them
(Codex's `x-codex-credits-*`), so `/load` shows what remains beside what is used; before sending, every lane waits out a recorded limit that fits
its budget and otherwise refuses the request unsent with a message the reliability classifier
reads as a rate limit carrying the remaining delay, so no retry ladder rediscovers a limit at the
account's expense; a worker's own retry ladder publishes its wait the same way. Bedrock's
`ThrottlingException` enters this rate-limit policy through the adapter's `Throttling error:`
message; admission records a shared limit only when that failure provides a reset or retry delay.
Counts and limits
are keyed by provider plus credential identity (`<provider>#<identity>`, never a secret), so two
accounts on one provider are two budgets. Admission captures that identity once and retains it
through result observation, even if the session's credentials change. A success clears a rate-limit
or overload record only when its request started strictly after that record was published; an older,
same-timestamp, or unknown-start success cannot establish recovery from a sibling's newer failure.
Cancellation cleanup is installed before transport creation is awaited, and completion, rejection,
or cancellation releases the hold and removes its listener. The emergency stop
(`<agentDir>/ESTOP`) holds new worker and background requests in every process and never the
foreground. A foreground request is otherwise registered and admitted at once. A worker or background request to a
provider at its configured limit (`providerAdmission.limits`; no provider is capped by default,
matching the Codex CLI, which applies no per-account cap) waits for a slot, deciding and registering under one lock so the last slot is taken exactly once, and is
admitted regardless after `maxWaitMs` so a wedged sibling can never starve it; every wait is a
`provider_admission` record in the owner session. The gate sits outside the idle watchdog and the
perf profiler, so waiting is neither a connect stall nor time to first token. Why: measured
2026-09-04..11 across several pi sessions, Codex CLI and Claude Code on one box, a second Codex
request in flight from any process cut generation from 97.7 to 62.2 tokens per second, and no
process knew what its siblings were sending; the census did not measure the count at which a cap
pays for itself, so the ledger records by default and a limit is the owner's choice. Pinned by
`packages/coding-agent/test/provider-admission.test.ts` and
`packages/coding-agent/test/provider-admission-completion.test.ts`.

**Queue validation cannot substitute a directory or start an attempt twice.** Fresh worker and
verifier contracts capture native directory identity before durable dispatch. Queued and resumed
execution revalidates that identity with bounded cancellation before provider execution; capacity
and authority are checked again after asynchronous validation. Queue ownership and reload blockers
remain live during that wait, and canceled or replaced queue entries reject late probe results.
Mailbox recovery runs before queue ownership transfers, so it cannot rediscover and re-enqueue
the attempt being started. Historical contracts retain explicitly admitted path-only recovery with
a diagnostic: identity never recorded cannot be reconstructed, and that limitation cannot bypass
a saved binding. Synthetic foreground and worker response scripts are independent of scheduling
order. Pinned by `packages/coding-agent/test/worker-directory-admission.test.ts`,
`packages/coding-agent/test/worker-dispatch-preflight.test.ts`,
`packages/coding-agent/test/session-worker-directories.test.ts`, and
`packages/coding-agent/test/agent-session-worker-delegation.test.ts`.

**A foreground call is handed off only on the model's request or the operator's clock.** A tool
declares which calls are foreground waits (never handed off) and which ask for a background task
up front (`backgroundRequested`, handed off at once); every other call blocks up to its own timeout
unless the operator configured a clock (`backgroundTool.callAfterMs`, off by default) or moved the
call by hand. The handoff stub names which of the three moved the call (`started as session task
… (background requested)`, `exceeded Ns; running as session task`, `moved to session task … by the
operator`). Pinned by `packages/agent/test/agent-loop.test.ts` (foreground by default) and
`packages/coding-agent/test/background-tool-task-controller.test.ts` and
`packages/coding-agent/test/tool-task.test.ts`.

**The completion wake-up carries the result.** When a background task ends, its wake-up lists each
finished record's status line followed by its bounded final output verbatim, in emission order,
under one 24 KiB message budget; a record whose output does not fit gets an `output omitted` line
naming the exact `tool_task wait` that collects it. The notifier builds the message from the
records still unread when it delivers and returns a receipt of the ids it inlined; the controller
marks exactly those observed (the wake-up is the model-facing read) and never re-derives the set
from an older snapshot; an omitted one stays unread until its own wait. `tool_task action=list` is
a status-only read and never observes: it prints `taskId: status — summary` and no output, so
consuming delivery there would make the notifier (which delivers only still-unread records) skip
exactly the records whose output the listing never showed. Only the wake-up and `wait` consume a
record. Each record in the wake-up's `details` carries `outputBytes` (the output's UTF-8 length) and
`inlined` (whether this message carried it in full), so the byte budget is priced from what was
delivered instead of assumed; persisted task records drop their output, so nothing else can answer
that afterwards. The handoff stub, the `tool_task` guideline and the `background` descriptions all say the
same thing: wait only for an omitted output, never poll. Why: listing only `taskId: status` made
every background job cost a second provider request whose sole purpose was to fetch bytes the
record already held, 10-45 s on a slow-first-token provider. Pinned by
`packages/coding-agent/test/background-tool-task-controller.test.ts` and
`packages/coding-agent/test/tool-task.test.ts`.

## System One

**System One decides the loop; the root and the workers execute.** Whenever System One is bound the
goal loop runs in `objective_primary` mode: each continuation pass evaluates one objective route from
deterministic facts (cancellation, budget, running attempts, the ledger's stall reading) and Jev's
judgments, then executes it. A route names its executor: the root (one foreground turn carrying the
route brief) for implement, investigate, replan, retrieval and non-independent verification; a worker
for review, independent verification and escalation; a wait on the running workers; the completion
coordinator for a completion candidate. The legacy continuation is the input layer of that route and
never a competing decider; `legacy_goal` stays available by setting and is the fallback without a
plane. Completion is only the coordinator's verdict: the goal follows the objective's terminal and
blocks, naming the unsatisfied requirements, when the two disagree. A completion check System One
could not settle holds the goal: an outage only holds, while an ambiguity also becomes a question to
the owner through the host's owner channel, naming the check and its doubts, since an objective
transition never closes on a doubt.
Pinned by `packages/coding-agent/test/goal-session-primary-loop.test.ts` and
`packages/coding-agent/test/session-objective-runtime.test.ts`.

**System One has the operator's two levers over every executor.** Cancel fires immediately (the Esc
path, a named abort). A steer is either queued for the next model turn or delivered now by
interrupting the running turn and sending it once the foreground is idle; for a worker, "now"
interrupts the attempt, queues the directive on its mailbox and resumes it. Both work from inside the
running turn and every directive is an operator event. The tool gate never pulls the cancel lever.
System One never judges a single tool call: the call is recorded with an intent built from its own
arguments, and relevance and scope are judged once per step in postflight. A preflight route is
recorded and does not skip the turn.
A hard yes that the user authorized the work enables every edge capability that is still off, and
the authority slot is the only text the model receives for that change. Relevance is judged only
against a real step or goal, never against an empty objective. A
System One cancel of the root's own turn inside the objective loop is a re-route, not a stop; only
the operator's interruption stops the loop. A worker judged off the mission is redirected now, a
stalled one at its next turn, a repeated stall rerouted. The off-step cancel proof uses `echo status`.
Pinned by `packages/coding-agent/test/system-one-foreground-control.test.ts` and
`packages/coding-agent/test/system-one-worker-control.test.ts`.

**The authority line says where a judgment may stop work** (`system-one/authority-line.ts`). Reversible
work proceeds past a doubt or an outage with the doubt visible; an ambiguous judgment asks for
evidence at most twice per evidence revision, then reversible work proceeds. An objective transition
(JEV-024..028) never closes on a doubt and holds on an outage. An irreversible or outward operation
goes to the operator (root) or is refused (worker). A Noul has no confidence of its own (its
probability is the certainty), so only Choice and Score answers are gated on confidence, and a
low-confidence answer is a doubt routed to `gather_more`, never an exception that ends the run.
Pinned by `packages/coding-agent/test/system-one/authority-line.test.ts`.

**An owner question is observable before presentation and stays open on timeout.** The host
publishes `waiting` before it invokes the presenter, then publishes `settled` even when presentation
fails. An unanswered deadline leaves a pending snapshot and grants no authority; an external owner
message may later resolve it. Pinned by `packages/coding-agent/test/human-input-activity.test.ts`
and `packages/coding-agent/test/human-input.test.ts`.

**Every answer's claims are checked against the turn's receipts** (`system-one/claim-delivery.ts`), with or
without a live objective. System One answers one atomic question per claim kind (the answer states tests
passed, a commit, a push, a publish, changed files); code combines each settled answer with the
turn's mechanical receipts. A claim the receipts contradict buys one correction turn; one no receipt
backs is an unverified-claim warning. Pinned by `packages/coding-agent/test/system-one/claim-delivery.test.ts`.

**What no agent could settle climbs a ladder, then reaches the owner** (`system-one/unsettled-ladder.ts`).
A worker reports findings it could not confirm as `inconclusive`, never rounded up. System One judges
each against the worker's own tool results; then a stronger model names the settling fact and System
One judges it; each pass carries new evidence, at most two. The model finds, System One decides. What stays
open goes to the owner: asked through the parent with the owner in the loop, written to the follow-up
document under a handoff while the run continues around it. `typesafe_review` is authorized by
`semantic.judge`, which read-only grants keep. Pinned by
`packages/coding-agent/test/system-one/unsettled-ladder.test.ts` and
`packages/coding-agent/test/worker-inconclusive-ladder.test.ts`.

**System One catches logic that is duplicated but written differently** (`system-one/code-duplicates.ts`). Token
clone detection finds copies; it cannot see two functions that do the same job with different names
and structure. A semantic unit index ranks candidates by IDF-weighted shared calls and normalized-token
fingerprints, with rarity measured from the index, never listed by hand; identical structure ranks a
candidate but is not the same job. System One judges every (new unit, candidate) pair of an edit in one
request and a decisive duplicate is reported in the edit's result, naming the function to reuse.
`npm run scan:semantic-duplicates` runs the same judgment over every production unit.
Pinned by `packages/coding-agent/test/system-one/code-duplicates.test.ts`.

**A noul answer is a probability with a direction, never a boolean.** Noul is P(the proposition is
true). The decision is the pair (direction, band): `required_true` needs the high end,
`required_false` the low one, and the band says whether it was reached. `hard_pass` and `hard_fail`
are decisive. `soft_pass` is provisional — the step may continue, but it may not close a goal or
authorize a destructive or outward-facing action. `ambiguous` decided nothing: it is not a pass and
not a failure, and acting on it is acting on ignorance. `BooleanDecisionResult` therefore carries
`probabilityTrue`, `direction` and `band` and has no `value` field; `settledBoolean` is the only way
to collapse one, and it returns undefined rather than pick a side. A checkpoint whose only problem is
doubt routes to `gather_more` — look again — instead of passing or rejecting, and the certificate
carries those predicates as `unsure_semantic_predicates`. A per-question numeric threshold
(JEV-004's 0.75, JEV-013's 0.7) is a deliberate calibration and reads the probability directly; a
0.5 cutoff is not a calibration and appears nowhere. The pane prints `P(yes)=0.55 · unsure`, never
`true (p=0.55)`. Pinned by `packages/coding-agent/test/noul-bands.test.ts`.

**The Decision graph draws doubt, not just pass and fail.** An unsettled judgment is an open doubt:
it is named in the list and in the diagram, it holds `goal satisfied?` at `not closed · N doubts`
exactly as an unmet check does, and it blocks the `DELIVER` node. Doubts travel as prefixed reason
lines on the evaluation record, so they reach the pane and the durable ledger by the route every
other reason already takes. The running clock is the current visit only and restarts on resume.
Pinned by `packages/coding-agent/test/workbench-decision-graph.test.ts`.

**The decision ledger is an input, never erased.** Every stage transition, Jev evaluation and route
is appended to one SQLite database per agent directory, keyed by session id and working directory.
The objective's recent routes are a history block in the state the judge reads, and "repeated without
new evidence" is a fact from those rows: one route on one evidence marker, twice. The root reads
the ledger through `decision_ledger_read`, a bounded query tool never exposed to workers; its
projected schema costs at most 100 tokens, budgeted separately from the 4,500-token base ceiling
and the other separately-measured additions (aggregate 5,813 = 4,500 + 350 task_directory +
720 task_automation + 100 decision_ledger_read + 143 repo_read; the Jev tool's 512 stays inside the base subtotal
accounting), so the ledger surface cannot hide growth in the pre-existing tools. `repo_read` is a bounded git read, measured at 143 tokens, and is budgeted the same way.
Root bash also runs git. The operator is asked only before deleting the repository, a directory
that contains it, the home directory, a filesystem root, or a disk.
Pinned by `packages/coding-agent/test/ledger-route-checkpoints.test.ts` and
`packages/coding-agent/test/context-composition.test.ts`.

## Structure

**The coordinator line ceiling provides owner-approved integration headroom while ownership ratchets remain authoritative.** `agent-session.ts` and extracted boundaries have an 8,000-line ceiling in
`scripts/check-coordinator-boundaries.mjs`; extracted-owner and forbidden reclaimed-responsibility markers remain strictly enforced.

**One call failing identically ends the run on the ledger's own count.** The failure ledger
counts an occurrence of a failure key once per tool batch: an occurrence is an attempt the model
made after seeing the previous failure, so identical calls emitted side by side in one assistant
message (and the duplicates the admission gate blocks unexecuted) share one occurrence, and the
history fold applies the same rule per assistant message. When one key reaches the tier's repeat
count across batches the run ends as a `repeated_tool_call` runaway, whatever else the model mixed
into the same turns. Why (2026-09-07): four parallel `goal` calls that differed only in their hex
ids reached the limit inside a single batch and ended a live audit before the model saw a result. The batch
fuses stay: the stagnant-cycle detector compares results with the ledger's per-occurrence stamp
removed, so an identical failure is identical. Why: measured live, one invented `task_steps` id
failed 28 times in 22 minutes inside batches whose other calls varied, and no guard fired. A slip
the resolver can name normalizes instead of refusing: an ordinal prefix followed by uuid-like or
parenthetical noise resolves to the one step carrying that number and the result says so; a short
numeric fragment still refuses with the open-step list. A compacted ordinal that is no longer among current steps names archive counts and says that id's historical status is unknown; it does not redirect to another step. Goal unknown-requirement and unknown-evidence refusals name the live catalogs. `tool_task` wait/invalid-id errors classify `errorKind` so completed waits stay operation outcomes and lookup misses stay tool failures. Why (2026-09-15): a live session spent 29 tool errors retrying selector `7` after compact, citing unknown evidence, and treating vitest/biome exits as MUST ledger mistakes. Pinned by
`packages/agent/test/runaway-loop.test.ts`, `packages/agent/test/tool-failure-memory.test.ts`
(envelope-stable signatures, corrective diagnostic tail),
`packages/coding-agent/test/task-state.test.ts`,
`packages/coding-agent/test/goal-tool-core.test.ts`, and
`packages/coding-agent/test/tool-task.test.ts`.

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
reroute), an unqualified `list` shows all three with their budgets while an explicit target
selects only that file, an over-budget general file puts a triage
note in the memory block (move project lines, never delete), and workers cannot write any project
memory. Why: on both owner machines the single global file was full of ticket and build facts,
refused writes four times in a row, and sent every project's facts to every other project's
sessions. Pinned by `packages/coding-agent/test/memory-subsystem.test.ts` (project-scoped hot
memory), `packages/coding-agent/test/file-store-memory-provider.test.ts` (project scope search)
and `packages/coding-agent/test/lane-private-paths.test.ts`.

**A managed memory file can always be recovered, and only the operator adopts an external edit.** The managed state stores the committed content with its digest; an empty file against a non-empty managed revision is restored on start and before a write (nothing of anyone's is in an empty file); any other drift refuses the model's write and names `/memory accept` and `/memory restore`, which only the operator can run. Pinned by `packages/coding-agent/test/memory-drift-recovery.test.ts`.

**Memory projections share the final prompt allowance.** Static memory receives only the capacity
left after the core contract, tool surface, paths, and caller instructions. The 4,096-character
minimal limit remains unchanged; omitted preferences arrive through the existing persona record,
whose model budget charges its complete wire framing. Without a model budget, static and persona
projections select the same whole preference lines. Reload retains the bounded notice identity for
each target and kind, so an unchanged drift revision is reported once. Pinned by
`packages/coding-agent/test/system-prompt-builder-tool-selection.test.ts`,
`packages/coding-agent/test/memory-user-persona.test.ts`, and
`packages/coding-agent/test/suite/agent-session-user-persona.test.ts`.

**Memory and skill admission preserve ownership.** Bounded OKF discovery visits the selected
project first without crossing symlink boundaries. External memory edits remain protected by
revision checks. A skill batch validates its entire requested set before one commit; an accepted
batch cannot evict a member of that same batch. Pinned by
`packages/coding-agent/test/okf-memory-provider.test.ts`,
`packages/coding-agent/test/memory-recovery.test.ts`, and
`packages/coding-agent/test/skill-vault.test.ts`.

**Goal accounting starts at ownership, and instructions scale to intent.** A goal created during
a foreground run acquires that run's lease at creation; earlier unrelated usage stays outside it.
Usage and active time flush once at response/end boundaries. Orientation, requested evaluation,
and implementation have different workloads. Existing explicit in-scope authorization is reused.
Goal continuation bounded recovery rearms transient provider failures once per streak, or waits when
independent in-flight workers or background tool tasks are active for that goal; repeated failures
without verified progress block until the owner prompts. The failure streak resets strictly on
verified host completion matching the pre-state turn ordinal (`completionTurn === continuationTurnsUsed + 1`),
so stale or duplicate receipts cannot replenish retries. Runaway/stagnant guard stops are accounted
separately in one durable bounded collection of consumed signatures (`consumedRunawaySignatures`,
at most 16): each signature earns exactly one automatic resume, alternating signatures (A, B, A)
cannot re-earn one, a full collection refuses further automatic recovery rather than evicting, and
neither provider successes nor trusted evidence reopen a consumed signature. Only the owner's own
prompt resets both allowances: it resumes any system-blocked goal (`resume_goal` without
`source: "system"`) and clears the streak and the collection; automatic resumes never impersonate
owner intent. Explicit owner pause, block, stop and `autoContinueGoal: false` are untouched.
These contracts fit the 3,300-byte core prompt budget (the full-profile pin in `system-prompt.test.ts`, measured with the live package root and cwd, including a deterministic long hosted checkout) and the 4,096-character minimal-profile ceiling (`agent-session-model-capability.test.ts`, measured with a long live cwd). Pinned by
`packages/coding-agent/test/goal-execution-budget.test.ts`,
`packages/coding-agent/test/agent-session-goal-continuation-loop.test.ts`, and
`packages/coding-agent/test/system-prompt.test.ts`.

**A feature earns its tokens or is gated by tier, never removed.** `scripts/feature-ledger.mjs`
measures each subsystem's cost and benefit from session files; a subsystem without a benefit
measurement gains no new surface.

## Changes to this file

| Date | Change |
|---|---|
| 2026-09-24 | Self-monitoring compaction: the agent sees its gauge and lines, hands itself off with `self_compact` at a clean checkpoint through the host compaction owner, and continues from its exact note; `self_compact` gets its own 140-token schema allowance, aggregate ceiling 5,953, base subtotal unchanged at 4,500. |
| 2026-09-24 | The provider-limit contract now pins Bedrock throttling classification and requires a known reset before sharing its limit, so sibling requests do not invent a cooldown. |
| 2026-09-21 | The tool gate's replan verdict refuses one call and never cancels the turn; relevance is judged only against a real step or goal; a System One cancel of the root turn inside the objective loop is a re-route, the operator's interruption a stop. |
| 2026-09-21 | `decision_ledger_read` joins the default root tool surface with its own 100-token schema allowance; aggregate ceiling 5,670, base subtotal unchanged at 4,500. |
| 2026-09-21 | System One integration: `objective_primary` drives the goal loop (root and workers as routed executors, completion only through the coordinator, goal follows the objective's terminal), cancel/steer levers for the root and for workers, and the decision ledger as a route input. New section "System One". |
| 2026-09-17 | Provider completion retains its admitted account identity. Successful recovery requires a request start strictly newer than the stored cooldown, so late or unowned successes cannot erase sibling limits. Cancellation during transport creation releases admission immediately. |
| 2026-09-16 | Specialist reuse admission compares compiled options at the host, including named read-only requests; replay identity survives branch-leaf changes. The new explicit parallel-work field receives a separate 75-token allowance while the old 875-token delegate surface and aggregate base-tool ceiling remain fixed. |
| 2026-09-15 | Read miss locates via `filesystem.file.exists`; write-create is a separate kind and is not loaded from that observation. Phone filesystem workflow asserts locate evidence, not create teaching. |
| 2026-09-13 | CI follow-up: memory shares final prompt capacity; persona framing cannot consume the unbudgeted preference allowance; reload deduplicates unchanged drift notices. Transcript fixtures explicitly select empty grants while default-authority tests exercise YOLO. The closed goal edge vocabulary adds 28 schema tokens; the aggregate ceiling stays fixed. |
| 2026-09-13 | Omitted edge policy grants YOLO execution across registered classes; explicit restricted policies retain their meaning. The edge contract fixtures select restricted mode explicitly, and dedicated regressions prove default grants, worker intersections, reload/compaction, and diagnostic recovery from unreadable policies. |
| 2026-09-07 | Whole-row task-directory status pagination replaces megabyte-scale responses, preserves complete escaped paths, and rejects stale cursors. Its measured 340-token schema receives a 350-token ceiling; the pre-existing 4,500-token aggregate remains unchanged. |
| 2026-09-07 | Worker and verifier identity survives queued dispatch and resume; asynchronous probes retain queue ownership, recheck policy, and reject stale completions. Mailbox recovery precedes the start transition. Historical path-only recovery remains explicit and cannot bypass a saved identity. |
| 2026-09-07 | Fresh workers capture admitted task cwd; explicit relative intent uses that directory while configured presets and default permission roots retain their original anchors. Queueing and foreground selection cannot retarget admitted work. |
| 2026-09-07 | A failure key's occurrence advances once per tool batch (executed failures and gate-blocked duplicates alike); the repeated-failure stop counts attempts the model made after seeing a failure, never parallel siblings. |
| 2026-09-07 | Persistent directory control earns a separate 330-token schema allowance; all pre-existing tools retain their combined 4,500-token ceiling. Explicit task pins address reproduced wrong-directory execution without widening grants or introducing per-turn schema churn. |
| 2026-09-06 | Session-audit repairs strengthen receipt provenance, setup supersession, useful unsuccessful handoffs, goal attribution, structured repair, action validation, bounded progress detection, worker grants/inspection, scoped memory, atomic skill batches, and proportional instructions without raising prompt or scanner limits. |
| 2026-09-02 | First edition: the invariants proven live on v0.97.24 and the ratchet model's gates. |
| 2026-09-02 | The output-repetition guard also watches the string values of a streaming tool call's arguments (a live probe looped inside a step selector). |
| 2026-09-02 | Demotion is evidence from tool-loop guards only; an output runaway ends the response without demoting. |
| 2026-09-03 | A host record carries only what changed (legend delta, goal bucket, ledger pointer); the sent prefix survives a new prompt; compaction summarizes the packed projection and names a deterministic checkpoint `fallback`. |
| 2026-09-03 | A call failing identically the tier's repeat count ends the run on the ledger's own occurrence; stagnant signatures ignore the occurrence stamp; ordinal-prefix selectors normalize. |
| 2026-09-03 | Aliases are minted only for existing paths; refs, listings and fragments never mint; only path parameters can be refused as unminted; listings print absolute paths. |
| 2026-09-03 | A skill lookup miss re-scans the roots once before refusing; search lists skills the loader could not index. |
| 2026-09-03 | Refusal false positives: prefix globs, harness roots, variable targets and line-wise scripts pass the credential guard; timeouts are operation outcomes; evidence lands on blocked goals; unions validate on the named branch; the Windows shell engine covers the full coreutils surface, heredocs and nested shells. |
| 2026-09-03 | Memory is scoped: the general MEMORY.md holds facts true in any task, each project has its own hot MEMORY.md under the agent home, the memory tool defaults to the project file, and workers cannot write project memory. |
| 2026-09-04 | Tool-surface stability permits explicit reload/provider transitions without cache-hit promises; root defaults add runtime_update and webfetch without raising schema ceilings. Long-session profiles require exact successful work, isolate summary responses, and verify accepted worker completions without relaxing performance thresholds. |
| 2026-09-06 | Worker `grep`/`find`/`ls` on a bash-only parent surface normalize onto `bash`; real uninherited siblings still refuse. |
| 2026-09-06 | Invented `sN-<slug>` task-step selectors normalize onto `step-N` when that id exists; trailing numeric fragments still refuse. |
| 2026-09-06 | A worker turn is capped by the model's own output limit, never the 2048-token lane summary cap; a length stop before the claim envelope closes is `output_truncated`, not invalid JSON. |
| 2026-09-06 | The output-repetition guard collapses ordered-list markers before comparing windows; an enumerated loop is a loop. |
| 2026-09-06 | `task_steps update` with no field to change refuses and names the accepted fields; a no-op is never "recorded". |
| 2026-09-08 | A `readOnly` worker grant keeps the capabilities that survive the read-only rule owned by the tool capability policy (local reads, skill reads, memory query, settings read, process execution). A `readOnly` start that names an excluded direct write tool is refused before a lane exists and says which tools to drop; `profile_inspect` prints what `readOnly` keeps and drops; a capability-missing skip explains itself. The `read` tool returns a bounded, directories-first listing for a directory path instead of `EISDIR`, so a read-only worker can enumerate a tree. |
| 2026-09-08 | A validation bounce on a well-typed value names the violated constraint and the received measure (`task: maxLength must not have more than 3500 characters (received 3610 characters)`), never "expected string, received string". A delegate start whose brief arrives in the shared-schema `task` field is folded onto `instructions` before schema validation, so the 16k start cap applies; `profile_create` keeps its own cap and a start carrying both fields is still a runtime conflict. |
| 2026-09-08 | The summary output budget grows with the conversation it must cover (one output token per forty input tokens, never below the gate demand, never above 80% of the reserve); a length-stopped checkpoint retries chunked with a halved recent window and a doubled budget instead of repeating the same request; a deterministic checkpoint tells the model the narrative was lost and the host emits a warning naming the cause; a metered model with a price tier below the default trigger compacts before crossing it, while an explicit owner trigger and the xAI subscription policy keep their own values. |
| 2026-09-08 | A goal continuation turn that ends in a provider error (after the session's own retries) blocks the goal with the classified reason and stops the loop with `turn_errored`; the blocked decision names that reason. An owner abort still leaves the goal active and untouched. A silently active goal after an outage was the failure this replaces. |
| 2026-09-08 | A bounded harness guard (stagnant cycle, runaway loop) resumes the goal automatically once per signature; the same signature stopping the run again leaves the goal blocked with that reason until the owner prompts, and the warning says so. The Windows shell engine's `sed` supports addresses, `-n`, `-e`, `-E`, `p`, `d`, and `s///`; Git-Bash `/c/…` and WSL `/mnt/c/…` drive roots are rewritten to `C:/…` in the router and the engine; a worker timeout names its wall-clock cap and the setting behind it; binding a task directory with the workspace's own absolute path is accepted. |
| 2026-09-08 | Windows shell parity: with the engine on, every bash call runs on the shell engine (the PowerShell floor serves only `windowsShell.pythonEngine: false` and a runtime outage); coreutils names dispatch to Git for Windows' real GNU binaries before any engine reimplementation, with the GNU directory first on those tools' own PATH; the engine grammar covers functions, `case`, `[[ ]]`, brace expansion, the bash parameter operators, `set -e/-u/-x/-o pipefail` and `command -v`, and names arrays, indirection, `select` and process substitution as refusals. The regression wall `test/windows-shell-corpus.test.ts` replays every sanitized command shape of the measured Windows sessions (`test/fixtures/windows-shell-corpus/commands.json`) through the router, the grammar and the executor with real GNU tools on Linux and Windows; its refusal budget for supported families is zero, a live Windows shell failure is added there as its failing shape before its fix lands, and the replay leg carries a timeout matching its own single-process spawn bound (vitest's 30 s default cut a defect-free 25 s replay off under a parallel suite run). The corpus is produced and replayed by one harness-owned tool (`pi-shell-engine/corpus.py`, driven by `scripts/windows-shell-corpus.mjs`): harvest sanitizes every `bash` call of any session transcript with a hard leak guard and records the real command's grammar verdict, replay classifies defects, and the wall test consumes the same replay, so the fixture is reproducible from transcripts on any machine and never carries a private command. |
| 2026-09-12 | Toolkit script authority is a host-owned edge class (`toolkit.script`) with cryptographic scope keys derived from `(cwd, scriptPath, runner, scriptName, argv)`; grants persist across compaction and reload, mutating script registration invalidates the grant, and owner authorization is reused without model confirmation prompts. Goal continuation bounded recovery rearms transient provider failures once per streak or waits on in-flight work, resetting failure streaks only on verified host completion with matching pre-state turn ordinals. Runaway signatures live in one bounded durable collection (once per signature, A,B,A stays blocked, full collection refuses, owner prompt resets) — this restates the 2026-09-08 row, it does not weaken it. The keyword `risk_assessment` gate is removed in favour of the structural envelope and the literal edge classes; `run_toolkit_script` drops its model `confirm` flag for the host authorizer; the core prompt renders standing owner authorization exactly once per capability class and keeps deterministic long-checkout headroom under the unchanged 3,300-byte and 4,096-character budgets. The runaway/stagnant guard identity stored by the consumed-signature collection names the guard and the signature only; the repeat count stays in the `runaway_stop` record and the warning, so a loop that trips at a different threshold is still the same loop. |
| 2026-09-12 | Tool surfaces aggregate ceiling recalibrates from 4,850 to 5,570 tokens (4,500 base + 350 task_directory + 720 task_automation) for deterministic task automation (681 measured, 720 ceiling), with feature deltas for versioned skill inspection/repair/exclusion (150 measured, 160 ceiling) and narrow toolkit grant selectors (295 measured, 305 ceiling). Core tools measure 4,218 tokens under the unchanged 4,500 base. |
| 2026-09-22 | Noul answers carry `(probabilityTrue, direction, band)` and no derived boolean; `settledBoolean` refuses to answer an ambiguous band, a checkpoint whose only problem is doubt routes to `gather_more`, and the 0.5 cutoff is removed from every gate (tool gate, worker supervision, project rules, acquisition, dedup, clarification, capability resolution). The Decision graph names open doubts and holds the goal open on them. The empty-turn placeholder appears only when the turn produced nothing readable. Worktree-discarding git (`reset --hard`, `clean -f`, `checkout --`, `restore`, `stash`) is a conditional `destructive.fs` operation, resolved per call against the live tree and the session's mutation ledger, and stays ordinary work when the session owns everything dirty. Typed delivery certifies per path instead of vetoing a tree that was already dirty at admission. The user-request classification asks only the questions that can still change something, reports an unavailable System One as `unavailable` rather than as silence, and shares its rule-text budget across every rule instead of truncating the tail. |
| 2026-09-23 | The legend delta is read from the legend records in the history a request plans from, not from a process-local memory of commits: a restarted process no longer re-sends the whole legend, and a history whose record was compacted away gets its lines again. |
| 2026-09-23 | Context GC rewrites the already-sent prefix only as a priced cache break: a crossing's below-mark batch (deep supersessions included) packs when its saving over the learned remaining requests pays for the re-prefill, and stays as sent otherwise. `contextGc.deepPackMinTokens` is removed; the price replaces its fixed floor. |
| 2026-09-23 | A cache break passes the custody gate or is recorded as a defect: every foreground and worker request is classified (append, first, sanctioned, unsanctioned) into the decision ledger; an extension system prompt and the prompt's date wait for a cold moment; a lane keeps its sent reasoning level against host adjustments while warm. |
| 2026-09-24 | Every agent runs the conversation mechanics within its boundaries; only the head orchestrates. Workers plan requests with root's request-context controller, price early compaction and GC on their own lane's facts, summarize on their own warm lane, and share root's tool mechanics and learning stores; a quota-exhausted routed worker moves to its next account. |
| 2026-09-24 | A conversation keeps one talker and every other model reads a brief; a side trip's brief says the earlier conversation is not shown and the side trip can hand its message back to the talker. |
| 2026-09-24 | No invariant moved: the path-alias contract test closes the runtimes it opens before removing their directories, since Windows cannot delete an open database. |
| 2026-09-24 | A side trip searches the conversation its brief omits (`conversation_history`) instead of handing its message back: the free side-trip model looked the conversation up 10 of 10 times and handed back 0 of 28. It keeps the whole tool surface, since reaching for a mutating tool is how work it cannot do reaches the talker. |
| 2026-09-24 | Path aliasing's scan cursor is the set of scanned message fingerprints, not the `last_scanned_timestamp` mark, so same-millisecond, replaced, branch-switched and pause-time messages are scanned once and scanned history is not rescanned; the contract test's persistence case counts fingerprints instead of reading the mark. |
| 2026-09-25 | A `readOnly` worker keeps `bash` but runs only commands that edit nothing that exists (new-file redirects allowed), loses interpreters and scripts, keeps this in YOLO, and defaults to the `explorer` role; worker supervision judges progress against the worker's role; a guarded worker's operation without the standing grant is judged and refused to the parent instead of skipped. |
| 2026-09-25 | Goal completion judges the outcome the goal promised: per-criterion outcome evidence, a requirement's check rerun by the harness, the repository diff and code-only questions only when the goal changed the repository. Completion bounds are measured on the real System One (`npm run eval:completion`, calibration and held-out sets): a defect fails above 0.50, an outcome holds at 0.70, the verdict must be `complete` at confidence 0.70. JEV-025/JEV-026 judge the same view through the same policy function. |
