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

Harness internals and programmatic SDK integrations can use the low-level public helpers:

```ts
import { acquireWorkRun, getProcessWorkRun, pruneWorkTenant } from "@caupulican/pi-adaptative";
```

- `acquireWorkRun(...)` returns a unique or named leased run. Call `release()` when the operation ends.
- `getProcessWorkRun(...)` reuses one leased run for process-scoped output.
- `pruneWorkTenant(...)` applies bounded retention to one category and tenant.

Use a named run only for transient coordination that must be shared across Pi processes. Use a generated run for commands, reports, downloads, tests, benchmarks, probes, and output spills.

Packaged extensions should use `pi.getStorage("extension-name").acquireWorkRun()` instead. It binds work to one extension namespace, releases leases automatically on failure/unload, and clamps extension-selected retention to the harness ceiling. Calling `getStorage()` alone creates no directories. Durable extension state and rebuildable extension cache similarly live under `state/extensions/<namespace>/` and `cache/extensions/<namespace>/`; see [extensions.md](extensions.md#pigetstoragenamespace).

## Not transient

Configuration and durable user data stay outside `work/`: `settings.json`, `auth.json`, `models.json`, `sessions/`, `state/`, `skills/`, `extensions/`, `prompts/`, `themes/`, profiles, backups, and managed binaries. Directory overlays are contained under `profiles/directories/`; explicit configuration snapshots are contained under `state/backups/config/`.

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
  okf-memory/                                                                          authored/indexed memory (root)
    user-preferences/index.okf.md                                                       USER.md overflow index
    user-preferences/user-preferences-<digest>.okf.md                                  bounded preference shards
  skills/ extensions/ prompts/ themes/ profiles/                                       user resources (root)
    profiles/directories/<workspace-hash>/settings.json                                directory overlays
  state/     durable machine state: model adaptation/fitness, tool-performance,        -- stateDir/stateFile
             learning observations, trust decisions, failure corpus, config backups, …
    state/backups/config/                                                              explicit config snapshots
    state/extensions/<namespace>/                                                      extension durable state
  cache/     rebuildable, safe to delete: tool-path probes, jiti transform cache, uv    -- cacheDir/cacheFile
    cache/extensions/<namespace>/                                                      extension rebuildable cache
  bin/       managed executable helpers (fd, rg, jq, uv)                               -- binDir (legacy getBinDir accessor)
  work/      transient/scratch (this document)                                         -- re-exported from agent-paths.ts
    work/extensions/<namespace>/<run-id>/                                              extension leased work
  runtimes/<kind>  models/<kind>  sessions/  npm/  git/  worktrees/                    -- runtimesDir/modelsDir/sessionsDir/npmDir/gitDir/worktreesDir
```

`state/` holds durable history — deleting it loses real data, not just cache. `cache/` is always safe
to delete; the next run re-probes or recomputes it. A startup migration (`migrateAgentDirLayout`,
`src/migrations.ts`, run before any store/trust read) relocates confirmed root-level stragglers into
their canonical locations: `trust.json` into `state/`, `backups/` into `state/backups/config/`, and
`resource-profiles/` into `profiles/directories/`. Obsolete root `auto-learn/` and `tmp/` trees are
preserved under `state/legacy-layout/`, where they cannot compete with live config/resources. Whole
roots move atomically when possible; literal Windows `auth.json:Zone.Identifier` sidecars move there
too. Partial migrations scan a bounded number of top-level entries and preserve collisions under
`state/migration-conflicts/` instead of overwriting either copy.

`USER.md` is the bounded hot profile shown in the static prompt. When a memory-tool mutation would
exceed that budget, Pi moves the complete profile into deterministic OKF shards, replaces `USER.md`
with a small link to the generated index, and keeps future replace/remove operations working across
those shards. The shards are written before the pointer, so retrying an interrupted migration reuses
the same identities instead of losing or duplicating facts.

The `memory` tool's `list` action reads the current general, project, and user files under their
respective locks. It reports current, committed managed, pending-write, and session prompt-snapshot
digests separately. Listing never accepts external edits, finalizes a pending write, or refreshes the
prompt snapshot. A recognized peer write can differ from the session snapshot without being drift.

Mutations refuse unrecognized revisions and return an error receipt with recovery guidance. Each
distinct refused revision is preserved beside its memory file as `.bak.sha256-<digest>`; identical
retries reuse that backup. Existing timestamped backups and distinct revisions remain available for
owner review. The owner must preserve and review external edits, then restore exact managed bytes
before retrying. There is currently no owner command for accepting an external revision; editing
managed-state metadata is not a reconciliation workflow.

General and project hot memory enforce limits of 1,200 and 2,200 characters. A file already above
its limit can be repaired incrementally: each accepted operation must strictly reduce its size until
it fits. Successful partial repairs report that the file is still over budget. Move facts to their
appropriate project or structured OKF destination before removing them from general memory.

`pi doctor` performs a bounded, read-only scan of the agent directory root. It stays silent for the canonical config, memory, resource, and storage entries above and warns about external or legacy root writers. The audit never relocates or deletes unknown data.
