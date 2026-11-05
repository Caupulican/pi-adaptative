# Proactive reviews

Pi reviews the conversation when the owner is idle and can raise a concrete follow-up, risk,
suggestion or reminder. Proactivity is enabled by default. A review considers recent conversation,
the owner's standing preferences and accepted profile, open goal requirements, and earlier notes.
Staying quiet is a normal result.

The default delay is two minutes, with at least three new owner turns between reviews and at most
four reviews per session. Each review permits two model responses, up to two notes and an estimated
spending limit of $0.05. Across sessions and restarts, the last rolling 24 hours allow $0.25 of review
spend (`maxUsdPerDay`) and three parent turns started without an owner message, by notes and CI
events together (`maxTurnWakesPerDay`). At the spend bound no review starts; past the wake bound,
accepted notes and CI events wait for the owner's next turn.
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

The observed revisions are the checked-out HEAD, revisions whose pre-push watcher has not recorded
an outcome, revisions named by task subscriptions, and revisions of retained events this session has
not accepted yet. Settled branch records are not observed again. If HEAD, a subscribed revision or a
revision with unaccepted events cannot be collected, the failure is reported and blocks the next
seal; the other revisions' evidence is still retained. An unsettled push that cannot be collected is
reported and sealed without an observation. A push whose watcher is gone and that has had no run for
five minutes is recorded as `no_run` and leaves the observed set.

Pending upstream runs have bounded completion monitors, including runs started from another
machine. Completion requests a fresh authoritative observation; process output itself never becomes
a CI verdict. A monitor that ends while its run still looks pending is re-armed after 30 seconds.
The host also discovers new upstream runs every two minutes while the session is active, so reruns
without a local file change remain visible. Only HEAD, branch references, CI status records and
subscriptions trigger a local observation; index writes, the source's own record updates and
foreground activity do not. An observation that finds nothing new commits nothing and keeps the
sealed source ready. Stopping or replacing the session cancels discovery and joins the monitors.

Session start and session switches never wait for Git, `gh` or the network and never fail on them.
Outside a Git work tree, in a repository without `.github/workflows/ci.yml`, or without `gh`
installed, the source stays inactive without a message. Other source problems are reported once
through the terminal warning channel, which the interactive screen releases when it exits.
`"proactivity": { "ciEvents": false }` stops CI discovery entirely. The footer CI verdict reads the
local record written by the pre-push watcher either way.

Stopping a session parks its consumer instead of removing it: CI results that finish while Pi is
closed stay retained and are delivered when the session resumes. A consumer parked for seven days,
or the oldest parked consumer when the source reaches capacity, is retired; it later resumes through
an explicit replay gap. A source journal that cannot be read is moved aside and a new source epoch
starts.

A failure becomes actionable only after the source has reconciled the current attempt. An older
failed attempt followed by a running or successful rerun remains available as historical evidence
and does not start a repair. A new applicable failure reaches the main session through durable
parent-input delivery. If an already consumed failure is superseded, the later result supplies a
correction. Such a delivery starts a parent turn and counts toward `maxTurnWakesPerDay` together
with proactive notes; past that bound the event is saved to the conversation and carried with the
owner's next turn instead, and `/proactivity status` shows `Last CI event delivery: waits for the
owner's next turn (max_turn_wakes_per_day_reached)`. Turning proactivity off stops delivery while
the source retains evidence.

An event routine (`routine` schedule `{ "kind": "event", "source": "ci" }`) is the owner's standing
request to act on CI results, such as "tell me when CI fails". It reads the same retained events
through the routine scheduler; there is no second event store, subscription or timer. A ledger
commit or a change in source readiness wakes the scheduler, which decides each attempt with the
failure note's rule: the source has reconciled in this running session, the attempt is the current
completed result of a current root revision, and its conclusion and workflow match the routine's
filter. The routine's cursor is a position in the session's task ledger; it starts at the ledger's
position when the routine is saved and never passes a matching attempt that its source has not
reconciled. A run is keyed by the attempt (provider, host, repository, run, attempt), so a replayed
or re-sealed attempt never runs twice, and consumed attempt keys outlive journal pruning. Superseded
and coalesced attempts are counted in the next run, and a new source replay gap is stated in it.
While the routine journal shared by the sessions of one agent directory has no room for another
run, a new attempt stays undecided instead of being skipped; the session is warned once, and the
attempt runs when finished, delivered results free room. The failure note does not depend on routines, and turning proactivity off does not stop a routine. A
routine's result is not counted toward `maxTurnWakesPerDay`; a run whose worker reports no owner
update is carried with the owner's next turn without starting one.

