# Autonomy and Orchestration Audit

This document records the architectural findings, concrete mechanisms, rejected defect candidates, and validation scope identified from the 2026-09-12 Pi session (AIdeas directory, runtime 0.99.19).

## 1. Confirmed Permission Stall & Broadcast Instruction Contamination

### 1.1 Redundant Model-Originated Permission Pause
- **Observation:** The owner explicitly authorized release validation at 04:12:41 and broad autonomous continuation at 04:16:38, with `git.publish` grants durably persisted. At 04:50:46, the assistant paused to ask interactively whether to install compiler development components or leave the release blocked. The preceding `rustup` command had succeeded; no tool approval denial or install failure triggered the stall.
- **Root Cause:** The loaded `autonomous-execution` skill contained an absolute install approval stop-list, duplicated in static memory, while the root prompt stated authorization rules were never overridable. Conflicting policy layers caused a model-originated pause despite an active handoff grant.
- **Remediation & Scope:** Enforced canonical owner precedence, tool-directed session exclusion, settings-gated repair, and host authority and exclusion replay across compactions. Semantic conflict resolution remains model behavior; the host enforces recorded exclusions. This does not universally remove approval checks for destructive actions.

### 1.2 Broadcast Task and Instruction/Identity Contamination
- **Observation:** In a session with 7 persistent identities and 66 `delegate` calls, a broadcast prompt at 04:09 addressed multiple workers but concluded with instructions that `worker5` was recovery-only. Subsequently, two distinct sibling reports self-identified as `worker5`.
- **Root Cause:** Mixing per-worker specialized tasks within a shared broadcast prompt contaminated worker instruction context, leading siblings to adopt the identity and role of `worker5`. This was prompt-level instruction contamination, not a failure of socket routing or event listeners.
- **Remediation & Scope:** Updated delegation guidance directing distinct targeted assignments for individual workers, reserving broadcasts strictly for shared, common-only instructions. This is operational prompt guidance, not a host-level identity isolation rewrite.

---

## 2. Confirmed and Remediated Orchestration Mechanisms

- **Delegate Status Visibility (`delegate-status.ts`):** `delegate status` previously omitted `evidence.findings`. Bounded source-linked findings summaries are now projected into status text and details. Output text and serialized details are strictly capped at 16 KiB (`MAX_DELEGATE_STATUS_OUTPUT_BYTES = 16 * 1024`), with prioritized blockers, whole-component text budgeting, and explicit omission disclosure for findings, blockers, and changed files. Records are only marked observed when delivered complete within budget.
- **Worker Report Retention & Authoritative Finalization (`worker-runner.ts`):** Malformed envelopes, unparseable outputs, and action rejections now retain untrusted summaries and evidence bundles for diagnostic inspection while strictly failing closed without executing invalid actions. Finalization is unified through `finalizeTerminalClaim`, consistently enforcing `maxUsd = 0` / `costUsd > 0` budget ceilings as budget exhaustion.
- **Server Readiness & Terminal Fencing (`herdr-runtime.ts`):** In `herdr-runtime.ts`, filesystem readiness event coalescing via a latching probe state prevents dropped events during in-flight checks. Synchronous child process termination fencing immediately fails readiness before awaiting atomic file writes, closing race windows where late probes could mark terminated servers ready. Exports canonical `probeHerdrSocket` validating protocols 20 and 22 via `isSupportedHerdrProtocol`.
- **Narrow Toolkit Script Authorization & Registry Replacement Isolation (`goal.ts`, `run-toolkit-script.ts`):** `goal grant_edge` supports concrete `toolkitScript` and optional `toolkitArgs` selectors instead of model-provided scope keys. Host logic derives an immutable cryptographic scope key from execution `cwd`, canonical script path, runner, script name, and exact `argv`. The grant persists across auto-compaction and session reload (`pi_edge_grant` session entries). Mutating either script path or runner under fixed name and argv alters the scope key and denies unconfirmed execution until restored. Tool cancellation during host authorization aborts via `AbortSignal.throwIfAborted()` without invoking the script executor. Authority context projection explicitly distinguishes `scope: narrow` with exact `scopeKey` from `scope: broad class-wide authorization`.
- **Owned Collaboration Control & Isolation:**
  - *No Redundant Confirmation Latch:* Removed redundant model `confirm` latch on owned panel controls (`collaboration_stop_job`, `collaboration_dismiss_job`). Owned panel operations proceed autonomously without unnecessary interactive permission pauses; dangerous toolkit script execution alone is governed by host edge grants.
  - *DryRun Non-Mutation:* Explicit `dryRun: true` previews actions (including dismiss) without mutating state.
  - *Ambiguous Target Collision Rejection:* Stopping an owned job by title rejects if multiple owned jobs match, preventing arbitrary first-match termination.
  - *Per-Worker Task Isolation:* `fire_task` without an explicit shared objective synthesizes a neutral common team objective rather than concatenating sibling tasks, ensuring worker prompts contain only their own assignments and preventing instruction contamination.
