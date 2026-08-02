---
name: deduplicate-by-evidence
description: "Detect hidden textual and semantic duplication, harden clone-scanner coverage, centralize real ownership, split duplicated god-unit responsibilities, and gate releases on evidence. Use for deduplication, DRY/refactor work, repeated or scattered rules, copy-paste bugs, oversized files that scanners may skip, cross-layer contract drift, duplicated state transitions, or requests to prove that a codebase has one mandatory implementation path."
---

# Deduplicate by Evidence

## How to use the skill

Use Detect → Verify → Score → Gate. Treat scanner output as candidate evidence until scope and coverage are proven.

Select the strongest mode authorized by the request:

- **Audit**: inspect without changing files; return an evidence-ranked ownership map.
- **Enforce**: harden scanner coverage and add a regression gate. Leave the gate failing while real clones remain.
- **Remediate**: enforce, centralize one bounded clone family, and verify behavior.
- **Continuous**: repeat bounded green slices until owned production code reaches the agreed zero-clone gate.

Pair production changes with `evidence-gated-tdd`. Preserve provider neutrality: this workflow is Markdown guidance for any Pi agent/model and has no provider-specific metadata or tool assumptions.

## North Star

Prove that every owned production source file is scanned at pinned sensitivity, then move each verified invariant behind one named owner without changing authority, failure semantics, timing, or hot-path cost.

Think before coding, state assumptions and the oracle, prefer the existing owner, make surgical changes, and stop only at verifiable evidence. Humans retain control over credentials, destructive actions, dependency installation, publishing, releases, pushes/tags, authority expansion, and material product decisions.

## Core Sections

### 1. Establish scope and invariants

1. Read repository instructions and inspect worktree state. Preserve unrelated work.
2. Identify owned production roots, languages, generated sources, vendored code, tests, fixtures, migrations, build output, symlinks, and nested workspaces.
3. Gate owned production source independently. Audit tests/migrations separately so their volume cannot dilute production findings.
4. Exclude generated or vendored files only by exact, proven ownership. Keep the generator or upstream license marker as evidence.
5. Record invariants a refactor must preserve: authority, validation order, atomicity, security boundaries, dependency direction, state transitions, latency, and allocation bounds.

### 2. Prove scanner coverage

Inspect the scanner, wrapper, package scripts, and CI command before trusting a green result. Verify:

- supported extensions and parser failures;
- candidate-file count versus analyzed-file count;
- hidden maximum line/byte limits;
- minimum clone lines/tokens and detection mode;
- ignore/config inheritance, symlink behavior, and nested-package traversal;
- whether skipped/oversized/failed files merely warn;
- whether CI runs the exact local gate.

For jscpd:

1. Prefer an existing repository wrapper such as `npm run check:clones`.
2. Require pinned jscpd v5 and verify the major version before relying on its Rust-native CLI. Do not silently fall back to the v4 Node engine.
3. Explicitly configure `maxLines` and `maxSize`; defaults can omit god units. Keep both far above the largest legitimate owned file.
4. Pin `minLines`, `minTokens`, `mode`, formats, cross-format policy, exact ignores, JSON reporter, and zero threshold in a regression test.
5. Reconcile every owned candidate with the analyzed count. Account for below-minimum files by exact path and proof that they cannot contain the configured block size.
6. Keep console projection bounded and retain the complete JSON report out of model context for explicit inspection.

Never make the gate green by raising thresholds, increasing minimum clone size, adding broad ignores, renaming identifiers, or reformatting clone blocks.

### 3. Detect semantic duplication

Search beyond scanner matches for repeated validation, limits, error mappings, state transitions, retry/idempotency loops, authorization, projections, serialization, canonicalization, persistence adapters, provider behavior, and constants with the same meaning.

Do not merge intentionally distinct trust, security, timing, provider, public/private, or failure boundaries. Similar syntax is not proof of shared ownership.

### 4. Verify and classify

For every candidate, record exact locations and behavior, classification, intended owner, divergence risk, and fix direction. Reproduce divergent behavior with a deterministic test and negative control before promoting a scanner/static finding to a confirmed defect.

Prefer a domain-named owner:

- shared engine/kernel for reusable mechanism;
- provider adapter for unique I/O;
- protocol/schema package for wire contracts;
- domain/plugin module for concrete policy;
- one coordinator for correlated state transitions.

Avoid generic utility dumping grounds and parameter-heavy abstractions.

### 5. Score and remediate

Score verified families 0–3 for divergence likelihood, blast radius, boundary harm, and change confidence. Fix the highest-risk family first, using confidence to bound slice size.

Use evidence-gated TDD:

1. **Red**: preserve the hardened scan and add behavioral/configuration regressions.
2. **Green**: move the invariant to the lowest authoritative owner and route all callers through it.
3. **Refactor**: remove replaced paths, aliases, fallbacks, and duplicate transitions in the same migration.
4. **Focused gate**: run affected tests, type/build checks required by the repository, and the clone scan.
5. **Release gate**: run the declared broader suite and inspect the report body, diff, and worktree scope.

### 6. Gate and hand off

Do not claim completion until scanner coverage reconciles, the owned production gate reports zero textual clones at pinned sensitivity, verified rules have one owner or tested intentional separation, required tests/checks pass, and unrelated work remains untouched.

Report confirmed-and-fixed families, rejected candidates and why, incomplete probes, scanner coverage, remaining risks, and commit identifiers only when a commit was authorized and created.

## Anti-Patterns

- Trusting a green percentage without proving file coverage.
- Treating every textual match as one semantic responsibility.
- Excluding god units because defaults cannot process them.
- Merging trusted/private and untrusted/public shapes.
- Hand-editing generated code instead of its generator.
- Trading duplication for allocations or network expansion on a hot path.
- Creating a new shared helper while the old paths remain callable.
- Loading a full clone report into agent context when a bounded index suffices.

## Examples

**Oversized coordinator:** enumerate all production files, raise explicit scanner caps with 2× or greater headroom, add a coverage regression, preserve the red report, then split only verified duplicated responsibilities behind named owners.

**Provider adapters:** two providers share ranking/error/cache policy but differ in transport. Centralize provider-neutral policy while leaving unique I/O in adapters; test both shared behavior and distinct failure semantics.

**Incidental syntax:** two short parsers share a loop shape but enforce different trust boundaries. Retain them separately and record the negative control instead of forcing an abstraction.

## Self-Check

- Owned production scope and languages are explicit.
- Generated/vendor exclusions have exact proof.
- Largest line/byte sizes fit with large headroom.
- Candidate/analyzed counts reconcile without unexplained omissions.
- jscpd is pinned to v5 Rust with sensitivity/config regression coverage.
- Every promoted defect has a deterministic reproduction and negative control.
- One authoritative owner replaces all competing paths.
- Focused and repository-required gates were inspected, not inferred from exit status.
- Output is bounded while full evidence remains retrievable.
- Human authority and unrelated work are preserved.

## Known Gaps

- jscpd proves textual/token overlap, not semantic ownership; deliberate search and behavioral verification remain required.
- A zero textual-clone result does not prove the absence of structurally equivalent rules written differently.
- Large legacy clone inventories may require multiple authorized remediation slices; the honest gate remains red meanwhile.
