# Bots and group chats

Bots have persistent identities and model settings. Teams are group chats: each bot has a separate
conversation and memory in each group. Direct bot chats remain separate from group chats.

Bot creation by the owner or root uses the selected, configured, or default model. It does not opt in
to model task-fitness judgments. These judgments require `modelRouter.fitnessGate: true`, the router,
and System One. With that gate off, no task-fitness judgment is required at startup, queued dispatch,
or execution. Authentication, model availability, permissions, capacity, and lifecycle checks remain
in force. See [Model Router settings](settings.md#model-router).

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
report. Bounds that always hold: a leader cannot make a leader, grants `canWrite` only when it can write itself, and keeps at
most 12 bots it created; a bot name that exists, retired or not, is refused. The store records who created each bot
(`owner`, `root` or the leader's id).

## Machines as bots

Any machine can host a hub, join a hub, or do both; nothing is tied to one machine. A machine that joins a hub shows up there
as a bot with a computer mark (💻 remote) and the machine's name. You message it like any bot (`/bot msg <name> ...`, its
chat, a group), and its answers come back into its chat.

On the hub: `/remote listen [port] [host]` turns the hub on (loopback by default), `/remote add <name>` lets a machine join
as a bot named `<name>` and prints a join token once, `/remote revoke <name>` cuts it off and retires its bot, and
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
