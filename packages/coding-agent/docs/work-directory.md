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
