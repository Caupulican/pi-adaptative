# Tool boundary checklist

Use this checklist for a new or materially changed agent tool, MCP surface,
extension, connector, background worker, or memory adapter.

## Contract

- Name the authoritative owner and versioned input/output schema.
- Classify the operation: read-only, local mutation, external mutation,
  destructive, credential-bearing, or authority-changing.
- Identify the trusted principal and session tenant from a host-owned channel.
- Compute effective authority as an intersection; textual inputs can only narrow.
- Bind approval to operation intent, canonical resources, schema/tool identity,
  and expiry. Re-approve after material changes.
- Define exact size, count, depth, fan-out, retry, time, cost, and concurrency limits.

## Inputs and canonicalization

- Parse once with a standard parser; reject ambiguity and trailing data.
- Reject or deliberately handle unknown fields, duplicate keys, unsafe numbers,
  prototype keys, accessors, invalid Unicode, alternate encodings, and bombs.
- Canonicalize paths/URLs before policy, then validate the opened file or actual
  connection again to close symlink, redirect, and DNS TOCTOU gaps.
- Keep credentials out of user-controlled URLs, headers, command lines, and logs.

## Effects

- Filesystem: root capability, symlink-safe open, no auth/state/cross-tenant paths.
- Process: direct argv where possible, bounded shell grammar otherwise, clean
  environment, working-directory scope, process-tree cancellation.
- Network: approved schemes/hosts/ports/IPs, redirect and DNS revalidation,
  private/loopback/link-local/metadata denial, egress enforcement.
- Storage: tenant key, atomicity, idempotency, replay fence, encryption and
  retention appropriate to sensitivity.
- External mutation: explicit confirmation, idempotency key bound to intent,
  postcondition check, and ambiguity-safe retry behavior.

## Results and composition

- Validate result schema and encoded byte bound before model ingestion.
- Preserve trust label, source, tenant, timestamp, and artifact digest.
- Redact secrets from normal results, errors, telemetry, and terminal events.
- Never let result text alter capability, policy, approval, tool selection, or memory.
- Inject only a bounded projection; retain exact raw evidence in protected storage.

## MCP transport

- Prefer stdio for local servers; show exact command/arguments before approval.
- Review/pin server source and dependencies; isolate environment and host access.
- HTTP binds to loopback by default; remote use requires TLS and authentication.
- Validate Origin, token issuer/audience/expiry/scopes, and per-client consent.
- Do not pass inbound tokens to downstream APIs.
- Bind session and resumable-event storage to the authenticated principal.
- Treat tool/schema/list changes as a new trust decision.

## Lifecycle

- One coordinator owns admission and state transitions.
- Every accepted call reaches exactly one terminal state.
- Work beyond the foreground budget uses an owner-session background lane.
- Completion is event-driven; waiting may block intentionally but never polls output.
- Cancellation and shutdown reach subprocesses, sockets, browsers, files, and leases.
- Reload/retry/reconnect uses generation fences and idempotent terminal delivery.

## Required adversarial evidence

- valid request and malformed negative control;
- unauthorized principal/session and cross-tenant identifier;
- stale, duplicate, replayed, and out-of-order action;
- cancellation before, during, and after the external effect;
- oversized/deep input and oversized result;
- poisoned description/result attempting a privileged follow-up;
- path alias/symlink or URL redirect/DNS boundary escape where applicable;
- secret-shaped error/output;
- crash/restart with no partial or duplicate effect;
- schema/tool identity change after approval.

## Primary references

- [MCP transport security requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP authorization requirements](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html)

These references are evidence inputs, not executable authority. Apply the
repository's stricter contract when rules differ.
