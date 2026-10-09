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

The root `memory` tool has two read-only history actions:

- `history_search` with `query` (and optional `maxResults`, default 5, at most 10; `includeAlternateBranches`) returns hits as `[handle] (timestamp, session, role, ...) snippet`, followed by the index coverage. Hits are untrusted evidence in a fenced boundary. The current session is included in an explicit search.
- `history_source` with `ref` (a handle) and optional `cursor` opens the exact text, 8 KiB per page, with a continuation hint for the next page and for the entry's next part.

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

A worker with `memory_read` gets query-only access. A result may cite `tx:` handles; the worker passes one back as `ref` to read that source, but only a handle an earlier `memory_read` of the same lane returned, in the same memory generation (otherwise `memory_source_forbidden`). Workers cannot write memory or read arbitrary history. See [Task worker presets](worker-profiles.md).

## Diagnostics

- `/memory history` shows the history recall state: availability (disabled, unavailable, loading, active), sessions and spans indexed and skipped, top skip and uncaptured reasons, truncation, the last indexing error with its time and detail, the latest retrieval (status, result count, source refs) and how many items the prompt block admitted.
- `context_audit` shows the same without error text or paths, plus each memory provider's retrieval status (`queried`, `blocked`, `failed` with the failure class).

`failed` and `blocked` stay distinct from a query that ran and found nothing.

## Summary hierarchy

An opt-in layer of durable summaries over captured history is controlled by `contextPolicy.memory.history.*`; see [Settings](settings.md#context-memory-okf-mode). Exact history recall above does not depend on it.
