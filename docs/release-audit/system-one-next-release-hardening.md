# System One Next Release Hardening State

## Identity

- Bundle: v1.2
- Field-bad release: v0.99.35 / `f01f7321bb99f79f29a746ce498497b3e5846a8b`
- Bundle source review HEAD: `cd6dd777d6fc59486bc06ac7c2698b7c5692b470`
- Current branch: `main`
- Current HEAD: `70321b061d80e6c204ac5a774188f9f8768e05da` plus uncommitted hardening follow-up (this file's slice)
- Latest affected session: `01a0c214-1607-723c-aa91-03f970c23058`
- Latest session CWD: `/home/caudev/GitHub/mine/AIdeas` (agent product under test; ledger in `~/.pi/agent/state/decision-ledger.sqlite`)
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
| NR-11 | VERIFIED | Gate I Jev 6/6 + list/consume 1.00; hysteresis rewrite 1.00 after 0.34 bad question |
| NR-12 | OPEN | check / CI / destructive / release:patch |

## Worker supervision

- Live path: `AgentSession` → `WorkerSemanticSupervisor.steering.requireCertificate("JEV-WORKER-SUPERVISION", …, { requirePass: false })`. Retention adapter is compaction-only.
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

## Resume next action

NR-12: `npm run check`, push, `ci.yml` + `destructive.yml` on exact SHA, `npm run release:patch`.
