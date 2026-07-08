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

### 2026-07-08 · packages/coding-agent · local prefix warming and managed residency defaults reduce cold-turn waste — claude
P3b/P3c landed: warmable local-class models are detected from OpenAI-compatible API class plus loopback base URL, then session start or manual selection schedules a best-effort `maxTokens: 1` standing-prefix request; a real prompt cancels the warmer before the turn proceeds. Managed Ollama spawns now set `OLLAMA_KEEP_ALIVE=30m` alongside single-parallelism so local cache residency survives normal interactive pauses.
- evidence: packages/coding-agent/src/core/agent-session.ts:1094 · packages/coding-agent/src/core/agent-session.ts:1102 · packages/coding-agent/src/core/agent-session.ts:1126 · packages/coding-agent/src/core/agent-session.ts:1158 · packages/coding-agent/src/core/models/local-runtime.ts:476 · packages/coding-agent/src/core/models/local-runtime.ts:497 · packages/coding-agent/test/suite/agent-session-prefix-warmer.test.ts:132 · packages/coding-agent/test/suite/agent-session-prefix-warmer.test.ts:155 · packages/coding-agent/test/agent-session-local-runtime.test.ts:420
- tags: local-models, prefix-cache, residency, ollama, packages/coding-agent, p3b, p3c

### 2026-07-08 · packages/coding-agent · provider standing prefix has a session-level stability regression — claude
P3a landed: the suite now captures consecutive faux-provider request contexts from one session and asserts the serialized provider payloads share a byte-identical common prefix through the standing prompt/tool prefix before appended history begins. This guards against future timestamps, counters, or other volatile fields being introduced before the append point; the coding-agent suite also aliases the current package scope to source so the regression does not exercise stale workspace `dist/` builds.
- evidence: packages/coding-agent/test/suite/agent-session-prefix-stability.test.ts:27 · packages/coding-agent/test/suite/agent-session-prefix-stability.test.ts:47 · packages/coding-agent/test/suite/agent-session-prefix-stability.test.ts:49 · packages/coding-agent/vitest.config.ts:33
- tags: local-models, prefix-cache, regression-test, packages/coding-agent, p3a

### 2026-07-08 · packages/coding-agent,agent · streamed perf profiles adapt quiet stall bounds per host/model — claude
P2 landed: successful streams now record host/model prefill and decode EWMA samples in the adaptation store; the per-request stream-idle resolver receives model/context metadata and raises `quietIdleMs` from measured prefill throughput when samples exist, while no-profile requests return the configured/default timing unchanged.
- evidence: packages/coding-agent/src/core/models/adaptation-store.ts:278 · packages/coding-agent/src/core/models/perf-profile.ts:89 · packages/coding-agent/src/core/models/perf-profile.ts:108 · packages/coding-agent/src/core/agent-session.ts:712 · packages/coding-agent/src/core/agent-session.ts:729 · packages/coding-agent/test/model-perf-profile.test.ts:76 · packages/coding-agent/test/model-perf-profile.test.ts:122
- tags: reliability, perf-profile, local-models, watchdog, packages/coding-agent, packages/agent, p2

### 2026-07-08 · packages/agent · stream-idle watchdog switches to quiet timing after response headers — claude
P1 landed: `withStreamIdleWatchdog` now wraps provider `onResponse` callbacks and treats HTTP response headers as transport confirmation before the first streamed event, so slow prefill after admission is charged to `quietIdleMs`; streams that never receive headers or events still fail under the original `connectMs` bound.
- evidence: packages/agent/src/reliability/watchdogs.ts:212 · packages/agent/src/reliability/watchdogs.ts:223 · packages/agent/test/reliability/stream-idle.test.ts:50 · packages/agent/test/reliability/stream-idle.test.ts:54
- tags: reliability, watchdog, local-models, packages/agent, p1

