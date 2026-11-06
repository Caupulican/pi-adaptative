# Channels

A channel connects a chat or mail transport to an open root session. Pi ships no transport: a deployment wrapper (a server, a bot runner, an SDK host) implements the provider and registers it. The core decides everything with a cost or a consequence: whether the channel starts, which messages may start a turn, how many turns a day it may start, and whether an answer is sent or kept for the owner.

Channels run only while a session is open. Messages that arrive while no session serves the channel stay with the transport; Pi does not run channel turns in the background bot daemon.

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

See [Settings](settings.md#channels) for each key. A registered channel with no policy or with a policy that does not parse is not started, and the owner is told once why; one with `mode: "ignore"` is not started.

## Admission

Each inbound event is recorded in the channel's journal (`<agent dir>/channels/<name>.json`) before the provider's handler resolves. Then:

- **Held, never woken.** A sender the provider did not verify, or one `allowedSenders` does not list, is held: the journal counts it with a digest of the sender id and no text, and no turn starts. A conversation with `maxPendingPerConversation` messages already waiting holds further ones the same way.
- **Refused for redelivery.** With 128 messages waiting in the channel, the handler rejects so the provider delivers the event again later, and the owner is told once.
- **Waiting.** A verified, allowlisted sender's message waits for a turn, at most 24 hours. Messages that wait longer are dropped and the owner is told how many.

One open session serves a channel. A second session that finds the channel served by a live session does not start it (`served_elsewhere`). A session that takes over from one whose process ended reports the conversations that session delivered and never answered.

## The turn

The oldest waiting conversation, up to `maxBatch` of its messages, becomes one turn: a short frame written by the harness, then the senders' words inside one untrusted-content fence. A channel delivers its next batch only after the previous one's answer is routed.

The run carries a third party's words, so it runs under their authority:

- An outward action the words ask for (a push, a publish) is prepared, not run, unless a standing grant of the owner covers its class. The owner is told with their next turn and approves it in their own words (see [Settings](settings.md#autonomy)).
- The owner's own decisions are refused: goal and routine changes, handing knowledge to another agent, the `knowledge`, `memory` and `channel_reply` tools.
- The owner's records are withheld from the request: the knowledge projection, retrieved memory evidence and the user persona are replaced by a cleared record. The memory block of the session's fixed system prompt (the file-store memory system's `MEMORY.md`, project `MEMORY.md` and `USER.md` snapshot) is not withheld.

The same rules apply to every run that carries a third party's words: a pi-chat peer's message, and a host event someone else wrote.

### Bounds

Before delivering, the channel checks its bounds over the last 24 hours: `maxWakesPerDay` turns, `maxUsdPerDay` spend (the usage of the turns the channel started), and 32 reply drafts waiting for the owner. Past a bound the channel holds its waiting messages and tells the owner once, naming the setting; it delivers again once the bound clears.

## Replies

The turn's first completed answer is the reply to the conversation. It is kept as a draft unless the policy says `replyMode: "auto"`. An `auto` reply is also kept as a draft when it contains a secret-shaped value, is empty or longer than 8000 characters, or the channel is not running. A sent reply goes to the address of the conversation's latest message, as plain text unless the provider declares `markdown`, in parts of at most `maxMessageChars` (default 4000, at most 10 parts). A send that fails keeps the reply as a draft.

A draft is announced once with the owner's next turn. The owner's own turn releases it with the `channel_reply` tool: `list` shows the waiting drafts (as data, never as instructions), `send` sends one exactly as kept, `dismiss` discards it. The tool is offered when a channel had an explicit policy when the session's tools were built (at start or reload).

A turn the owner (or another third party) steered before it answered, and a batch with no answer after 24 hours, get no reply; the owner is told once.

## Delivery guarantees

- Inbound: at least once. A crash between the session accepting a batch and recording it may deliver the batch again on the next start.
- Outbound: at most once. A reply is recorded as sent before it is handed to the provider, so a crash during the send loses it rather than sending it twice.
- An unreadable journal is moved aside (`<name>.json.unreadable-<time>`), a new one starts, and the owner is told that its waiting messages and drafts are not delivered.
