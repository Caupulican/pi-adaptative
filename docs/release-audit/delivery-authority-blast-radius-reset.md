# Delivery authority and blast-radius reset

> Live source wins. This file is the record for bundle `Pi_Delivery_Authority_Blast_Radius_Reset_v1.0`.

## Identity

- Reviewed HEAD: `7edbe271534eabd36340beafdac038de8f556518`
- `origin/main` at BR-00 matched that SHA. No newer authority, git, release, or completion commits were present.

## What this reset keeps

One terminal completion owner. `system_one_required` floor. JEV-025 and JEV-026 hard pass. JEV-027 on the final bundle. Bug-fix propagation. Typed receipts. Detached HEAD and missing-upstream rejection. `npm publish --ignore-scripts`. The post-DI14 closure behavior those pieces already had.

## BR status

| ID | Result |
| --- | --- |
| BR-00 | Reviewed HEAD is current `main`. |
| BR-01 | `fix`, `implement`, `repair`, `refactor`, and `build` do not grant commit. Explicit `commit` and `push` do. Denials still win. |
| BR-02 | `DeliveryIntent` is compiled with the charter and stores exact push, tag, package, deploy-adapter, and GitHub identity. |
| BR-03 | `createRepoGitDelivery` commits `git commit -- <paths>`. It does not run `git add -A` or `git add .`. |
| BR-04 | A dirty worktree at executor construction fails automatic commit with `delivery_unsafe_unowned_changes`. Coding is not blocked. |
| BR-05 | A path that is not in the attributed list fails the same way. Shared-mode shell edits are unattributed, so they fail closed. |
| BR-06 | Proof requires approved parent, approved tree, `candidateRevision`, and `candidateTreeDigest(tree)`. |
| BR-07 | Push without commit and with residue or a moved HEAD fails `commit_required_for_dirty_candidate`. |
| BR-08 | Push uses the remote and ref frozen at admission. A later upstream change fails `push_upstream_drift`. |
| BR-09 | Tag requires an exact name. There is no default tag `objective`. Tag push is `tag_push_unsupported`. |
| BR-10 | `package.json` deploy scripts do not become adapters. Deploy runs only through a `TrustedDeployAdapter` passed at bind time. |
| BR-11 | `proveDeploy` calls `adapter.observe`. It does not cache deploy stdout. |
| BR-12 | Publish freezes package name, version, and registry. A manifest change fails `package_identity_mismatch` before `npm publish`. |
| BR-13 | A granted GitHub release fails `github_release_unsupported` and the objective does not complete. |
| BR-14 | Git and npm subprocesses take a timeout, an abort signal, a bounded buffer, and noninteractive git env. Hooks run. Signing is the repo's. `--no-verify` is not passed. |
| BR-15 | The terminal hook impact is `read_only`. It runs before `noteTerminalProof`. A refusal throws and leaves the store not complete. |
| BR-16 | `executeDelivery` owns side effects. `finalizeDelivery` owns JEV-027 and the terminal transition. `CompletionCoordinator` still owns complete-ready. |
| BR-17 | Rebase continuation stages the resolved unmerged paths, not `git add -A`. The exit-commit example no longer stages the worktree. |

## Validation

Targeted tests passed, and `npm run check` passed:

- `packages/coding-agent/test/system-one/delivery-authority-blast-radius.test.ts`
- `packages/coding-agent/test/autonomy/zero-human-charter.test.ts`
- `packages/coding-agent/test/system-one/final-completion-closure.test.ts`
- `packages/coding-agent/test/system-one/post-di14-closure.test.ts`

## Not in this reset

Isolated per-objective worktrees are still the way automatic commit can name shell edits. Until a write tracker attributes those paths, shared-worktree automatic commit fails closed. Worktree-sync's bash classifier still treats the text `git add -A` as an allowed command string; the sync engine no longer executes that form.
