# Channels

A channel connects a chat or mail transport to an open root session. Pi ships Telegram, Slack and Gmail (below); other transports still come from a deployment wrapper (a server, a bot runner, an SDK host) that implements the provider and registers it. The core decides everything with a cost or a consequence: whether the channel starts, which messages may start a turn, how many turns a day it may start, and whether an answer is sent or kept for the owner.

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

## Gmail

Pi ships a Gmail transport: one mailbox, plain-text mail, over the Gmail REST API (HTTPS only; no IMAP, no SMTP, no push subscription, no listening port). It starts by itself when `channels.gmail` has an explicit policy and no wrapper registered a provider named `gmail` (a wrapper's provider wins), and reads the mailbox's new mail once a minute. Setup:

1. In the Google Cloud console, create a project, enable the Gmail API and configure the OAuth consent screen. Google expires the refresh token of an External app whose publishing status is Testing after 7 days; set the app In production, or use an Internal app of a Workspace organization.
2. Create an OAuth client ID of type Desktop app and keep its client id and client secret.
3. Open `https://accounts.google.com/o/oauth2/v2/auth?client_id=<client id>&redirect_uri=http://127.0.0.1:8765&response_type=code&access_type=offline&prompt=consent&scope=https://www.googleapis.com/auth/gmail.readonly%20https://www.googleapis.com/auth/gmail.send` in a browser, sign in as the mailbox and allow access. The browser then fails to load `http://127.0.0.1:8765/?code=…`; copy the `code` value from its address bar.
4. Exchange the code for a refresh token with the secrets on standard input, out of the shell history and the process list: run `curl -s https://oauth2.googleapis.com/token -d @-`, paste `client_id=<client id>&client_secret=<client secret>&code=<code>&redirect_uri=http://127.0.0.1:8765&grant_type=authorization_code`, press Ctrl-D, and keep the `refresh_token` of the answer.
5. Write `~/.pi/agent/channels/gmail.credentials`, readable by you only, holding exactly `{"client_id": "…", "client_secret": "…", "refresh_token": "…"}`: `(umask 077; mkdir -p ~/.pi/agent/channels; cat > ~/.pi/agent/channels/gmail.credentials)`, paste, Ctrl-D.
6. Add `"channels": { "gmail": { "mode": "explicit", "allowedSenders": ["you@example.com"] } }` to `~/.pi/agent/settings.json`. Addresses compare without regard to case.

The credentials are read when the channel starts and again on each retry after Google rejected them, and are never written anywhere else: the client secret and the refresh token go only to Google's token endpoint, the access token only into the Gmail calls' `Authorization` header. A missing file, a file other users can read, or one that does not hold exactly those three fields shows as `suspended` with the file named; credentials Google rejects, a refresh token without the `gmail.readonly` scope, and a project without the Gmail API each show as `suspended` with their own reason while reading is retried with backoff.

A first start reads from the mailbox's current position, so mail already in it is not read. The read position (`~/.pi/agent/state/channels/gmail-cursor.json`: a digest of the mailbox address and a history id) moves past a mail only once Pi recorded it, so a mail Pi could not record is read again. When Gmail no longer keeps the history from that position, Pi says so once and reads on from the current one.

A sender is the `From` address in lower case. It is verified only when the first `Authentication-Results` header, the one Gmail writes (`mx.google.com`), shows DMARC passing for the `From` domain, or DKIM signed by that domain and SPF passing for it; a mail that fails is held unverified, and the owner is not told of it. The sender chose the address, so a held verified sender's notice does not name it: the `channel_reply` tool's `list` action shows it, fenced as data, for a day. Mail from the mailbox itself, automatic replies (`Auto-Submitted` other than `no`, `Precedence: auto_reply`), bounces (an empty `Return-Path: <>`), list and bulk mail (`List-Id`, `Precedence: bulk`, `list` or `junk`, `X-Auto-Response-Suppress`), mail outside the inbox (sent, drafts, spam, trash) and mail with no plain-text part Pi can read (HTML only, an unknown charset) never reach the journal. A mail larger than 4 MiB, an answer that is not a mail, and a mail Gmail refuses with a client error on three reads in a row are skipped with a warning each; a read that fails on the network or on Gmail's side is made again. The turn gets the subject and the first 20 KB of the plain-text body, without `>` quoted lines, the "On … wrote:" attribution and an "Original Message" separator with its header lines; text written below or between quoted lines is kept, and so is an original message an "Original Message" separator introduces without `>` marks. One thread is one conversation. Replies are plain text, up to 8000 characters a mail, sent from the mailbox to the `From` address in the same thread (subject `Re: …`, `In-Reply-To` and `References` set, and `Auto-Submitted: auto-replied` so the other side's responder does not answer), about one mail a second per recipient.

Limits of the verification:

