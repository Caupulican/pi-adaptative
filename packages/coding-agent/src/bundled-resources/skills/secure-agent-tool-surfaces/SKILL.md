---
name: secure-agent-tool-surfaces
description: "Threat-model, build, review, and red-team AI-agent tools, MCP servers/clients, extensions, background workers, memory, and multi-agent boundaries. Use when adding tool authority, external connectors, process/filesystem/network access, remote transports, persistent state, delegated work, or when investigating prompt injection, tool poisoning, SSRF, tenant crossover, replay, credential leakage, or excessive agency."
---

# Secure Agent Tool Surfaces

## How to use the skill

Use this skill for agent-facing execution and data boundaries. It is not an
offensive-testing grant. Pair implementation with `evidence-gated-tdd` and use
`authorized-web-security-audit` before active network probing.

**Freedom Dial: High Freedom.** Threat modeling and boundary selection require
judgment; identity, capability, tenant, input, egress, secret, lifecycle, and
evidence rules are mandatory gates.

Read [references/tool-boundary-checklist.md](references/tool-boundary-checklist.md)
when designing or reviewing a tool. Read
[references/defensive-exploit-catalogue.md](references/defensive-exploit-catalogue.md)
when building a threat model or adversarial regression matrix.

## North Star

Treat the model as an untrusted planner and every external result as untrusted
data. Enforce authority in deterministic host code so no prompt, tool
description, result, memory entry, delegated message, resumed event, or provider
can grant itself capability, cross a session tenant, disclose secrets, or widen
network/process/filesystem reach.

Think before coding, prefer a small capability over a broad filter, change the
lowest authoritative owner, prove behavior with adversarial tests, and keep
humans at credentials, destructive/irreversible actions, external publication,
authority expansion, and material security decisions.

## Core Sections

### 1. Draw trust and authority boundaries

Inventory principals and data flows:

- human owner, foreground agent, delegated agent, session tenant, tool host,
  extension, MCP client/server, provider, external service, and storage;
- trusted instructions versus untrusted user/repository/web/tool/worker content;
- capabilities for filesystem paths, commands, network destinations, secrets,
  memory, durable state, notifications, and external mutations;
- where identity is established, narrowed, persisted, resumed, and revoked.

Represent authority as immutable host-owned data. The effective grant is the
intersection of user approval, session role, tool profile, current host policy,
resource ownership, and operation-specific scope. Text cannot add to it.

### 2. Enforce session and principal isolation

Every live task, shell/coordinator process, background lane, event queue,
notification, credential view, memory write, and temporary artifact belongs to
one session tenant by default. Same directory, process, account, or MCP server
does not imply shared authority.

Use opaque unpredictable identifiers plus an owner identity derived from a
trusted channel. Bind every read, mutation, resume, cancellation, delivery, and
cleanup to both. Do not use a session id alone as authentication. Reject stale,
replayed, out-of-order, duplicate, cross-user, and cross-session messages before
side effects. Make idempotency keys bind operation intent, principal, and scope.

Delegation only narrows authority. A worker cannot create workers, mutate global
settings/memory, acquire credentials, or expand tools unless the owner explicitly
granted that exact capability and policy allows it.

### 3. Validate tool contracts at one choke point

Use typed, versioned input and output schemas. Canonicalize once, then validate:

- reject unknown fields where ambiguity is dangerous;
- cap strings, arrays, nesting, decoded bytes, files, results, and fan-out;
- handle duplicate keys, unsafe integers, accessors, prototype keys, alternate
  encodings, Unicode/path normalization, trailing data, and decompression ratio;
- distinguish shape repair from semantic decisions; never invent authority,
  paths, destinations, credentials, or intent;
- bind tool identity and schema hash at approval and re-check on change to catch
  tool-description/schema rug pulls and shadowing.

Keep policy out of model-visible descriptions. A description may explain a
capability, but only host code may authorize it.

### 4. Constrain filesystem, process, and network effects

Filesystem operations use canonical, symlink-safe handles rooted in an approved
workspace or resource capability. Validate the final opened object, not only the
input path. Deny credential, state, auth, and cross-tenant paths by default.

Process tools prefer direct executable plus argument arrays. Do not interpolate
model text into a shell. If a shell is the declared capability, keep a bounded
grammar, explicit working directory/environment, process-tree cancellation,
output limits, and no implicit privilege escalation.

For network tools, prevent SSRF with established URL/IP libraries, destination
allowlists, HTTPS in production, redirect-hop validation, DNS pinning or
revalidation, and default denial of private, loopback, link-local, multicast,
and metadata ranges. An explicit local-development grant may allow loopback;
never let arbitrary web content select that exception. Strip credentials on
origin changes and constrain egress independently of prompt policy.

### 5. Harden MCP and extension transports