- **Bounded Goal Continuation & Transient Recovery (`goal-session-controller.ts`, `goal-state.ts`):**
  - *Authoritative Turn Ordinals:* Fresh host continuation turn ordinals reset consecutive provider failure streaks (`systemFailureStreak`) only when the outcome is `completed`, the goal is `active`, and `completionTurn === (state.continuationTurnsUsed ?? 0) + 1`. Missing, stale, or replayed ordinals never replenish retries.
  - *Distinct Runaway Signatures:* Durable runaway recovery signatures (`runawayRecoverySignature`) remain distinct from provider failure accounting. Runaway stops do not increment the provider failure streak, and subsequent provider successes do not clear active runaway signatures.
  - *Replay & Duplicate Receipt Resistance:* Duplicate receipt URIs and replayed evidence do not replenish recovery allowances or advance progress revisions.
  - *Bounded Auto-Continuation:* Auto-continuation rearms after caught transient network or provider errors up to a bounded recovery allowance (enforced as host policy rather than owner configuration); unknown failure classifications fail closed as blocked.
  - *Owner Precedence:* Explicit owner pause, stop, and cancellation commands are unconditionally respected without automatic system override.
- **Shared Collaboration & Steering Mechanics:**
  - *Shared-Panel Immutable Binding:* Collaboration placement (`current-pane` vs `managed-workspace`) is immutably bound at admission. Test fixtures explicitly default to `managed-workspace`, preventing ambient environment leaks.
  - *Exact-Occupant Event Completion:* Process lifecycle completion is strictly event-driven by the designated occupant handle rather than polling or peeking output streams.
  - *Admitted Esc/Readiness Steering:* Interactive Esc cancellation and readiness state machines halt execution at clean boundaries without unmanaged orphan tasks or lost readiness events.
  - *Prior Terminal Acknowledgment:* Existing terminal handoffs are acknowledged prior to scheduling successor turns or publishing new terminals.
  - *Retained Intent on Publication Failure:* Failed terminal publications preserve terminal records and handoffs for retry without duplicating evidence or requiring redundant steering Esc inputs.
  - *Exact Caller Executable Admission:* Caller executable admission enforces exact binary path resolution (`HERDR_BIN_PATH`) without silent fallback to ambient or path-searched binaries, ensuring caller runtime integrity across workspace launches.

---

## 3. Rejected Defect Candidates & Safety Invariants

