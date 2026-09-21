# System One Next Release Hardening State

## Identity

- Bundle: v1.2
- Field-bad release: v0.99.35 / `f01f7321bb99f79f29a746ce498497b3e5846a8b`
- Bundle source review HEAD: `cd6dd777d6fc59486bc06ac7c2698b7c5692b470`
- Current branch: `main`
- Current HEAD: `aa451947f0cb9e5a8add541dd626aeae53ebf42c` (`Add [Unreleased] section for next cycle` after Release v0.99.37)
- Shipped: `v0.99.36` / `330a4d354`; `v0.99.37` / `9c9e1f9872496a3686ba4e5d07936c56a72304c0`
- Serialize/pending-checks code SHA: `056309a7d2b4b5a84a64e18bd877bb99e969eee1`
- Latest field-bad session: `01a0c214-1607-723c-aa91-03f970c23058` (v0.99.35)
- Gate J v0.99.36 JSON-fail session: `01a0c27f-5269-7469-98c2-e1d5b4ced0ac`
- Gate J v0.99.37 clean session: `01a0c2a6-c147-754c-8e2c-45abd5414a9c` (cwd scratch `smoke-cwd-037`; ledger `~/.pi/agent/state/decision-ledger.sqlite`)
- Last updated: 2026-09-21
- Agent/run: grok-goal-b7a661675d04

## Latest session anomaly census

See `{SCRATCH}/session-forensics.md`. Ledger: 27 `worker supervision` failed `Missing answer for boolean decision 'meaningful_progress'`; 79 tool-gate ok; 4 preflight ok; 5 postflight ok. JSONL: 0 compaction events; cacheRead 861568 / cacheWrite 0 (hot prefix). All `not started` / `unknown effect` rows classified. Remaining negatives are tool `isError` / one `operation_outcome` / one aborted assistant — not the field supervision defect.

## Work orders

| WO | Status | Notes |
|---|---|---|
| NR-00 | VERIFIED | session `01a0c214`; JSONL+ledger census |
| NR-01 | VERIFIED | `JEV-WORKER-SUPERVISION` seven booleans; SteeringPlane bind; Jev packets |
| NR-02 | VERIFIED | `JevAdapterFailure`; missing answers `invalid_response`; no empty success |
| NR-03 | VERIFIED | debounce + `onSupervisionError`; worker continues |
| NR-04 | VERIFIED | `early-compaction-economics.ts`; hysteresis not stamped on skip/missing prices |
| NR-05 | VERIFIED | replay table: old=no compaction row; new=`hot_cache` defer; no fabricated savings |
| NR-06 | VERIFIED | List+Diagram pending not lit DELIVER |
| NR-07 | VERIFIED | follow key; pin `new`; deliver-pending current node |
| NR-08 | VERIFIED | density: no second in-flight Jev level; POV owns CONTROL/ACTOR/ROUTE/JEV |
| NR-09 | VERIFIED | `test/fixtures/system-one/latest-session-hardening.json` |
| NR-10 | VERIFIED | hunt-runtime.md, hunt-tui-economics.md; B1/B2 and TUI blockers fixed |
| NR-11 | VERIFIED | Gate I Jev 6/6 + list/consume 1.00; hysteresis rewrite 1.00 after 0.34 bad question; v0.99.37 reconfirm 10/10 at 1.00 |
| NR-12 | VERIFIED | `v0.99.36` then `v0.99.37`; `ci.yml` success on `056309a7d` (35566215182) and Release `9c9e1f987` (35567463088); `destructive.yml` on `9c9e1f987` (35567581390); `build-binaries.yml` tag `v0.99.37` (35567695496); GitHub https://github.com/Caupulican/pi-adaptative/releases/tag/v0.99.37 ; live Jev + two-worker smoke on installed 0.99.37 |

## Worker supervision

- Live path: `AgentSession` → `WorkerSemanticSupervisor.steering.requireCertificate("JEV-WORKER-SUPERVISION", …, { requirePass: false })`. Retention adapter is compaction-only.
- Boolean noul questions omit `criteria` when the program has none (`TypeSafeSystemOneDecisionEngine`); `serializeEvaluation` rejects `undefined`. This is the v0.99.37 transport fix.
- First-class checkpoint: yes
- Empty-answer pseudo-success: adapter throws `invalid_response`; supervisor `requireSupervisionAnswers` throws; coordinator continues worker
- Unrecognized checkpoint: throws, no generic `approved`
- Pending specialist/capability/verifier: `composeObjectiveRoute` after wait/owner; consume only if adopted
- Observation: `outputTail`, `isStalled`, `isRepeating` on live attempt and in Jev state; intervention uses the seven answers (churn is a separate mechanical gate)

## Compaction economics

- Early planner: `projectEarlyCompactionEconomics`; missing prices → `insufficient_evidence`; hot hit-ratio ≥ 0.7 → `hot_cache`
- Hysteresis stamp: not on `insufficient_evidence` or `hysteresis`
- Safety/recovery: unchanged

## TUI

- false DELIVER: List and Diagram require open checks = 0
- semantic focus: `graphFocusKey`; pinned `new`
- deliver-with-open-checks: pending yes-node is current

## Jev (implementer Gate I)

- `{SCRATCH}/jev-gate-i-2-results`: 6/6 gate_passed confidence 1.00
- `{SCRATCH}/jev-gate-i-3-results`: list 1.00, consume 1.00; hysteresis-no-stamp 0.34 (badly formed) rewritten
- `{SCRATCH}/jev-gate-i-3b-results`: hysteresis-token-in-if 1.00
- `{SCRATCH}/jev-gate-i-037-results`: 10/10 gate_passed confidence 1.00 against tagged v0.99.37 sources (omit undefined criteria, pending obligations, serialize throw, requirePass false, observer returns undefined, seven ids, POV CONTROL/ACTOR/ROUTE/JEV, JEV ok label, resumable human-input snapshot, native_calibrated)

## Gate J

- v0.99.36 print-mode session `01a0c27f`: 2 workers, files correct, tool-gate Jev ok; supervision failed `TypeSafe evidence must be finite, acyclic JSON` (boolean `criteria: undefined`). Fixed in v0.99.37.
- v0.99.37 installed binary print-mode session `01a0c2a6`: 2 workers (`worker_completed`), `hello-a.txt`=`alpha`, `hello-b.txt`=`beta`; tool-gate `jev-1.13.0` allow ×2; no TypeSafe JSON error. One truthful degraded supervision row: confidence 0.62 < 0.75. Workers not aborted. cacheRead 86189.

## Resume next action

None for this bundle. v0.99.37 is installed on this host (`~/.local/bin/pi` → `releases/v0.99.37`).
