# Bots and group chats

Bots have persistent identities and model settings. Teams are group chats: each bot has a separate
conversation and memory in each group. Direct bot chats remain separate from group chats.

A delegate worker (`worker-1`, started by the `delegate` tool) is not a bot: it is a child of the session that started it, has no
bot record, roster row or chat, and is managed with `delegate` (status, send, cancel). Its id is outside the bot id domain, so no
bot can take a name like `worker-3`; the `bot` tool, `/bot` and the roster only ever name real bots.

Bot creation by the owner or root uses the selected, configured, or default model. It does not opt in
to model task-fitness judgments. These judgments require `modelRouter.fitnessGate: true`, the router,
and System One. With that gate off, no task-fitness judgment is required at startup, queued dispatch,
or execution. Authentication, model availability, permissions, capacity, and lifecycle checks remain
in force. See [Model Router settings](settings.md#model-router).

## A bot is a session of its own

A bot you message directly (`/bot msg`, its roster chat, `@bot`) runs as its own session, not as a worker of the session you
are in. Its home is `<agent dir>/bots/<id>/`: `profile.json` (written from the bot's record: model, soul, write grant, who
made it), `sessions/` (its own session files), `session.json` (which of them it continues, so it keeps one conversation
whichever project you message it from; the first time a bot loads without it, its newest session file is chosen and recorded)
and `orchestration/` (its sessions' bundles, leases and worker transcripts; state an earlier version kept in the main
session's home is moved there the first time the bot loads). While a session or another host holds the bot's
conversation and is not proven dead (alive, on another machine or not yet judgeable), the bot's host stays out and opens
it again on a backoff while the bot is owed work; you are told once which kind of holder keeps it out. A `session.json`
or session file that is a symbolic link is not followed: the bot's load stops and tells you why, and the link must be
replaced by the file (a symlinked `bots/<id>` directory is fine). A watch belongs to the conversation that armed it and is checked only by it, so the one place a bot's
session is chosen (when it loads) keeps that true: if it continues another conversation than the one its watches target,
those watches are cancelled and you are told. The record in the bot store stays the index; editing the bot's model, permissions or soul
refreshes the profile and applies to its session when it starts, so a bot that is working must be stopped first. The session
runs on the bot's model, under the rules a worker's own model is held to (a model that is gone, has no credentials, is paid by
API key without being the owner's choice while subscription models are usable, or that your model policy disallows refuses the
message, and every turn is held to them when it starts, a turn a watch's wake opens included; a refused model loads no session).
It never leaves that model: a model out of quota or refused for the account is not replaced by the account's default or a
failover model; the turn is refused with the reason and the bot answers again once its model can run. A subscription
model whose account reports its usage windows used up is out of quota until the last of them resets. A watch's wake
refused that way is kept: it is taken up again when anything asks (a session that starts or attaches, another host letting
the bot go, a record change) and finds the refusal's cause gone, and, for a quota exhaustion with a recorded reset, at that
reset (the bot's idle session is closed and opened again so its recovery runs the wake). The session works in
your project directory. Like a worker, it never reaches an owner credential file (`.env`, keys): a read or a
command that would is refused before it runs, never run with the values masked. Its commands (shell, python) run as a
worker's do: without the credential variables of your environment (except those `PI_WORKER_PASS_ENV` names) or the
credential profile of the project, with `PI_SESSION_ROLE=worker` (a `pi` it starts is a worker, never a root), a temp
directory of its own, and anything they leave running ended when the session closes, which you are told about. Its name and its soul replace the main agent's in its system prompt, so it never
introduces itself as the main agent. Its system prompt carries what a worker of the bot carries: the project's context
files (`AGENTS.md`), only those inside its read scope when its profile names one, and a profile's resources, but never
your own `SYSTEM.md` or `APPEND_SYSTEM.md`. Its memory blackboard (`<agent dir>/memory/bots/<id>.md`, the same file a bot running as
a worker reads) opens its system prompt under its soul when the session starts; it can read the file, not edit it, and a
line from each finished turn is appended to it. It reads, and writes only when the bot has write access, and then as a worker writes: its file tools write inside your project directory only, never to a harness resource (skills, extensions, prompts, settings, hooks, git config); a read-only bot has a shell whose
commands are judged one by one, as a read-only worker's are (nothing that edits or creates a file runs, nor anything that
reaches the network unless its profile grants `network.http`, in every execution mode). Its spend is bounded per request:
each outside input it serves (your message, a message its inbox took, a watch's wake) opens a spend window, and the turns
serving it, the handoff turns its workers' results open and those workers' runs (a plan's steps included, however much
later each is released, and the turns its plan's updates open) share its dollar ceilings, each when set:
`workerDelegation.maxUsd`, the main session's own ceiling and a profile's `maxCostUsd` on all of the window's spend, and
the main session's metered-only ceiling and a profile's `maxMeteredCostUsd` on the part of it made on metered models. A
turn is stopped once the window's spend (its own and its workers', from the delegation ledger) passes a ceiling that
holds the bot's model, and a turn a worker's handoff opens into a window already past one is stopped before its first
request; the window's workers share each ceiling less what the bot's turns spent in the window on the
spend it counts (a metered worker the metered-only ones too, so a subscription bot's own turns never use up the metered
ceiling of its metered workers), and a remainder at or below zero refuses a worker's next request. On a model no bound applies to (a subscription with no ceiling set)
its workers get no dollar bound: the plan's usage windows hold them, and a worker whose usage is used up waits for the
reset and continues on its own. A bot or a worker on a subscription model that declares no price gets no dollar bound
either: its spend cannot be priced, so its usage windows hold it. On a metered (API) model that declares no price, a
dollar ceiling that applies refuses the bot's turns and its workers' requests, as it refuses the main session's workers:
real dollars would be spent with nothing to hold them. The windows are kept in the bot's spend ledger, `bots/<id>/spend.json`; past 64 windows the oldest are dropped, but never one a worker that may still run serves, nor the one the bot's turn is counting to. A turn is bounded
in time by `workerDelegation.maxWallClockMs` when that is set, as a worker's run is. What the bot's session spends is added
to the main session's cost at each turn's end and each time a worker's usage reaches it, from a watermark kept in the same
ledger: each charge's range is written there before it is reported and kept until the main session's file holds it, so a
reopen or a crash loses no range. The watermark only moves forward, field by field, over the usage the bot's session has
recorded, so a reading short of it (its history still loading, or failed to load) charges nothing twice. Each charge names
its range (where it starts and ends in the bot session's spend) and the bot session's file it reads (when that file
began: a file created again under the same session id starts its spend at zero, so its watermark and ranges are its own,
and the earlier file's charges still held are delivered under their own ids), and the main session's cost, its task costs and the daily
brake count a bot session's charges as the union of their ranges: within one main session's file a range recorded again
after a reopen or overlapping another counts once. A main session's cost and task costs read only its own file, so a
range delivered to two main sessions counts in each one's view. The daily brake reads the main sessions' files changed
within the day and counts a range once across them, on the earliest day a charge covering it among those files was
recorded; a range fixed again whose earlier charge lies only in a file not changed that day counts again on the later
charge's day. Every charge delivers the ones still held first, in order, so a range a main session lost is recorded
again before any later one. A charge counts as held once a main session's file holds it. A charge fixed while a main session that keeps no
file (`--no-session`, an in-memory SDK session) answers is held by it as it holds its own spend: the charge is settled
when that session takes it, with the charge mark kept at once, counts in that session's views while it lives and in
nothing after it ends, and is never delivered again to a later session. A charge left pending from before (by a main
session with a file in an earlier process, or taken back from another main session's unwritten entries) is not given to
a main session without a file: it waits for one with a file. A session with no watermark (a new bot, a new session file, a
lost record) starts at zero when it recorded no spend, with nothing read, and otherwise at the furthest of how far the
main sessions of the process hold its charges, the charge mark in its own transcript and the charges the ledger still
holds for it. Only the main sessions' files changed since the bot's session began, or since its last charge mark, are
read back for it (a file a writer appends to while it is read is read as it was, one that changes otherwise is read
again, one that is no session file holds none; one that cannot be read, or a directory that cannot be listed, is read
as holding none, so the watermark may start lower and what it holds may be charged again, counted once by the union
within the file that receives it; once that watermark is taken you are told of each path once, the first three named
with why and the rest counted). A live main session's charges count once its file holds them, the ones it holds unwritten being delivered
again. At each turn's end and when the session closes, how far the main sessions' files hold the bot's charges is marked
in the bot's transcript (`bot-charge-mark-v1`), so a range is not charged again after session retention removed the files
that held it (a mark that cannot be written is told once). Ranges reach the main session in order. A spend record that cannot be read is left in place and read again,
counting in memory meanwhile; one that does not read is set aside as `spend.json.unreadable-<time>`, keeping what of it
reads. You are told once either way. A turn's spend counts, with its model calls, the
compactions that serve it: one while it runs or between its runs, and one just before its first run in the same
submission (the threshold check before your message's run). A compaction after a turn's last run counts toward no turn's
bound; it is charged with the session's next charge. The bot compacts its own context with `self_compact` as the main session
does (`docs/compaction.md`): the note it saves ends its run, the session compacts, and the note's handoff continues the
same turn, under the same spend and time bound. A turn stopped at either bound releases the saved note, so no later run
continues the stopped work, and a note the bot's session left saved when it closed is handed off when it loads again. Its tool loop is supervised as a worker's is: repeated broad validation with no new change is steered back to the work, and a turn System One judges stalled or off its message is steered, redirected or stopped; the directive shows in its chat. It reads the settings the main session reads, again each time the main session changes them, and runs
System One as the main session does at each use (on or off, the same provider and connection; turning System One off or on in settings turns it off or on for a loaded bot too): your messages to it are judged as your
messages to the main session are, the claims in its answers (files changed, a commit, a passing check) are checked
against its own turn's tool results as the main session's are, a contradicted or unbacked claim getting the one correction
turn (on a message or a watch's wake alike), it holds the `systemone` tool, and its System One evidence is kept in its session's bundle in its home
(`orchestration/sessions/<session-key>/typesafe-reviews/`), as every session's is; evidence an earlier build kept in
the home's own `typesafe-reviews/` is still read. As a root session it writes the learning stores a worker only reads (model adaptation, fitness and
outcomes, observations, the failure corpus, tool performance and recovery logs, steering certificates); every write
takes the store file's lock and works from what the file holds then, so the bot's session and any other session or process
sharing the agent directory never drop each other's records. A bot is a session of its own, so its edge grants are its own conversation's plus your settings'; no other session's
conversation counts, the main session's included (a bot running as a worker takes the main session's grants). To give
a bot standing authority, grant the class in settings (`edge.allow`, which stands for every session and every bot); to
authorize one action, say so in the bot's chat, where System One reads your words as it does in the main session (such a
grant is not standing). `/edge allow` is a command of the main session: typed while a bot's chat is open, it still grants
the main session's conversation, since a bot's chat takes no slash command. It is loaded on its first message, kept
while a turn runs or input is queued, and closed after ten idle minutes or
when the session that hosts it ends. Its answers are read in its chat (the roster marks them unread); they do not reach the
orchestrator as a worker's terminal does.

A bot directs workers of its own with `delegate`, its one-call form `assign` and `plan`, the tools the main session directs
its workers with; its plans run through the same fleet as its other workers ([Plans](plans.md)), and the plan rule and the
director role's plan line reach it with the tool. Its system prompt carries the director role in a bot's words (its own work is
integration, verification, security and every answer in its conversation; a writing bot writes instruction files in
the project's `.pi` when its write roots hold it, and else where it may write, and a read-only bot's words say it and its workers change no files), and the `delegation` rule reaches it as it reaches the main session, without the line on worker memory,
since a bot lends its workers no memory. Its workers are held to the bot's own reach: they write, read, run commands and
reach the network no wider than the bot (a read-only bot's workers are read-only). Their conversations lie in the bot's
home (`orchestration/`), their spend counts in the bot's spend window and reaches the main session with the bot's, and a
worker's end opens the bot's next turn, as a worker's handoff opens the main session's. They answer only the bot: a
bot's own workers hold no `bot_message` (the bot holds no messaging to lend), and a profile bot's workers that hold it
are offered only `reply` to the bot. `/bot stop` stops the bot's turn and every worker it started, and says the
bot was stopped when it ended a turn or input in flight, or the workers in flight; a stop that could not be recorded or
taken still ends the turn and the workers of the bot this process hosts, and one that could not be recorded also pauses its
goal, declines its usage-limit wait and refuses the messages sent to the bot before it, as a recorded stop does. A
stop that could not be recorded for a bot no process hosts is held by the process that made it, across the root
sessions it runs in turn (a new, resumed or forked session keeps it), scoped to the work there was when it was made: the
workers then unended, the plans then open, the turn running since then and the jobs placed on other machines by then or
by those workers. Wherever and whenever it is applied, it ends that work and nothing started after it. While no process
hosts the bot, a take in that process applies it under the bot's host lock (a retry, or that process's open of the bot,
a stop made during the open included), the messages sent before it refused; a take that fails keeps it held. While
another process hosts the bot, the periodic check records it again in the bot's home until the write lands, for that
host to take, and you are told it is recorded now. A stop of the bot recorded later covers it. When the session that
holds it quits (the last one of the process for its agent directory) with the stop still held, it is recorded one last
time and you are told once whether it was recorded or lost; a stop a bot's or worker's own session held when it closed is
kept by the process the same way. It is not held
when the work there is cannot be read as the stop is made: you are told it was dropped, and why, to send it again. A
host of an older build never takes a stop recorded late, which then waits until a host of this build takes it. For a bot this process hosts, a stop that could not be
recorded applies only to the bot's work in this process, and you are told so. A worker the owner stopped opens no turn
of the bot. A profile bot holds `delegate`, `assign` and `plan` when its profile's tools name any of them, since
`assign` runs `delegate` and `plan` runs its steps on the same fleet; a worker of any profile holds none of them. A
read-only bot's plans name no files: a step that names files is refused (its worker would run read-only under a plan
that treats it as a writer), so each step is planned as the read-only work its worker does. The delegation gate
(`orchestrator.delegationGate`) applies to a bot's session as to the main session. The orchestration directories it
counts as a bot's own are its home `bots/<id>`, which its path scope keeps private (it writes nothing there), and the
place its director role names for its instruction files: the project's `.pi` in its working directory when its write
roots hold it, else its write roots, so the role never names a place the gate refuses. A bot is never hosted in a worker
process.

A bot waits on its own work with `task_watch`, the tool a worker holds for it: a one-shot watch on a file, a managed
process, a process id, a port, a command or a page, with an end time at most 24 hours ahead, at most eight at a time
whatever armed them (the bot changes none, and cancels one its own session armed with `task_watch`'s `cancel` action, naming its `watchId`, once it
no longer waits on it, which frees that slot). A command or page is first admitted as the call its own shell or
fetch tool would make, by its own gate (System One's operation judgment included), so a bot without that tool arms
nothing, and a read-only bot's command is held to its read-only shell at arming and at every check. The bot's own session
samples its watches and wakes it with the event (a running turn is steered, an idle bot starts a turn); no other session
samples or delivers them. While it holds a live watch, or a fired watch's wake it has not taken yet (a one-shot that fired
is no longer live), its session stays loaded past the idle close, a process that starts
or sees its host let it go or die opens it again (only where it works in the directory that session worked in; the phone session
never does), and retiring the bot drops its watches. The roster shows each bot's live watch count in the operator bar's
words (`watching n`; the ring `◌n` only where the row has no room), read from the store and the watch ledgers beside its
session files in every session.

**Every open session sees every bot, and closing a session loses none.** Nothing about a bot depends on the session that
created, messaged or hosts it: the bot list is the bot store, the chat is read from the bot's home, and the unread mark is
on the bot's record in the store (`lastMessageAt`, `lastReadAt`), which every session watches. One process hosts a bot at a
time (`bots/<id>/host.lock`), and inside a process one host serves every root session on the same agent directory (the last
root to close stops it). Inside that host, a bot's settings follow a change any of those root sessions makes and are read
again when a root session opens (a new or resumed session replacing the one the bot loaded from), and a root session in
the bot's directory hands it your project trust decision (`/trust`); a settings file edited outside a session reaches a
loaded bot when a root session reads it again (`/reload`), as it reaches that session. A bot
loaded by a message works in the sending session's directory, with its turns' spend going to that session
(to another open root session once it closes); the lock record carries that host's token, so a second host is told apart from the first even in
one process. The host publishes what the session is doing in `host-state.json`, and a watch over the bot homes
tells every other session's roster and open chat when the conversation, that state or the history changed. A second session
shows the bot running, queued or idle from that file (trusted only while the lock names a live process, so a killed host
leaves no stale "running"), and its chat from the session files. A message to a bot another process hosts goes to the
bot's inbox (`bots/<id>/inbox/`, one file per message, at most 32 and 1 MiB waiting); the sender is told it was delivered
to the host in that session and process, and the bot's chat in every session shows it as waiting. The host that holds the
lock takes the inbox when its session loads (before the message that loaded it), when the watch over the bot homes sees a
message written (every 5 seconds while that watch does not run, and every minute beside a watch that runs, which can miss
what another process writes), and before an idle close, giving each message to the
bot's session as your words, oldest first; the bot answers in its chat, and that turn's spend goes to the host's own
session. What a bot's own session raises for you (a warning, such as a routine result it could not deliver, a turn that
failed, a turn stopped at its spend or time bound) is a notice in the bot's chat (`bots/<id>/notices/`, the newest sixteen
kept), which every session shows and which marks the bot unread in the roster until you read it; an informational one
marks nothing. Only a notice that could not be written is a warning of the process that hosts the bot, with its words. A message the session refuses (its model moved or cannot run, say) leaves the queue as a refused
record that the chat shows with the reason (the newest eight are kept), and the host's session is warned. A message that
waits when the host lets the bot go or dies is taken by the process that opens the bot next, including one working in the
directory the message was sent from: every process lists the inboxes of the bots no process hosts once a minute, so that
happens without the owner's next message even where the watch over the bot homes does not fire (a bot whose session
failed to open for another reason than its model, such as an unreadable session file, is tried again by that listing only
once a new message waits or its record changed; a process start or another host's change tries it at once); a bot retired or moved to a worker refuses what waits, with the reason. That
release (its waiting messages refused, the watches its session armed dropped, its closed session's workers and the jobs its
home's sessions placed ended) is taken up by the next process that opens the bots when the process that retired or moved
the bot ended before it finished: the bot's record is the mark of what is owed, and what its home still holds of that work
is the work, so a bot whose release finished is left as it is and one another process hosts stays that process's. Delivery is at
least once: a host killed after its session took a message and before it deleted the file gives it again. An inbox file
that does not read is set aside as `<name>.unreadable` and you are told; one that can be neither read nor set aside (a file
the process may not read in a directory it may not write, a Windows sharing lock) stays in place, is told once, is counted
as waiting by nothing (it holds back no message, opens no bot and keeps no session loaded), and is read again on a backoff
of two seconds doubling to five minutes, or at once when the file changes. Like the session
files beside it, the inbox is private harness storage: a worker's and a bot session's file and process tools are refused
the bot homes. `/bot stop` ends everything of the bot's running when it is taken: its turn in flight, its plans, the attempts and queued
work of its worker tasks and the jobs its sessions placed on other machines (a session file in its home that is a
symbolic link is skipped, and you are told once for that stop, however often its take is tried again). Your words sent after it never start a turn before it is applied: while a
stop waits unapplied they wait in the bot's inbox behind it, and you are told so. It reaches the bot
wherever it is: the stop is written to the bot's home and taken by the process that hosts the bot (you are told which, or that it could not be read),
or applied in place when no process does. It also ends the watches the bot's session armed by the time of the stop (a
stopped worker's watches end with it) and settles the results it had not read yet that fired by then, or that those
watches fired after the stop while it waited to be taken, recorded by a note in its conversation (or, when the session has
no conversation written yet, in the bot's watch records alone), and you are told how many of each it ended; while the stop
waits, no watch result wakes the bot. A watch the bot arms after the stop is kept and wakes it as usual. A watch's wake its conversation had already taken before the stop is not withdrawn:
it still runs when the bot next opens or is next sent words. A stop that cannot be written to the bot's home
is not recorded: you are told this process holds it and records it again until it lands, and that wherever it is applied
it ends only the work there was when it was made (for a bot this process hosts, that it applies only to the bot's work in
this process). A session started after every other one
closed lists each bot with its whole conversation.

What ran before a bot had a session of its own is part of that conversation. Those worker conversations live under the
orchestration directory of whichever session messaged the bot, and only that session's own transcript says which runtime
was whose, so `bots/<id>/history.json` indexes them by reference (a path-free transcript reference and a time range, bounded
to the newest 200; nothing is copied), and the startup cleanup of old session directories keeps any directory holding a run
an index references, a bot directory that is a symbolic link to one included; an index that exists but cannot be read, or a
bot directory whose symbolic link does not resolve, stops that cleanup (with a startup warning naming the bot) until it
reads, since what it holds is unknown. The index is built by one streamed scan of the session files, off the screen's
drawing path (the chat shows what it has until the scan ends). The scan runs once for the agent directory
(`state/bots/history-scan.json` marks it done), never again in any process and never for a bot made later; afterwards each
worker-path start of a bot adds its own run as it is bound. A process of an older build, still running after the scan ran,
does not add the runs it starts (it has no index to write), so those runs are missing from the chat. The chat shows those earlier conversations in time order with the bot's own session. A chat reads them from disk again only when the index or
a run transcript it shows changed; otherwise it keeps what it drew.

A group's message and a routine's prompt to a bot that answers in a session of its own are a turn of that session too,
under an origin of their own, never as your words: a group's message is stamped as the group's mail (the bot reads that
it was posted in the group's room, and its answer is appended to the group's log), and a routine's prompt as the
routine's (a third party's when the routine's trigger carried a third party's words). A routine run ends when the bot's
session took the prompt; the bot's answer is not part of the run. The orchestrator's `bot ask` is a turn of that session
as well, as the orchestrator's mail (see "The orchestrator asks a bot" below). These still run as workers of the session
that sends them: leaders, the bots a leader made and machines joined over the link (a group's message, a routine's prompt
or the orchestrator's ask to such a bot as well). A bot made from a worker profile runs as a session of its own too, on the contract its profile compiles to at every
run, by the resolution a fresh worker of it takes (the owner's pin for its role, the bot's model stance, read-only grant
and soul, the model rules and the execution plan), without a worker run's admission gates (whether the session delegates
now, the worker fleet), since no worker runs: the resolved model and thinking, the plan's tools, its working directory, its read roots (a profile
that confines reads confines the read tools, `repo_read`, `lookup`, the read-only shell and its watches to them), its write
roots and read-only grant, a capability ceiling of the plan's capabilities held by the session's tool gate, the soul and
resources a worker of it carries, and the profile's cost budget as ceilings over its spend per request (`maxCostUsd` on
all of it, `maxMeteredCostUsd` on the part made on a model reached with an API key rather than a subscription, each
spend judged on the model that makes it, a worker's on its own), beside the worker and session bounds. A run on a session built from an older compile (the profile, a model pin or the worker policy changed
since) is refused and the idle session is rebuilt. A profile that needs an independent verifier of each claim, names a
tool a session does not hold, or sets a token, wall-clock, attempt or tool-call limit (which only a worker's run counts)
keeps the bot a worker; a profile the resolution refuses refuses the message in the owner's words. One predicate decides it
for the message and for the bot's host alike: a bot whose record leaves the session path (it becomes a leader, a leader's,
or its profile now needs a worker) has its idle session closed and its watches dropped, and no session of it is opened
again, so it never answers in two conversations at once. A bot's session has no subagents, routines, goals or `bot` tool yet (its only routine tool is `task_watch`); it holds
`bot_mail` to write to the other bots (see [Bots mail each other](#bots-mail-each-other)). A bot that only ever talked through those
paths has no session of its own: its chat shows its earlier conversations from its history index, in any session, and its
last summary when none can be read.

## Bot names

A bot has an id and a display name. The id is the stable handle (`trello-scout`: what you type after `@` and in `/bot msg`);
the display name is what the roster shows (`Trello Scout`). A bot made on the fly with no id (the orchestrator's `bot`
tool) is named from its purpose, its description or soul (`release-notes-writer`), and a
taken name gets a number (`release-notes-writer-2`); the answer says which id it chose. `/bot rename <id> <name...>` changes
the display name only. The roster row shows the name and its badges; the selected bot's model appears as a hint on the line
below. A bot created without a model runs on what a worker would (the worker profile, else the subscription-routed efficient
model), not on the session's own model.

## Who creates bots

Bots are created on the fly, for whatever purpose you have:

- You create one with `/bot new <id> [--write] [model] [soul...]`.
- The orchestrator (the root session, always the same one) creates one with its `bot` tool: `action create` with an
  `agentId`, a `soul` (the bot's standing instructions), an optional `model` and `canWrite`. With `forLeader` (a leader's
  id) the bot is that leader's own: the store names the leader as its creator, and the leader's message starts it under the
  leader's goal.
- Your own message to a bot (`/bot msg`, its roster chat, `@bot`) makes the bot it names when none has that id, on the
  default model. No other message makes a bot: the orchestrator's `bot ask`, a leader's brief, a group's message and a
  routine's run to an id no bot has are refused before anything starts, and the orchestrator is told to create the bot or
  find the one it means with `bot list`.

No other bot creates bots, a leader included. A **leader** that needs a bot of its own asks the orchestrator in the middle
of its goal (`bot_message` `action ask_root`, naming the bot's purpose); the goal stays open until the orchestrator's answer
starts the leader's next turn, and the orchestrator creates the bot with `forLeader` and tells the leader its id. Every
other bot asks its leader (leaders are marked in its `bot_message` peer list) or its parent in its report. Only you make a
bot a leader: `/bot lead <id>` and `/bot unlead <id>` (they take effect from the bot's next worker start; `/bot list` marks a
leader). Bounds that always hold: a leader's bot writes only when the leader can, and a leader keeps at most 12 bots of its
own; a bot name that exists, retired or not, is refused. The store records who created each bot (`owner`, `root` or, for a
leader's own bot, the leader's id). A leader's bot is told to ask that leader, by name, for any bot it needs. With
`leaders.maxDepth` set to 2, a leader that works a goal may hand a part of it to a standing leader it names
(`bot_message` `action lead` with `agentId`; only the orchestrator appoints a goal leader, so a hand-on without `agentId` is
refused); that part's outcome goes back to the leader that handed it on, and the goal ends only after its parts have.

## Leaders lead goals

The orchestrator can hand a whole goal to a leader instead of running every part itself. A leader is a bot that works the
goal with the bots it owns; it is never a second orchestrator, and its authority is the orchestrator's, narrowed.

- The orchestrator calls its `bot` tool with `action lead`: `goal`, and optionally `requirements` (`{id, text}` each),
  `constraints`, `files` (project-relative paths the goal may change), `budgetUsd`, `minutes` and `context`. With
  `agentId` it names a leader you made; without it, it appoints a **goal leader**: a read-only leader made for this one goal
  and retired once the goal ends and it is idle.

  ```json
  { "action": "lead", "goal": "Find why the nightly export is slow and propose a fix",
    "requirements": [{ "id": "cause", "text": "The cause is named with evidence" }],
    "constraints": ["Do not change the schema"], "minutes": 60, "budgetUsd": 2 }
  ```

- What the leader may do is clipped, never refused: a path outside the project, files for a leader that cannot write (a
  goal leader never writes), a budget or deadline past the orchestrator's own. Each clipped item is in the answer, in the
  leader's brief under "Held back", and in `/lead show`.
- One goal at a time per leader: a second goal for a busy leader waits, oldest first, until the first ends and the leader
  is idle.
- The orchestrator hears back once, when the goal ends, with one outcome: the outcomes of the leader's last turn and of
  each of its bots' last turns, combined as they are, never judged again. A turn belongs to the goal when the goal started
  it: the leader's turns, the orchestrator's brief, updates and answers, and the turns the leader's own messages start on
  its bots. None of them wakes the orchestrator. Your chat with the leader or its bots during the goal is yours, not the
  goal's, and, where they run as workers, it reaches the orchestrator as any other bot turn does. The one exception is a
  leader turn that ends asking for an answer: that question reaches the orchestrator, the goal stays open, and the orchestrator answers with `bot` `action ask`.
- The goal ends early when its time runs out, its metered budget is spent, a subscription it uses has no allowance left in
  its usage window, you cancel it, or its leader is gone; the leader and its bots are stopped and the outcome says why.
- Budgets: `budgetUsd` counts metered spending only. A subscription turn is not metered, so the budget does not count it;
  the subscription window is the bound for those turns. `/lead show` and the leader's brief say so.
- A bot the leader made that is not running is started by the leader's own message to it, as the leader's child under
  the goal; the goal's envelope applies to it (its providers, and write access only when the goal grants it). A bot that is
  already running keeps the start it was given. The bot runs on its own soul: a leader's soul is the leader's alone and is
  not passed on to the bots it starts.
- Stopping a leader stops the bots it owns. The stop interrupts their work and leaves the goal open: each stopped bot's
  report still reaches the leader, and the leader's next turn ends the goal. To hold a goal instead, pause it
  (`/lead pause <leader>`). A leader leading an open goal cannot be retired until the goal ends; cancel it first to end it sooner.
- The orchestrator retires a bot with its `bot` tool (`action retire`, `agentId`), as `/bot retire` does, under the same refusals.
- A retired bot takes only your own message (`/bot msg`, its roster chat, `@bot`), which brings it back. The orchestrator's
  `bot ask`, a leader's brief, a group's message and a routine's run do not reach it: the ask is refused with that reason,
  the group's message records that member as not delivered, and the routine's run fails. You are told once per routine, until
  a run reaches the bot again, and three failed runs in a row pause the routine, as any failing routine is paused.
- A paused goal holds the messages it filed to its bots, in order, and starts them again when it resumes. The goal closes
  only once none of its messages is still waiting.
- The goal lives in this session's orchestration store, so a restart resumes every open goal where it stood.
- `leaders.maxDepth` (default 1, at most 2) bounds how deep leaders may nest. Today only the orchestrator hands goals to
  leaders; a leader handing part of its goal to another leader is not available yet.

The Orchestration panel lists the goals under **Leaders**: the leader's name, the goal, and where it stands (Waiting to
start, Working, Paused, or how it ended). In the Chats roster a leader's bots sit under it. `/lead` is for looking and
overriding only: `/lead` lists the goals, `/lead show <leader>` shows one in full, and `/lead cancel|pause|resume <leader>`
acts on the leader's current goal. Reading the goals never starts the worker runtime. `/bot lead <id>` is the other command:
it makes a bot a standing leader (only you do that), and `/lead` never does.

The goal's turns are filed under its delegation in the orchestration store (`delegation-<id>`), and the store records which
bot's message started each turn. Those are the facts the leader's outcome and the orchestrator's wake-ups are read from.
Leaders on another machine are not available yet: `bot lead` refuses a machine that is joined over the link and says why.
The remote job protocol reserves a `leader` job kind for that work; no executor exists for it yet.

## Machines as bots

Any machine can host a hub, join a hub, or do both; nothing is tied to one machine. A machine that joins a hub shows up there
as a bot with a computer mark (💻 remote) and the machine's name. You message it like any bot (`/bot msg <name> ...`, its
chat, a group), and its answers come back into its chat.

On the hub: `/remote listen [port] [host]` turns the hub on (loopback by default), `/remote add <name>` lets a machine join
as a bot named `<name>` and prints a join token once. `root` and `owner` cannot be a new machine's name: they name who creates a
bot, so `/remote add` refuses them and suggests another name. A machine already named so keeps working: `@root` still addresses the orchestrator, so message that machine with `/bot msg root <text>`. `/remote revoke <name>` cuts it off and retires its bot, and
`/remote status` lists the machines and their links. On the joining machine: `/remote join <host:port> <token>` (and
`/remote leave <host:port>`). `/remote name <name>` renames this machine.

How it holds together:

- Each side proves a shared secret by HMAC (the secret is never sent), and the joiner checks the hub proves it back.
- After that proof, a link between two current builds is sealed: every message, answer and keep-alive is encrypted and
  authenticated (AES-256-GCM) with keys made fresh for each connection from the secret and both sides' handshake
  nonces, one key per direction, and each frame carries the next number of its direction. A frame that was changed,
  replayed, reordered, dropped or sent back to its sender does not open, and the connection closes. `/remote status`
  says "not sealed" beside a link that is not.
- A machine on an older build links unsealed, as before. Sealing is guaranteed only when both machines are current
  and at least one refuses unsealed links: someone able to change the traffic between two current builds can remove
  the offer to seal from the handshake and leave the link unsealed. To refuse unsealed links, write
  `{ "requireSealed": true }` to `<agent dir>/remote/settings.json`: a hub then refuses a joiner that does not seal, and
  a joining machine refuses a hub that does not. It is off by default so older builds keep linking. For another
  machine, prefer a private network (Tailscale, WireGuard) or an SSH tunnel either way.
- A joined machine's root session receives the hub's words as a peer's words under the `link` channel's usual bounds
  (wakes and spend per day), never as its owner's. Settings may replace the implied policy with `channels.link`. Its
  conversation with a hub is keyed by the hub's install id, so two hubs with the same name keep separate conversations.
- The hub refuses a machine that would make a loop of hubs (a machine already above it, or a chain more than three deep),
  a machine id that changed under a known name, and an install that already joined under another name. The reasons
  show in `/remote status` in plain words.
- Machines are told apart by the id each install generates, never by hostname: a WSL instance and its Windows host
  that share a hostname are two machines. Names are the labels the owner gives.
- One root session per agent directory hosts the hub (`remote/host.lock`). Another session on the same directory does
  not bind the port and shows no warning; `/remote status` there names the hosting session and its machines, and
  messages, `/remote listen` and `/remote stop` go through that session. When the hosting session stops the hub or
  closes, a waiting session takes the hub over; a lock left by a session that crashed is replaced at the next start,
  once that session's process is proven gone. A revoke from any session cuts the machine at once.
- State lives under `<agent dir>/remote/`: this machine's id and name, the machines allowed to join, the hubs joined, each
  machine's chat log, the host lock, and where each link stands (`links.json`: `joins` by hub address with the hub's id
  and the active features, `machines` by install id with the name and the active features). Secrets are stored for the
  owner only: mode 0600 on POSIX, and on Windows an access list that names only the current account.

### Asking a linked machine

A message from the orchestrator to a joined machine (the `bot` tool's `ask`, or the owner typing `/bot msg` in the
orchestrator's conversation) is a conversation turn placed as a lane. It goes as an ordinary chat message under the
lane's id, so a machine of any build answers it with its own session, and the machine's reply under that id is the
lane's end. A machine that stays silent until the deadline (ten minutes by default), stays offline past the offline hold,
or is revoked ends the lane the way any placed job ends, and the asking session gets the same single terminal
notification every worker sends, with the reply as untrusted evidence. Nothing is polled. The owner's own messages typed
in a machine's chat are not lanes: the answer arrives in that chat, which refreshes while it is open. A turn is not a
job: the machine's session answers it with its own tools and memory, and nothing is offered or admitted there. An answer
the machine sends before its turn ends (`final: false`) reaches the chat and leaves the lane open; the lane ends on the
final answer, the deadline, the offline hold or a revoke. A hub on an older build ignores the field and ends the lane on
the first answer, as before.

### Jobs on linked machines

Two current builds on a sealed link also tell each other what they can take (`cap/1`) and can run each other's jobs
(`jobs/1`). Both ride inside the sealed frames only; an older peer, or an unsealed link, keeps chatting as before and is
never offered a job. Job frames never become a turn on either side: they move work, not words.

- **Adverts.** Each side sends its facts when the link comes up and when they change: operating system, shell, which
  projects it offers (by project identity, never by path), the tools on its PATH (read from the file system; nothing is
  spawned), the model providers it can use and by which access (`api`, `subscription`, `local`; never an account or a
  key), its free room, and whether it takes jobs. They land in `<agent dir>/remote/fleet.json`, and the machine's
  roster row reads from them: `ready, 2 free`, `full`, `takes no jobs now`, `working on 1 job`, `offline, 1 job
  waiting`.
- **Project identity.** A checkout is named by a hash of its root commits and its normalized `origin` URL, so two clones
  of the same project match on any machine and under any path. A machine offers only the checkouts the owner listed
  under `repos` in `remote/settings.json` (absolute paths, `ready` once set up).
- **Read-only first.** A placed job runs on the other machine as a native read-only worker through that session's own
  worker path, in the offered checkout when the job names one. Jobs that change files are not placed yet. The worker's
  reads are a local read-only worker's: the offered checkout is where it starts, not a fence. It can read other files
  on that machine the read-only rules allow (the machine credential stores and secret files stay denied), so link only
  machines whose files the other side may read.
- **Exactly once.** The placer gives each job an id derived from its own install id and the dispatch's idempotency key.
  The executor admits a job id at most once (`remote/jobs/in/`); an offer sent again is answered the same way, a
  different offer under the same id is refused. The outcome waits in the executor's outbox until the placer persists it
  and acknowledges it, so a link that drops mid-job resumes on reconnect (`job.resume`) and the outcome arrives once.
  The placer records the job as a managed worker lane at once, so it shows in Orchestration as `<task> · on <machine>`,
  and reports its end to the session that placed it, once. The cost and tokens the other machine reports for the job
  count in that session's cost and, for a bot's job, in the bot's spend window.
- **Ends the placer decides.** A job past its deadline is stopped there and ends as a timeout; a machine that stays
  offline past the offline hold (`offlineHoldMs`, ten minutes by default) has its jobs end as blocked; `/remote revoke`
  ends that machine's jobs at once; a refusal ends the lane as blocked with the reason in plain words. Only one session
  per agent directory runs other machines' jobs (`remote/jobs/runner.lock`); a job its runner was running when that
  session died ends as interrupted.
- **What a peer may do here.** A joined machine runs jobs from the hub it joined by default; a hub runs jobs from a
  joined machine only once the owner allows it. Per machine, `remote/settings.json` holds `acceptsJobs`, `trust`
  (`answers`: no job that names a project; `reads` and `changes`: jobs in an offered checkout, read-only until jobs
  that change files ship) and `hold`; `jobRoom` caps how many placed jobs run here
  at once (2 by default). A task that holds what looks like a secret is not sent at all.
  A placed job's worker reads only the checkout the job names, through its read tools and its read-only shell; a job that
  names no checkout reads nothing from disk. The credential and harness stores stay denied in every mode, YOLO included.
  The read-only shell is a command-text gate, not an operating-system sandbox: it judges the paths a command names and the
  paths its arguments reach, not the files a program opens on its own.
- **Commands** (inspection and override; placement itself needs none): `/remote jobs` lists the jobs placed from here
  and how many run here for other machines; `/remote run <name> <task>` gives a named machine a read-only job (in its
  checkout of this project when it offers it); `/remote cancel <name>` stops the jobs on it; `/remote hold <name>` and
  `/remote release <name>` stop and resume new jobs going there; `/remote trust <name> answers|reads|changes` and
  `/remote accept <name> on|off` set what it may do here; `/remote rotate <name>` gives a joined machine a new secret and
  disconnects it from any session, keeping its jobs.
- State: `remote/jobs/out/` (jobs placed from here), `remote/jobs/in/` (jobs admitted here), `remote/jobs/runner.json`,
  and `remote/jobs/journal.jsonl`, one line per job transition with ids and codes only. Finished jobs are kept seven
  days.

## Create and use a group

Use existing bot names in the member list:

```text
/team create implementation analyst,builder
/team open implementation
/team msg implementation Review the proposed change together.
```

While a group is open, ordinary text goes to that group. An `@member` mention targets a member
inside the open group; an unrelated bot name is refused rather than opening another conversation.

```text
/team members implementation analyst,builder,reviewer
/team delete implementation
```

The root manages membership. Worker grants retain their admitted scope, so membership additions do
not broaden an existing worker's grant. Removal prevents new group messaging. Deleting and
recreating a group name creates a new group identity and does not reuse the deleted group's memory
or worker conversations.

## Bot communication

Native workers use `bot_message` through the existing durable mailbox:

- `list` discovers peers in the worker's admitted conversation.
- `send` delivers to an existing peer and can request a reply.
- `reply` uses the original message ID; the mailbox selects its recipient, including the parent.

An idle peer wakes through the existing worker scheduler. Messages to a running peer arrive at a
request boundary. The worker's group is bound by the host; supplying another `teamId` cannot enter
another group's mailbox. Messages are coordination input and do not grant file, process, spawning
or advisor authority. A worker of a bot's own session lists no bot or group and replies only to its session root.

Default native worker grants include this broker. An explicit profile or tool list must include
`bot_message` and `workflow.message`; an already admitted worker does not gain tools retroactively.
Workers send findings and questions to their parent; the independent advisor serves the root only.

### Bots mail each other

A bot that answers in a session of its own holds `bot_mail`:

- `list` names the bots it may mail: every other bot that answers in a session of its own, not retired and not hosted
  on another machine.
- `send` (`to`, `message`) delivers the words to that bot's own session and returns at once. A mail never makes a bot
  and never brings a retired one back; a mail to the bot itself, to an id no bot has, to a retired bot, to a machine
  joined over the link or to a bot that runs only as a worker is refused in plain words to the sending bot, as is a mail
  to a bot whose inbox is full.

The mail is a turn of the receiving bot's own session, never a worker. Its turn is stamped as an agent's mail (`agent-mail`,
with the sender and its place in the chain): it is never your words, carries no evidence of what you asked, starts no
goal and grants no authority; what the receiving bot may do is what its own session may do. A mail a third party's words
reached carries that taint on. The receiver reads who wrote it and answers in plain words: when its turn ends, its last
words after the mail go back to the sender once, as a reply that is a turn of the sender's own session. A reply is not
answered again, and a reply sent twice (the receiver's turn ran again after its session reopened) is taken once. A chain
of mails holds at most 8; a send past that is refused and the bot is told to stop the exchange and report. Every refusal
reaches the sending bot in English, whatever language your interface draws in. A mail to a bot whose session is not
open, that another process hosts, or whose session is running a turn waits in its inbox as a `.mail.json` record, which
a build before this one never lists: a mail is given only to an idle session, as a turn of its own (never as a steer of
the running turn, nor in the session's own queue, which keeps no origin), so a mail waiting when pi stops is given after
it starts again as the same mail from the same sender. A mail the session took is kept as `.mail.json` renamed
`.mail.given.json` until the turn that took it ends; a host that stops before then leaves it, and the next host gives it
again unless the bot's transcript already holds it. A group's message and a routine's prompt to a bot that is running a
turn wait the same way. A bot's chat shows a mail as `alice wrote` (`alice escreveu`), and a group's message as
yours in that group.

### The orchestrator asks a bot

The orchestrator's `bot` tool `action ask` to a bot that answers in a session of its own gives the words to that session
as its turn, as mail from the orchestrator (`agent-mail` from `root:<session id>`, first in its chain): the bot reads that
it is another agent's words that grant no authority, and that its answer goes back to the orchestrator on its own. A third
party's words that decide the orchestrator's run make the mail a third party's. The ask returns once the bot's session took
the words (or queued them behind a running turn, as any mail waits); it is refused, in English, when the bot's session
cannot take them.

When the bot's turn ends, its last words after the ask are written, by whichever process hosted the bot, to a reply inbox
for the asking session (`state/orchestration/bot-replies/` in pi's home), which a build before this one never lists. The
orchestrator's session reads it while it runs and hands each reply to its conversation once, as the event that starts
its next turn, framed as the bot's words and not yours (a turn that ended without words, or on an error, says so). A reply
read again after a restart is taken once. A reply not read in 30 days expires, and the orchestrator
is told it did. Your chat shows the reply as `<bot> answered` (`<bot> respondeu`). An ask to a leader running a goal is
that goal's input, and an ask to a bot that runs only as a worker or to a machine joined over the link is taken as before.

### A worker messages a bot

A worker of the orchestrator's session that holds `bot_message` (a leader, a bot a leader made, a bot whose profile needs a
worker's run) reaches a bot that answers in a session of its own in that session, never through a worker for it. `list`
shows such a bot available with its session's state (`idle`, `queued` or `running`), and `send` gives the words to its
session as mail from that worker (`agent-mail` from `worker:<session id>:<worker>`, a third party's when a third party's
words reached the worker's run) and returns at once with the mail's id; `expectReply` does not
apply, since the answer always comes back. A send in a group's thread carries the group's room after the words, as a
group's message does, and is recorded in the group's log. A send replayed after a restart is the same mail and runs once.
Refusals reach the worker in English.

When the bot's turn ends, its answer is written to the same reply inbox as an ask's, and the orchestrator's session hands
it to the worker's mailbox once, as the bot's words and not the orchestrator's; when that worker has ended, the reply goes
to the orchestrator's conversation instead, saying so. A bot whose host does not take the mail (it refuses it, sets its
record aside as unreadable, or your stop covers it) answers that no answer comes and why, and a mail whose turn ended
where no answer was sent (its host stopped first) is answered from the bot's conversation by the next host to open it, so
the worker always hears back. A bot that runs only as a worker is reached as before.

A mail a worker sends in a leader's goal (the leader's, or a bot's working under it) holds the goal open until the reply
reaches that worker: the goal records the mail in its store (in this session's orchestration store, so a restart keeps
it), the reply starts the worker's next turn under the goal, and the goal settles only after that. The goal stops waiting
for a mail that was not sent, whose bot is retired, removed or no longer answers in a session of its own, or whose reply
expired unread; its deadline and budget bound the rest. The metered spend of the bot's turn that answered (its workers'
included, as of the turn's end) counts against the goal's budget once the reply is handed on, as a bot's worker turn under
the goal counted. A worker's mail is first in its chain unless a reply started the worker's turn, in which case it is one
hop past that reply, so a worker and a bot answering each other stop at the bound of 8 mails as bots mailing each other do
(a goal mails bots at most 128 times). A bot's
chat shows such a mail as `The orchestrator's worker <worker> wrote` (`O worker <worker> do orquestrador escreveu`).

## History and lifecycle

A new task does not require a new worker session. Automatic evidence gathering runs one question
at a time through ordinary worker admission, which reuses a compatible idle specialist. It does
not request an independent parallel copy. Busy, unreadable, or ambiguous contexts remain subject
to admission checks; the gatherer does not bypass them by creating another session.

The Workplan pane groups worker tasks by their agent identity. A terminal native task that never
acquired an agent binding is not a retained session. Retiring a worker removes it from retained
session counts but preserves its task records and transcript. A bot that runs as a worker reuses its
existing direct or group runtime for later messages; different groups remain separate conversations. A bot that answers in
a session of its own takes every message in that one session, a group's message included: its group turns sit beside its
direct chat, each labelled with the group's room, and a group's message carries the room as a worker's start does: the
end of the group's blackboard and the group's latest messages in its current incarnation (the message itself left out),
read when the message is sent. The blackboard lies outside the bot's workspace, so it reads it there, and when its turn
ends a line of its answer (or, for a turn that failed without one, why) is added to it, as a member running as a worker
adds one.

For a member that runs as a worker, group replies and automatic memory updates belong only to their originating group, and
group prompts exclude direct-chat summaries, the shared bot blackboard and other groups' history. Older unscoped
history remains available for root inspection and is not automatically imported into new group
conversations.

A group runtime binding is persisted before worker admission. A failed or uncertain start can leave
an inactive binding; this does not claim that a worker ran or completed. Bot reconfiguration and
retirement account for its direct and group generations.

Bot group communication works with System One enabled or disabled. It uses deterministic membership
and identity checks; it does not enable an evaluator. The separate [pi-chat mesh](pi-chat.md) connects
root sessions on one machine and is not the group mailbox used by native workers.