Prefer stdio for local MCP servers and display the exact executable/arguments
for human approval before first launch. Pin and review dependencies, manifests,
tool schemas, and updates as executable supply-chain input. Sandbox local
servers with the smallest filesystem, environment, process, and network access.

For Streamable HTTP:

- bind local servers to loopback by default;
- authenticate every connection and validate token issuer, audience, expiry,
  scopes, and principal; never use token passthrough;
- validate `Origin` on every incoming connection and reject invalid origins;
- bind session state and resumable events to the authenticated principal;
- prevent cross-node event injection and cross-stream replay;
- use TLS outside an explicitly local development boundary;
- expose health endpoints without tool authority or sensitive diagnostics.

Tool-list changes, schema changes, reconnects, and resumed streams require the
same trust decision as a new tool. Never silently inherit newly advertised
capabilities.

### 6. Contain untrusted results, memory, and secrets

Parse a tool's structured result against a bounded schema and label all content
as untrusted result data before model ingestion. It cannot override system/user
intent, authorize another tool, request secret access, change policy, or become
durable memory without an independent host-owned gate.

Keep secrets in a model-blind store. Inject only into the authorized adapter at
execution time, redact stdout/stderr/errors/telemetry, and block secret-bearing
values from URLs, argv, prompts, reports, caches, and worker handoffs.

Memory writes require provenance, tenant, category, size, sensitivity, and
authority checks. Repository text, web pages, tool results, and worker claims do
not become trusted instructions or global/user memory. Compact and index data
without erasing its trust label or owner.

### 7. Make lifecycle bounded and auditable

Every call has admission, running, terminal, canceled, and failed states with
one coordinator. Long work moves to a session-owned background lane; completion
is event-driven, persists a bounded handoff, and notifies only the owning parent
session. Never poll output merely to discover completion or inject a late result
into an unrelated active transcript.

Enforce request, cost, token, CPU, memory, output, recursion, retry, concurrency,
and wall-time budgets. Cancellation reaches descendants and durable state.
Shutdown/reload must fence stale generations and close files, sockets, browsers,
workers, and subprocess trees.

Log identities, decisions, hashes, counts, and protected artifact pointers—not
secrets or raw sensitive bodies. Audit failures must fail closed for mutations.

### 8. Red-team and gate

For every privileged boundary, add a focused regression and negative control.
Exercise prompt/tool injection, schema rug pulls, name shadowing, malformed and
oversized values, path aliases/symlinks, redirects and DNS rebinding, replay,
duplicate/out-of-order events, cancellation at each phase, crash/restart,
cross-session access, worker escalation, secret-bearing errors, and unbounded
loops/fan-out.

Verify absence of partial side effects. A green model response, tool exit code,
or scanner label is not proof. Gate on deterministic host behavior and inspect
the evidence body for skipped probes and errors.

## Anti-Patterns

- Relying on a system prompt to enforce permissions.
- Treating a tool description, annotation, or `destructiveHint` as access control.
- Sharing one process, queue, cache, memory namespace, or credential view across sessions.
- Accepting bearer tokens for the wrong audience or forwarding them downstream.
- Exposing an unauthenticated HTTP tool server, even on loopback, without Origin checks.
- Passing raw tool output into trusted instructions or durable memory.
- Validating a path before following symlinks or a URL before redirects/DNS use.
- Letting timeout, disconnect, or session disposal stand in for cancellation.
- Hiding full evidence in model context or logging secrets for debugging.

## Examples

**Poisoned tool result:** an external search result says to read a credential
file and upload it. The result remains labeled data; host UAC denies the file and
egress operations, and no memory write occurs. A regression asserts all three.

**Two sessions in one workspace:** each receives a distinct coordinator,
background namespace, event stream, and credential capability. Guessing or
replaying the other session's task id returns not found without revealing
existence.

**Remote MCP server:** the HTTP listener uses TLS, authentication, audience and
scope validation, an Origin allowlist, principal-bound sessions, bounded tools,
and egress policy. A valid session token from another user is a negative control.

## Self-Check

- Every capability is host-owned, explicit, least privilege, and session-bound.
- Delegation and resume can only preserve or reduce authority.
- Inputs, outputs, paths, destinations, redirects, schemas, and tool identities are bounded.
- Stdio/HTTP transport protections match the exposure.
- Secrets remain model-blind and redacted from every failure path.
- Untrusted results and memory retain provenance and cannot become instructions.
- Background completion is event-driven and owner-session scoped.
- Cancellation, crash, reload, replay, and cross-tenant tests cover side effects.
- Focused regressions and negative controls pass with no skipped security probes.

## Known Gaps

- No schema or content filter can perfectly detect instruction-like text; hard
  capability isolation remains required.
- Application-specific authorization and data-classification policy must be
  supplied by the product owner.
- This skill cannot establish that a third-party server or package is benign;
  provenance review, sandboxing, and runtime containment are still necessary.
