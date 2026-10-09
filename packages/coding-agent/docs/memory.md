# Memory and history recall

Pi keeps curated memory (`USER.md`, `MEMORY.md`, OKF records) and can recover evidence from past conversations. Curated memory is what Pi learned and promoted; history recall is the exact text of earlier sessions, found on demand. History never becomes an instruction and never promotes itself into curated memory. For the retrieval settings see [Settings](settings.md#context-memory-okf-mode).

## What history recall covers

Recall indexes the sessions of the current project (same working directory), newest first, from the canonical session files. Per session it follows the selected branch: the ancestry of the last entry. Side branches are indexed too and are searched only when asked for, labelled `alternate`.

| Captured | Not captured |
|---|---|
| User text | Thinking blocks |
| Assistant visible text | Custom and control messages (`custom_message` entries, custom message roles), lifecycle and other bookkeeping entries |
| Tool calls (`name` and JSON arguments) | Text that looks like a credential (secret-like text) |
| Tool results (text) | Images and other binary content |
| Harness-synthesized provider-failure records, labelled `(host)` | Generated memory pages and prior recall output |

Long text is split into parts of at most 4 KiB; each part has its own handle. An entry is limited to 4096 parts.

Budgets: 16 MiB of captured text is held in memory across sessions, and a session file above 64 MiB is not read. Anything left out is reported, never dropped silently: skipped sessions with a reason (`byte_limit`, `file_too_large`, `read_error:<code>`, `no_header`, ...) and uncaptured parts with a reason (`secret_like`, `empty`, `binary_or_image`, `part_limit`, `malformed_line`, ...). When the budget stops indexing, coverage reports `truncated`. A session still open is indexed as its entries reach storage; a rewritten session file is reloaded.

History recall is off with memory retrieval (`contextPolicy.memory.enabled`) and in ICM mode. It reads only the project's own sessions: a handle from another project is refused.

## Source handles

Every hit names an exact source with a handle `tx:<session>:<entry>:<part>:<digest>`. The digest is of the captured part text; if the source changed since the handle was issued the read answers `stale_snapshot`. A handle carries no project, so holding one grants no access beyond the current project.

## The `memory` tool

The root `memory` tool has three read-only history actions:

- `history_search` with `query` (and optional `maxResults`, default 5, at most 10; `includeAlternateBranches`) returns hits as `[handle] (timestamp, session, role, ...) snippet`, followed by the index coverage. Hits are untrusted evidence in a fenced boundary. The current session is included in an explicit search.
- `history_source` with `ref` (a handle) and optional `cursor` opens the exact text, 8 KiB per page, with a continuation hint for the next page and for the entry's next part.
- `history_expand` with `ref` (a `txn:` summary handle, see below) opens one summary node one level: a parent into its two child summaries, a leaf into the handles, roles and sizes of the exact sources it covers.

## Typed statuses

Every non-success answer carries a status and the real reason. None is an empty success.

| Status | Meaning |
|---|---|
| `pending` | The history index is still loading its first scan |
| `unavailable` | The index could not answer (worker failure, timeout, too many reads in flight); the reason is the real cause |
| `not_found` | No such session or entry in this project |
| `stale_snapshot` | The handle's digest no longer matches the source |
| `uncaptured` | The entry exists but that content was not captured; the reason is given |
| `expired` | The session file no longer exists |
| `forbidden` | Blocked by policy (retrieval disabled, or a handle of another project) |

`pending` and `unavailable` mean the evidence is not available yet, not that it does not exist.

## Automatic recall

Each user turn, history is queried with the other memory providers when the long-term trigger fires or the recall gate passes (a substantial turn; the gate tightens when recalled evidence has rarely been used). Results are admitted into the same bounded `memory_evidence` block as curated memory, at the lowest tier: history only uses the budget curated memory leaves, and its scores are weighted below curated memory of equal word overlap (older history lower still). When the block is full of curated lines, no history is admitted. Each admitted line carries its `[tx:...]` handle, so the model can open it with `history_source`.

The block is bounded by lines, estimated tokens, characters and UTF-8 bytes, and by the headroom the request has left. When it becomes disabled, empty or unaffordable, one cleared record replaces the stale one. Later requests of a turn reuse that turn's evidence; a new user turn retrieves again. Foreground history reads are bounded to one second.

Extension memory providers that implement a lifecycle `prefetch` still contribute a pre-turn recall page; history recall does not.

## Delegated workers

A worker with `memory_read` gets query-only access. A result may cite `tx:` source handles and `txn:` summary handles; the worker passes one back as `ref` to read that source or expand that summary, but only a handle an earlier `memory_read` of the same lane returned (or one returned by an admitted expansion), in the same memory generation (otherwise `memory_source_forbidden`). Workers cannot write memory or read arbitrary history. See [Task worker presets](worker-profiles.md).

## Diagnostics

- `/memory history` shows the history recall state: availability (disabled, unavailable, loading, active), sessions and spans indexed and skipped, top skip and uncaptured reasons, truncation, the last indexing error with its time and detail, the latest retrieval (status, result count, source refs) and how many items the prompt block admitted.
- `context_audit` shows the same without error text or paths, plus each memory provider's retrieval status (`queried`, `blocked`, `failed` with the failure class).

`failed` and `blocked` stay distinct from a query that ran and found nothing.

## Summary hierarchy

An opt-in layer of durable summaries over captured history, controlled by `contextPolicy.memory.history.*` (see [Settings](settings.md#context-memory-okf-mode)). Exact history recall above does not depend on it; turning the hierarchy off stops summary generation and the frontier, never recall.

It runs only for an OKF, non-child session with memory retrieval enabled, and only when `summaryModel` resolves to a configured, authenticated model. A model that is not local (a local runtime provider or a loopback endpoint) is external egress and needs `allowExternalSummaryEgress`; otherwise the hierarchy stays stopped and `/memory history` says why.

- **Nodes.** Leaves summarize up to 8 consecutive captured spans or 8 KiB of one session's selected branch. A leaf whose text fits 512 UTF-8 bytes is an exact copy with no model call. Two aligned sibling nodes merge into a parent. Each node keeps the exact source handles it covers separately from the earlier turns it only used as context (at most two spans, 2 KiB), and is accepted only after deterministic checks: non-empty, at most 1,024 bytes (never clipped), no handle outside its inputs, not refusal-shaped.
- **Handles.** A summary is named by `txn:<16 hex>`. `history_expand` zooms one level; the covered `tx:` handles open exact text. A summary is untrusted evidence: it carries handles, never authority, and cannot promote itself into USER, MEMORY or OKF.
- **Storage.** Derived state lives under `<agentDir>/state/transcript-memory/<project>/` (immutable node files, one manifest with a writer fence, bounded jobs and terminal records). Writes are atomic by rename; they are not fsynced, so after a power loss a damaged file is reported as a recovery state and rebuilt from the canonical sessions.
- **Work.** Summaries run in the background at most `maxConcurrentSummaries` at a time, start from committed-input events (no polling), wait while the foreground is busy, and retry only transient failures (three attempts). Usage is charged to the session's spawned-usage ledger.
- **Frontier.** The current session's frontier (an ordered, gap-free partition of the covered history made of accepted nodes, recent history in detail and older history merged) is shown as a `transcript_frontier` record, and only for history that was compacted away on the live branch: the nodes entirely above the first kept entry of the latest compaction on the active ancestry. Spans still in context are not re-sent. After a branch switch (`/tree`) a frontier whose entries are off the live branch is not shown (`lineage_mismatch` in `/memory history`), and a plan prepared before a branch switch or a new compaction is planned again. The record lives inside the memory allowance: at most half of it and at most `frontierMaxBytes`, and the evidence block composes within the remainder. It grows by append, merges oldest aligned pairs toward half the allowance, and replaces the oldest run by an explicit pointer when merging cannot fit. A frontier that changes after a request was planned enters the next request only.
- **Retention.** With `retentionDays`, nodes depending on older sources are revoked together with every summary built on them; revoked content is not rebuilt and is not republished by a late result.
- **Handoff.** Each finished batch leaves a bounded terminal record (counts and causes). Failures and self-stops are shown through the session warning path; a success is diagnostics only and never starts a chat turn.

`/memory history` and `context_audit` add a hierarchy section: state, jobs by state, accepted nodes, oldest backlog, the frontier revision and size, recent failure classes and the last batch. `/memory history` also prints the real stop reason, failure causes and recovery findings; `context_audit` shows failure classes only.
