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
made it), `sessions/` (its own session files; it continues the newest one, so it keeps one conversation whichever project you
message it from). A watch belongs to the conversation that armed it and is checked only by it, so the one place a bot's
session is chosen (when it loads) keeps that true: if it continues another conversation than the one its watches target,
those watches are cancelled and you are told. The record in the bot store stays the index; editing the bot's model, permissions or soul
refreshes the profile and applies to its session when it starts, so a bot that is working must be stopped first. The session
runs on the bot's model, under the rules a worker's own model is held to (a model that is gone, has no credentials, is paid by
API key without being the owner's choice while subscription models are usable, or that your model policy disallows refuses the
message, and every turn is held to them when it starts, a turn a watch's wake opens included; a refused model loads no session).
It never leaves that model: a model out of quota or refused for the account is not replaced by the account's default or a
failover model; the turn is refused with the reason and the bot answers again once its model can run. The session works in
your project directory. Like a worker, it never reaches an owner credential file (`.env`, keys): a read or a
command that would is refused before it runs, never run with the values masked. Its name and its soul replace the main agent's in its system prompt, so it never
introduces itself as the main agent. Its memory blackboard (`<agent dir>/memory/bots/<id>.md`, the same file a bot running as
a worker reads) opens its system prompt under its soul when the session starts; it can read the file, not edit it, and a
line from each finished turn is appended to it. It reads, and writes only when the bot has write access, and then as a worker writes: its file tools write inside your project directory only, never to a harness resource (skills, extensions, prompts, settings, hooks, git config); a read-only bot has a shell whose
commands are judged one by one, as a read-only worker's are (nothing that edits, creates a file or reaches the network runs,
in every execution mode). A turn is bounded by `workerDelegation.maxUsd` (and the main session's own ceiling) when one is
set, and what each turn spends is added to the main session's cost. Its tool loop is supervised as a worker's is: repeated broad validation with no new change is steered back to the work, and a turn System One judges stalled or off its message is steered, redirected or stopped; the directive shows in its chat. It reads the settings the main session reads, again each time the main session changes them, and runs
System One as the main session does at each use (on or off, the same provider and connection; turning System One off or on in settings turns it off or on for a loaded bot too): your messages to it are judged as your
messages to the main session are, it holds the `systemone` tool, and its System One evidence is kept in its home
(`typesafe-reviews/`). A bot is a session of its own, so its edge grants are its own conversation's plus your settings'; no other session's
conversation counts, the main session's included (a bot running as a worker takes the main session's grants). To give
a bot standing authority, grant the class in settings (`edge.allow`, which stands for every session and every bot); to
authorize one action, say so in the bot's chat, where System One reads your words as it does in the main session (such a
grant is not standing). `/edge allow` is a command of the main session: typed while a bot's chat is open, it still grants
the main session's conversation, since a bot's chat takes no slash command. It is loaded on its first message, kept
while a turn runs or input is queued, and closed after ten idle minutes or
when the session that hosts it ends. Its answers are read in its chat (the roster marks them unread); they do not reach the
orchestrator as a worker's terminal does.

A bot waits on its own work with `task_watch`, the tool a worker holds for it: a one-shot watch on a file, a managed
process, a process id, a port, a command or a page, with an end time at most 24 hours ahead, at most eight at a time
whatever armed them (the bot can change or delete none). A command or page is first admitted as the call its own shell or
fetch tool would make, by its own gate (System One's operation judgment included), so a bot without that tool arms
nothing, and a read-only bot's command is held to its read-only shell at arming and at every check. The bot's own session
samples its watches and wakes it with the event (a running turn is steered, an idle bot starts a turn); no other session
samples or delivers them. While it holds a live watch its session stays loaded past the idle close, a process that starts
or sees its host let it go or die opens it again (only where it works in the directory that session worked in; the phone session
never does), and retiring the bot drops its watches. The roster shows each bot's live watch count with the operator bar's
ring (`◌n`), read from the store in every session.

**Every open session sees every bot, and closing a session loses none.** Nothing about a bot depends on the session that
created, messaged or hosts it: the bot list is the bot store, the chat is read from the bot's home, and the unread mark is
on the bot's record in the store (`lastMessageAt`, `lastReadAt`), which every session watches. One process hosts a bot at a
time (`bots/<id>/host.lock`), and inside a process one host serves every root session on the same agent directory (the last
root to close stops it). Inside that host, a bot's settings follow a change any of those root sessions makes, and a bot
loaded by a message works in the sending session's directory, with its turns' warnings and spend going to that session
(to another open root session once it closes); the lock record carries that host's token, so a second host is told apart from the first even in
one process. The host publishes what the session is doing in `host-state.json`, and a watch over the bot homes
tells every other session's roster and open chat when the conversation, that state or the history changed. A second session
shows the bot running, queued or idle from that file (trusted only while the lock names a live process, so a killed host
leaves no stale "running"), and its chat from the session files. Messaging a bot another session hosts is refused with a
line naming that session (messages do not cross sessions until mail arrives), and `/bot stop` of a bot working in another
session says to stop it there. A session started after every other one closed lists each bot with its whole conversation.

What ran before a bot had a session of its own is part of that conversation. Those worker conversations live under the
orchestration directory of whichever session messaged the bot, and only that session's own transcript says which runtime
was whose, so `bots/<id>/history.json` indexes them by reference (a path-free transcript reference and a time range, bounded
to the newest 200; nothing is copied), and the startup cleanup of old session directories keeps any directory holding a run
an index references. The index is built by one streamed scan of the session files, off the screen's
drawing path (the chat shows what it has until the scan ends). The scan runs once for the agent directory
(`state/bots/history-scan.json` marks it done), never again in any process and never for a bot made later; afterwards each
worker-path start of a bot adds its own run as it is bound. A process of an older build, still running after the scan ran,
does not add the runs it starts (it has no index to write), so those runs are missing from the chat. The chat shows those earlier conversations in time order with the bot's own session. A chat reads them from disk again only when the index or
a run transcript it shows changed; otherwise it keeps what it drew.

Until later phases move them, these still run as workers of the session that sends them: group messages (the group's
conversations), the orchestrator's `bot ask`, routine sends, leaders, the bots a leader made and machines joined over the
link. A bot made from a worker profile runs as a session of its own too, on what the worker admission compiles for that
profile at every run: the admitted model and thinking, the plan's tools, its working directory, its read roots (a profile
that confines reads confines the read tools, `repo_read`, `lookup`, the read-only shell and its watches to them), its write
roots and read-only grant, a capability ceiling of the plan's capabilities held by the session's tool gate, the soul and
resources a worker of it carries, and a turn bound of the profile's cost budget when it is lower than the worker and
session bounds. A run on a session built from an older compile (the profile, a model pin or the worker policy changed
since) is refused and the idle session is rebuilt. A profile that needs an independent verifier of each claim, names a
tool a session does not hold, or sets a token, wall-clock, attempt or tool-call limit (which only a worker's run counts)
keeps the bot a worker; a profile the admission refuses refuses the message in the owner's words. One predicate decides it
for the message and for the bot's host alike: a bot whose record leaves the session path (it becomes a leader, a leader's,
or its profile now needs a worker) has its idle session closed and its watches dropped, and no session of it is opened
again, so it never answers in two conversations at once. A bot's session has no subagents, routines, goals or `bot` tool yet (its only routine tool is `task_watch`). A bot that only ever talked through those
paths has no session of its own: its chat shows its earlier conversations from its history index, in any session, and its
last summary when none can be read.

