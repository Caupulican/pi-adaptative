# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Portable Harness Integration

- Final Pi Adaptative behavior, extensions, templates, tests, and documentation must live in this repository/package. User-level files may be temporary migration or validation sources only; restore or remove those runtime edits after the packaged implementation is validated.
- Every managed background process must emit a terminal signal, persist a bounded handoff, and notify the owning parent session. Completion detection must be event-driven; never poll or peek into process output merely to discover whether work ended.

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
- Never run `npm run build` or `npm test` unless requested by the user. Release verification delegates the full suite to GitHub Actions; the local release smoke below may build its unpublished artifacts but must not run the full suite.
- While developing, run only the targeted tests specific to the code you touched: `./test.sh <specific-test-path>` or from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`. Do not run the full suite to iterate on a change.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. The full non-e2e suite is owned by GitHub Actions; local `./test.sh` with no arguments is forbidden unless the user explicitly requests it.
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

2. **GitHub full test suite (mandatory)**: push the exact committed release candidate and require its `ci.yml` run to finish fully green. Inspect every matrix job; targeted local tests do not substitute for it. Never run `./test.sh` locally as part of release preparation. Missing, pending, skipped unexpectedly, or failed GitHub evidence blocks the release unless the user explicitly accepts the risk.

3. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
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

4. **Run the release script**: the flow is split into `prepare` (bump/changelog/commit/push, no tag) and `promote` (gate on CI, then tag/push) so a CI failure never burns a version number.
   ```bash
   npm run release:patch    # fixes + additions: prepare, push, then wait for CI and tag/push on success
   npm run release:minor    # breaking changes: same flow
   ```
   No env flags are required for the normal case: `scripts/check-lockfile-commit.mjs` already auto-allows a `package-lock.json` diff that only touches workspace-package metadata (the usual outcome of a lockstep version bump), and `npm_config_min_release_age=0` is scoped inside `scripts/release.mjs` to just the lockfile-refresh command it runs, not exported for the whole release. If the pre-commit lockfile guard blocks a release for a real reason (external dependency changes bundled into the same commit), stop and review the diff rather than bypassing it - that's the guard doing its job.

   `release:patch`/`release:minor`/`release:major` run **prepare** then automatically chain into **promote**:
   - Prepare: preflight (on `main`, clean tree, `origin/main` is an ancestor of `HEAD`, prospective tag unused, **HEAD already has a successful complete `ci.yml` run**) -> version bump -> changelogs -> shrinkwrap regen -> `npm run check` -> commit `Release vX.Y.Z` -> push `main` -> add fresh `## [Unreleased]` sections -> commit `Add [Unreleased] section for next cycle` -> push `main`. Preflight refuses immediately if exact-HEAD CI is missing, pending, or red. The release command never runs the full suite locally. The metadata-only Release commit's CI skips tests and the Windows runner because exact-preflight-HEAD GitHub CI already proved the complete suite. A failure anywhere after preflight resets the local tree back to the preflight commit; nothing is tagged.
   - Promote: finds the `Release vX.Y.Z` commit, polls GitHub Actions (`ci.yml`) then `destructive.yml` for their conclusions on that exact commit SHA (dispatching a destructive run if none exists), and only on success of both creates and pushes the `vX.Y.Z` tag (which triggers `.github/workflows/build-binaries.yml`).

   Review any lockfile or shrinkwrap diffs the release creates before push. Model catalogs (`packages/ai/src/*.generated.ts`) are never regenerated by the release script - it's a pure function of the already-committed, already-tested tree; catalog freshness is governed separately by the weekly `check:model-catalog` workflow.

   **If CI fails after prepare pushed the release commit**: nothing is tagged yet. Fix or rerun CI for that commit, then resume with:
   ```bash
   npm run release:promote
   ```
   This is also how to resume if the `promote` step's CI poll times out or the local process is interrupted after prepare succeeded. If a failed gate requires a committed fix, commit and push the fix, wait for successful exact-HEAD `ci.yml`, then run `npm run release:repair`. Repair requires the tag to remain free and every next-cycle `[Unreleased]` section to remain empty; it removes only those empty markers, creates and pushes `Repair release vX.Y.Z` without another version bump, restores the markers, and promotes the repaired exact SHA through CI and destructive gates. Do not rerun `release:patch`/`release:minor`/`release:major` for the same version once its release commit has been pushed - that would bump the version again.

5. **CI publishes npm packages**: the `vX.Y.Z` tag (pushed only after CI succeeds on the release commit) triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

6. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch`/`release:minor`/`release:major` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
# System Knowledge

Long-term reference for how this system works: invariants the code relies on and sharp edges that are
not obvious from reading it. Entries are short, present-tense, and topical — no dates, authors,
incident narratives, or progress notes. New durable facts go directly into the fitting section;
anything fully encoded in code, tests, or docs does not belong here.

## Delegation and Orchestration

- Workers are persistent specialists: conversations are keyed by `(parentSessionId, logicalAgentId)` and survive across tasks. `delegate start` with `agentId` dispatches onto an idle worker's transcript and keeps its admitted grant (`authority`/`profileId` are rejected on reuse); `list` reports per-agent `activity`. `start` must never silently ignore `agentId`.
- Worker retry is host-owned and evidence-gated, built on suspend/resume — there is no parallel re-dispatch path. Retries require a classified-transient failure detail (`classifyFailure`; missing or `unknown` never retries); `maxAttempts: 1` never ladders. Retry count and not-before are persisted atomically with the fenced suspension, restart recovery retains both, and terminal transitions clear the durable ladder while terminal publication clears its process timer.
- Token budgets charge `budgetedTokens()` — cache reads at `CACHE_READ_BUDGET_WEIGHT` — in both the capability gateway and the worker-tree coordinator; face-value cache-read counting turns `maxTokens` into a request counter. Grants below `MIN_VIABLE_WORKER_TOKEN_BUDGET` reject at admission; bounded failures carry `detail`; worker provider calls retry transient transport failures with jittered backoff.
- Background workers notify the foreground root by lane record plus a bounded completion event; root output is retrieved explicitly via `delegate` action `status`. Nested child terminals use the parent control handoff and expose evidence through the child's `delegate` transcript. Late worker output never enters an active foreground transcript — it races the foreground model.
- A blocked worker-wait restore is woken by write-reservation availability (`subscribeReservationAvailability` → `notifyAvailability`), not `subscribeStateChanges` and not a 1s poll. The 300s restore bound is a watchdog only; a reservation release must resume the waiter on the event.
- Delegated memory is a bounded query capability, not delegated file access: granted per call and by the lane profile, delivered source-labeled via `memory_read`; raw memory/state/auth paths stay denied; the mutation tool is never exposed to workers.
- The worker claim envelope is authoritative, but non-JSON reports are retained as bounded plain text with disclosure, never rejected outright. Worker tool loops resolve tool-call protocol from the lane model, never the foreground model. Concurrency admission counts running workers only; durable fleet admission separately caps depth, direct children, persistent identities, and queued dispatches, while ordinary starts and persistent-agent turns reserve mandatory-verifier headroom before durable mutation.
- Omitted `forkTurns` is `none` even for same-provider/model root workers. Explicit `all` or a turn count remains available only inside the exact provider/model boundary. Worker terminals that need parent review wake the parent through the terminal handoff; they must not queue Review now / Keep blocked, because that latch blocks automatic parent wake. `delegate list` reports session peers with `controllable`; a worker may start/transcript/cancel only `controllable=true` descendants. Nested start is rejected at admission when the tree already holds its `maxAttempts` ceiling. A worker token/cost/wall/tool budget denial terminals the lane; it is not a per-call block the model can retry around.

## TUI and Terminal

- East Asian ambiguous characters occupy 2 columns on CJK-codepage consoles; width mode is probed at startup (print `·`, DSR `6n`, read the CPR column) because locale sniffing cannot detect it. All width math goes through `visibleWidth`/`graphemeWidth`; ambiguous width is never hardcoded to 1; probe consumers must not outlive startup (CPR is byte-identical to modified-F3 sequences); `PI_AMBIGUOUS_WIDTH=wide|narrow` overrides.

## Compaction and Long Sessions

- Token measurement is a pure read: `TokenBudget.anchor()` anneals EWMA state per call, so it runs only from the per-turn pipeline on fresh persisted usage. The compaction loop's within-threshold skip runs on cycle 1 only, using the same `shouldCompact` predicate that triggers compaction.
- Gated facts are bounded and de-noised (verb+path, deduped, capped, harness plumbing excluded); the summary budget derives from that demand; verification failure details thread to warnings, never flattened to a bare cause. The open-error classifier is signal-first (`isError` → `exitCode` → bash-only anchored text), never whole-text keyword matching.
- Verification scores exact identities: read paths as recalled items, open errors weighting operation and error identity independently; failure breakdowns cross the retry boundary into the applied checkpoint; both verification loops share one implementation.
- Long-session performance: no quadratic prefix work (append then reverse once; retain stream fragments and join once at the delimiter; lazily serialize only the transport in use). Compacted-away payloads ≥ 16KiB become disk-backed getters, and provider session resources invalidate immediately after compaction applies. Retention and UI bounds are byte-based, never count-only.
- Field-acceptance replays copy the session file to a scratch id and resume with `--no-extensions`; live session files are never replayed, and `/compact` is never passed as a `-p` prompt with extensions active.

## Local Models and Reliability

- Native tool-calling is serving-stack-scoped, not a property of the weights: identical GGUF can have a working tool channel under one runtime and none under another. Probe verdicts are keyed by provider/model ref; the runtime is part of model identity.
- Local-class (loopback) providers emit nothing — headers included — until the first generated token, so prefill lands in the connect phase. The adaptive resolver treats local connect as the quiet bound and raises profiled `connectMs` from measured prefill throughput; remote providers keep the stock bound. A `text-protocol` demotion probed under starved transport (stock bounds, CPU serving) is invalid evidence — re-probe with adequate bounds.
- A reachable Ollama server does not mean its configured model is ready: `/api/tags` is verified after managed startup and the owned runtime stops on absence. Child stdio is ignored alongside `unref()` so CLI invocations exit instead of hanging on pipe handles.

## Providers

- A successfully parsed provider stream is delivered even if the caller abort signal races the terminal push. Mid-stream abort is the transport's job (`terminateAssistantStreamWithError`); `completeAssistantStream` must not inspect `signal.aborted`. Responses `response.output` and `output_item.done` are authoritative when incremental `added`/`delta` events were skipped — fast or coalesced xAI/OpenAI streams otherwise land as empty assistant turns. Message, reasoning, and function-call ids are attached on `output_item.added`; `done`/`response.output` must reuse that block even after `currentBlock` has moved on. Creating a second text or tool-call block for the same item stores the status sentence or tool twice.
- Degenerate collapse drops later text that repeats an earlier block. Parallel tool calls with distinct ids are kept even when name and arguments match; the Responses assembler reuses a function-call block by item/call id so the same stream item is not stored twice.
- `EventStream.end()` must settle `result()`. Ending without a `done`/`error` event is an error, never an unresolved promise. `complete()` and the text-protocol wrapper consume that settlement; a hang here is a deadlock of the turn.
- Fugu/Sakana orchestration usage detail fields are categories already included in `total_tokens`: allocate them to normalized categories for cost, never add them to `totalTokens` again.
- The Codex Responses WebSocket reports its 60-minute connection lifetime as a nested `error.code: websocket_connection_limit_reached` before response output; the request replays once on a fresh socket, only before output starts.
- ChatGPT subscription meter headers (`x-codex-*`) are reset windows, not USD spend; they are recorded as redacted diagnostics and `(sub)` cost stays token accounting.

## Tooling, Shell, and Extensions

- Global `~/.pi/agent/AGENTS.md` (and CLAUDE.md/GEMINI.md in that directory) is always loaded into the system prompt. Repository copies are off until that directory/project opts in (`projectContextFiles: "on-demand"` via `/settings` → Project AGENTS.md). Opt-in lists paths only; `--no-context-files` skips project files. The global file is not optional.
- Tool-call repair is validate-then-repair through the named registry (`tool-repair/{registry,analyzer,repairer}.ts`): valid arguments pass unchanged, and there are no tool-specific pre-coercion shims. Delegated worker actions pass through the same choke point.
- Extension tools share a runner-scoped identity map: after a successful result, schema fields that are `*Id`/`card`/`project`/`board` (including nested `name.id` → `nameId`) fill vacant args on the next call from the same extension. Builtin tools are excluded; unresolved `needs_*`/`ambiguous*` statuses are not retained.
- Tool-failure recovery admission is reconstructed from the transcript when a new run starts with an empty gate: per-operation execution budget and circuit survive user turns and session resume, so an already-exhausted identical operation is not re-executed. Run-level halt and family/run counters stay on the current run so other operations remain available. Memory occurrence counts are not an admission budget. Execution identity omits resource-envelope fields (`timeout` and siblings); changing only the wait bound is the same operation. `owner_authorization_required` is prompt-scoped and must not restore a circuit across a new user turn. Goal start/action failures return `isError` — a successful-looking `goal start failed` text is invisible to the gate. Consecutive repeated assistant lines or the same sentence repeated inside one paragraph are collapsed before the next provider turn; a toolless stream that is already looping is aborted instead of waiting for `done`.
- Bash runs in persistent per-agent shell sessions (`shell-session.ts`): a nonce sentinel carries the exit code; timeout/abort/silence kills the whole session tree and the next exec respawns — state loss is by design; explicit `shellPath` or a changed per-command env falls back to per-command semantics. Shell discovery is process-lifetime: successful platform resolutions are cached, failures are not.
- Extension load failures are isolated startup warnings, never fatal: failed factories restore shared state and dispose subscriptions; `/reload` is transactional and preserves the current runtime on a failed generation.

## Build, Test, and Release Traps

- Windows vitest runs the same worker count as Linux; serialization is a ruled-out dead end. Crashes attributed to parallelism were libuv 8.3-short-path asserts, fixed by `realpathSync.native(tmpdir())` fixtures — do not re-serialize without evidence a failure is load-dependent.
- `pgrep -f` self-matches its own `execSync` `/bin/sh -c` wrapper; no-leftover-process assertions anchor the pattern to the start of the command line.
- Workspace consumers resolve `@caupulican/pi-agent-core` through its gitignored `dist/`, which goes stale silently and surfaces as `TypeError: X is not a function` in consumers. Rebuild `packages/agent` and confirm the export exists in `dist/` before wiring it into a consumer.
- `.git/info/exclude` cannot stop a commit once a path is staged; the pre-commit hook derives a blocklist from it — never bypass with `git add -f` or `--no-verify`. The coding-agent package ships everything tracked under its `docs/` in the npm tarball; check `npm pack --dry-run` when adding docs.
