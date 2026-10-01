# pi-chat

pi-chat is the packaged peer-agent message mesh. Agents running on the same machine discover each other and exchange short text messages while they work. It ships as the bundled extension `pi-chat` and is active whenever the active resource profile allows it (`all-active` does).

## Tools and command

- `list_peers` lists connected peers (`includeSelf` adds this agent).
- `agent_send` sends one message to one or more peer ids, names or addresses. `expectReply` waits for the peer's acknowledgement up to `timeoutMs` (default 15 s, maximum 120 s). `to: "*"` broadcasts only when `broadcastEnabled` is true in `config.json`.
- `/pi-chat status | setup | peers | help`. `setup` writes `config.json`, `identity.json` and `peers.json` after confirmation, so the agent keeps one persistent identity.

## Transport

One Unix socket per user, `~/.pi/pi-chat/sessions/local/broker.sock` (override the root with `PI_CHAT_STATE_ROOT`). The first process that finds no broker becomes it; every other process is a client. The wire protocol is newline-delimited JSON (`hello`, `peers`, `send`, `incoming`, `delivery_ack`, `send_result`, `error`) and is unchanged from the user-level pi-chat extension, so other agents that speak it can join the same socket. Frames are shape-checked and bounded (128 KiB envelope, 32 KiB message, 16 KiB metadata). Native Windows has no transport yet; the extension then registers `/pi-chat` only.

## Receiving

An incoming message shows a compact card (Ctrl+O expands it), notifies the UI, and is queued as a steering turn framed as untrusted peer text. It never authorizes credential use, commands, edits or privilege changes. The audit log (`sessions/local/audit.jsonl`) holds metadata only, never message bodies.

## Limits

Payloads are not encrypted; do not send secrets. Workers never receive these tools (`WORKER_FORBIDDEN_TOOLS`); lean, minimal and chat capability classes do not either. TCP/LAN, pairing, relay and daemon modes of the user-level extension are not part of the package.
