# Telemetry and durable event storage

Pi keeps authoritative state separate from diagnostic telemetry. They do not share a schema or
retention policy:

| Data | Location | Contract |
|---|---|---|
| Install/update ping | `https://pi.dev/api/report-install` | Anonymous version ping only when enabled. `PI_TELEMETRY=0` or offline mode disables it. |
| Autonomy diagnostics | Active session JSONL as redacted `autonomy-telemetry` custom entries | Bounded payloads for routes, gates, worker lifecycle, evidence, and learning decisions. Local only. |
| Orchestration events | `<agentDir>/state/orchestration/<session>/events/*.json` | Lossless authoritative task/runtime history with ordinals and idempotency markers. Never rotated as telemetry. |
| Tool recovery | `<agentDir>/state/tool-recovery-events.jsonl` | Local bounded diagnostic log: 4 MiB high-water, 3 MiB rotation target, at most 5,000 retained records. |
| Failure corpus | `<agentDir>/state/failure-corpus.jsonl` | Local redacted replay evidence: 512 KiB high-water, 384 KiB rotation target, at most 1,000 retained records. |
| Learning observations | `<agentDir>/state/learning-observations.json` | Compact counters used by the learning gate, capped at 500 keys. |
| Worktree audit | `<git-common-dir>/pi-worktree-sync/events.jsonl` | Repository-local bounded coordination audit: 4 MiB high-water, 3 MiB rotation target, at most 10,000 retained records. |

The three bounded JSONL logs use one lock-safe append/rotation implementation. Rotation retains the
newest records to a low-water byte target so a log is not rewritten on every subsequent append.
The orchestration event store is intentionally separate because it is durable task truth used for
replay and resume, not expendable telemetry.
