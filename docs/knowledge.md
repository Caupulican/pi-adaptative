# Accepted knowledge in ICM

ICM keeps accepted knowledge in `memory/knowledge.sqlite` under the agent directory, separately from conversation history. Records cover the owner's profile, behavioral preferences, workstream decisions, related people and organizations, and dated journal facts. Each record has a scope, evidence citations, validity dates and a revision history.

The main session receives a bounded current view through the normal memory request planner, including in continuous chat. Explicit, applicable and recent facts take priority. Future and expired records are excluded, and the view reports omissions. Knowledge changes invalidate a pending request plan; the next request reads the committed revision. The chat's cached summary prefix stays stable. Derived knowledge projections exist only on the current request; they never enter durable conversation history or chat summaries.

The `knowledge` tool reads and changes this collection on demand:

- `search` accepts up to eight terms, an optional category and an `after` cursor. Omitting the query browses the category.
- `read` opens an exact record ID and pages its evidence citations.
- `history` pages earlier revisions of an exact record ID. Expired and historical records are evidence, not current instructions.
- `evidence` pages original owner inputs in 4,000-character portions. Its cursor names the exact source record and offset. Older truncated sources are identified as incomplete.
- `change` accepts a `remember` or `forget` command with original owner source IDs and quotes. A targeted correction or forgetting also names the current record ID and expected revision. The host checks the evidence, semantic meaning and canonical identity before writing. Held proposals are not saved.

Audience and project identity are supplied by the host. New facts can apply globally or to the current project. The root tool cannot be delegated to workers or read another audience's records. Disabling memory retrieval disables reads; excluding memory from the prompt removes the automatic view without disabling explicit reads. Explicit requested changes remain possible while retrieval is off.

Current owner instructions and corrections take precedence. Stored preferences do not grant permissions. Forgetting removes the accepted value and revision history while retaining its subject/key identity and an evidence barrier. A newer explicit instruction can relearn it; old remember or forget requests cannot overwrite newer evidence. This does not delete the original conversation, including dated tool-result echoes. Those echoes are historical evidence, not a current knowledge view.

Inferred changes require independent original sources and the existing learning policy. Disabling Auto Learn still permits explicit owner requests to remember, correct or forget. The semantic engine must establish the meaning of a proposed change; no engine or an uncertain verdict leaves it held. Secret-bearing sources and values are refused before admission. Originals of up to 16,000 characters are judged whole, within the semantic engine's state capacity. Longer originals are judged window by window: 8,000-character cores with up to 2,000 characters of surrounding context on each side. No window may contradict the change or leave it unresolved, and at least one must support it. An identity scan covers at most 2,000 canonical identities. Exceeding a bound leaves the proposal held.

Schema-1 databases migrate on open. A previously forgotten schema-1 record has no recoverable subject/key identity: new identity scans in its scope remain held instead of treating that lost identity as absent. Its deleted value is never reconstructed from conversation history.

Automatic collection (`autoLearn.enabled`, on by default) runs in persisted ICM root sessions when a semantic admission engine is available, which is currently System One. After owner input and an idle delay, an isolated extraction reads complete original owner inputs and proposes bounded changes. Those proposals pass through the same admission as the `knowledge` tool. Its spending is limited per original source and per session. Without a semantic admission engine, collection does not start and explicit changes are held. In-memory-only and child sessions never collect.