## Bot names

A bot has an id and a display name. The id is the stable handle (`trello-scout`: what you type after `@` and in `/bot msg`);
the display name is what the roster shows (`Trello Scout`). A bot made on the fly with no id (the orchestrator's `bot`
tool, a leader's `bot_message create`) is named from its purpose, its description or soul (`release-notes-writer`), and a
taken name gets a number (`release-notes-writer-2`); the answer says which id it chose. `/bot rename <id> <name...>` changes
the display name only. The roster row shows the name and its badges; the selected bot's model appears as a hint on the line
below. A bot created without a model runs on what a worker would (the worker profile, else the subscription-routed efficient
model), not on the session's own model.

## Who creates bots

Bots are created on the fly, for whatever purpose you have:

- You create one with `/bot new <id> [--write] [model] [soul...]`.
- The orchestrator (the root session, always the same one) creates one with its `bot` tool: `action create` with an
  `agentId`, a `soul` (the bot's standing instructions), an optional `model` and `canWrite`.
- A **leader** creates one with `bot_message` `action create`, with the same fields. Only you make a bot a leader:
  `/bot lead <id>` and `/bot unlead <id>` (they take effect from the bot's next worker start; `/bot list` marks a leader).

Every other bot cannot create bots. It asks a leader (leaders are marked in its `bot_message` peer list) or its parent in its
report. Bounds that always hold: a leader cannot make a standing leader, grants `canWrite` only when it can write itself, and keeps
at most 12 bots it created; a bot name that exists, retired or not, is refused. The store records who created each bot
(`owner`, `root` or the leader's id). A bot a leader made is told to ask that leader, by name, for any bot it needs. With
`leaders.maxDepth` set to 2, a leader that works a goal may hand a part of it to a leader of its own (`bot_message` `action lead`);
that part's outcome goes back to the leader that handed it on, and the goal ends only after its parts have.

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
  (`/lead pause <leader>`). A leader leading an open goal cannot be retired; cancel the goal first.
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
  and reports its end to the session that placed it, once.
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
or advisor authority.

Default native worker grants include this broker. An explicit profile or tool list must include
`bot_message` and `workflow.message`; an already admitted worker does not gain tools retroactively.
Workers send findings and questions to their parent; the independent advisor serves the root only.

## History and lifecycle

A new task does not require a new worker session. Automatic evidence gathering runs one question
at a time through ordinary worker admission, which reuses a compatible idle specialist. It does
not request an independent parallel copy. Busy, unreadable, or ambiguous contexts remain subject
to admission checks; the gatherer does not bypass them by creating another session.

The Workplan pane groups worker tasks by their agent identity. A terminal native task that never
acquired an agent binding is not a retained session. Retiring a worker removes it from retained
session counts but preserves its task records and transcript. A bot's later messages reuse its
existing direct or group runtime; different groups remain separate conversations.

Group replies and automatic memory updates belong only to their originating group. Group prompts
exclude direct-chat summaries, the shared bot blackboard and other groups' history. Older unscoped
history remains available for root inspection and is not automatically imported into new group
conversations.

A group runtime binding is persisted before worker admission. A failed or uncertain start can leave
an inactive binding; this does not claim that a worker ran or completed. Bot reconfiguration and
retirement account for its direct and group generations.

Bot group communication works with System One enabled or disabled. It uses deterministic membership
and identity checks; it does not enable an evaluator. The separate [pi-chat mesh](pi-chat.md) connects
root sessions on one machine and is not the group mailbox used by native workers.
