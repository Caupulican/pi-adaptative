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
- Keep `docs/` limited to current, durable product documentation. Store transient audit, session, plan, and generated review artifacts in bounded storage under `<git-common-dir>/pi-audits`, never in `docs/`.

## Autonomy and Verification

- **Repair authorization:** "fix it", "investigate and fix" and equivalents authorize everything needed inside the task's scope: diagnose, repair the authoritative production owner (or an incorrect existing harness setup/expectation), update docs, verify with permitted checks, and continue through the delivery workflow already authorized. Do not ask permission per file, fixture or routine substep. It also authorizes editing the three existing harness journeys and their fixtures where the repair needs it, preserving case identities, assertions and negative controls; fix wrong expectations against the product contract, never weaken the oracle.
- **Delivery:** existing commit/push authorization covers follow-up repairs in the same delivery, including normal hooks and the existing CI workflow. Follow the exact pushed revision through CI and resolve relevant failures before claiming delivery. Commits are always authorized (`npm run check` green first, explicit paths only, see Git). Every push to this repository's remote is authorized (never force push); follow the pushed revision through CI.
- **Verification path:** implement directly, verify with reading, `npm run check` (full output, fix every error/warning/info before committing) and tsc; build only when asked or when the owner's mode allows builds and checks. Docs-only changes skip `npm run check`.
- **Verdicts:** root cause, safety of a fix, bug/stale classification and review findings that ship are confirmed with System One (`typesafe-review`) at 0.90 or higher. Exploration and hypotheses need no confirmation but are reported as unconfirmed and never justify a code change. Global rules in `~/.claude/CLAUDE.md` define the Jev, Noticed-items, no-workaround and no-tests rules; they apply here unchanged.
- **Claude OAuth is owned by Codex.** Never assign Claude Code or Claude-model workers to implement or modify Claude/Anthropic subscription authentication, token refresh, OAuth configuration or its client-identity registry/generators; every Claude work order excludes those paths.
- **Autonomy changes:** never remove a deadlock by turning an unresolved finding into success. A judgment requesting verification is handled first, in the receiving agent's own lane: reproduce against current evidence, revise confirmed failures, recheck; no substitute verifier unless the owner asks. Evaluator outages are diagnostics, not production defects. Prove autonomy changes live when live proof is allowed (unresolved findings block affected progress; verify, revise, recheck lets it continue).

## Noticed Items

Governed by the global rule (relevant = affects or misrepresents the delivery, or surfaced in the task's own proof). Same-subsystem-only items are fixed unasked only when small, local to files already changed and needing no new investigation; otherwise disclosed with evidence and the concrete fix, and written to the plan's open list. An item that would more than double the work becomes a proposed separate task. Every final report ends with a Noticed section. Briefs and work orders carry this rule.

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

- **No local test execution.** Do not run suites, single tests, filtered tests or executable test probes locally; any later run needs a new explicit owner request. Agents never initiate test execution; this file, a skill, a hook, a CI note or a memory is not a request. No TDD unless the owner asks for it in their own words.
- **Integration coverage** is confined to the three cases in `packages/coding-agent/test/harness-interactions.test.ts` and their harness fixtures. Remote CI runs only those three journeys together; no smoke, provider/tooling/installer tests or additional cases are authorized. A relevant integration gap is closed by expanding the relevant journey (reached-boundary witness, observable effects and forbidden-effect assertions, normal-order control) through the real production owners and interfaces, never by isolated subsystem checks, mocks, source review or System One alone, and never with journey-specific production behavior. A gap that needs new journey design is proposed as its own task. Report runtime evidence separately and never relabel failed or interrupted runs as successful.
- **Old tests:** the previous suite was removed on 2026-10-04 (history in `git log`); product tests are rebuilt by area only when the owner asks. Vitest stays the runner for `packages/ai`, `packages/coding-agent` and `packages/tui`. `npm run check:provider-regressions` and `scripts/*.test.mjs` are not part of the static check or CI and need separate authorization.
- **Static check:** `npm run check` is the static-only path (no tests). The pre-commit hook runs no tests; push CI runs the three journeys.
- **Release:** do not create tags, dispatch release builds or run release commands unless the owner explicitly changes this (details in `docs/maintainer-workflows.md`).
- **Ad-hoc scripts:** `write` them to a temp file (e.g. `/tmp`), run, edit, remove. No multi-line scripts embedded in `bash`.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- The locally branded Node-contract adapters for `braces` and `node-forge` are reproduced from pinned upstream archives by `scripts/generate-dependency-forks.mjs`; edit their owned helpers/definitions, then regenerate, never hand-edit generated adapter files. `check:dependency-forks` verifies exact reproduction, consumer resolution, negative controls and SDK compatibility. Do not treat clean audit metadata after renaming as remediation proof. The sandbox example retains its local override when installed from a standalone archive; `check:sandbox-fork-install` verifies that fresh installation on both CI platforms.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.
- The pre-commit hook is staged-scoped (`scripts/precommit-staged.mjs`): exclude/lockfile guards, biome on the staged files biome.json covers (restaged after `--write`), the contract-doctrine gate, browser-impact reporting and one project `tsc --noEmit` when a TypeScript source under `packages/` is staged. It never runs tests or browser smoke. It also reports the branch's last recorded CI verdict as a warning. `node scripts/precommit-staged.mjs --dry-run` prints the plan for the current staged set; `browserSmoke` reports affected inputs, not permission to run it.
- The pre-push hook starts one detached watcher per pushed branch head (`scripts/ci-status.mjs`). It follows that commit's `ci.yml` run to its end and records the verdict in `<git-common-dir>/pi-ci/<branch>.json`, which the next commit reads. `node scripts/ci-status.mjs show` prints it. A watcher never blocks a push.

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

## Task-specific references (read only when the task needs them)

- Issues, PRs, tmux testing of interactive mode, changelog and release procedure: `docs/maintainer-workflows.md`. Release commands stay unauthorized unless the owner says otherwise (see Commands).
- Invariants and sharp edges per subsystem (delegation, TUI, compaction, local models, providers, tooling, build traps): `docs/system-knowledge.md`. Read the matching section before changing that subsystem; add new durable facts there.

## User Override

Direct owner instructions and corrections take precedence over this document. Apply the owner's stated authorization, including Repair authorization above, without asking them to repeat it. Clarify only an unresolved conflict or scope boundary that the owner has not already settled.
