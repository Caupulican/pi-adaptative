# Accepted knowledge in ICM

ICM keeps accepted knowledge in `memory/knowledge.sqlite` under the agent directory, separately from conversation history. Records cover the owner's profile, behavioral preferences, workstream decisions, related people and organizations, and dated journal facts. Each record has a scope, evidence citations, validity dates and a revision history.

The main session receives a bounded current view through the normal memory request planner, including in continuous chat. Explicit, applicable and recent facts take priority. Future and expired records are excluded, and the view reports omissions. Knowledge changes invalidate a pending request plan; the next request reads the committed revision. The chat's cached summary prefix stays stable. Derived knowledge projections exist only on the current request; they never enter durable conversation history or chat summaries.

The `knowledge` tool reads this collection on demand:

- `search` accepts up to eight terms, an optional category and an `after` cursor. Omitting the query browses the category.
- `read` opens an exact record ID and pages its evidence citations.
- `history` pages earlier revisions of an exact record ID. Expired and historical records are evidence, not current instructions.

Scope is supplied by the host. The root tool cannot be delegated to workers, and it cannot read another audience's records. Disabling memory retrieval also disables these reads; excluding memory from the prompt removes the automatic view without disabling explicit reads.

Current owner instructions and corrections take precedence. Stored preferences do not grant permissions. Forgetting a record removes its accepted value and revision history from this collection; it does not delete the original conversation.

Automatic collection and model-facing mutation of accepted knowledge are not currently enabled.