- **Magic Confirmation Bypass:** A model-provided `confirm: true` flag is not authority; bypassing host authorization based on caller payload flags is rejected.
- **Redundant Confirm Latch on Owned Panel Control:** Imposing interactive confirmation prompts on owned panel stop and dismiss controls is rejected; owned panels remain autonomous while dangerous toolkit scripts require host grants.
- **First-Match Deletion on Ambiguous Collisions:** Resolving multiple owned jobs sharing a title by terminating the first match is rejected; ambiguous requests must fail closed.
- **Cross-Worker Directive Concatenation:** Merging sibling tasks into a shared objective is rejected to avoid role confusion and instruction leakage.
- **Broad Scope Inheritance Across Registration Changes:** Allowing scripts to retain grants when their underlying path, runner, or execution directory changes under the same name is rejected.
- **Unverified Error Auto-Resume:** Auto-resuming unclassified or unknown failure classifications is rejected; unknown failures fail closed.
- **Replayed Ordinal / Duplicate Receipt Replenishment:** Allowing replayed completion ordinals or reworded duplicate evidence receipts to reset failure counters is rejected.
- **Memory Raw-Path Denial:** Access denials on raw memory and authentication paths are intentional broker boundary protections, not orchestration bugs. Delegated memory remains a bounded query capability.
- **Read-Only Tasks with Configured Write Grants:** Workers completing without mutations despite holding write grants do not constitute a grant bypass; failing to exercise unneeded authority is safe.
- **Evidence-Gated Worker Retries:** Retries after definite terminal failure are host-owned and evidence-gated on transient classifications; they do not represent duplicate uncertain dispatches.
- **Capability, Action, and Budget Denials:** Failing closed on missing write grants, invalid action payloads, or exhausted budgets is intentional capability enforcement. Auto-salvaging unauthorized writes or invalid claims is rejected as unsafe.
- **General Delegation Utility:** Parent reviews frequently uncovered genuine implementation defects; the evidence does not support treating delegation as inherently redundant or wasted.

---

## 4. Validation Scope and Limitations

- **Prior Phase Verification (Baseline Evidence):**
  - Prior root `npm run check` completed cleanly with exit code 0, including clone gate coverage over 1,010/1,019 eligible files across 979 detection files with 0 clones (largest unit 4,638 lines / 184,392 bytes). Baseline retained two informational Biome `useTemplate` messages and npm `globalignorefile` warnings without errors.
  - Prior independent root verification of 414 unique focused tests across 34 files (135 autonomy and prompt, 73 status/runtime/worker, 66 provider/backend, 140 collaboration integration).
  - Prior 1,000-case varying-shape property fuzz probe (`pi-status-budget-fuzz.ts`) completed with 0 byte budget violations.
  - Prior live read-only Herdr protocol 22 channel ping, socket adapter probe, and caller identity verification.
  - Prior real-ledger steering probes demonstrating reliable Esc boundaries and failed publication retry without requiring a second Esc.
- **Current Refinement Verification:**
  - Independent root verification of 444 unique targeted tests across 20 files:
    - 336 tests across 12 files (authority, worker, toolkit script, and collaboration suites)
    - 5 tests across 1 file (`test/provider-authority-context.test.ts` for narrow vs. broad scope projection)
    - 71 tests across 5 files (goal continuation controllers and autosteer suites)
    - 32 tests across 2 files (`test/goal-lifecycle.test.ts` and `test/goal-state-session.test.ts` for goal lifecycle authority, persistence, turn ordinal validation, and recovery)
  - 12 authority probes and 2 scheduler probes verified (14 probes total).
  - Root `npm run check` completed with exit code 0 on final source (full output inspected): includes Windows and Linux installer regressions, TypeScript checks, browser smoke, coordinator ceiling, and clone coverage over 1,010/1,019 eligible/owned files across 979 detection files with 0 clones (largest unit 4,638 lines / 184,392 bytes). Retained baseline 2 Biome informational messages and npm `globalignorefile` warnings with 0 errors.
- **Honest Limitations & System Boundaries:**
  - Unknown failure classes fail closed and do not auto-resume.
  - Semantic conflict recognition remains model-dependent; the host enforces recorded exclusions and scope keys, but cannot guarantee model discernment.
  - External native CLIs retain their own distinct permissions, system budgets, and lifecycle semantics.
  - Cross-process Pi edge-grant transfer and inheritance is not verified.
  - Skill repair atomic replacement does not lock out arbitrary concurrent OS writers.
  - Verification does not include live paid-provider token acceptance suites or native Windows collaboration lifecycle automation.
  - No claim of universal autonomy or release readiness is made.
