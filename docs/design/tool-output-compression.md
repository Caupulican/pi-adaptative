# Tool-output compression and prompt caching

Reduce a tool result once, before its first model request. Reuse that representation on subsequent requests. The cost that matters is the total billed for a completed task, including later requests to recover detail.

## When the tool finishes

Bash and Python already apply deterministic reducers to supported output shapes. `repo_read` also runs Git output through the shared reducer. Keep the existing material-savings threshold and the per-call escape hatch on tools that support `fullOutput`. A model call to summarize each result would add latency and spend before there is evidence the summary will be reused.

Continuous chat records the producer's reported input bytes, output bytes and omitted lines. Python stdout and stderr have separate receipts. A recorded stream file belongs to the session that produced it and can expire. The receipt records its path once. A configured persistence policy alone cannot establish that a file was written.

## What goes into a request

- **Initial result.** The active turn uses the producer's bounded output and recovery notice. Subsequent requests can reuse the same bytes.
- **History summary.** A new tree leaf identifies reduced output and retains a bounded excerpt when needed. Known session-file paths in the excerpt use a stable label. Creating the leaf requires no filesystem availability check or model request.
- **Inspection.** A numeric `zoom` returns the retained message and the producer's receipt within the caller's page budget. Reading a referenced file is a separate, access-controlled operation. Details requested now enter the conversation as a new tool result.

## Readable JSON sent directly to the model

When many objects share scalar fields, the JSON reducer can send the field names once followed by ordered rows. For instance, a build report can carry `"columns":["file","status","code"]` and `"rows":[["src/a.ts","failed","E42"],["src/b.ts","passed",null]]`. Each value is ordinary JSON. Full tables carry every row when they fit the existing output budget. Sampled tables identify the retained source row indices and the count omitted. The shared reducer still requires material byte savings and uses the existing raw-output recovery policy.

## When a rewrite is worth paying for

Keep already-sent history stable across ordinary follow-ups. For a necessary context reduction, use the existing context-GC decision point. Price a batch from the earliest changed position because every cached token after it may need to be processed again. For discretionary rewrites, the expected savings over the remaining requests should exceed that reprocessing cost and the likely cost of retrieving omitted evidence. A cold cache or a required compaction is a natural time to reconsider deferred work. Tool reducers should never independently repack old history as it ages.

Evaluate changes on recorded tasks using billed input and cache-read tokens, follow-up retrieval calls, and elapsed time to completion. Distinguish within-turn prefix changes from a new turn's history view. A smaller tool message or a WebSocket fallback alone cannot establish a cost saving or a cache miss.

## Reusing an accepted turn

An owner turn in continuous chat starts with a pinned project view. On a compatible follow-up, Pi reuses the messages from the last accepted native request, appends its completed assistant response, then sends the new turn state and messages. An unchanged request-only knowledge block keeps its original position. Compatible path alias additions travel in the suffix. Tool results in the retained prefix keep the representation the provider first received.

Pi keeps this window in memory for adjacent turns in the same session. It chooses the fresh project view when a branch or visibility changes, another source contributes project records, live knowledge or authority changes, a one-shot instruction is present, or the request reaches its retention budget. The bound applies to the estimated complete request, including the system prompt and tools, and rolls over before the configured early or hard compaction trigger. The new turn state identifies the prior turn’s permanent chat IDs for retrieval. Durable compaction continues to operate on the active turn. Provider-side caching and transport resume have their own eligibility checks.

## Encoding data for the model

Arithmetic coding can pack a raw artifact losslessly when both ends share the same probability model and finite-precision coding rules. A hosted model receives tokenized message content. An arithmetic-coded artifact embedded in that content would require a decoder before its original evidence could be read. The prompt representation here is readable reduced text with a reference to retrievable detail. Compare representations using the provider's input tokens and the cost of any follow-up reads. [Witten, Neal and Cleary](https://doi.org/10.1145/214762.214771)
