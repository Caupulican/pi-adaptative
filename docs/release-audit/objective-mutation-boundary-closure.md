# Objective mutation boundary closure

Reviewed base: `d8f3666688168a20f8a0987ba71c407a150f0a66`.
The dogfood safety edits were uncommitted on that commit when this closure started. They are kept and narrowed.

Safety mode: `shared_guarded`.

`shared_guarded` proves whether a call changed the checkout. It does not stop a process from damaging that checkout. Process-heavy dogfood runs in a disposable clone. `isolated_objective` is named and not wired in-process. Nothing here resets the owner checkout.

## Boundary

`RepositoryMutationObserver` is the only fingerprint owner. A call is observed from the capability catalogue: `process.exec`, `tests.execute`, `filesystem.write`, `worktree.mutate`, `source.write`, and the other mutating capabilities. `edit` and `write` stay typed owned writes and are still fingerprinted. An extra path is `shell_mutation_unattributed`. Unknown tools are observed while commit, push, or tag delivery is active. Host `repositoryEffect: "none"` is the only opt-out. Tool arguments cannot set it.

Observation starts before extension `tool_call` hooks and finishes after result hooks, including a hook that blocks. A background call keeps its token until `afterToolCall`. Candidate freeze awaits `waitForRepositoryQuiescence` before JEV-024.

A shared-worktree worker attempt is one parent token. A different git dir is not applied to the root ledger. Typed worker writes stay declared paths. Any other delta is unexplained.

## Git

Root bash refuses every git invocation, including quoted, path-qualified, `env`, and `command` forms. `repo_read` is on the default root tool list. Lane `classifyDangerousGitBash` uses a quote-aware lexer. `git commit "-a"`, `git commit '--no-verify'`, and `git.exe add "--all"` are refused. An unfinished quote or a substitution fails closed.

## Fingerprint

`captureRepoDeliveryFingerprint` streams `rev-parse HEAD`, `git ls-files --stage -z`, and `git status --porcelain=v2 -z --untracked-files=all`, then streams each changed or untracked file in chunks. Ignored paths are absent. A fence mismatch retries once. A second mismatch is `repository_fingerprint_unstable`. A failed read is `repository_fingerprint_unavailable`.

Shared-worktree bash, Python, `run_process`, and toolkit scripts own a tracked process tree. The persistent bash wire runs `wait` after the command status is saved and before the sentinel. A one-shot process is a process-group leader and the tool returns only after that group is empty. A persistent shell's direct children are waited the same way. Shell death ends its process group. A tree that cannot be observed is `process_tree_untracked`. Command text is not a detach detector.

A frozen candidate that is no longer the live tree returns to completion. The next cycle freezes the new tree and reruns JEV-024. Certify-time `delivery_unsafe_unowned_changes` and a HEAD that left the admission baseline stay terminal. A delivery failure that is not candidate identity stays `unrecoverable`.

## Known limitation

Native per-objective worktrees are not built. A destructive process in `shared_guarded` can change the checkout before the observer blocks delivery. Dogfood of process-capable automatic commit uses a separate clone.
