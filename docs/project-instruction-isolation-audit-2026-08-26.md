# Project-instruction isolation audit — 2026-08-26

This incident report records the archived failure, source-level root cause, working-tree design, and current proof for Pi's `projectContextFiles: "off"` policy. User-facing behavior lives in `packages/coding-agent/docs/settings.md`; the independent background-task reliability audit lives in `docs/windows-harness-archive-audit-2026-08-26.md`.

## Verdict

**Confirmed defect:** v0.97.7 treated `projectContextFiles: "off"` as a context-file presentation preference rather than one instruction-isolation policy. Project-local skills still had independent discovery/audit paths, and the model received no explicit global-only rule against rediscovering project instruction files through ordinary tools.

**Working-tree repair confirmed:** the persisted policy now gates project `.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md` discovery and project extensions, skills, and prompt templates before admission/import, plus built-in SDK/runtime file inputs, registered external-resource catalogs, skill audit/skillify inputs, root and worker guidance, reload behavior, and settings documentation. Explicitness or catalog trust no longer authorizes a physical project-local file. Trusted global/bundled resources, physically external catalogs, caller-materialized data, on-demand mode, and inert project themes remain available.

**Not a filesystem confidentiality boundary:** global-only mode prevents project files and skills from being selected or applied as instructions. Ordinary project files remain available as task data. The read/shell tools do not implement a general hidden-filesystem view; the system prompt supplies the semantic rule against rediscovering excluded instruction paths.

No commit, release, or publication is claimed.

## Source archive and handling

- Source: a private session archive (`.pi.7z`, kept outside the repository)
- SHA-256: `acb57138299ef0b9dfe089ecce396a38ff405125aaa8caf2168b9563790d07c6`
- Integrity: 7-Zip reported `Everything is Ok` for 2,254 files and 192 folders (235,121,543 uncompressed bytes).
- Listing coverage: 2,447 archive paths.
- Session coverage: 16 JSONL files, 15,770 records, zero parse errors.
- Selective extraction root: `/tmp/pi-security-audit-20260826-acb57138/extracted/.pi`.

The audit parsed records structurally and retained only path/tool metadata needed to prove the boundary violation. It does not reproduce archived conversation text, credentials, or project source.

## Archived reproduction

**Global-only baseline — confirmed.** The archived `.pi/agent/settings.json` omits `projectContextFiles`; `SettingsManager.getProjectContextFiles()` defaults that setting to `"off"` (`packages/coding-agent/src/core/settings-manager.ts:3153-3159`).

**Bypass — confirmed.** In archive session `2026-08-26T12-43-45-312Z_01a03e19-1120-725b-bdc4-ac8f865f4fa1.jsonl`:

- line 162 is a Bash result listing three project-local `.codex/skills/*/SKILL.md` paths;
- line 165 issues a read for one listed project skill;
- line 167 records the completed read.

This proves that project-local skill instructions could re-enter a global-only session through ordinary-tool rediscovery. It does **not** claim that the `skill` tool automatically activated that specific file; the archive evidence and source-level discovery defect are kept separate.

## Root cause

### 1. Split policy ownership

**Confirmed.** Context-file loading consulted `projectContextFiles`, but package/resource skill discovery did not share that predicate. Auto-discovered project roots, project settings paths, and project package resources could therefore remain visible when context files were off.

### 2. Independent audit fallback

**Confirmed.** Standalone `skill_audit`/`skillify` fallback discovery used cwd-based skill loading, which could traverse project defaults independently from the host resource loader. That made the audit universe broader than the runtime-admitted skill universe.

### 3. No ordinary-tool semantic guard

**Confirmed.** The archived system had no global-only prompt block forbidding project AGENTS-family files and skill directories from being rediscovered and applied as instructions. The archived Bash/read sequence exercised that gap.

## Working-tree design

### One policy predicate

