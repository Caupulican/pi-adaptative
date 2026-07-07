# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: audit the latest commit on `main` yourself before releasing. Do not ask the user to run `/cl`; use git diff/log and the changelog rules above to update each affected package's `[Unreleased]` section, then validate and commit the changelog update before running the release script.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes npm packages**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

5. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

## Open threads

(none)

## Findings

### 2026-07-07 · packages/ai · tool-call validation repair is now a named validate-then-repair layer — claude
R31 is closed: `validateToolArguments` now checks first and returns valid argument objects unchanged, then routes failures through `packages/ai/src/utils/tool-repair/{registry,analyzer,repairer}.ts`. The named registry covers the Phase 4 grammar landed in this commit (null optional drop / required-null bounce, JSON string parse, array wrapping/unwrapping, scalar string repairs, enum normalization, numeric arrays, and bash command shapes); `packages/coding-agent/src/core/tools/edit.ts` no longer carries the stringified-`edits` shim, leaving that shape to the shared repairer while preserving the legacy `oldText`/`newText` adapter.
- evidence: packages/ai/src/utils/validation.ts:293 · packages/ai/src/utils/tool-repair/registry.ts:1 · packages/ai/test/tool-repair.test.ts:1 · packages/coding-agent/src/core/tools/edit.ts:95
- CLOSED 2026-07-07: follow-up roadmap items R32-R38 closed the remaining Phase 4 tool-call reliability gaps: OpenAI-compatible streamed id synthesis (`2f39f10e`), truncated-args bounce (`3db63cf3`), schema-rich validation feedback (`c1aebcb2`), shape-only telemetry (`65945a12`), provider tool-name sanitization (`87026269`), replaying repaired args (`3d70c75a`), opt-in text tool-call extraction (`25cc5649`), repeated validation-failure escalation (`64df95f4`), and the per-model adaptation store (pending commit). Keep the validation layer as validate-then-repair; do not reintroduce tool-specific pre-coercion shims.
- tags: tool-repair, validation, packages/ai, packages/coding-agent, roadmap-r31, roadmap-r38

### 2026-07-06 · compaction · auto-compaction retry ladder is unreachable in the early-trigger band: loop skips "within threshold" after cycle 1 — claude
`_checkCompaction` fires auto-compaction from the EARLY fractional trigger (`contextWindow * triggerPercent`, default 0.7) or `model.autoCompactionTriggerTokens`, but `_runAutoCompaction` hands `runCompactionLoop` only the HARD threshold (`contextWindow - reserveTokens`). The first `measureLiveTokens()` read is force-inflated past that threshold (`measureReads++ === 0 ? Math.max(measured, triggerThreshold + 1) : measured` — a symptom-mask, not a fix); every later cycle measures honestly, so after any cycle-1 failure (e.g. gate-failed) cycle 2 sees `measured <= threshold` and returns `skip: "within threshold"`. Nothing is applied, deterministic fallback (cycle 4) is unreachable, and the next agent_end re-triggers the same fail-and-skip — an every-turn loop that burns 2 full-context summarizer calls per turn and never compacts. Field repro (session 019f39f1, openai-codex/gpt-5.5, window 272k): live ~191–193k > fractional 190.4k (triggers) but < hard 255.6k (skips); log shows `cycle 2: gate-failed` immediately followed by `Auto-compaction skipped: within threshold`. Fix direction: the loop's skip/success predicate must be the SAME predicate that triggered compaction (pass `shouldCompact(...)` in, delete the first-read forcing hack).
- evidence: packages/coding-agent/src/core/agent-session.ts:3181-3189 (threshold + forcing hack) vs :3148 (`shouldCompact` with fractional/autoCompactionTriggerTokens) · packages/agent/src/compaction/loop.ts:76-85 (skip check) · ~/.pi/agent/sessions/…/2026-07-07T00-19-01-249Z_019f39f1….jsonl
- RESOLVED 2026-07-06: shared `shouldCompact(tokens)` predicate replaces the numeric threshold; forcing hack deleted; overflow reason uses always-true predicate + post-apply short-circuit (the provider error is the trigger). Commits 51ee6adf, a7ec5d8a. Field-verified: `/compact` on the broken session now produces a compaction entry.
- tags: compaction, retry-ladder, packages/agent, packages/coding-agent, root-cause