### 2026-07-08 · models/serving · native tool-calling capability is serving-stack-scoped, not a property of the weights — claude
The same GGUF weights (byte-identical by sha256: the Ollama manifest's model-layer digest equals the HF LFS oid) have NO native tool channel under plain llama-cpp-python `create_chat_completion` (no server-side `<tool_call>` parsing; markup arrives as text — text-protocol territory) but a WORKING native channel under Ollama (tool-aware chat-template layer + server-side parsing into structured `tool_calls` — probed native/task, live-verified). Tool-probe verdicts must therefore stay keyed by provider/model ref as the adaptation store already does; never generalize a verdict across runtimes, and treat the runtime as part of model identity in any lifecycle or residency-arbiter work.
- evidence: packages/coding-agent/src/core/models/adaptation-store.ts (host+ref keying) · scripts/accept-text-protocol-live.mjs (live acceptance, 2026-07-08 run: native read executed)
- tags: local-models, serving, tool-probe, ollama, llama-cpp, adaptation-store

### 2026-07-08 · packages/agent,ai · stream-idle watchdog charges local-CPU prefill to the connect phase, and tool-probe verdicts collected under that starvation are false capability evidence — claude
Ollama's OpenAI-compat endpoint emits ZERO stream events until the first generated token, so the entire prompt prefill of a CPU-served model counts against `connectMs` (120s, meant for dead connections) instead of `quietIdleMs` (600s, designed for prefill) — a ~2.6k-token prompt on an 8B CPU model stalls every time, and the stall's retry re-prefills from zero and stalls again. Consequence for probe integrity: the graded tool probe runs its task-scale trial through the same starved transport, so transport timing masquerades as model capability — the same model on the same host flipped `text-protocol` (nativeGrade `echo-only`, probed cold under stock bounds) → `native` (nativeGrade `task`, live read executed, probed warm under raised bounds) with no model change. Fix direction: end the connect phase at HTTP response headers so prefill falls under the quiet bound, and derive stall bounds from measured per-host/model prefill rates; the task-scale probe trial should also be multi-trial before recording a demotion. Never trust a `text-protocol` demotion recorded on a host where stall bounds were stock and the model is CPU-served — re-probe with adequate bounds (`retry.stall.*`, `httpIdleTimeoutMs`) first.
- evidence: packages/agent/src/reliability/watchdogs.ts:183 (phase bound selection) · packages/agent/src/reliability/watchdogs.ts:195 (stall description) · packages/ai/src/providers/openai-completions.ts (no pre-token event) · run-1 vs run-2 adaptation-store probe records (`stream stalled: no events for 120000ms (connect phase)`)
- tags: reliability, watchdog, tool-probe, local-models, ollama, packages/agent, packages/ai, root-cause

### 2026-07-07 · packages/ai,coding-agent · P7.6 text-protocol live lockout resolved at provider and repair chokepoints — claude
P7.6 remediation is closed: when text protocol is active, completion now withholds native provider tool definitions but parses replies against the original tool set; the Phase 7 gating hierarchy is documented where `_textProtocolFlag` resolves; gpt-5.5 remains on the native path unless explicitly flagged. Gemma's observed live failures (`Path` key casing, smart-quote JSON delimiters, and malformed object strings with extra text) are repaired in the shared validation layer via named, guard-checked modes instead of tool-specific shims. The live acceptance script requires qwen3:1.7b to stay native and gemma3:1b to produce a genuine text-protocol row with a calibrated variant and marker.
- evidence: packages/ai/src/stream.ts:61 · packages/ai/src/stream.ts:66 · packages/ai/src/stream.ts:111 · packages/ai/src/utils/tool-repair/repairer.ts:125 · packages/ai/src/utils/tool-repair/repairer.ts:143 · packages/ai/src/utils/tool-repair/repairer.ts:291 · packages/ai/src/utils/tool-repair/registry.ts:5 · packages/ai/src/utils/tool-repair/registry.ts:12 · packages/coding-agent/src/core/agent-session.ts:1311 · packages/coding-agent/test/model-protocol-calibration.test.ts:316 · scripts/accept-text-protocol-live.mjs:8 · scripts/accept-text-protocol-live.mjs:138
- tags: tool-repair, text-protocol, live-acceptance, p7.6, packages/ai, packages/coding-agent

### 2026-07-07 · packages/ai,coding-agent · text-protocol validation matrix now covers grammar and live fleet probing — claude
P7.3/P7.4 is closed: the text protocol parser/primer fixtures cover canonical `<pi:call>` plus accepted `<tool_call>`/fenced inbound variants, unknown-tool and malformed-envelope bounces, prose preservation, and the R31 `jsonStringParse` handoff. Coding-agent now has `/toolprobe`/RPC `tool_probe` that probes native tool calls first, then text-protocol fallback, persists a host-local verdict, and lets a persisted text-protocol verdict opt in the exact model after env/settings/model gates. C10-style live acceptance is scripted with scratch session dirs and `--no-extensions` for local Ollama qwen models.
- evidence: packages/ai/src/utils/tool-repair/text-protocol.ts:206 · packages/ai/src/utils/tool-repair/text-protocol.ts:223 · packages/ai/src/utils/tool-repair/repairer.ts:166 · packages/ai/test/text-tool-protocol.test.ts:37 · packages/coding-agent/src/core/agent-session.ts:1311 · packages/coding-agent/src/core/agent-session.ts:1496 · packages/coding-agent/src/core/models/adaptation-store.ts:257 · packages/coding-agent/test/model-protocol-calibration.test.ts:304 · scripts/accept-text-protocol-live.mjs:115
- tags: tool-repair, text-protocol, validation-matrix, live-acceptance, packages/ai, packages/coding-agent

### 2026-07-07 · packages/coding-agent · failed text-protocol calibration is now explicit, persistent, and resettable — claude
P7.2 is closed: text protocol calibration now stores a `status: "failed"` record after the bounded variant ladder fails, fast-fails future turns for that host/model until `/toolprotocol-reset <provider/model>` or RPC `reset_tool_protocol` clears it, and invalidates a previously calibrated protocol after three repeated live parse failures so the next turn recalibrates. Health output now shows failed protocol records with reset guidance instead of silently rerunning calibration every turn.
- evidence: packages/coding-agent/src/core/agent-session.ts:1295 · packages/coding-agent/src/core/agent-session.ts:1395 · packages/coding-agent/src/core/agent-session.ts:1404 · packages/coding-agent/src/core/models/adaptation-store.ts:230 · packages/coding-agent/src/core/tool-repair-health.ts:27 · packages/coding-agent/test/model-protocol-calibration.test.ts:188
- tags: tool-repair, text-protocol, calibration, packages/coding-agent, roadmap-p7

### 2026-07-07 · packages/coding-agent · tool-repair operator docs cover controls, diagnostics, and replay — claude
R50 is closed: `docs/tool-repair.md` now documents the shipped repair/teach/text-protocol contract, visible repaired-call signals, `/toolhealth`, `/toolrule-remove`, RPC equivalents, replay commands, and registry mode names; `docs/index.md`, `docs/settings.md`, `docs/usage.md`, and `docs/rpc.md` link the operator surface where users already look for settings, commands, and RPC protocol details.
- evidence: packages/coding-agent/docs/tool-repair.md:1 · packages/coding-agent/docs/tool-repair.md:9 · packages/coding-agent/docs/tool-repair.md:29 · packages/coding-agent/docs/settings.md:153 · packages/coding-agent/docs/rpc.md:541 · packages/coding-agent/docs/index.md:49
- tags: docs, tool-repair, operator-playbook, packages/coding-agent

### 2026-07-07 · packages/coding-agent · delegated worker actions now pass through shared tool validation — claude
R49 is closed for the known bypass: `parseWorkerActions` now validates action arrays through the shared `validateToolArguments` choke point (including repaired stringified arrays and telemetry) before deterministic apply-time envelope enforcement. Audit result for the other enumerated paths: main agent loop and extension tools already enter through `prepareToolCall`; SDK consumers use the agent loop; RPC `bash` is direct user command execution, not model-output tool execution, so it intentionally does not repair model-emitted arguments.
- evidence: packages/coding-agent/src/core/delegation/worker-actions.ts:52 · packages/coding-agent/src/core/delegation/worker-actions.ts:84 · packages/coding-agent/test/worker-actions.test.ts:20 · packages/agent/src/agent-loop.ts:798
- tags: tool-repair, validation, delegation, packages/coding-agent

### 2026-07-07 · packages/agent,ai,coding-agent · tool-repair visibility and control surface is live — claude
R48 is closed: repaired tool executions now carry a `repair` marker through agent events (RPC-visible) and the interactive tool panel renders `[repaired arguments]`; `/toolhealth`, RPC `get_tool_repair_health`, and `formatToolRepairHealthReport` expose per-model learned rules/protocol/teach stats; `/toolrule-remove`, RPC `remove_tool_repair_rule`, and `ModelAdaptationStore.removeRule` remove standing rules persistently. Independent repair/teach/text-protocol switches resolve from `settings.toolRepair.{repair,teach,textProtocol}` and env kills `PI_TOOL_REPAIR_DISABLED`, `PI_TOOL_REPAIR_TEACH_DISABLED`, `PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED`.
- evidence: packages/agent/src/types.ts:460 · packages/agent/src/agent-loop.ts:1061 · packages/coding-agent/src/modes/interactive/components/tool-execution.ts:250 · packages/coding-agent/src/core/tool-repair-health.ts:15 · packages/coding-agent/src/core/tool-repair-settings.ts:16 · packages/coding-agent/src/core/models/adaptation-store.ts:195 · packages/coding-agent/src/core/slash-commands.ts:30
- tags: tool-repair, visibility, repair-teach, packages/agent, packages/ai, packages/coding-agent

### 2026-07-07 · packages/ai,coding-agent · tool-repair failure-corpus flywheel records sanitized bounce shapes — claude
R47 is closed: validation bounces now carry `failureShape`/`errorKeywords` telemetry and `AgentSession` appends only bounced shape records to `state/failure-corpus.jsonl` (`kind: "tool_validation"`) with schema paths, expected/received types, model/tool identity, and no argument values. `packages/ai/src/utils/tool-repair/replay.ts` plus `scripts/tool-repair-replay.mjs` replay those sanitized records offline through the analyzer/repairer and emit deterministic bounce fixtures for new repair-mode development.
- evidence: packages/ai/src/utils/validation.ts:21 · packages/coding-agent/src/core/failure-corpus.ts:21 · packages/coding-agent/src/core/agent-session.ts:1361 · packages/ai/src/utils/tool-repair/replay.ts:1 · scripts/tool-repair-replay.mjs:1
- tags: tool-repair, failure-corpus, telemetry, packages/ai, packages/coding-agent

### 2026-07-07 · packages/ai · tool-call validation repair is now a named validate-then-repair layer — claude
R31 is closed: `validateToolArguments` now checks first and returns valid argument objects unchanged, then routes failures through `packages/ai/src/utils/tool-repair/{registry,analyzer,repairer}.ts`. The named registry covers the Phase 4 grammar landed in this commit (null optional drop / required-null bounce, JSON string parse, array wrapping/unwrapping, scalar string repairs, enum normalization, numeric arrays, and bash command shapes); `packages/coding-agent/src/core/tools/edit.ts` no longer carries the stringified-`edits` shim, leaving that shape to the shared repairer while preserving the legacy `oldText`/`newText` adapter.
- evidence: packages/ai/src/utils/validation.ts:293 · packages/ai/src/utils/tool-repair/registry.ts:1 · packages/ai/test/tool-repair.test.ts:1 · packages/coding-agent/src/core/tools/edit.ts:95
- CLOSED 2026-07-07: follow-up items R32–R38 closed the remaining Phase 4 tool-call reliability gaps (one commit each, findable by subject): OpenAI-compatible streamed id synthesis, truncated-args bounce, schema-rich validation feedback, shape-only telemetry, provider tool-name sanitization, replaying repaired args, opt-in text tool-call extraction, repeated validation-failure escalation, the per-model adaptation store, in-band repair teach-back notes, standing per-model repair rules, repeated execution-failure guidance, teach-efficacy telemetry, the teachable execution-error catalogue, and text-protocol calibration. Keep the validation layer as validate-then-repair; do not reintroduce tool-specific pre-coercion shims.
- tags: tool-repair, validation, packages/ai, packages/coding-agent

### 2026-07-07 · release/git · local-only doc discipline: `.git/info/exclude` cannot stop a commit, and npm ships everything tracked under `docs/` — claude
Two coupled traps. (1) `.git/info/exclude` only hides UNTRACKED files from status and release sweeps; if an excluded path ever gets explicitly staged, the exclusion is inert from then on and the file rides every commit, push, and tag. The pre-commit hook therefore derives a blocklist from `.git/info/exclude` at runtime and rejects any staged path matching it — never bypass it with `git add -f` or `--no-verify`. (2) `packages/coding-agent/package.json` `files` includes `"docs"`, so EVERY tracked file under `packages/coding-agent/docs/` ships in the public npm tarball; when adding anything under docs/, sanity-check `npm pack --dry-run`.
- evidence: .husky/pre-commit (exclude-derived guard) · packages/coding-agent/package.json `files` array
- tags: release, git, npm, exclude, gotcha

### 2026-07-06 · compaction · auto-compaction retry ladder is unreachable in the early-trigger band: loop skips "within threshold" after cycle 1 — claude
`_checkCompaction` fires auto-compaction from the EARLY fractional trigger (`contextWindow * triggerPercent`, default 0.7) or `model.autoCompactionTriggerTokens`, but `_runAutoCompaction` hands `runCompactionLoop` only the HARD threshold (`contextWindow - reserveTokens`). The first `measureLiveTokens()` read is force-inflated past that threshold (`measureReads++ === 0 ? Math.max(measured, triggerThreshold + 1) : measured` — a symptom-mask, not a fix); every later cycle measures honestly, so after any cycle-1 failure (e.g. gate-failed) cycle 2 sees `measured <= threshold` and returns `skip: "within threshold"`. Nothing is applied, deterministic fallback (cycle 4) is unreachable, and the next agent_end re-triggers the same fail-and-skip — an every-turn loop that burns 2 full-context summarizer calls per turn and never compacts. Field session replay (openai-codex/gpt-5.5, window 272k): live ~191–193k > fractional 190.4k (triggers) but < hard 255.6k (skips); log shows `cycle 2: gate-failed` immediately followed by `Auto-compaction skipped: within threshold`. Fix direction: the loop's skip/success predicate must be the SAME predicate that triggered compaction (pass `shouldCompact(...)` in, delete the first-read forcing hack).
- evidence: packages/coding-agent/src/core/agent-session.ts:3181-3189 (threshold + forcing hack) vs :3148 (`shouldCompact` with fractional/autoCompactionTriggerTokens) · packages/agent/src/compaction/loop.ts:76-85 (skip check) · field session replay
- RESOLVED 2026-07-06: shared `shouldCompact(tokens)` predicate replaces the numeric threshold; forcing hack deleted; overflow reason uses always-true predicate + post-apply short-circuit (the provider error is the trigger). Commits 51ee6adf, a7ec5d8a. Field-verified: `/compact` on the replay now produces a compaction entry.
- tags: compaction, retry-ladder, packages/agent, packages/coding-agent, root-cause

### 2026-07-06 · compaction · verification gate demands transcription of unbounded, noise-polluted facts the prompt tells the summarizer to compress — claude
`extractCompactionFacts` emits one action string per tool call over the whole compacted span, unbounded (field session: 110 actions, facts block ≈ 4,429 tok), each carrying the tool result's FIRST LINE as "outcome" — which is file-content noise (`— ---`, import lines, `## main...origin/main`) plus volatile tokens (timings `21ms`, counts, and pi's own context-gc stub paths, because the agent READs those stubs and extraction records harness plumbing as work). `verifySummary` then demands ≥60% unique-token containment of ALL of that in `## Done` (plus all modified paths, 80% read-path tokens, 90% active-task tokens) while `getSummaryBudget` hard-caps output at 4,000 tok AND the prompts instruct compression ("Budget: ~N tokens. Concrete beats complete", update path: "keep 15 most recent Done items"). The ladder makes gate failures WORSE: tier escalation is a no-op when router is off (cheap==session resolve to the same model), and `enforceMonotonicProgress` halves keepRecentTokens (bigger span → more facts → higher demand) and switches to chunked mode, whose `slice(-4)` drops older chunks the gate still covers. Which specific check failed in the field is unknowable: `mapFailureCause` flattens the error to `gate-failed` and transitions print only the cause — the `formatVerificationFailures` detail is discarded (observability gap). Fix direction: bound/de-noise the gated facts (gate on verb+path, not outcomes; exclude harness plumbing paths; cap actions), derive budget from the bounded demand, make gate-failed rungs actually change odds, and surface failure details in the warning.
- evidence: packages/agent/src/compaction/extraction.ts:367-374 (unbounded actions w/ outcomes) · packages/agent/src/compaction/verification.ts:92-103 (actions containment ≥0.6) · packages/agent/src/compaction/compaction.ts:655-668 (4k cap) · packages/agent/src/compaction/loop.ts:200-236 (ladder escalation) · field session replay
- RESOLVED 2026-07-06: gated facts bounded and de-noised (verb+path actions, deduped, cap 15; harness plumbing paths excluded; active-task gate uses the shared 4k clamp), budget derived from bounded demand with `summary-demand-exceeds-reserve` → deterministic fast path, gate-failed no longer enlarges span, no-op tier rung skipped, failure details threaded to warnings. Commits 51ee6adf, 638eb33b. Checkpoint CONTENT contract (working set, open-error facts, drop rules) was follow-up work, still open at that point.
- CLOSED 2026-07-07: checkpoint v2 complete. Note for future maintainers: the open-error classifier must stay SIGNAL-FIRST (`isError` → `details.exitCode` → bash-only line-anchored text signals) — a whole-text `\berror\b` heuristic misclassified 40/110 tool results on this codebase because file content mentions errors (field-verified on a long real session; commit "Fix checkpoint open-error classification"). Field-acceptance replays must COPY the session file to a scratch id and resume the copy with `--no-extensions` — never replay a live session file, and never pass `/compact` as a `-p` prompt with extensions active.
- tags: compaction, verification-gate, extraction, packages/agent, root-cause