Routine intake turns the owner's own words into routines without a model tool call. It is owned by
the routine session (`core/routines/routine-intake.ts`) and writes only through the routine owner,
so an automatic routine has the same parent check, authority capture and store limits as a tool
save, with read-only worker authority. After an owner turn settles and the foreground stays idle,
one pass reads at most four unread complete originals from the owner-evidence ledger. With System
One bound, each original passes a cheap gate first; one bounded extraction request then proposes
requests with verbatim excerpts, and the host keeps only proposals whose excerpts it finds as the
owner's stated (not shown) words. Each proposal is judged for being an explicit request and for a
faithful schedule, by System One or else the session model, and is created only when both hold at
0.9 probability and confidence. A notice rides with the owner's next turn. The pass, its extracted
requests and the origin of every created routine are retained in the routine store, so a restart
resumes the pass without a second extraction, and a decided request is never created twice, even
after its routine is deleted. Messages the model answered with a `routine` save are passed over.

The `delegate` tool exposes bounded event recall and task subscriptions:

- `events` with `eventView: "sources"` lists exact subjects and their workflow thread keys.
- `events` recalls retained attempts; `eventId` selects one occurrence and `taskId` limits the view
  to a task. Results distinguish current evidence from historical evidence.
- `start` accepts a `subscriptions` array with the new task. Each item names a `threadKey`, exact
  `subject`, and `wake` policy (`never` or `resume_same_task`).
- `subscriptions` with `taskId` reads the task's subscriptions and their revision. Providing
  `expectedRevision` and a replacement `subscriptions` array changes that set; an empty array
  revokes it. Workers can only narrow their own task's subscriptions. Rows the replacement leaves
  unchanged keep their revision and pending events; a wake-only change keeps them too. Only a
  removed row or a changed subject unsubscribes the task from that thread's undelivered events.

Workers use the scoped `task_events` tool for the same evidence and subscription views. The host
supplies their task identity; workers cannot choose a different task, add subjects or widen a wake
policy through this tool.

Subscriptions belong to the durable task, not the reusable worker. Delivery checks the current
attempt, execution lease and conversation context before mailbox acceptance and again before
consumption. An event cannot create a new task, widen permissions or reach a worker's later unrelated
assignment. Only the execution an event copy was bound to can append it. A copy left by an earlier
attempt, lease or task of the same worker never fails a later run; it is settled in its original
transcript and the event is offered to the current execution. A task that is waiting (queued, leased,
retrying, or suspended on a resumable conversation), or whose worker controls are briefly
unavailable, keeps the event pending. Only a running or suspended execution whose conversation can
never hold the event returns it to the main session. A queued copy stays valid while its event is
current, so a source reconnect that observes nothing new does not rebind it. Events for the main
session wait for the foreground on their own lane; worker deliveries and runtime replacement never
wait behind a parent turn.

Source custody, canonical event acceptance, mailbox acceptance and transcript consumption have
separate receipts. Restart replays retained work using those identities. Retention and recall are
bounded. Each open delivery reserves only its own settlement, and a worker copy reserves its
transcript receipt when it is bound, so a refused binding leaves the delivery pending with a visible
warning. Settled history is reclaimed whenever new evidence is accepted, not only after a source
reconciles. A task subscription is refused when its CI subject already has the maximum number of
subscribed tasks, so admitted subscriptions never block the source's next event. When retained
events, deliveries or bytes pass three quarters of their bound, settled events give up the rest of
their seven-day recall window, oldest first. A reconcile names each current result by its source
position, and every position a session accepted and later released stays its history, so a branch
that returns after its result was pruned neither delivers that result again nor stalls the source,
however many other subjects were pruned meanwhile. Capacity that remains exhausted leaves unaccepted
evidence with its source, which reports it and stays unready. Host events remain untrusted
operational evidence in memory and never become owner preferences or permission grants.
