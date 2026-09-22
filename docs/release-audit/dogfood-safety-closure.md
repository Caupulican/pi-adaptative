# Dogfood safety closure

Superseded for root git and fingerprinting by `objective-mutation-boundary-closure.md`.

Reviewed base: `d8f3666688168a20f8a0987ba71c407a150f0a66`.

This closure keeps operational closure. It does not redesign delivery and it does not add isolated worktrees.

## DF-01 — Root bash git is read-only

`classifyRootGitBash` is the root bash allowlist. Plain inspection commands are allowed, including `status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `ls-tree`, `cat-file`, `blame`, `grep`, and the other plumbing reads in `ROOT_READ_ONLY_GIT`. `branch` with no name, `tag` with no name, `remote` list/`show`/`get-url`, `config` reads, and `worktree list` are inspection. Commit, add, tag create, branch create, rebase, update-ref, checkout, switch, merge, pull, push, reset, clean, stash, config writes, and any other subcommand are refused. A `-c` global is refused because it can install an alias.

Lane WIP stays on `classifyDangerousGitBash`. An explicit `git add README.md` and `git commit -m` are still not refused there. `lane-gate.ts` and `lane-tool-surface.ts` still call that function.

Typed delivery does not go through bash. The root tool gate calls `classifyRootGitBash` before the command runs.

## DF-02 — Shell poison follows the checkout

`captureRepoDeliveryFingerprint` hashes `rev-parse HEAD`, `diff --raw --cached -z`, `diff --raw -z`, the bytes and mode of paths in `diff --name-only -z`, and the bytes and mode of `ls-files -z --others --exclude-standard`. Ignored paths are not in that untracked list. A missing or failed git read returns `{ ok: false }`.

The root tool gate and the worker attempt executor snapshot that fingerprint before an allowed `bash` or `run_process`, then again after it settles. Equal digests do not call `noteShellMutation`. A changed digest, a failed read, or a missing before-snapshot does. Read-only root git skips the snapshot. `git status > note.txt` is not read-only, so a redirect that creates a candidate is observed.

`npm test` and `cargo check` that leave that fingerprint unchanged do not mark `shell_mutation_unattributed`. A tracked write, a new untracked candidate, or a HEAD or index change does.

## DF-03 — Production-composition smoke

`packages/coding-agent/test/system-one/dogfood-safety-closure.test.ts` drives a real `AgentSession` and `ObjectiveExecutionController` on a temp git repo.

Prompt: `fix the file, run the targeted test, commit and push when complete`. The same compiler leaves commit and push false for `fix the file, run the targeted test`.

The passing run blocks root `git commit -m x -- README.md`, records one typed write of `README.md`, runs a node check that does not change the checkout, freezes a candidate at JEV-024, commits that file, pushes the frozen upstream, passes JEV-027, and stores phase `complete`.

The negative run writes `other.txt` from bash. Delivery returns `unrecoverable` with `shell_mutation_unattributed` and does not move HEAD.

## Validation

Targeted vitest: `dogfood-safety-closure.test.ts` (4) and `delivery-authority-operational-closure.test.ts` (9) passed. `npm run check` exited 0. No release and no tag. The start words did not authorize commit or push.

## Preserved

Coding verbs do not grant commit. The candidate freezes before JEV-024. Owned paths are the only automatic commit input. Push remote and ref stay frozen. Tag push is the tag ref only. Package identity stays on the charter intent. Deploy stays on registered adapters. Pre-commit tests still start without the hook git location. Git subprocesses that pass an explicit checkout still drop inherited `GIT_DIR` and `GIT_INDEX_FILE`.