### 2026-07-06 · compaction · verification gate demands transcription of unbounded, noise-polluted facts the prompt tells the summarizer to compress — claude
`extractCompactionFacts` emits one action string per tool call over the whole compacted span, unbounded (field session: 110 actions, facts block ≈ 4,429 tok), each carrying the tool result's FIRST LINE as "outcome" — which is file-content noise (`— ---`, import lines, `## main...origin/main`) plus volatile tokens (timings `21ms`, counts, and pi's own context-gc stub paths `~/.pi/agent/context-gc/<uuid>/<hash>.txt`, because the agent READs those stubs and extraction records harness plumbing as work). `verifySummary` then demands ≥60% unique-token containment of ALL of that in `## Done` (plus all modified paths, 80% read-path tokens, 90% active-task tokens) while `getSummaryBudget` hard-caps output at 4,000 tok AND the prompts instruct compression ("Budget: ~N tokens. Concrete beats complete", update path: "keep 15 most recent Done items"). The ladder makes gate failures WORSE: tier escalation is a no-op when router is off (cheap==session resolve to the same model), and `enforceMonotonicProgress` halves keepRecentTokens (bigger span → more facts → higher demand) and switches to chunked mode, whose `slice(-4)` drops older chunks the gate still covers. Which specific check failed in the field is unknowable: `mapFailureCause` flattens the error to `gate-failed` and transitions print only the cause — the `formatVerificationFailures` detail is discarded (observability gap). Fix direction: bound/de-noise the gated facts (gate on verb+path, not outcomes; exclude harness plumbing paths; cap actions), derive budget from the bounded demand, make gate-failed rungs actually change odds, and surface failure details in the warning.
- evidence: packages/agent/src/compaction/extraction.ts:367-374 (unbounded actions w/ outcomes) · packages/agent/src/compaction/verification.ts:92-103 (actions containment ≥0.6) · packages/agent/src/compaction/compaction.ts:655-668 (4k cap) · packages/agent/src/compaction/loop.ts:200-236 (ladder escalation) · scratchpad repro on session 019f39f1
- RESOLVED 2026-07-06: gated facts bounded and de-noised (verb+path actions, deduped, cap 15; harness plumbing paths excluded; active-task gate uses the shared 4k clamp), budget derived from bounded demand with `summary-demand-exceeds-reserve` → deterministic fast path, gate-failed no longer enlarges span, no-op tier rung skipped, failure details threaded to warnings. Commits 51ee6adf, 638eb33b. Checkpoint CONTENT contract (working set, open-error facts, drop rules) is roadmap Phase 0 C6–C8, still open.
- CLOSED 2026-07-07: checkpoint v2 complete (C6–C10). Note for future maintainers: the open-error classifier must stay SIGNAL-FIRST (`isError` → `details.exitCode` → bash-only line-anchored text signals) — a whole-text `\berror\b` heuristic misclassified 40/110 tool results on this codebase because file content mentions errors (field session 019f39f1; fixed in 778106cb, released v0.81.11). Field-acceptance replays must copy the session file and run `--no-extensions` (procedure: roadmap Phase 0 C10).
- tags: compaction, verification-gate, extraction, packages/agent, root-cause

### 2026-07-03 · packages/coding-agent · `pgrep -f` self-matches its own `execSync` wrapper, faking survivors in process-kill tests — claude
`execSync` always runs the command via `/bin/sh -c "<command>"`. If `<command>` is itself `pgrep -f '<pattern>'` and `<pattern>` is a plain literal, the wrapping `/bin/sh -c ...` process (and the forked `pgrep` process) both have that literal text in their own argv/command-line — so `pgrep -f` (which matches the full command line) matches itself, reporting spurious "survivor" PIDs even when the real target process is already dead. Verified by an isolated repro (spawn + kill outside vitest) showing the real grandchild PID absent from survivors while only the self-referential shell/pgrep PIDs were present. Fix: anchor the pattern to the start of the command line (e.g. `pgrep -f '^sleep 60\.123'` instead of `pgrep -f 'sleep 60.123'`) — the `/bin/sh` wrapper's cmdline starts with `/bin/sh` and the forked `pgrep`'s argv starts with `pgrep`, so anchoring excludes both while still matching a genuine leftover process (argv[0] `sleep`). Any test that shells out to `pgrep -f` to assert "no leftover process" needs an anchored (or otherwise self-exclusive) pattern.
- evidence: packages/coding-agent/test/exec-kill-escalation.test.ts (grandchild process-group test) · commit d9668f0d
- tags: testing, process-management, pgrep, vitest, packages/coding-agent, gotcha

### 2026-07-03 · packages/agent · workspace packages resolve `@caupulican/pi-agent-core` via its gitignored `dist/`, which goes stale silently — claude
`packages/agent/package.json` `main` points at `./dist/index.js`, and `dist/` is gitignored (not committed). When new source is added to `packages/agent/src` (e.g. Plan 1's reliability kernel: `createSilenceWatchdog`, `classifyError`, retry policy), every other workspace package that imports `@caupulican/pi-agent-core` (e.g. `packages/coding-agent`) keeps resolving the OLD compiled `dist/` until someone runs `cd packages/agent && npm run build`. The failure mode is a plain `TypeError: X is not a function` at test time, which reads like a wiring bug in the consuming package rather than a stale build in the dependency. Before wiring any new `packages/agent` export into a consumer, rebuild `packages/agent` first and confirm the export exists in `dist/index.js` (or the relevant `dist/reliability/*.js`), not just in `src`.
- evidence: packages/agent/package.json:6 (`"main": "./dist/index.js"`) · .gitignore:7 (`packages/*/dist/`) · packages/coding-agent/src/core/tools/bash.ts (silence watchdog wiring, Plan 2 Task 1)
- tags: build, monorepo, packages/agent, packages/coding-agent, gotcha
