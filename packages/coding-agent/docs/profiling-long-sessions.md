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
  re-parsing its file per read, and the GC/path-alias passes; after them the profile is dominated by
  the tool-performance store's per-call durable write and `analyzeToolFailureContext`, which are the
  next targets.
- **Thresholds are advisory.** The growth report warns above 2x growth and above 25ms per request /
  15ms per tool call at the warm baseline. Warnings annotate the workflow run; nothing fails.

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
