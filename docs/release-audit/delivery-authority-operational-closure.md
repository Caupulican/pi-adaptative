# Delivery authority operational closure

Reviewed base: `c19a4590a37bfb1bf1f0cc8d2bdafacd5da9da0f`.

This closure keeps the blast-radius reset. It wires the remaining production paths. It does not add isolated per-objective worktrees.

## What is now true

- A successful typed `edit` or `write` on the root tool gate, and the same tools on a worker, record a repo-relative path and a sha256 of the resulting bytes on one session ledger. `attributedMutationPaths` reads that ledger. An empty ledger still fails closed.
- A bash command that is not read-only git (`status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `blame`, `grep`) marks the objective `shell_mutation_unattributed`. Automatic shared-worktree commit stays fail-closed. The user can keep working.
- If an owned path's bytes change without a new owned write, the ledger reports `ownership_drift` and the commit does not proceed.
- Root bash and lane bash share one classifier. It refuses `git add -A`, `git add --all`, `git add .`, `git add -u` without explicit paths, `git commit -a` / `--all` / `--no-verify`, `git stash`, `git reset --hard`, `git clean` with `-f`, `git checkout .`, `git restore .`, and any `git push`. Explicit-path `git add` and `git commit -m` stay available for lane WIP. The delivery executor does not go through bash.
- When a commit is requested, `certifyOwnedCandidate` runs before JEV-024. The approved parent, tree oid, tree digest, and owned path digests are part of the canonical proof state. Delivery commits that tree. It does not certify a replacement tree. A mismatch is a failed commit.
- `completion_candidate` runs with impact `read_only`. A hook result that asks to mutate does not pass. Mutating extensions use `before_mutation`, which runs before the freeze.
- A push with no commit compares live HEAD to the semantic candidate revision. A clean HEAD move fails `stale_candidate` and does not push the new commit.
- A tag receipt includes `tag` and `targetSha`. After a commit, the target is the proven commit. With no commit, the worktree must be clean and the target is the semantic candidate. A missing target is `tag_target_unspecified`.
- `push tag <name>` and `create and push tag <name>` grant tag push only. Branch push remains a separate `push`. Tag push is `git push <frozen-remote> refs/tags/<name>:refs/tags/<name>`, proved by `ls-remote`. It does not push branch HEAD.
- The live release executor receives `packageIntent: charter.delivery.packagePublish` or `false`. A public manifest alone does not bind publish. When admission observed a checkout and publish is granted, the npm registry is read once into the intent. Publish does not read it again.
- Publish builds one tarball with `--ignore-scripts` and publishes that file. A later worktree edit does not repack. Registry `dist.integrity` and `dist.shasum` must match the tarball. The receipt carries package name, version, registry, and integrity.
- Deploy adapters come from `registerTrustedDeployAdapter` on the session. Repository scripts are not adapters. A missing adapter fails `deploy_adapter_unavailable`. An observation whose deployed revision or artifact digest disagrees with the candidate fails proof.

## Still fail-closed on purpose

Shell edits in the shared worktree are not attributed. Isolated per-objective worktrees would be the mode that could attribute them. This closure does not build that mode and does not weaken the shared-worktree rule.

GitHub release remains `github_release_unsupported`.

## Preserved from the blast-radius reset

`fix`, `implement`, `repair`, `refactor`, and `build` do not grant commit. A dirty admission baseline fails closed. Push remote and ref stay frozen. There is no default tag name. Commit does not use `git add -A` or `commit-tree`. The terminal hook is read-only and runs before complete is stored.