`SettingsManager.areProjectInstructionsEnabled()` is the shared persisted policy owner (`settings-manager.ts:3158-3159`). The old setting key remains compatible; the TUI names the behavior **Project instructions**.

### Discovery boundary

`DefaultPackageManager.resolve()` gates project extensions, skills, and prompts before package manifest/convention enumeration. Project themes remain available. When a project package shadows the same global package identity, a second skill/extension/prompt-only global pass preserves the globally authorized resources without traversing the project instruction sources. User/global resources stay available.

`DefaultPackageManager.resolveLocalExtensionSource()` also requires `extensions` in the admitted resource types before treating a project package's direct file or otherwise untyped directory as an extension; theme-only project-package scans still retain themes (`package-manager.ts:983-1077`).

`DefaultResourceLoader.isInstructionPathAdmitted()` is the shared file-backed admission owner (`resource-loader.ts:658-663`). It combines the persisted mode, resource metadata scope, lexical project containment, and canonical real-target containment. `extendResources()` uses that decision before contributed skill/prompt traversal (`resource-loader.ts:800-809`); `updateSkillsFromPaths()` and `updatePromptsFromPaths()` retain the same final pre-read gate (`resource-loader.ts:1381-1429`). Agent-dir and bundled resources are the only always-trusted roots. Registered catalogs still require canonical trust to be scanned, but physical project classification runs before their resources are admitted.

Project `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md` discovery requires both enabled project instructions and project trust; otherwise matching global files remain the fallback (`resource-loader.ts:1733-1766`). Explicit SDK system/append paths pass through the same admission decision before reads. A blocked explicit system path selects global `SYSTEM.md`; an append list selects global `APPEND_SYSTEM.md` only when filtering leaves no explicit append content (`resource-loader.ts:1314-1352`).

### SDK and runtime file-input boundary

**Confirmed.** `projectContextFiles: "off"` applies to project paths supplied through system/append prompt options, additional extension/skill/prompt paths, path-backed skill/context overrides, discoverable extension listing, direct and isolated extension loading, extension-contributed skill/prompt paths, and registered trusted catalogs. Both path spelling and canonical target are checked. Catalog trust authorizes scanning but cannot relabel a physical project path. True external paths retain existing profile/import controls; caller-materialized prompt/context/extension-factory data performs no project-file read and remains available. The public `loadProjectContextFiles({ includeProject: true })` helper is a low-level policy selection equivalent to enabling on-demand mode, not a bypass of a separate hidden setting.

`loadSkills()` exposes `includeProjectDefaults` so callers can include global defaults without silently adding cwd/ancestor project roots (`skills.ts:268`, `323-327`).

### Audit and runtime boundary

Runtime `skill_audit` and `skillify` receive `resourceLoader.getSkills().skills` (`runtime-builder.ts:945-946`). Their standalone fallback remains available for SDK/backwards compatibility, but the session runtime uses exactly the host-admitted skill universe.

### Root and worker guidance

`SystemPromptBuilder` emits `PI PROJECT INSTRUCTION ISOLATION` only while the policy is off (`system-prompt-builder.ts:240-246`). Root and delegated child prompt tests confirm inheritance; on-demand mode removes the block.

### Operator surface

`/settings` now presents **Project instructions** and explains that global-only excludes project AGENTS-family files, `.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md`, extensions, skills, and prompt templates. `packages/coding-agent/docs/settings.md`, `quickstart.md`, `usage.md`, and `sdk.md` document the same boundary without describing ordinary project data as hidden.

## Regression evidence

An initial integrated matrix passed 348 tests but did not cover three alternate admission paths. Independent review identified those missing paths; deterministic regressions then established the pre-fix baseline:

```text
npx vitest run test/resource-loader.test.ts test/package-manager.test.ts
```

Result before repair: 3 failed, 173 passed (`tool-task-41`). The same command passed 176/176 after the owning-boundary repairs (`tool-task-43`).

The adjacent affected-interface matrix was:

