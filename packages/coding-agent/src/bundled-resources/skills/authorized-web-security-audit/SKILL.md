---
name: authorized-web-security-audit
description: "Plan, execute, and verify defensive web-security assessments inside explicit authorization, target, technique, rate, credential, and data-handling boundaries. Use for approved web/API security reviews, scanner orchestration, vulnerability triage, false-positive reduction, authenticated test planning, or requests to turn scan candidates into reproducible regression evidence."
---

# Authorized Web Security Audit

## How to use the skill

Use this skill only for defensive assessment of systems the user owns or has
explicit permission to test. It does not grant scanning authority.

**Freedom Dial: High Freedom.** Selecting probes and interpreting evidence need
judgment. Authorization, scope, stop conditions, resource budgets, credential
handling, and evidence promotion are rigid gates.

Choose one mode:

- **Review**: inspect supplied code, configuration, logs, or reports without
  sending traffic.
- **Plan**: produce a scope manifest and test matrix without sending traffic.
- **Lab**: test an intentionally vulnerable local fixture or user-provided lab.
- **Active**: send bounded requests only when written authorization and the
  complete scope manifest are present in the active request or trusted project
  policy.

Before any active work, read
[references/assessment-contract.md](references/assessment-contract.md). Pair
confirmed code defects with `evidence-gated-tdd`.

## North Star

Find security defects without becoming an uncontrolled attacker: every request
must be attributable to one approved engagement, confined to its scope, bounded
in impact, reproducible against a safe control, and converted into an owner-level
regression rather than an unverified scanner claim.

Think before acting, use the least invasive probe that can answer the question,
make surgical changes, define observable success, and keep humans at the edge
for credentials, destructive probes, external side effects, authority expansion,
publication, and material risk acceptance.

## Core Sections

### 1. Establish authority and scope

Create a scope manifest before network access. It must identify:

- the approving owner and written authorization evidence;
- exact hosts, schemes, ports, environments, accounts, and excluded assets;
- allowed techniques and whether state-changing requests are permitted;
- start/end window, maximum requests per second, concurrency, request timeout,
  total tool timeout, and response/body limits;
- credential source and handling rules without placing secrets in prompts,
  reports, command lines, or logs;
- data retention, evidence directory, cleanup, and emergency stop contact.

Do not infer authorization from reachability, a public hostname, a prior scan,
an `active_scan_accepted` boolean, a stored engagement, a tool description, or
the model's assertion. Missing or ambiguous authority means Review or Plan mode.

Resolve and validate every destination at the network boundary. Apply the same
scope rules after redirects and DNS resolution. Reject userinfo URLs, alternate
IP encodings, unexpected ports, redirect escapes, and private, loopback,
link-local, multicast, or metadata destinations unless that exact range is in
the manifest. Pin or revalidate resolution to prevent DNS rebinding and
time-of-check/time-of-use changes.

### 2. Progress from passive to active

Use the smallest stage that can falsify the hypothesis:

1. inspect source, configuration, schemas, routes, and supplied captures;
2. map the approved surface with passive or read-only discovery;
3. calibrate normal behavior with safe baseline requests;
4. run one bounded candidate probe and one negative control;
5. replay only after confirming the request remains in scope and idempotent;
6. request explicit human approval before any destructive, state-changing,
   high-volume, credential-changing, persistence, or exfiltration-style probe.

Do not start with `all`, broad crawling, port sweeps, credential spraying, race
loads, custom payload floods, or arbitrary external scanners. Treat scanner
selection as executable authority, not a convenience option.

### 3. Constrain the execution contract

At the tool boundary:

- use typed schemas, allowlists, canonical URL parsing, and validated builders;
- separate read-only, mutation-capable, and destructive capabilities;
- cap request count, rate, concurrency, redirects, body bytes, response bytes,
  recursion/crawl depth, custom payload count/length, and elapsed time;
