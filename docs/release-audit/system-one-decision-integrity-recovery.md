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
| DI-03 | DONE | external_block_present wired |
| DI-04 | DONE | Semantic activity tied to session liveness |
| DI-05 | DONE | Canonical work-state consolidated |
| DI-06 | DONE | JEV-004 route state evidence-complete |
| DI-07 | DONE | Exact completion candidate frozen |
| DI-08 | DONE | Delivery-truth certification moved |
| DI-09 | DONE | Typed side-effect receipts required |
| DI-10 | DONE | Deterministic completion truth unified |
| DI-11 | DONE | Semantic provenance hardened on mandatory gates |
| DI-12 | DONE | Long-horizon counterfactual harness created |
| DI-13 | DONE | Durable audit created |
| DI-14 | DONE | Validation gate, bug hunt, and fixes completed. Pushed to origin/main. |

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
