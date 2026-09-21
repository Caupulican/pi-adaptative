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
- Gate 3 run() regression: `packages/coding-agent/test/system-one/post-di14-closure.test.ts` drives `ObjectiveExecutionController.run()` with a store-backed `executeCompletionTransaction` that honors `persistTerminal`. Inner semantic pass then JEV-025 fail returns terminal `unrecoverable` (does not `break` into the route loop). JEV-027 fail after receipts is the same store-not-complete assertion. Both assert `persistTerminal === false` and `store.phase !== "complete"`.

## Final completion closure

Live source wins. Three outcomes:

1. After outer final delivery truth succeeds, the objective result status is `complete` and the System One store phase is `complete`. `SystemOneController.commitTerminalCompletion` is the only production transition to that phase and it runs the terminal hook once. A duplicate proof does not transition or hook again. A conflicting proof is rejected. JEV-025 fail, JEV-026 fail, a required receipt fail, and JEV-027 fail each leave the store phase not `complete`. JEV-025 and JEV-026 both return terminal `unrecoverable`. Inner `executeCompletionTransaction(..., { persistTerminal: false })` still does not persist terminal complete. The goal tool passes that flag, and omitting `persistTerminal` does not finalize the store either. A required commit or push whose executor is missing fails the receipt instead of throwing `Git commit unavailable`. Fake SHAs, mismatched observed SHAs, and a reported remote that is not the observed remote stay not complete. The proven push remote is the observed remote. A live session binds `createRepoGitDelivery` as that executor. Tag, publish, and deploy receipts are proven the same way: a tag whose commit is not the proven commit, or a publish or deploy id the proof port does not observe, is not complete.
2. `resolveEffectiveCompletionProfile` is the SDK setting path and the objective-controller fallback. Active steering mode `system_one_required` resolves to `system_one_required` over `mechanical`, `mechanical_plus_reviewer` / `reviewer`, and `semantic_enhanced`. Optional steering keeps an explicit `semantic_enhanced` request. With no semantic plane and no request, the effective profile is `mechanical`.
3. A required commit or push is complete only when `gitExecutor.proveDelivery` shows actual HEAD equal to the commit receipt SHA, the observed remote SHA equal to that commit SHA, and no candidate-attributable residue. The push receipt and final delivery bundle carry that remote, ref, and observed SHA. A fake commit SHA or a mismatched observed SHA is not complete. The controller does not open a network connection for that proof. `createRepoGitDelivery` is the session port: it commits, pushes, and tags in the session worktree, and `git ls-remote` stays inside that port. Commit and tag use the repo's own signer. The tag is created with a message so an annotated tag does not open an editor. Push uses `branch.<name>.remote` and `branch.<name>.merge`. A detached HEAD or a branch with no upstream is not given a stand-in remote. `createRepoReleaseDelivery` is bound only when `package.json` is a publishable package or has a deploy script. Publish passes `--ignore-scripts`. A status script supplies an independent deployment id; otherwise the id is the deploy script's stdout. Bug-fix detection matches the words `bug`, `bugs`, and `bugfix`. Tag, publish, and deploy use `proveTag`, `provePublish`, and `proveDeploy`. A missing proof function fails the receipt. JEV-025 and JEV-026 grade the completion catalog at the completion policy's hard-pass thresholds.
