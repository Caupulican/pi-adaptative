# Profiling long sessions

Where the harness's CPU goes on a long session, measured instead of guessed. Three instruments,
one reading method, and an on-demand GitHub workflow that runs all of them and publishes the
results. None of it gates a merge: it is a monitor the owner fires when they want to know where
to tackle next.

## What grows, and how it was found

Real session logs carry exact host-side markers: `request_snapshot` (host assembly finished, request
about to leave), `foreground_tool_start` and the `toolResult` message (one tool call's span). Measuring
those across the largest real sessions showed host pre-request time flat per request, while the goal
family grew with the session: in one 4,540-request session `get_goal` went 9ms -> 94ms, `task_steps`
51ms -> 430ms, `goal` 16ms -> 558ms, `delegate` 75ms -> 752ms, with `read`/`edit`/`memory` flat. That
isolated the growth to work that re-walks history per call (the goal journal reconstruction, the
session id space) and to fixed-but-heavy per-call work (the host state store's parse per read, an
`os.cpus()` call per read). The per-request assembly path was then profiled directly and found to
run its GC, path-alias and enforcement passes three times per request.

## Instruments

- **Host long-session profile** — `packages/coding-agent/test/profiling/host-long-session.profile.test.ts`.
  Drives a REAL `AgentSession` through the faux provider for N tool turns, records every tool call
  and every request's host assembly time from the session-log markers above, prints them by session
  decile, and writes a V8 `.cpuprofile`. Skipped unless opted in. `PI_PROFILE_SCENARIO` picks the
  mix: `goal` (default: task_steps, get_goal, update_goal, read -- what dominates real sessions),
  `tools` (bash, grep, read with large outputs, so the tool-output reducers run on every call),
  `delegate` (the goal mix plus one in-process worker delegation every 30 turns, reported as the
  `delegate-run` series). A load generator: its scripted mix may produce a few tool errors, which are
  reported, not asserted away -- they exercise the failure-ledger path the profile measures.
- **Agent-core per-turn profile** — `scripts/profile-coding-agent-turn.mjs`. The agent-core loop
  alone, against a stub stream, with turn durations by decile.
- **Startup profile** — `scripts/profile-coding-agent-node.mjs`.

## Running locally

```bash
# host long-session profile (from packages/coding-agent); --pool=forks so node:inspector is available
PI_PROFILE_LONG_SESSION=1 PI_PROFILE_TURNS=1500 PI_PROFILE_DIR=/tmp/pi-profile \
  npx vitest run test/profiling/host-long-session.profile.test.ts --pool=forks
# other mixes: PI_PROFILE_SCENARIO=tools (bash/grep/read) or PI_PROFILE_SCENARIO=delegate

# rank a profile by self time (the function burning CPU, not the one merely on the stack)
node scripts/analyze-cpuprofile.mjs /tmp/pi-profile/host-session.cpuprofile --top 40

# per-turn cost by session decile, with advisory growth and budget warnings
node scripts/report-long-session-growth.mjs /tmp/pi-profile/host-session-profile.txt
```

Or from the repo root: `npm run profile:long-session`, `npm run profile:analyze -- <file.cpuprofile>`,
`npm run profile:growth -- <host-session-profile.txt>`.

## Reading the results

- **Decile rows.** Each row is the median cost of one tenth of the run's calls, in order. Flat means
  no per-call cost grows with the session. Rising means something re-walks history. Compaction resets
  the transcript mid-run, so a row can rise, drop, and rise again; the growth report uses the peak as
  well as the last decile, against a warm baseline (deciles two to five) so JIT warm-up is not read as
  growth.
- **Platforms differ.** The first two-platform run put the same code at 5ms per request on Linux
  and 13ms on Windows: the difference was one journaled SQLite write per request that Linux absorbs
  and Windows charges for. Compare the two summaries before deciding where a cost lives.
- **Self time.** Sort by self time first. The top rows at 1,500 turns before the 2026-09-01 fixes were
  the request estimator re-measuring every message, `os.cpus()` per store read, the host state store
  re-parsing its file per read, and the GC/path-alias passes; then the tool-performance store's
  per-call durable write and `analyzeToolFailureContext` (now a session-scoped fold that resumes).
- **The delegate scenario found the task runtime.** With the goal path flat, the first two-platform
  run still showed one worker delegation growing from 83ms to 313ms across twenty of them on Linux:
  every read of the durable task runtime listed the orchestration events directory, validated the
  whole tail and deep-cloned the whole projection, about thirty times per delegation, which was 40%
  of that scenario's host CPU. The runtime now shares one frozen projection whose identity turns
  over per event, and a poll for new events is one existence check. What remains per request is
  work over the context messages, which compaction bounds: the GC plan, the path-alias render, the
  history fingerprint window, the token estimate.
- **Native frames need an owner.** `existsSync`, `writeFileUtf8` or `read` at the top of a Windows
  profile say nothing by themselves; `--owner <frame>` charges each to the nearest project frame
  above it, past Node's wrappers and the shared utilities. That is how the event store's per-poll
  cursor and baseline reads and the lock around content-addressed GC originals were found.
- **Tool spans on Windows are process creation.** In the tools mix, `grep` costs about 85ms per call
  on Windows against 10ms on Linux and `bash` 80ms against 50ms, flat by decile: that is spawning
  ripgrep or the shell, not harness bookkeeping. A rising row is the signal; a high flat row on one
  platform is a platform cost.
- **Thresholds are advisory.** The growth report warns above 2x growth and above 25ms per request /
  15ms per tool call at the warm baseline. Warnings annotate the workflow run; nothing fails.

## Pressure: memory, disk, CPU, processes

Alongside the timing report, the host long-session profile also samples `process.memoryUsage()`
and `process.resourceUsage()` at every turn boundary (each `toolResult` message finalizing --
the same unit the per-tool decile tables use), and counts child processes. It writes
`host-session-pressure.txt` (the decile table plus totals) and `host-session-pressure.json` (the
raw per-turn samples and per-spawn records) into the same `PI_PROFILE_DIR` as
`host-session-profile.txt`. Feed both files to the growth report to get one combined table:

```bash
node scripts/report-long-session-growth.mjs host-session-profile.txt host-session-pressure.txt
```

- **rssMB / heapMB** — median resident set size and V8 heap used across the turns in that decile
  (point-in-time values, not deltas). Flat means the process isn't retaining more per turn; a
  rising row across deciles (or the totals' peak far above the warm baseline) means something is
  holding onto memory as the session grows -- a history structure that never trims, a cache keyed
  by turn number, an ever-growing array of samples.
- **cpuMs/turn** — `userCPUTime + systemCPUTime` (from `resourceUsage()`, in microseconds)
  consumed since the previous decile boundary, divided by the number of turns in the decile. This
  is host CPU, not wall-clock time: a flat row alongside a rising wall-clock/tool-latency row in
  the timing report means the extra time is waiting (I/O, another process), not extra computation.
- **fsRead/turn, fsWrite/turn** — `resourceUsage()`'s `fsRead`/`fsWrite` (block I/O operation
  counts, not bytes) delta per turn. Usually near zero for the goal/delegate mixes, since their
  reads are small and stay in the page cache; a sustained non-zero value is real disk traffic per
  turn, worth chasing the same way a rising CPU row is.
- **ctxSw/turn** — voluntary plus involuntary context switches (`resourceUsage()`) per turn.
  Voluntary switches usually mean the turn blocked on I/O or another process; a rising involuntary
  count alongside rising CPU means more contention for the CPU itself (more concurrent work, not
  just more work).
- **spawns** — child processes created during that decile's turns, tagged by the turn that
  started them (see "How spawns are counted" below). Zero for the `goal` mix (task_steps,
  get_goal, update_goal, read never shell out). Non-zero for the `tools` mix, where `bash` and
  `grep` both spawn a process per call.
- **Totals** — peak rss/heap across the whole run (not just the decile medians, so a short-lived
  spike between turn boundaries wouldn't be averaged away), total CPU ms, total fsRead/fsWrite,
  total spawn count, and the top 5 spawned commands by basename. The growth report folds this
  totals line in verbatim under the rss/heapUsed growth table.
- **Growth vs. flat**, same method as the timing rows: warm baseline is the median of deciles two
  through five (JIT/cache warm-up in the first tenth is not growth), compared against the last
  decile and the peak decile; the growth report warns above 2x on either, advisory only, never a
  non-zero exit.
- **Post-GC heapUsed** — if the test process was started with `NODE_OPTIONS=--expose-gc`
  (`global.gc` available), one forced GC's resulting heapUsed is printed at the end of the
  pressure report -- a useful check for whether a rising heapMB decile is retained data or just
  uncollected garbage. Without `--expose-gc` the report says so plainly instead of guessing.
- **Spawn counts on Windows are the dominant tool cost.** As the "Tool spans on Windows are
  process creation" note above already shows for wall-clock time, the pressure report's spawn
  count explains *why*: every `bash`/`grep` call on Windows starts a shell or `ripgrep.exe`
  process, and process creation is far more expensive on Windows than on Linux. A high, flat
  spawn-per-decile row is a platform cost to budget for, not a regression; a *rising* spawn count
  across deciles (more processes per turn as the session grows) is a real bug.
- **How spawns are counted.** All of this project's own tool code imports `spawn`/`exec`/etc. as
  ESM named bindings resolved once when the module loads, so reassigning
  `child_process.spawn`/`exec`/`execFile`/`fork` from outside is a no-op for them (verified by
  experiment: a monkeypatched property is simply never seen by a caller already holding the
  original function). The profiler instead subscribes to Node's `diagnostics_channel`
  `"child_process"` channel, which fires from inside `node:child_process` itself whenever any of
  `spawn`/`exec`/`execFile`/`fork` creates a process, regardless of how the caller obtained its
  reference -- this is what actually counts the `bash`/`grep` spawns in the `tools` mix.
  `spawnSync`/`execFileSync` publish nothing on that channel (Node only instruments the async
  `ChildProcess` constructor), so those two are additionally wrapped by reassigning the module
  property; that still can't catch this project's own synchronous callers, but it does catch any
  CommonJS dependency that reaches them through a live `require("child_process").spawnSync(...)`
  property lookup.

## Heap: what the memory is made of

`PI_PROFILE_HEAP_SNAPSHOT=1` makes the host profiler write `host-session.heapsnapshot` at the end
of the run (after a `global.gc()` when Node was started with `--expose-gc`), and
`node scripts/analyze-heapsnapshot.mjs <file>` ranks it by self size: node type and constructor
first, then strings of 256 bytes or more grouped by shape (whitespace collapsed, digits replaced),
so a thousand copies of one kind of text read as one row. Self size answers "what is the memory
made of", which is the question a rising rss or heap column raises first. It found the profiler's
own 460 MB: the request events kept 120-character heads cut from each serialized prompt, and V8
keeps such a slice as a view onto its parent, so every event pinned a whole prompt. Snapshots are
tens of megabytes; they stay local and are not uploaded by the workflow.

## The Profile workflow

`.github/workflows/profile.yml`, `workflow_dispatch` only. Inputs: `host_turns` (default 1500),
`tools_turns` (400), `delegate_turns` (600) and `loop_turns` (600). It runs the three host scenarios
plus the agent-core and startup instruments on ubuntu-latest AND windows-latest as separate matrix
jobs, writes each platform's growth table and ranked self-time tables to the job
summary, and uploads every `.cpuprofile` and report as the `cpu-profiles-<os>-<run id>` artifact
(30 days). Fire it from the Actions tab whenever a baseline is wanted; compare summaries across
runs, and across the two platforms, to see the trend and where they diverge.

## Both platforms, always

Every change on this path is verified on Linux (WSL) and on the Windows checkout on the D: drive
before it is considered done: update that checkout, run the same targeted suites there, and run the
profiler at a short turn count. Filesystem metadata cost, lock behaviour and CPU accounting differ
enough between the two that a fix measured on one is only half measured.
