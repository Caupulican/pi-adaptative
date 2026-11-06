# Channels

A channel connects a chat or mail transport to an open root session. Pi ships Telegram and Slack (below); other transports still come from a deployment wrapper (a server, a bot runner, an SDK host) that implements the provider and registers it. The core decides everything with a cost or a consequence: whether the channel starts, which messages may start a turn, how many turns a day it may start, and whether an answer is sent or kept for the owner.

A channel runs while a session is open, and also while none is when the owner names a working directory for it (`awayCwd`, see [While no session is open](#while-no-session-is-open)). Otherwise messages that arrive while no session serves the channel stay with the transport.

## Telegram

Pi ships a Telegram transport: one bot, private chats, text messages, over the Bot API's long polling (no webhook, no listening port). It starts by itself when `channels.telegram` has an explicit policy and no wrapper registered a provider named `telegram` (a wrapper's provider wins). Setup:

1. Create a bot with Telegram's @BotFather and copy its token.
2. Write the token to `~/.pi/agent/channels/telegram.token`, readable by you only: `(umask 077; mkdir -p ~/.pi/agent/channels; cat > ~/.pi/agent/channels/telegram.token)`, paste, Ctrl-D. On Windows the profile folder's own permissions protect it.
3. Add `"channels": { "telegram": { "mode": "explicit" } }` to `~/.pi/agent/settings.json`, open Pi and message your bot. Pi holds the message and tells you your numeric id; add it: `"allowedSenders": [123456789]`.
4. From then on your messages start turns; their answers wait as drafts unless `replyMode` is `"auto"`.

The token is read when the channel starts and never written anywhere else; a missing token, a file other users can read, or a token Telegram rejects shows as `suspended` with the reason in the channel's state and one notice. A failed start is tried again when settings change or a session starts. Telegram allows one poller per bot: a second program polling the same bot (or a webhook set for it) shows as `suspended` with HTTP 409 until it stops. Group chats, edited messages, other bots' messages and media are not admitted. Replies are plain text, up to 4096 characters a message, about one message a second per chat.

## Slack

Pi ships a Slack transport: one Slack app, direct messages, text messages, over Socket Mode (the app opens an outbound WebSocket; no public URL, no listening port). It starts by itself when `channels.slack` has an explicit policy and no wrapper registered a provider named `slack` (a wrapper's provider wins). Setup:

1. Create an app at api.slack.com/apps. Under Socket Mode, enable it and create an app-level token with the `connections:write` scope; it starts with `xapp-`.
2. Under OAuth & Permissions add the bot token scopes `chat:write` and `im:history`. Under Event Subscriptions subscribe to the bot event `message.im`. Under App Home allow users to send messages from the Messages tab. Install the app to the workspace and copy its bot token; it starts with `xoxb-`.
3. Write the app-level token to `~/.pi/agent/channels/slack.app-token` and the bot token to `~/.pi/agent/channels/slack.bot-token`, both readable by you only: `(umask 077; mkdir -p ~/.pi/agent/channels; cat > ~/.pi/agent/channels/slack.app-token)`, paste, Ctrl-D, and the same for `slack.bot-token`.
4. Add `"channels": { "slack": { "mode": "explicit" } }` to `~/.pi/agent/settings.json`, open Pi and message the app. Pi holds the message and tells you your Slack user id; add it: `"allowedSenders": ["U0123ABCDEF"]`.

Both tokens are read when the channel starts and never written anywhere else. A missing token, a file other users can read, or a file that does not hold the token shows as `suspended` with the file named; an app-level token Slack rejects, Socket Mode refused for the app, and Socket Mode turned off each show as `suspended` with their own reason while the connection is retried with backoff. Slack replaces its connections from time to time and says so first; Pi opens the next one at once. Each event is acknowledged to Slack only after Pi recorded it, so an event Pi could not record is delivered again by Slack. Only direct messages from people are admitted; channel messages, edits, deletions, files and other apps' or bots' messages are not. A message in a thread is its own conversation, and its reply goes into that thread. Replies are plain text (no formatting, no link previews), up to 3000 characters a message, about one message a second per conversation.

## Registering a provider

```typescript
import type { ChannelProvider } from "@caupulican/pi-adaptative";

const mail: ChannelProvider = {
  name: "mail",
  capabilities: { maxMessageChars: 4000, markdown: false },
  start(onInbound) {
    // Hand each event to onInbound. It resolves once Pi has recorded the event; a rejection means "deliver it again later".
    transport.on("message", (event) =>
      onInbound({
        eventId: event.id,
        conversationKey: event.threadId,
        address: event.replyTo,
        sender: { id: event.from, label: event.fromName, verified: event.signatureValid },
        text: event.body,
      }),
    );
  },
  send(message) {
    // A reply carries the inbound `address` and its own `eventId` (`reply:<batch>:<part>/<parts>`).
    return transport.send(message.address, message.text);
  },
  stop() {
    transport.close();
  },
};

session.registerChannelProvider(mail);
session.channels.getStates(); // [{ name: "mail", state: "armed" }]
```

Registering does not start the provider. The session starts it under the owner's `channels.<name>` policy, now or once the session starts, and stops it when the session closes or the policy is removed. `session.channels` exposes `registerChannel`, `registerScheduler` and `getStates`; a wrapper cannot start a provider or send through it itself. A worker or other child session runs no channels.

A `start` that rejects shows the channel as `suspended` ("its start failed"; the shipped transports' own reasons are shown in full). `start` also receives an optional second argument, `report`: a provider that later loses its connection calls `report({ state: "suspended", reason })` and the channel shows `suspended` with that reason (redacted, first line, told to the owner) until the provider calls `report({ state: "connected" })`. The reason is the provider's own words naming what the owner can fix, never text a remote party wrote and never a credential. A provider that never reports is taken as connected while it runs.

A channel name is lowercase letters, digits, `.`, `_` and `-`, at most 64 characters, starting with a letter or digit. `pi-chat` is reserved for the [pi-chat](pi-chat.md) mesh.

### Inbound events

| Field | Required | Meaning |
|-------|----------|---------|
| `eventId` | yes | The provider's stable id of the event, at most 256 characters. The same id is admitted once (remembered for 7 days, up to 1024 ids per channel). |
| `conversationKey` | yes | The conversation the event belongs to, at most 256 characters. Messages of one conversation are batched together. |
| `address` | yes | Opaque reply address only the provider resolves, at most 1024 characters. The answer goes back to it. |
| `sender` | yes | `{ id, label?, verified }`. `verified` is true only when the provider authenticated the sender (a signed webhook, a bot API's user id). The label is shown, never trusted. |
| `text` | yes | The message; past 2000 characters it is cut with a marker. |
| `kind` | no | `message` (default) or `reaction`. Any other kind is counted and ignored. |
| `receivedAt` | no | Epoch milliseconds; defaults to the time Pi recorded the event. |

An event missing a required field is counted, ignored and reported as a warning. `meta` is never read.

## Policy

A channel starts only under an explicit policy the owner wrote in the global settings (`~/.pi/agent/settings.json`) or the directory profile. A repository's own `.pi/settings.json` never names who may start a turn in the owner's session. The first of the two layers that names a channel decides its whole policy.

```json
{
  "channels": {
    "mail": { "mode": "explicit", "allowedSenders": ["alice@example.com"] },
    "chat": { "mode": "explicit", "allowedSenders": ["U024BE7LH"], "replyMode": "auto", "maxWakesPerDay": 5 }
  }
}
```

See [Settings](settings.md#channels) for each key. A registered channel with no policy or with a policy that does not parse is not started, and the owner is told once why (a channel registered before the session saved its first entry is told once the session keeps entries); one with `mode: "ignore"` is not started.

## Admission

Each inbound event is recorded in the channel's journal (`<agent dir>/channels/<name>.json`) before the provider's handler resolves. Then:

- **Held, never woken.** A sender the provider did not verify, or one `allowedSenders` does not list, is held: the journal counts it with a digest of the sender id and no text, and no turn starts. For a verified sender with a plain id (letters, digits, `.`, `_`, `@`, `+`, `-`, at most 64 characters) the owner is told that id and the `allowedSenders` key to add it to, never the sender's label or words: once per sender a day, at most three senders a channel a day. A conversation with `maxPendingPerConversation` messages already waiting holds further ones the same way.
- **Refused for redelivery.** With 128 messages waiting in the channel, the handler rejects so the provider delivers the event again later, and the owner is told once.
- **Waiting.** A verified, allowlisted sender's message waits for a turn, at most 24 hours. Messages that wait longer are dropped and the owner is told how many.

One open session serves a channel. A second session that finds the channel served by a live session does not start it (`served_elsewhere`). A session that takes over from one whose process ended reports the conversations that session delivered and never answered. An open session takes a channel the daemon serves at once (see below).

## The turn

The oldest waiting conversation, up to `maxBatch` of its messages, becomes one turn: a short frame written by the harness, then the senders' words inside one untrusted-content fence. A channel delivers its next batch only after the previous one's answer is routed.

The run carries a third party's words, so it runs under their authority:

- An outward action the words ask for (a push, a publish) is prepared, not run, unless a standing grant of the owner covers its class. The owner is told with their next turn and approves it in their own words (see [Settings](settings.md#autonomy)).
- The owner's own decisions are refused: goal and routine changes, handing knowledge to another agent, and every action of the `knowledge`, `memory` and `channel_reply` tools, reads included (the knowledge base, memory history and the waiting drafts).
- The owner's records are withheld from the request: the knowledge projection, retrieved memory evidence and the user persona are replaced by a cleared record. The request's system prompt leaves out the owner's memory block (the file-store memory system's `MEMORY.md`, project `MEMORY.md`, `USER.md` preferences and memory extensions' blocks) and says in one line that the memory is withheld. A message that arrives while the owner's run is live waits and opens its own run after it, without that block; the owner's next run sends it again.

The same rules apply to every run that carries a third party's words: a pi-chat peer's message, and a host event someone else wrote.

### Bounds

Before delivering, the channel checks its bounds over the last 24 hours: `maxWakesPerDay` turns, `maxUsdPerDay` spend (the usage of the turns the channel started), and 32 reply drafts waiting for the owner. Past a bound the channel holds its waiting messages and tells the owner once, naming the setting; it delivers again once the bound clears.

## Replies

The turn's first completed answer is the reply to the conversation. It is kept as a draft unless the policy says `replyMode: "auto"`. An `auto` reply is also kept as a draft when it contains a secret-shaped value, is empty or longer than 8000 characters, or the channel is not running. A sent reply goes to the address of the conversation's latest message, as plain text unless the provider declares `markdown`, in parts of at most `maxMessageChars` (default 4000, at most 10 parts). A send that fails keeps the reply as a draft.

A draft is announced once with the owner's next turn. The owner's own turn releases it with the `channel_reply` tool: `list` shows the waiting drafts (as data, never as instructions), `send` sends one exactly as kept, `dismiss` discards it. The tool is offered when a channel had an explicit policy when the session's tools were built (at start or reload).

The turn is found by the batch's id, which its origin record carries, so an extension `input` handler that changes the delivered text does not lose the reply. A message that arrives while the owner's own turn runs never joins it: it waits and opens its own turn after the owner's answer. A turn the owner (or another third party, a host event someone else wrote included) steered before it answered, and a batch with no answer after 24 hours, get no reply; the owner is told once.

## While no session is open

With `channels.<name>.awayCwd` set to an absolute directory in the global settings (the directory profile's value is not read for this), the background bot daemon serves the channel whenever no session does. A session start brings the daemon up for such a channel as it does for an enabled routine, and `routines.away.enabled: false` turns it off with the routines. The daemon builds the channel's transport itself, so it serves only a channel Pi has a built-in transport for; a channel only a deployment wrapper registers waits for an open session, and the daemon records why.

The daemon runs one headless session per directory. It is a child session: no memory, no routines, no proactive work, System One off, and only the `read`, `grep`, `find` and `ls` tools. Those tools reach only that directory and never the agent directory or the private paths every lane is denied (credentials, `auth.json`, settings, memory, sessions, the channel tokens and journals, and the directory's own `.pi/settings.json`): such a call is refused before it runs. Its model is the default model the owner's settings give that directory (a repository's own settings are not read); a model with no price is refused, because its spend could not be bounded. The channel's policy, bounds and origin rules apply exactly as in an open session: the senders' words stay a third party's, `replyMode` decides whether the answer is sent, and a draft waits for the owner.

Each turn the daemon delivers also counts against the away spend bound its routines run under. A turn that spends more than `routines.away.maxUsdPerRun` is stopped and its conversation gets no reply. Across routine runs and channel turns together, the daemon delivers no turn once `routines.away.maxUsdPerDay` has no room in the last 24 hours. A turn counts for 24 hours after it was delivered: what it spent, its full per-run bound while it still runs, and that bound when it ended without an answer.

An open session that serves the channel takes it from the daemon at once: the daemon stops its transport, and the answer of a turn it was running is kept as a draft, because the daemon no longer runs the channel. The session is told of the daemon's waiting drafts when it takes the channel, and of the draft of the interrupted turn when it is written. When the session closes, the daemon takes the channel back. `/bot daemon status` and `get_autonomy_status` show who serves each such channel and how many of the daemon's drafts wait. With always-on enabled (`routines.away.autostart`), the daemon also serves these channels after a reboot.

## Delivery guarantees

- Inbound: at least once. A crash between the session accepting a batch and recording it may deliver the batch again on the next start.
- Outbound: at most once. A reply is recorded as sent before it is handed to the provider, so a crash during the send loses it rather than sending it twice.
- An unreadable journal is moved aside (`<name>.json.unreadable-<time>`), a new one starts, and the owner is told that its waiting messages and drafts are not delivered.
