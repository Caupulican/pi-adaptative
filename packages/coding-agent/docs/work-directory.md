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
- Retention applies best-effort age, run-count and byte limits within fixed scan and removal budgets. An incomplete size scan charges only counted bytes, a lower bound; only counted excess triggers byte eviction. Live leases, unreadable entries and exhausted budgets can leave tenants above the configured limits, so these limits are not an instant hard ceiling on total storage. The extension storage API clamps scan limits to at least one; the low-level prune API accepts zero for a diagnostic no-scan budget.
- Removal snapshots and validates at most 4 KiB of ownership metadata before deleting content. It withdraws ownership metadata before its cleanup fence, then removes the root non-recursively: concurrent new entries cause refusal and recovery rather than being deleted. Acquisition revalidates matching ownership and the exact newly written lease marker before returning; a cleaner restoring ownership cannot conceal a deleted lease. A recoverable removal failure restores exact ownership before releasing its cleanup fence. Incomplete recovery preserves removal and recovery causes and leaves a fail-closed fence; repair exact ownership metadata and the recovery fence before retrying. Acquisition rolls back its new lease if ownership or marker revalidation or pruning fails.
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
  memory/                                                                              project hot MEMORY.md + ICM bundles (root)
    projects/<project-key>/MEMORY.md                                                    per-project hot memory
  skills/ extensions/ prompts/ themes/ profiles/                                       user resources (root)
    profiles/directories/<workspace-hash>/settings.json                                directory overlays
  state/     durable machine state: model adaptation/fitness, tool-performance,        -- stateDir/stateFile
             learning observations, trust decisions, failure corpus, config backups, …
    state/backups/config/                                                              explicit config snapshots
    state/extensions/<namespace>/                                                      extension durable state
    state/orchestration/sessions/<session-key>/                                        one session's control-plane bundle (swept after 180 days, see below)
  cache/     rebuildable, safe to delete: tool-path probes, jiti transform cache, uv    -- cacheDir/cacheFile
    cache/extensions/<namespace>/                                                      extension rebuildable cache
  bin/       managed executable helpers (fd, rg, jq, uv)                               -- binDir (legacy getBinDir accessor)
  work/      transient/scratch (this document)                                         -- re-exported from agent-paths.ts
    work/extensions/<namespace>/<run-id>/                                              extension leased work
  runtimes/<kind>  models/<kind>  sessions/  npm/  git/  worktrees/                    -- runtimesDir/modelsDir/sessionsDir/npmDir/gitDir/worktreesDir
  channels/  channel tokens and per-channel journals (private to every lane)          -- channelsDir
  bots/<id>/ one bot's home: profile.json, sessions/, session.json, orchestration/ (private to every lane)  -- botHomeDir
  logs/      the harness's own log, logs/harness/harness-<date>.jsonl                  -- harnessLogDir
  collaboration/  the collaboration backend's managed config, herdr/config.toml        -- collaborationDir
