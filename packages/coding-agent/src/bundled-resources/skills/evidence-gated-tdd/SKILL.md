---
name: evidence-gated-tdd
description: "Build or harden software through a Detect → Verify → Score → Gate TDD workflow. Use when Pi is asked to add regression coverage, reproduce bugs, red-team an owned system, assess scanner/static-analysis findings, prevent false positives, test authority or atomicity, add crash/replay/concurrency tests, or decide whether evidence is strong enough to block a release."
---

# Evidence-Gated TDD

## How to use the skill

Turn broad findings into deterministic regression gates. Treat detectors, logs, workers, fuzzers, and scanners as hypothesis generators; require independent verification before changing product behavior or declaring a release blocker.

Read [references/evidence-model.md](references/evidence-model.md) when triaging multiple findings or uncertain scanner output. Read [references/security-scanners.md](references/security-scanners.md) before offensive scanning or network fuzzing.

## North Star

Make one observable invariant fail for the suspected reason, prove it with a negative control, fix it at the lowest authoritative owner, and retain the change only when focused and proportional broader gates pass.

Think before coding, surface assumptions and tradeoffs, choose the simplest enforcing boundary, keep changes surgical, and measure the requested outcome. Humans approve credentials, destructive actions, external state-changing probes, dependency installation, publishing, releases, pushes/tags, authority expansion, and material product choices.

## Core Sections

### 1. State the invariant

Define what must always hold, what must never happen, and which boundary owns the rule. Prefer observable authorization, conservation, atomicity, boundedness, ordering, lifecycle, and wire-shape invariants over implementation details.

### 2. Establish the baseline

Run the narrowest existing test or read-only reproduction first. Record exact inputs, outputs, versions, timing, and environment needed to distinguish the defect from existing noise. Characterize unsafe legacy behavior before refactoring it.

### 3. Detect broadly

Use focused code search, static analysis, fuzzing, scanners, logs, property tests, or adversarial inputs to generate candidates. Preserve raw evidence and tool errors outside model context. A successful exit is not proof, and an incomplete scan is not a passing scan.

### 4. Verify independently

1. Add a focused test that fails for the suspected reason.
2. Add a negative control and, when useful, a baseline/differential comparison.
3. For stateful systems, exercise stale versions, duplicate requests, concurrency, cancellation, rollback, replay, shutdown, and ambiguous response loss.
4. For parsers/protocols, exercise size/depth bounds, missing fields, alternate shapes, duplicate keys, unsafe integers, accessors, prototype pollution, and trailing data.
5. For UI/rendering, combine state assertions with production-shaped interaction or visual evidence.
6. Reproduce delegated/scanner claims locally before promotion. Use a clean-context verifier only when user/project policy authorizes delegation.

### 5. Score the evidence

Separate confidence from severity. Promote only deterministic or independently reproduced findings to confirmed defects. Keep low-confidence candidates visible without letting them drive speculative changes. Apply the confidence bands in `references/evidence-model.md` when the queue is non-trivial.

### 6. Fix the owning boundary

Centralize the invariant at the lowest reusable owner that can enforce it completely. Keep provider/product policy in its adapter, generic mechanism free of concrete vocabulary, and one mandatory path for state transitions. Remove obsolete fallbacks and compensation paths after replacement is proven.

### 7. Gate the regression

Run the focused reproduction, adjacent tests, then repository-required type, build, duplication, dependency, security, and production-shaped gates in proportion to risk. Review the report body, not only process exit status. Require zero unexplained tool errors or skipped probes. Inspect worktree scope and generated artifacts before any authorized commit.

### 8. Hand off evidence

Report the invariant and root cause, regression and negative-control tests, confirmed/fixed findings, rejected candidates and why, incomplete probes, validation matrix, and remaining risk. Never call a system secure, release-ready, complete, or bug-free from happy-path tests alone.

## Anti-Patterns

- Weakening a failing test to match current behavior.
- Fixing a scanner match without reproducing its claimed effect.
- Using sleeps or probabilistic races when deterministic barriers/fault hooks exist.
- Testing only the first participant or mutation in a multi-step transaction.
- Asserting success without absence of partial side effects.
- Treating worker self-report, exit code zero, or a green percentage as trusted proof.
- Running active security probes outside explicit ownership and authority.

## Examples

**Replay safety:** send one request, replay the exact idempotency key and intent, then reuse the key with different intent. Assert exact replay is inert and intent mismatch fails closed with no additional durable effects.

**Scanner candidate:** preserve the report, reproduce one claimed duplicate rule with a focused behavioral test plus an intentionally different negative control, then centralize only if both blocks own the same invariant.

**Crash atomicity:** inject failure after the penultimate durable mutation, restart, and assert state, versions, journals, events, metrics, and notifications are either entirely committed or entirely absent.

## Self-Check

- The invariant is observable and names its owner.
- Baseline and failure reason are recorded.
- Focused regression fails before the fix and passes after it.
- A negative control rejects the competing explanation.
- Tool errors, omissions, and skipped probes are counted.
- The fix is at the lowest authoritative boundary with obsolete paths removed.
- Focused and proportional broader gates pass and their bodies were inspected.
- Confirmed, rejected, incomplete, and residual findings are separated.
- Authority and unrelated work remain unchanged.

## Known Gaps

- Deterministic tests cannot prove every stochastic/provider/environment interaction; report the untested surface.
- External scanners may have parser and transport blind spots; their output always requires local verification.
- This skill does not grant authority for destructive or state-changing security tests.
