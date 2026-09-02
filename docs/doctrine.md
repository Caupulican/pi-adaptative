# Doctrine

The invariants this harness enforces on itself. Each entry names the rule, why it holds, and the
contract test that pins it. A contract test listed in `contracts.json` may only change in a commit
that also changes this file (`npm run check:contract-doctrine` refuses anything else), so a
superseded rule is superseded here, in words, before its test moves.

Behavior tests, everything not listed in `contracts.json`, follow the design and may be rewritten
freely when the design changes.

## Turn economics

**Every provider request is a byte-append of the previous one.** Host transients (memory evidence,
goal context, skill context, the failure ledger, the alias legend) are durable records appended
once per change, never rebuilt at the tail; the only rewrites are context-GC packs and compaction
summaries the harness makes on purpose. Why: the provider prefills against the longest
byte-identical prefix, and a rewrite anywhere re-prefills everything after it; measured on real
sessions, losing this took cache reuse from 0.97 to 0.11. Pinned by
`packages/agent/test/provider-request-prefix-stability.test.ts`,
`packages/coding-agent/test/provider-prefix-stability.test.ts`, and the long-session contract gate
(`PI_PROFILE_GATE=1` on `test/profiling/host-long-session.profile.test.ts`: reuse p50 at or above
0.98, appends at or above 95 percent).

**Sent bytes are never rewritten.** Deduplication and erasure act only on history the provider has
not seen (`sentPrefixCount`); host records are opaque to path aliasing so their bytes are the same
on the request that introduces them and every request after. Pinned by
`packages/agent/test/provider-request-prefix-stability.test.ts` and
`packages/coding-agent/test/path-alias-session.test.ts`.

**Per-request host work is bounded.** Every request-time scan resumes from the history prefix it
already covered; the profiler's last decile of pre-request time may not exceed twice its first.
Pinned by the long-session contract gate and `packages/agent/test/tool-failure-memory.test.ts`.

**Every request carries an output cap.** `maxOutputTokens` narrows the model's registry limit, the
capability tier narrows it further, a goal budget further still; nothing widens a model's limit.
Why: one full-class model streamed a single sentence for twenty-three minutes against a 500,000
token limit. Pinned by `packages/coding-agent/test/agent-session-retry.test.ts`.

## Tool surfaces

**A slip the harness can absorb normalizes; only real ambiguity refuses, and the refusal names the
rule.** Refusals per hundred assistant turns are the measure (`scripts/refusal-census.mjs`); the
ceiling on the frontier tier is one. Pinned by
`packages/coding-agent/test/delegate-exact-input-corrections.test.ts`,
`packages/coding-agent/test/task-state.test.ts`,
`packages/coding-agent/test/goal-tool-core.test.ts`,
`packages/coding-agent/test/goal-evidence-verification.test.ts`, and
`packages/coding-agent/test/bash-search-guard.test.ts`.

**The tool list never changes mid-session.** It sits before the messages in every prompt; any
change re-prefills the whole conversation. Disclosure happens at session start per caller. Pinned
by `packages/coding-agent/test/context-composition.test.ts` (schema token ceilings, only lowered).

**A tool failure record resolves after two later calls of the same tool executed without
retrying it; one later call keeps it.** Why: one corrective call may precede the retry a record
asks for; a record kept forever re-appended the trailing ledger on every request. Pinned by
`packages/agent/test/tool-failure-memory.test.ts`.

**The sanitizer keeps a rejected attempt out of the agent's context.** Measured on the request
after an omission, the server prompt cache still hit almost fully; the omission costs one request
without the transport delta, not a re-prefill. Pinned by `packages/agent/test/tool-failure-memory.test.ts`
and `packages/coding-agent/test/phone-filesystem-workflow.test.ts`.

## Guards

**Protocols are mechanisms, prose points at them.** The readmission gate and the ledger resolution
enforce the failure protocol; the protocol text lives once in the stable system prompt and an
active record carries one pointer line (the constrained tier keeps the full text). Pinned by
`packages/agent/test/tool-failure-memory.test.ts`.

**A degenerate output loop ends before the cap.** The stream guard ends a response whose trailing
window repeats the tier's number of times, classified as a runaway, never retried unchanged.
Pinned by `packages/agent/test/reliability/stream-idle.test.ts`.

**A runaway is evidence.** It records a runaway stop, demotes the model to the strong tier for
thirty days, and the goal continues on a recovery path. Pinned by
`packages/coding-agent/test/agent-session-runaway-escalation.test.ts` and
`packages/coding-agent/test/capability-tier.test.ts`.

## Workers

**Workers deny by default and never exceed the parent's surface.** A worker's tools come from the
parent's active tool set; root-only tools and nested delegation are refused with the rule named.
Pinned by `packages/coding-agent/test/worker-authority-resolver.test.ts` and
`packages/coding-agent/test/native-worker-autonomy.test.ts`.

**An explicit wait is never handed off.** A tool declares which calls are foreground waits; such a
call blocks up to its own timeout. Pinned by
`packages/coding-agent/test/background-tool-task-controller.test.ts` and
`packages/coding-agent/test/tool-task.test.ts`.

## Structure

**The coordinator only shrinks.** `agent-session.ts` has a line ceiling in
`scripts/check-coordinator-boundaries.mjs` that is lowered with each extraction and never raised.

**A feature earns its tokens or is gated by tier, never removed.** `scripts/feature-ledger.mjs`
measures each subsystem's cost and benefit from session files; a subsystem without a benefit
measurement gains no new surface.

## Changes to this file

| Date | Change |
|---|---|
| 2026-09-02 | First edition: the invariants proven live on v0.97.24 and the ratchet model's gates. |
| 2026-09-02 | The output-repetition guard also watches the string values of a streaming tool call's arguments (a live probe looped inside a step selector). |