```

### Session bundle retention

`state/orchestration/sessions/<session-key>/` holds one foreground session's worker transcripts, mailboxes, context forks, and event history. Once per main-session startup (never in a worker, never on a timer), `sweepSessionBundles` (`src/core/session-bundle-retention.ts`) removes bundles that have expired. The limits are constants beside the sweep, not settings: a bundle whose session transcript still exists is kept until both are older than 180 days (a paused session can be resumed with its persistent-worker context for that long), a bundle whose transcript is gone is not held by that rule, and no bundle with a file newer than 24 hours is touched. An interactive start runs the sweep in the background and never waits for it; its warnings reach the session as host warnings. Print, JSON and RPC modes await it, so an exit cannot cut a removal short. Each startup removes at most 8 bundles and stops starting new ones after 256 MiB; the remainder waits for the next startup.

A bundle is skipped, never forced, when a live or resumable process-matrix entry names its session, when `reserveWorkerBundleDeletion` refuses (live claim, busy or enrolled specialist context, unreadable transcript), or when a worker or session-root mailbox still owes work. Removal runs under the same deletion reservation as explicit session deletion and reopens worker admission for that session once the bundle is gone. Once the bundle is gone, and before the reservation settles, the session's fleet queue metadata in the same home goes too (`<stateDir>/fleet/queue/<session-id>.json` and its away controller's `<session-id>.away.json`): it only orders and stops attempts the bundle's ledger held. A failed or partial removal keeps the reservation and is retried at the next startup. Problems appear as bounded startup warnings and never stop startup.

An obligation older than 30 days (an undelivered message, a delivered request still awaiting its reply, a reply acknowledgement that never committed, a session-root reply nobody acknowledged) can never be answered, because the session that owed it is gone. After every other gate passes and before a bundle is refused for it, the sweep settles it as failed with the reason `obligation_expired`, through the mailbox's own state machine: it is never marked delivered, replied, or acknowledged, and a late reply to an expired request is refused. A bounded record (bundle, session id, agent id, message id, state, creation time, the first 160 characters) is appended to the obligation ledger of the bundle's orchestration home, `expired-obligations.jsonl` at its root (`state/orchestration/` for the owner's, `bots/<id>/orchestration/` for a bot's; a forced retire's and a dead-lettered reply's records go to the ledger of their mailbox's home the same way) (at most 1 MiB and 2,000 records per ledger, oldest dropped) inside the mailbox transaction before the mailbox is written, so an unwritable ledger settles nothing. The next startup warning names the count and the ledger. Settlement is all or nothing per bundle and is decided read-only before any write: when one obligation is younger than 30 days, or one cannot be settled (a project-bound or unreadable mailbox), nothing in the bundle is written and the bundle stays refused. A partial settlement would refresh the bundle's newest file time and postpone its removal by the full retention age. An I/O failure part-way through settling several mailboxes can still leave a bundle partly settled; the next sweep retries it. The settlement is not routed through the owner follow-up document: that document records decisions the owner can make for the current session, and an expired obligation is not one.

Each startup first resumes, in every orchestration home and ahead of the removal budgets, the reservations earlier startups left (no session can open a reserved bundle until its removal settles). It then scans every home's bundles as one list, the owner's first, starting at a different bundle each time (chosen from the clock, nothing is remembered), so bundles that stay refused cannot starve the ones behind them in any home; at most 1,024 bundles are inspected in all.

A bot's sessions keep their bundles in the bot's own home, `bots/<id>/orchestration/sessions/<session-key>/`, and the same sweep reaches every bot home, with the same gates; the 8-bundle and 256 MiB budgets and the 1,024-bundle inspection bound are shared by all homes. Two more sessions are held: a bot home's current session (the one `bots/<id>/session.json` records, or the newest session file when none is recorded) while the home exists, profile or not, and the session a live host of the bot holds (its `host.lock` held by a process not proven dead, the session named in `host-state.json`). Their bundles are not reserved, and the routine work of those sessions is never settled as gone; a bundle of theirs that an earlier sweep already reserved is resumed rather than kept, since no session can open a reserved bundle until its removal settles. Bundles of a bot's earlier sessions age out by the 180-day rule like the owner's. Retention removes bundles and the fleet queue metadata that goes with them only: a bot home, its session files and its project-specialist index are never removed by it. In a bot home whose current session, or whose live host's session, cannot be told, no new bundle is reserved and only the reservations an earlier sweep made are resumed; the home is named in a startup warning, and while a live host there may hold a session no id names, the routine work of the sessions whose files lie in its `sessions/` is not settled as gone. Each home's session files are listed on their own, within 100,000 names: a home whose files do not list is treated as one whose sessions cannot be told, and while it is so, no owner-home bundle whose session has no listed file is newly reserved (it may be that bot's). When the owner's own session files do not list, the owner's bundles are only resumed and the routine work of deleted sessions is not settled. Every deletion reservation in any home stays in place, with its operation recorded, from before the removal starts until it settles.

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