### 2026-07-03 · packages/coding-agent · `pgrep -f` self-matches its own `execSync` wrapper, faking survivors in process-kill tests — claude
`execSync` always runs the command via `/bin/sh -c "<command>"`. If `<command>` is itself `pgrep -f '<pattern>'` and `<pattern>` is a plain literal, the wrapping `/bin/sh -c ...` process (and the forked `pgrep` process) both have that literal text in their own argv/command-line — so `pgrep -f` (which matches the full command line) matches itself, reporting spurious "survivor" PIDs even when the real target process is already dead. Verified by an isolated repro (spawn + kill outside vitest) showing the real grandchild PID absent from survivors while only the self-referential shell/pgrep PIDs were present. Fix: anchor the pattern to the start of the command line (e.g. `pgrep -f '^sleep 60\.123'` instead of `pgrep -f 'sleep 60.123'`) — the `/bin/sh` wrapper's cmdline starts with `/bin/sh` and the forked `pgrep`'s argv starts with `pgrep`, so anchoring excludes both while still matching a genuine leftover process (argv[0] `sleep`). Any test that shells out to `pgrep -f` to assert "no leftover process" needs an anchored (or otherwise self-exclusive) pattern.
- evidence: packages/coding-agent/test/exec-kill-escalation.test.ts (grandchild process-group test) · commit d9668f0d
- tags: testing, process-management, pgrep, vitest, packages/coding-agent, gotcha

### 2026-07-03 · packages/agent · workspace packages resolve `@caupulican/pi-agent-core` via its gitignored `dist/`, which goes stale silently — claude
`packages/agent/package.json` `main` points at `./dist/index.js`, and `dist/` is gitignored (not committed). When new source is added to `packages/agent/src` (e.g. Plan 1's reliability kernel: `createSilenceWatchdog`, `classifyError`, retry policy), every other workspace package that imports `@caupulican/pi-agent-core` (e.g. `packages/coding-agent`) keeps resolving the OLD compiled `dist/` until someone runs `cd packages/agent && npm run build`. The failure mode is a plain `TypeError: X is not a function` at test time, which reads like a wiring bug in the consuming package rather than a stale build in the dependency. Before wiring any new `packages/agent` export into a consumer, rebuild `packages/agent` first and confirm the export exists in `dist/index.js` (or the relevant `dist/reliability/*.js`), not just in `src`.
- evidence: packages/agent/package.json:6 (`"main": "./dist/index.js"`) · .gitignore:7 (`packages/*/dist/`) · packages/coding-agent/src/core/tools/bash.ts (silence watchdog wiring, Plan 2 Task 1)
- tags: build, monorepo, packages/agent, packages/coding-agent, gotcha