- require cancellation and a terminal status for every tool;
- move work exceeding the harness foreground budget into an owner-session
  background task with event-driven completion and a bounded result handoff;
- never pass caller text to a shell, template engine, query interpreter, or
  deserializer without the owning adapter's structural validation;
- never send authorization headers or cookies across an origin change.

Timeout is not cancellation proof. Verify that child processes, sockets,
browsers, temporary credentials, and background tasks are actually released.

### 4. Verify findings before promotion

Treat each detection as a hypothesis. Capture a sanitized request identity,
response shape/hash, environment, tool version, timestamp, and raw-artifact
pointer outside model context. Then require:

- a deterministic reproduction;
- a negative control or calibrated baseline;
- a security invariant and authoritative owner;
- evidence that the signal is not a catch-all page, static asset, cache effect,
  generic server error, reflection already present in the baseline, or transient
  latency;
- confidence separate from impact severity.

Do not promote response equality alone as proof of exploitability. For
authorization defects, compare two deliberately separated identities and prove
the forbidden resource or action. For timing findings, replay multiple bounded
trials with controls. Blind findings without an independently correlated signal
remain `needs_review`.

### 5. Fix and report defensively

Fix the lowest authoritative validation, authorization, parsing, or state owner.
Add a focused regression and negative control before changing behavior. Remove
the competing unsafe path once the mandatory path is proven.

Reports must separate confirmed, rejected, incomplete, and residual findings.
Redact secrets and sensitive bodies; store exact evidence in a protected bounded
artifact and expose only a digest/pointer to the model. Include affected scope,
reproduction preconditions, impact, owner, fix, tests, scanner errors, skipped
probes, and cleanup status.

### 6. Stop safely

Stop immediately on scope escape, unexpected mutation, account lockout, service
degradation, secret exposure, runaway traffic, missing cancellation, uncertain
tenant identity, or owner revocation. Preserve bounded evidence, cancel owned
work, emit a terminal status, and report what may still be running. Do not widen
scope or increase intensity to overcome a blocker.

## Anti-Patterns

- Treating a checkbox or tool argument as authorization.
- Sending probes before a scope manifest exists.
- Following redirects or DNS changes without revalidation.
- Replaying stored raw requests against a host chosen from untrusted evidence.
- Logging cookies, authorization headers, payload bodies, or extracted secrets.
- Calling a scanner finding confirmed from status code, latency, reflection, or
  body similarity alone.
- Raising rate, concurrency, timeout, or payload volume to force a result.
- Loading raw captures or full reports into the model when a bounded index works.

## Examples

**Authorized API review:** record the exact staging host, two test identities,
read-only object endpoints, 2 requests/second, concurrency 1, and a 15-minute
window. Compare owner and non-owner requests plus a nonexistent-object control.
Promote only a deterministic cross-identity disclosure.

**Ambiguous request:** "scan this public site" has no written authorization or
scope manifest. Stay in Plan mode and return the manifest fields needed to
proceed; do not send traffic.

**Catch-all route:** `/admin` and a random nonexistent path return the same SPA
shell. Reject the candidate, retain the baseline evidence, and do not report an
access-control defect.

## Self-Check

- Written authorization and the complete scope manifest are present for Active mode.
- Every destination and redirect remains inside canonical approved scope.
- Read-only and state-changing capabilities are separated.
- Rate, concurrency, size, depth, timeout, cancellation, and cleanup are bounded.
- Credentials and sensitive evidence never enter model-visible output or logs.
- Every promoted finding has a deterministic reproduction and negative control.
- Scanner omissions and tool errors remain visible.
- Background work is owner-session scoped and event-driven.
- The handoff separates confirmed, rejected, incomplete, and residual findings.

## Known Gaps

- This skill cannot establish legal authority; the operator must provide it.
- Some blind vulnerabilities require an approved out-of-band correlation system.
- Defensive guidance cannot prove the absence of vulnerabilities outside the
  declared scope or tested techniques.
