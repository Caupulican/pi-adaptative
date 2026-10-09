# Memory and history recall

Pi keeps curated memory (`USER.md`, `MEMORY.md`, OKF records) and can recover evidence from past conversations. Curated memory is what Pi learned and promoted; history recall is the exact text of earlier sessions, found on demand. History never becomes an instruction and never promotes itself into curated memory. For the retrieval settings see [Settings](settings.md#context-memory-okf-mode).

## What history recall covers

Recall indexes the sessions of the current project (same working directory), newest first, from the canonical session files in the current session directory and the legacy default directory. Per session it follows the selected branch: the ancestry of the last entry. Side branches are indexed too and are searched only when asked for, labelled `alternate`.

| Captured | Not captured |
|---|---|
| User text | Thinking blocks |
| Assistant visible text | Custom and control messages (`custom_message` entries, custom message roles), lifecycle and other bookkeeping entries |
| Tool calls (`name` and JSON arguments) | Text that looks like a credential (secret-like text) |
| Tool results (text) | Images and other binary content |
| Harness-synthesized provider-failure records, labelled `(host)` | Generated memory pages and prior recall output |

Long text is split into parts of at most 4 KiB; each part has its own handle. An entry is limited to 4096 parts.

Budgets: 16 MiB of captured text is held in memory across sessions, and a session file above 64 MiB is not read. Anything left out is reported, never dropped silently: skipped sessions with a reason (`byte_limit`, `file_too_large`, `read_error:<code>`, `no_header`, ...) and uncaptured parts with a reason (`secret_like`, `empty`, `binary_or_image`, `part_limit`, `malformed_line`, ...). When the budget stops indexing, coverage reports `truncated`. A session still open is indexed as its entries reach storage; a rewritten session file is reloaded.

Coverage counts sessions by identity. Each project session with a readable identity is exactly one of: indexed; unsupported, meaning its format cannot carry stable handles (a pre-id v1 file, which becomes capturable once opening it migrates and rewrites the file, or a session id that cannot be resolved); or skipped for a stated reason. Two files that claim one session id with different contents make that identity ambiguous (`ambiguous_session_identity`), and nothing of that session is indexed, because a handle could resolve to either copy. A byte-identical copy in both directories is one session. Files with no readable identity are skipped (`no_header` and the like); files of other working directories and auto-learn sessions are not eligible. Coverage is not a claim that every session is indexed: `/memory history` gives the eligible, indexed, unsupported and skipped counts.

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

A `memory_read` result is sized against the receiving lane, never the root model. The lane's own model window, its last accepted request (system prompt, tool schemas and messages), the reply room it keeps free and the tokens its grant and tree still allow are measured from the lane itself. A lane that has sent no request, or whose model declares no window, has unknown capacity. After the wrapper, status and omission lines, standing memory takes at most half of what remains, and the history frontier at most half of what is left after that. Open Knowledge Format documents, extension recall and history hits then compete for the rest. Each is admitted as a whole source-labelled record, so a `tx:` or `txn:` handle is never cut. An Open Knowledge Format document that does not fit appears as its title and summary only, and the omission is stated. When capacity is unknown or exhausted the result says `Memory is constrained`, gives the reason, and attaches no memory. A frontier in a lane snapshot names `memory_read` rather than the history tools. Each lane attempt builds its own memory port, so a retry queries again and holds only the handles its own new reads return.

## Diagnostics

- `/memory history` shows the history recall state: availability (disabled, unavailable, loading, active), sessions and spans indexed and skipped, top skip and uncaptured reasons, truncation, the last indexing error with its time and detail, the latest retrieval (status, result count, source refs) and how many items the prompt block admitted.
- `context_audit` shows the same without error text or paths, plus each memory provider's retrieval status (`queried`, `blocked`, `failed` with the failure class).
- History transport. A failed post to the index worker, or a reply outside the protocol, ends that worker once with its cause; reads then answer `unavailable` with that cause until the memory generation restarts the worker. A read that exceeds its bound (one second for queries and source reads, 30 seconds for session and lineage listings) answers `unavailable` and is counted. A stopped worker (`stoppedAt`) and a slow one (`readTimeouts`) are reported separately. In coverage, `lastError` is historical; `activeFailures` counts the sources failing now, and when it is zero the error is labelled historical.

`failed` and `blocked` stay distinct from a query that ran and found nothing.

## Summary hierarchy

An opt-in layer of durable summaries over captured history, controlled by `contextPolicy.memory.history.*` (see [Settings](settings.md#context-memory-okf-mode)). Exact history recall above does not depend on it; turning the hierarchy off stops summary generation and the frontier, never recall.

It runs only for an OKF, non-child session with memory retrieval enabled, and only when `summaryModel` resolves to a configured, authenticated model. A model that is not local (a local runtime provider or a loopback endpoint) is external egress and needs `allowExternalSummaryEgress`; otherwise the hierarchy stays stopped and `/memory history` says why.

- **Nodes.** Leaves summarize up to 8 consecutive captured spans or 8 KiB of one session's selected branch. A leaf whose text fits 512 UTF-8 bytes is an exact copy with no model call. Two aligned sibling nodes merge into a parent. Each node keeps the exact source handles it covers separately from the earlier turns it only used as context (at most two spans, 2 KiB), and is accepted only after deterministic checks: non-empty, at most 1,024 bytes (never clipped), no handle outside its inputs, not refusal-shaped.
- **Admission.** The deterministic checks prove shape, not fidelity, so a model summary is accepted only after a second gate. Exact copies are never judged. System One, the session's recording semantic engine, judges the exact input the summary covers, with the earlier context kept apart (it only resolves references). Each judgment is a separate yes/no question:
  - `support` (always): every statement is supported by the input.
  - `constraints` (when the input has an owner entry or an earlier summary): owner corrections and constraints are stated with their force intact.
  - `status` (when it has tool traffic, a host-written record or an earlier summary): failed, pending and completed steps are reported as the input shows them.

  A judgment passes only as a decisive yes: P(holds) of at least 0.90, and in the engine's hard-pass band (0.93 by default, which binds). A decisive no (P at or below 0.20) ends the job `failed` as `admission_rejected`; any other answer ends it as `admission_uncertain`. Neither is sampled again. An evaluator that did not answer (outage, timeout, unparseable answer) is transient: the job retries within its attempts, and its validated reply is kept on the job, so the summarizer is not paid again. The kept reply is reused across restarts while its input and recipe still match and it still passes the deterministic checks. An evaluator that refuses the exact input (a credential in it, or more than 128 KiB, never truncated) is terminal. Usage is charged to the session's System One receipts and shows as `summary admission` on the semantic ledger.

  A model summary is **held** before any model call, with the cause shown and the attempt returned, while exact copies keep flowing. Held when the summarizer is missing or its egress is not allowed; when `allowExternalAdmissionEgress` is off (see [Settings](settings.md#context-memory-okf-mode)); when System One is not bound; when its evaluator does not report calibrated probabilities; or, for a parent, when a child summary is not approved yet (a parent is judged only after both children are approved). Before anything is published, source coverage, child approval, policy and the writer fence are rechecked; an egress setting withdrawn after judgment discards the admitted text. The node records its admission: contract version, judged questions, confidences, evaluator, and a digest of the admitted text. The store refuses to publish a model summary without a current admission.

  Pre-contract nodes (accepted before the contract, or under an older one) are not approved: they are out of the frontier, and `history_expand` returns the exact `tx:` handles of their sources instead of their text. Each is judged again from its own text against freshly re-read sources, with no summarizer call. Admitted: the record is added and the node becomes approved. Rejected or uncertain: the node is revoked and derived again through the normal pipeline, where a second rejection ends that job. Unavailable: it stays unapproved and is retried on a 5-minute wake. `/memory history` shows held jobs with their cause, judgment counts, and unapproved nodes counted by what each waits for (for example `child_not_approved` or `evaluator_unavailable`).
- **Handles.** A summary is named by `txn:<16 hex>`. `history_expand` zooms one level; the covered `tx:` handles open exact text. A summary is untrusted evidence: it carries handles, never authority, and cannot promote itself into USER, MEMORY or OKF.
- **Storage.** Derived state lives under `<agentDir>/state/transcript-memory/<project>/` (immutable node files, one manifest with a writer fence, bounded jobs and terminal records, retention anchors and spent-attempt records). Writes are atomic by rename and are never fsynced. A process crash leaves the old file or the new one, never a torn one; power-loss durability is not established, so after one a file can be missing or empty. Every file is verified on load. A damaged file is kept beside the store as `*.corrupt.<time>`, reported as a recovery issue, and its derived content is rebuilt from the canonical sessions.
- **Work.** Summaries run in the background at most `maxConcurrentSummaries` at a time, start from committed-input events (no polling), wait while the foreground is busy, and retry only transient failures (three attempts). Usage is charged to the session's spawned-usage ledger.
- **Frontier.** The current session's frontier (an ordered, gap-free partition of the covered history made of accepted nodes, recent history in detail and older history merged) is shown as a `transcript_frontier` record, and only for history that was compacted away on the live branch. What the live context still shows after the latest compaction (the kept tail, the original user message and restored gap entries under `original-user` retention, carried-forward records) is read from the session's retention owner and is not re-sent. A node that also covers visible spans is expanded to its two children; a leaf that mixes both is withheld and replaced by a pointer that keeps its compacted-away source handles reachable. The persisted frontier is never changed by this view. After a branch switch (`/tree`) a frontier whose entries are off the live branch is not shown (`lineage_mismatch` in `/memory history`), and a plan prepared before a branch switch or a new compaction is planned again. The record lives inside the memory allowance: at most half of it, in bytes and in estimated tokens, and at most `frontierMaxBytes`, and the evidence block composes within the remainder. It grows by append, merges oldest aligned pairs toward half the allowance, and replaces the oldest run by an explicit pointer when merging cannot fit. A frontier that changes after a request was planned enters the next request only.
- **Retention.** `retentionDays` ages out derived summaries only. It never erases or hides a canonical transcript and never limits exact history search or source reads. A source's age is its entry's event time; without one, the canonical session timestamp; without one, the moment it was first captured (`event_time_unknown` in `/memory history`). That anchor is persisted per source, so invalidation and rebuilds never reset it, and up to 20,000 anchors are kept; past that, the affected work is held and reported. A node that depends on a source past the window is revoked with every ancestor and frontier built on it. Expiry is enforced when a summary is read, when it is expanded, and before a late result is published; the frontier is withheld while it names an expired node. A source with no age yet does not feed a new summary. One lifecycle wake covers the earlier of the next retry and the next expiry, and a restart recomputes it from persisted state. A job whose attempts are spent ends `failed` with `attempts_exhausted`, and identical work found again gets no fresh budget. Spent-attempt records are kept for pruned failed jobs, up to 20,000; past that the job is pruned unrecorded and counted.
- **Reconciliation.** Revoked nodes are derived again after an invalidation (a source changed) or after an admission verdict of `rejected` or `uncertain` on that node. A retention or forgetting revocation is permanent: its identity is never admitted again, and a late result for it is refused. A parent whose two children survive is derived again from them, and until it is published its range is covered at child level. `/memory history` reports how many parents are being derived again.
- **Handoff.** Each finished batch leaves a bounded terminal record (counts and causes). Failures and self-stops are shown through the session warning path; a success is diagnostics only and never starts a chat turn.

`/memory history` and `context_audit` add a hierarchy section: state, jobs by state, accepted nodes, oldest backlog, the frontier revision and size, recent failure classes and the last batch. `/memory history` also prints the real stop reason, failure causes and recovery findings; `context_audit` shows failure classes only.