- The first `Authentication-Results` header is trusted only because Gmail adds its own on top of a mail that arrives through its servers. Mail that reaches the inbox another way (fetched from another account by POP, imported or inserted through the API, appended by IMAP) can carry a header the sender wrote in that place, and Pi cannot tell it apart. Keep such paths off the mailbox Pi reads.
- Verification covers the `From` domain, not the address. Anyone who can send authenticated mail for that domain (a colleague whose mail server does not enforce the `From` address, a shared sending service the domain's SPF record includes) passes as any address in it. An allowlisted address is only as trustworthy as its domain's mail policy.

## Registering a provider

```typescript
import type { ChannelProvider } from "@caupulican/pi-adaptative";

const mail: ChannelProvider = {
  name: "mail",
  capabilities: { maxMessageChars: 4000, markdown: false },
  // The sender writes their own address, so a notice never names it; addresses compare in lower case.
  senderIds: { assignedBy: "sender", normalize: (id) => id.toLowerCase() },
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

- **Held, never woken.** A sender the provider did not verify, or one `allowedSenders` does not list, is held: the journal counts it with a digest of the sender id and none of the sender's text, and no turn starts; the id of a verified sender the notice does not name is kept as is for a day so `list` can show it. For a verified sender the owner is told the `allowedSenders` key to add them to, never the sender's label or words: once per sender a day, at most three senders a channel a day. The notice names the id only when the platform assigned it (the provider's `senderIds.assignedBy` is `platform`, as for Telegram and Slack), it is plain (at most 64 letters, digits, `.`, `_`, `@`, `+`, `-`) and the notice fits its one line; any other id (an id the sender chose, such as a mail address, and the ids of any provider that does not say) is shown instead by the `channel_reply` tool's `list` action, fenced as data, for a day or until the owner adds it. A provider's `senderIds.normalize` puts ids in the one form they compare in (Gmail: lower case), applied to `allowedSenders` entries as well. A conversation with `maxPendingPerConversation` messages already waiting holds further ones the same way.
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

The daemon runs one headless session per channel, in its directory. It is a child session: no memory, no routines, no proactive work, System One off, and only the `read`, `grep`, `find` and `ls` tools. Those tools reach only that directory and never the agent directory or the private paths every lane is denied (credentials, `auth.json`, settings, memory, sessions, the channel tokens and journals, and the directory's own `.pi/settings.json`): such a call is refused before it runs. Its model is the default model the owner's settings give that directory (a repository's own settings are not read); a model with no price is refused, because its spend could not be bounded. The channel's policy, bounds and origin rules apply exactly as in an open session: the senders' words stay a third party's, `replyMode` decides whether the answer is sent, and a draft waits for the owner.

Each turn the daemon delivers also counts against the away spend bound its routines run under. A turn that spends more than `routines.away.maxUsdPerRun` is stopped and its conversation gets no reply. Across routine runs and channel turns together, the daemon delivers no turn once `routines.away.maxUsdPerDay` has no room in the last 24 hours. A turn counts from the moment it is offered to the session until 24 hours after it was delivered: at least its full per-run bound while it is offered or runs and when it ended without an answer (what it spent when that was more), and what it spent once it was answered. A channel no longer served away still counts what its turns spent in those 24 hours.

A model with no price, a session that cannot open, or a channel with no transport is reported once and leaves the messages with their transport; the daemon tries again after a wait that starts at one minute and doubles up to one hour, and at its next tick (every 10 seconds) after `auth.json`, `models.json` or that directory's model settings change. Stopping the daemon, or a settings change that no longer serves the channel away or names another directory, stops the channel's turn, keeps an answer it already had as a draft, and records any other turn as unanswered with what it spent.

An open session that serves the channel takes it from the daemon at once: the daemon stops its transport, and the answer of a turn it was running is kept as a draft, because the daemon no longer runs the channel. Once that turn is settled (or the daemon is gone), the session tells the owner, in one notice with their next turn, what the daemon left; it sees the draft through a watch on the journal directory, and without one at its next channel pass (its next turn, an inbound message or a settings change). The notice holds the daemon's waiting drafts by id and reason (as many as fit the notice's one line, the rest counted), how many messages it dropped after 24 hours, how many of its conversations got no reply, and how many messages it held, by reason. The notice names no sender and carries none of their words; a stranger the daemon held is only counted, and is told by id when it writes while a session serves the channel. Each record is marked told in the same journal change that decides to tell it, so no later session tells it again; a notice dropped before it was saved takes its marks back, so the next pass or session tells it. A session that does not hold the channel tells nothing, and one with no saved transcript entry yet tells at its first. A journal written by an earlier build has its gaps and the daemon's drafts read as told. A draft's reason keeps a send error's text only when Pi ships the transport, the daemon's included. Gaps recorded while an open session served the channel are told one notice each. When the session closes, the daemon takes the channel back. A session that wants a channel another open session serves takes it as soon as that session gives it up, without waiting for a settings change. `/bot daemon status` and `get_autonomy_status` show who serves each such channel and how many of the daemon's drafts wait. With always-on enabled (`routines.away.autostart`), the daemon also serves these channels after a reboot.

## Delivery guarantees

- Inbound: at least once. A crash between the session accepting a batch and recording it may deliver the batch again on the next start.
- Outbound: at most once. A reply is recorded as sent before it is handed to the provider, so a crash during the send loses it rather than sending it twice.
- An unreadable journal is moved aside (`<name>.json.unreadable-<time>`), a new one starts, and the owner is told that its waiting messages and drafts are not delivered.
