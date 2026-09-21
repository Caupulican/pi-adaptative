# System One Decision Integrity Recovery Audit

## Exact revisions
- Start HEAD: d434cd60d041f232491af37aab7da9d1f3fc2b5c
- Final HEAD: d1045ff8b
- Pushed: yes

## Work Orders
| ID | Status | Notes |
|----|--------|-------|
| DI-00 | DONE | Baseline established |
| DI-00A | DONE | Semantic provider boundary closed in previous session |
| DI-01 | DONE | External block decision contract repaired in previous session |
| DI-02 | DONE | Circuit breaker implemented |
| DI-03 | CLOSED | `mark_external_block` was not in pending root requests. Now included and consumed once onto `blocked_external`. See post-di14-closure.md. |
| DI-04 | DONE | Semantic activity tied to session liveness |
| DI-05 | DONE | Canonical work-state consolidated |
| DI-06 | CLOSED | JEV-004 now receives System One snapshot identity; missing state is `integrity_state_unavailable`, not a clean empty matrix. |
| DI-07 | CLOSED | Candidate identity is `captureCandidateSnapshot(repoRoot)` (tracked bytes, untracked path+bytes, revisions). Not `process.cwd()`. |
| DI-08 | CLOSED | JEV-027 runs on the FINAL bundle after required receipts, not before push/publish/deploy. |
| DI-09 | DONE | Typed side-effect receipts required |
| DI-10 | CLOSED | One terminal-complete persist after proof, JEV-025/026, receipts, and JEV-027. Inner semantic evaluation uses `persistTerminal: false`. |
| DI-11 | DONE | Semantic provenance hardened on mandatory gates |
| DI-12 | DONE | Long-horizon counterfactual harness created |
| DI-13 | DONE | Durable audit created |
| DI-14 | SUPERSEDED | Marked DONE while RC-01..RC-11 were still live. Closed by post-DI14 closure SHA recorded in `system-one-post-di14-closure.md`. |

## Validation
- `npm run check`
- Targeted `biome` and `tsc`
- `scripts/install-standalone.test.mjs` (flaky test noted, bounds staging cleanup)

## Bug Hunt Findings
- Hunt 1 (Contract Drift): Fixed `programs.ts` JEV-025 and JEV-026 duplicate definitions.
- Hunt 3 (Self-certified truth): Replaced `mechanicalPassed` and `smokePassed` booleans with actual receipts.
- Hunt 4 (Placeholder evidence): Replaced `active_verified` and `smoke_passed` with `unknown` and threw an error when `candidateRevision` falls back to `HEAD`.
- Hunt 9 (Operator illusion): Fixed by resolving contract drift in `programs.ts`.
- Hunt 10 (Adversarial long-task effectiveness): Removed `elapsedMs` from `shouldAssess` hash.
- Hunt 11 (Provider leakage): Fixed truth/confidence inversion in `evidence-retention-planner.ts`.

## Known limitations
- TBD
