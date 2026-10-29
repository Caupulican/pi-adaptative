# Bots and group chats

Bots have persistent identities and model settings. Teams are group chats: each bot has a separate
conversation and memory in each group. Direct bot chats remain separate from group chats.

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
