# System One Next Release Hardening State

## Identity

- Bundle: v1.2
- Field-bad release: v0.99.35 / `f01f7321bb99f79f29a746ce498497b3e5846a8b`
- Bundle source review HEAD: `cd6dd777d6fc59486bc06ac7c2698b7c5692b470`
- Current branch: `main`
- Current HEAD: `cd6dd777d6fc59486bc06ac7c2698b7c5692b470`
- Latest affected session: `01a0c214-1607-723c-aa91-03f970c23058`
- Latest session CWD: `/home/caudev/GitHub/mine/AIdeas` (agent product under test; ledger in `~/.pi/agent/state/decision-ledger.sqlite`)
- Last updated: 2026-09-21
- Agent/run: grok-goal-b7a661675d04

## Working tree

```text
(clean at census)
```

## Latest session anomaly census

Session file: `~/.pi/agent/sessions/--%2Fhome%2Fcaudev%2FGitHub%2Fmine%2FAIdeas--/2026-09-21T03-48-11-399Z_01a0c214-1607-723c-aa91-03f970c23058.jsonl`

Ledger `semantic_evaluations` for this session: 27 `worker supervision` `failed` with reasons `Missing answer for boolean decision 'meaningful_progress'`; 79 tool-gate ok; 4 preflight ok; 5 postflight ok.

| Record | Count | Classified | Active blocker? | Cause/fix | Evidence |
|---|---:|---:|---|---|---|
| Jev supervision failures | 27 | control-plane defect: secondary decoder after empty `answers: {}` / unrecognized checkpoint `approved` fallback | yes | NR-01/NR-02 | ledger rows 03:54–03:55 UTC 2026-09-21 |
| duplicate TUI errors | 27 identical | reporting: no debounce by attempt+error class | yes | NR-03 | same reasons string repeated |
| not started | unknown in this ledger | not in semantic_evaluations; classify from session JSONL in NR-00 remainder | open | NR-00/NR-09 fixture | session JSONL |
| negative outcome | unknown | same | open | NR-00 | session JSONL |
| unknown effect | unknown | same | open | NR-00 | session JSONL |
| retained error result | unknown | same | open | NR-00 | session JSONL |
| compactions | TBD | economics gap if early-threshold without cache proof | possible | NR-04/NR-05 | compaction-controller + usage |

Original field screenshot (`evidence/worker-supervision-missing-meaningful-progress.png`) matches this ledger error string. The 27 repeats are the same secondary coverage failure, not 27 distinct provider faults.

## Work orders

| WO | Status | Notes |
|---|---|---|
| NR-00 | VERIFIED | session `01a0c214`; ledger census |
| NR-01 | FIXED_UNVERIFIED | first-class checkpoint + SteeringPlane bind; Jev packets |
| NR-02 | FIXED_UNVERIFIED | JevAdapterFailure; no empty answers |
| NR-03 | FIXED_UNVERIFIED | debounce + onSupervisionError |
| NR-04 | FIXED_UNVERIFIED | early-compaction-economics.ts |
| NR-05 | OPEN | replay table still needed |
| NR-06 | FIXED_UNVERIFIED | goalYesNode pending not lit |
| NR-07 | FIXED_UNVERIFIED | follow key |
| NR-08 | OPEN | density audit incomplete |
| NR-09 | FIXED_UNVERIFIED | fixture in test/fixtures |
| NR-10 | IN_PROGRESS | two explore hunts launched |
| NR-11 | OPEN | adversarial remainder |
| NR-12 | OPEN | after NR-00–11 VERIFIED |

## Worker supervision

- Live path: `AgentSession` constructs `WorkerSemanticSupervisor` with `createRetentionDecisionEngine` (compaction adapter). SteeringPlane path exists but checkpoint compiler falls through to generic `approved`.
- First-class checkpoint: no
- Original provider failure retained: no (secondary `meaningful_progress`)
- Empty-answer pseudo-success impossible: no
- Failure debounce: time debounce only, not error-class
- Worker continues on observer failure: coordinator catch exists; `onSupervisionError` unbound
- TUI recovery: not proven

## Compaction economics

- Early compaction planner: `assessCompactionNeed` / `shouldCompact` token thresholds only
- Hysteresis: ineffective-threshold frontier exists; not cache-economics

## TUI

- false DELIVER branch: `composeDecisionDiagram` always builds yes/DELIVER
- semantic focus: `{ row: composed.currentRow }` only
- auto-follow: re-anchors only when row number changes

## Resume next action

Implement first-class `JEV-WORKER-SUPERVISION`, stop empty-answer adapter fallback, bind supervisor to SteeringPlane.
