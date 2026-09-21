# System One Post-DI14 Closure

> Live source wins. This file records remaining red-team defects after DI-14 and the closing SHAs.

## Identity

- Bundle: `Pi_SystemOne_Post_DI14_RedTeam_Closure_Bundle_v1.0`
- Bundle reviewed HEAD: `d9389da5d`
- Current `main` at RC-00: `2215bdc436d57592fb09dc60c1da47788181cde3`
- Newer commits since review (do not reset):
  - `2215bdc43` — Scope GitHub CI to the commit and run the full suite on tags
- Closing SHA: `b6f69ad526bdb541f575811275ee2bc4a90ff755`

## RC-00 review of newer commits

`2215bdc43` is CI trigger/planner work. It does not close RC-01..RC-11.

## Defects still live at RC-00

| ID | Defect on `2215bdc43` |
| --- | --- |
| RC-01 | Live `completion_candidate` does not pass `getExecutionState`. Coordinator throws if it is missing. |
| RC-02 | `getPendingRootRequests` omits `mark_external_block`. |
| RC-03 | Inner `executeCompletionTransaction` persists `complete` before JEV-025/027. |
| RC-04 | Digest uses `process.cwd()` / `git diff HEAD` without an explicit repo root or untracked path identity. |
| RC-05 | JEV-004 `projectBoundedCombinedState` is called without System One state; missing state looks clean. |
| RC-06 | `sideEffects: any`; failed receipts can TypeError on `.detail`; failed push can still complete. |
| RC-07 | JEV-027 runs before push/publish/deploy; final bundle is not re-certified. |
| RC-08 | SDK default profile is `semantic_enhanced` even under `DEFAULT_STEERING_POLICY.mode = system_one_required`. |
| RC-09 | Breaker still evaluates Jev after opening; `stop_and_reroute` can fire more than once. |
| RC-10 | Same as RC-04/RC-05: snapshot identity is not shared across certificates. |
| RC-11 | DI-03, DI-06, DI-07, DI-08, DI-10, DI-14 marked DONE in recovery audit while these defects remain. |

## Closing record

- Implementation: `b6f69ad526bdb541f575811275ee2bc4a90ff755`
- Message: Close remaining post-DI14 System One integrity defects
- Pushed to `origin/main` (SHA stamp follows this file)
- Gate 3 run() regression: `packages/coding-agent/test/system-one/post-di14-closure.test.ts` drives `ObjectiveExecutionController.run()` with a store-backed `executeCompletionTransaction` that honors `persistTerminal`, fails JEV-027 after inner semantic pass, and asserts `store.phase !== "complete"` and `result.status` is not complete.
