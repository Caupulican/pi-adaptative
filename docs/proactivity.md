# Proactive reviews

Pi reviews the conversation when the owner is idle and can raise a concrete follow-up, risk,
suggestion or reminder. Proactivity is enabled by default. A review considers recent conversation,
the owner's standing preferences and accepted profile, open goal requirements, and earlier notes.
Staying quiet is a normal result.

The default delay is two minutes, with at least three new owner turns between reviews and at most
four reviews per session. Each review permits two model responses, up to two notes and an estimated
spending limit of $0.05. Across sessions and restarts, the last rolling 24 hours allow $0.25 of review
spend (`maxUsdPerDay`) and three note deliveries that start a parent turn (`maxTurnWakesPerDay`). At
the spend bound no review starts; past the wake bound, accepted notes wait for the owner's next turn.
Configure these settings through `/proactivity` or the `proactivity` settings. The model-facing
preferences tool requires confirmation on the owner's screen before a change.

## Checking current evidence

A review can make up to three read attempts using the subset of `read`, `grep`, `find`, `ls`,
`repo_read`, `memory_read`, `zoom` and `date` that its foreground session and current policy permit.
Malformed and refused read requests consume this allowance. The review cannot read again after
raising a note. It normally uses its first response to request evidence and its second to decide
whether a note is useful.

Each read result is limited to 8 KiB of text, including its evidence label. All tool results share a
16 KiB allowance. Read work and its reserved source revalidation share an absolute deadline starting
with the first read; a later model response does not extend it. Filesystem reads also have separate
limits for bytes, files, directory entries, metadata operations and native processes. Installed
decoders and matchers may be used; a review never provisions them.

Repository inspection has a distinct process budget. Git's internal object and index I/O is not
metered as filesystem source bytes. Recursive repository paths require authority for the entire
subtree, including historical and deleted paths. A directory containing a denied descendant is not
an authorized recursive target; explicitly authorized file targets remain available.

Private harness files remain unavailable through filesystem tools. Memory is accessed through a
read-only broker, with bounded native sources and without extension callbacks. Continuous-chat
navigation keeps image descriptions but does not read image bodies for a proactive review.

## Delivery and source lifetime

Read results carry host-issued evidence IDs. A note produced after investigation must cite evidence
that was already included in a model request. The host checks the exact delivered text and retains
its source references and digests with the note. These references establish provenance; they do not
prove that the model's interpretation is correct. Partial results cannot establish absence.

Before delivery, Pi revalidates the sources within their original read allowance. Owner activity,
branch changes, policy changes, changed memory or expired read authority can discard the review.
Filesystem validation is an optimistic observation, not an atomic snapshot against unrelated writers.
The final admission check runs again before the parent session accepts the note.

Provider usage belongs to the original session even if cancellation precedes the physical response.
Review endings are announced as raised, quiet or failed. Delivery uses the normal durable parent-input
path; accepting a note and consuming it in a parent response are distinct states.

## CI events and delegated work

The main interactive session also observes GitHub Actions CI for its checkout. The host owns Git,
GitHub access and filesystem observation; the session receives validated facts about exact workflow
runs and attempts. This works with continuous chat as well as ordinary session history. SDK hosts
can supply their own event source through the same session binding.

Pending upstream runs have bounded completion monitors, including runs started from another
machine. Completion requests a fresh authoritative observation; process output itself never becomes
a CI verdict. The host also discovers new upstream runs every two minutes while the session is
active, so reruns without a local file change remain visible. Stopping or replacing the session
cancels discovery and joins the monitors.

A failure becomes actionable only after the source has reconciled the current attempt. An older
failed attempt followed by a running or successful rerun remains available as historical evidence
and does not start a repair. A new applicable failure reaches the main session through durable
parent-input delivery. If an already consumed failure is superseded, the later result supplies a
correction. Turning proactivity off stops delivery while the source retains evidence.

The `delegate` tool exposes bounded event recall and task subscriptions:

- `events` with `eventView: "sources"` lists exact subjects and their workflow thread keys.
- `events` recalls retained attempts; `eventId` selects one occurrence and `taskId` limits the view
  to a task. Results distinguish current evidence from historical evidence.
- `start` accepts a `subscriptions` array with the new task. Each item names a `threadKey`, exact
  `subject`, and `wake` policy (`never` or `resume_same_task`).
- `subscriptions` with `taskId` reads the task's subscriptions and their revision. Providing
  `expectedRevision` and a replacement `subscriptions` array changes that set; an empty array
  revokes it. Workers can only narrow their own task's subscriptions.

Workers use the scoped `task_events` tool for the same evidence and subscription views. The host
supplies their task identity; workers cannot choose a different task, add subjects or widen a wake
policy through this tool.

Subscriptions belong to the durable task, not the reusable worker. Delivery checks the current
attempt, execution lease and conversation context before mailbox acceptance and again before
consumption. An event cannot create a new task, widen permissions or reach a worker's later unrelated
assignment. A task that cannot consume an event can return it to the main session.

Source custody, canonical event acceptance, mailbox acceptance and transcript consumption have
separate receipts. Restart replays retained work using those identities. Retention and recall are
bounded; capacity pressure leaves unaccepted evidence with its source. Host events remain untrusted
operational evidence in memory and never become owner preferences or permission grants.
