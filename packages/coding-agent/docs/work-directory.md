# Transient work directory

Pi-owned transient files live under one multi-tenant root:

```text
~/.pi/agent/work/<category>/<tenant>/<run-id>/
```

`PI_ADAPTATIVE_CODING_AGENT_DIR` still relocates the whole agent directory. Pi exposes the resolved work root to child processes as `PI_WORK_ROOT`.

## Contract

- `category`, `tenant`, and `run-id` are lowercase portable path segments, at most 64 characters.
- Windows-reserved names, traversal, separators, trailing dots, and case-ambiguous uppercase names are rejected on every platform.
- Every owned run has `.pi-work-run.json` metadata.
- Active processes hold PID/host lease markers under `.leases/`.
- Cleanup never follows symlinks, never deletes directories without a matching ownership manifest, and rechecks leases under an exclusive cleanup marker before removal.
- Retention is bounded by age, run count, total bytes, scanned runs, recursive entries, and directory depth. An incomplete size scan is treated as over-budget instead of undercounted.
- Released work remains available for diagnostics until retention removes it. A caller that owns a one-shot run may release and delete it immediately.

The default per-tenant retention policy is 30 days, 64 inactive runs, 512 MiB, 10,000 scanned runs, and 100,000 recursively scanned entries. Active runs are never removed to satisfy those limits.

## Repository API

Extensions and internal code can use the public helpers:

```ts
import { acquireWorkRun, getProcessWorkRun, pruneWorkTenant } from "@caupulican/pi-adaptative";
```

- `acquireWorkRun(...)` returns a unique or named leased run. Call `release()` when the operation ends.
- `getProcessWorkRun(...)` reuses one leased run for process-scoped output.
- `pruneWorkTenant(...)` applies bounded retention to one category and tenant.

Use a named run only for transient coordination that must be shared across Pi processes. Use a generated run for commands, reports, downloads, tests, benchmarks, probes, and output spills.

## Not transient

Configuration and durable user data stay outside `work/`: `settings.json`, `auth.json`, `models.json`, `sessions/`, `state/`, `skills/`, `extensions/`, `prompts/`, `themes/`, profiles, backups, and managed binaries.

Do not put Automata memory or its graph in Pi's work directory. Automata remains an external memory system.

## Agent directory layout

`work/` is one wedge of the full canonical layout under `~/.pi/agent/` (`getAgentDir()`). Everything
machine-managed resolves through one typed path module, `src/core/agent-paths.ts` — every writer of
machine data (stores, caches, managed runtimes/models, cross-process coordination) goes through it
instead of hand-rolling `join(agentDir, …)`, so a new writer can't silently reintroduce a root-level
straggler:

```text
~/.pi/agent/
  auth.json settings.json models.json keybindings.json MEMORY.md USER.md SYSTEM.md …   user config/memory (root)
  skills/ extensions/ prompts/ themes/ profiles/                                       user resources (root)
  state/     durable machine state: model adaptation/fitness, tool-performance,        -- stateDir/stateFile
             learning observations, trust decisions (trust.json), failure corpus, …
  cache/     rebuildable, safe to delete: tool-path probes, jiti transform cache, uv    -- cacheDir/cacheFile
  bin/       managed executable helpers (fd, rg)                                       -- binDir (legacy getBinDir accessor)
  work/      transient/scratch (this document)                                         -- re-exported from agent-paths.ts
  runtimes/<kind>  models/<kind>  sessions/  npm/  git/  worktrees/                    -- runtimesDir/modelsDir/sessionsDir/npmDir/gitDir/worktreesDir
```

`state/` holds durable history — deleting it loses real data, not just cache. `cache/` is always safe
to delete; the next run re-probes or recomputes it. A startup migration (`migrateAgentDirLayout`,
`src/migrations.ts`, run before any store/trust read) relocates confirmed root-level stragglers into
their canonical location — currently just `trust.json` into `state/` — idempotently and without ever
overwriting an already-migrated target. `resource-profiles/` intentionally stays at the agent-directory
root rather than moving under `state/`: it's surfaced in two user-visible profile-menu description
strings, and moving it needs those updated in the same change (tracked open in the bug ledger, not a
silent gap).