```text
npx vitest run test/goal-tool-core.test.ts test/goal-evidence-verification.test.ts test/package-manager.test.ts test/resource-loader.test.ts test/bundled-prompts-discovery.test.ts test/bundled-skills-discovery.test.ts test/suite/regressions/2781-skill-collision-precedence.test.ts test/skillify-extensionify.test.ts test/system-prompt-builder-tool-selection.test.ts test/settings-selector.test.ts
```

Result: 10 files, 338/338 passed (`tool-task-44`). An independent read-only reviewer then inspected the repaired source, reran the four directly affected suites with 233/233 passing, ran TypeScript no-emit successfully, and reported no blockers.

A later owner clarification revoked the project-local SDK-path carve-out. The expanded deterministic matrix is:

```text
npx --no-install vitest --run --bail=0 test/sdk-project-context-file-admission.test.ts
```

In the original 18-case pre-repair matrix, 15 tests failed for the expected security reason and 3 controls passed. After the shared admission owner was added, those 18/18 passed. Source-grounded review added a mixed blocked-project/literal append negative control, producing 19/19. A twentieth case then confirmed that registering the physical project as a trusted external-resource root still bypassed off mode: after rejecting one fixture-error run, the repaired fixture produced 1 product failure and 19 passes. Separating agent-dir/bundled always-trusted roots from registered catalogs moved the identical final matrix to 20/20. The exact-final resource-loader/context/package matrix passes 200/200 (`tool-task-65`), and the coding-agent TypeScript/package build passes. A bounded independent review of the central source and final regression slice found no confirmed blocker; its limited excerpt scope is covered by the broader local gates below.

Broader Linux validation includes:

- exact `npm run check` passed before the original documentation correction and again afterward, with Biome checking 1,888 files followed by the harness, release, dependency, TypeScript, import, coordinator, clone, and browser gates (`tool-task-46`, `tool-task-53`);
- the original exact `npm test` passed all four packages: 10,282 total, 9,525 passed, 757 skipped, 0 failed (`tool-task-47`);
- the clarified SDK addendum's exact-final `npm test` completed successfully across the workspace; its final coding-agent summary alone reports 722 test files passed, 8 skipped, 7,346 tests passed, 45 skipped, and 0 failed (`tool-task-67`).

Coverage includes:

- global system-prompt files remain the fallback while project `.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md` are excluded in global-only and restored only after trusted on-demand opt-in;
- global/user contributed skills and prompts remain available while project-scoped extension contributions are rejected at admission;
- global direct/fallback extension packages remain available while project direct/fallback extensions are excluded and project themes remain available;
- global user resources, true external SDK paths, and physically external trusted catalogs remain available while project extensions, skills, prompts, configured paths, trusted-catalog project paths, explicit SDK/runtime file paths, and project package instruction resources are excluded before instruction-content reads, returned listing contribution, or import;
- project instruction resources return after on-demand opt-in; non-bundled extension import still requires extension-profile authority;
- skill audit/skillify use only the host-admitted universe;
- root and worker prompts receive global-only guidance;
- running background tasks still block goal completion while failed/canceled terminal results remain invalid evidence.

## Residual risk and scope

- **Confirmed gap:** a general shell cannot provide a hidden-filesystem view of selected project instruction files without a materially different sandbox/mount architecture. The current design enforces runtime admission in code and semantic non-use in the system prompt; it does not claim filesystem secrecy.
- **Not yet checked:** a native Windows replay of the exact archived workflow.
- **Out of scope:** credential contents, unrelated archived chats, and project source were not reproduced in this report.

Confidence labels above distinguish archived reproduction, current-source confirmation, and untested residuals. Exact Linux root and workspace validation passed for the original repair as recorded. The clarified SDK addendum now has focused 20/20, adjacent 200/200, package-build, full-workspace, bounded independent-review, exact post-documentation root-gate (`tool-task-71`), and clean diff/status evidence. Native Windows replay remains not checked and is owned by release CI.
