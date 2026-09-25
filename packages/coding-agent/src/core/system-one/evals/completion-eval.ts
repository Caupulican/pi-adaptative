/**
 * Completion reliability evaluation: does the production completion transaction accept a goal that
 * is done and reject one that is not, for every kind of outcome a goal can promise?
 *
 * Each case builds the goal the way a session does (createGoalState + applyGoalEvent), projects it
 * through the same canonical truth, runs the SAME `SystemOneController.executeCompletionTransaction`
 * the goal tool runs, against whatever System One adapter the caller passes (the real one for a
 * measurement; a fake for the harness's own tests), repeated to expose variance. The workspace is
 * a scratch git repository, so `final_diff` is exactly what production would send.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	applyGoalEvent,
	createGoalState,
	type GoalEvidenceKind,
	type GoalState,
	type RequirementCheck,
} from "../../goals/goal-state.ts";
import { describeRequirementCheckRefusal, proveRequirementChecks } from "../../goals/prove-requirement-checks.ts";
import { runRequirementCheck } from "../../goals/requirement-checks.ts";
import type { JevAdapter } from "../adapter.ts";
import { projectCanonicalTruth } from "../canonical-truth.ts";
import { SystemOneController } from "../controller.ts";
import { ExecutionStore } from "../execution-state.ts";
import { readWorkDiff } from "../work-diff.ts";

export type OutcomeKind = "repository" | "machine" | "remote" | "information" | "mixed";

export interface CompletionEvalCase {
	id: string;
	kind: OutcomeKind;
	/** What the owner asked for. */
	goal: string;
	requirements: readonly string[];
	/** Evidence the agent recorded, satisfying the requirement at the same index. */
	evidence: readonly { kind: GoalEvidenceKind; summary: string; uri?: string }[];
	/**
	 * The requirement checks the agent attached, aligned with `requirements` (undefined = none).
	 * `{machine}` in a command is the scratch directory standing in for the machine's state.
	 */
	checks?: readonly (RequirementCheck | undefined)[];
	/** Files that exist on the "machine" (outside the repository) when completion is judged. */
	machine?: Readonly<Record<string, string>>;
	/** Repository files as they were before the goal (committed in the base the diff starts from). */
	repositoryBase?: Readonly<Record<string, string>>;
	/** Repository files the work changed (written before completion, after the goal started). */
	repositoryChanges?: Readonly<Record<string, string>>;
	/** Whether the goal is actually done. A planted-incomplete case is false. */
	done: boolean;
	/** Why a planted-incomplete case is not done (the thing a correct judge must catch). */
	plantedGap?: string;
}

const DURATION_BASE = {
	"src/duration.ts":
		"export function parseDuration(text: string): number {\n\tconst match = /^(\\d+)([smh])$/.exec(text.trim());\n\tif (!match) throw new Error('bad duration: ' + text);\n\tconst value = Number(match[1]);\n\treturn match[2] === 'h' ? value * 3600 : match[2] === 'm' ? value * 60 : value;\n}\n",
	"test/duration.test.ts":
		"import { expect, it } from 'vitest';\nimport { parseDuration } from '../src/duration.ts';\nit('minutes', () => expect(parseDuration('2m')).toBe(120));\n",
};
const DEFAULTS_BASE = { "config/defaults.json": '{\n\t"provider": "ollama"\n}\n' };

/** Correct and planted-incomplete completions for every outcome kind. */
export const COMPLETION_EVAL_CASES: readonly CompletionEvalCase[] = [
	{
		id: "machine-uninstall-done",
		kind: "machine",
		checks: [
			{ command: "test ! -e {machine}/usr/local/bin/ollama" },
			{ command: "test ! -e {machine}/home/.ollama" },
		],
		machine: { "home/.pi/agent/models.json": '{"providers":{"openai-codex":{}}}' },
		goal: "Remove the local Ollama server and its downloaded models from this machine.",
		requirements: [
			"Ollama server binary and service are removed and nothing listens on port 11434",
			"Downloaded Ollama models under ~/.ollama are deleted",
		],
		evidence: [
			{
				kind: "tool",
				summary:
					"Removed /usr/local/bin/ollama and the ollama systemd unit; `command -v ollama` prints nothing and `ss -ltn` shows no listener on 11434.",
			},
			{ kind: "tool", summary: "Deleted ~/.ollama (5.5 GB); `test -e ~/.ollama` now exits 1." },
		],
		done: true,
	},
	{
		id: "machine-uninstall-models-left",
		kind: "machine",
		checks: [
			{ command: "test ! -e {machine}/usr/local/bin/ollama" },
			{ command: "test ! -e {machine}/home/.ollama" },
		],
		machine: { "home/.ollama/models/blobs/sha256-7a1f": "model weights" },
		goal: "Remove the local Ollama server and its downloaded models from this machine.",
		requirements: [
			"Ollama server binary and service are removed and nothing listens on port 11434",
			"Downloaded Ollama models under ~/.ollama are deleted",
		],
		evidence: [
			{
				kind: "tool",
				summary:
					"Removed /usr/local/bin/ollama and the ollama systemd unit; `command -v ollama` prints nothing and `ss -ltn` shows no listener on 11434.",
			},
			{
				kind: "tool",
				summary:
					"Deleted ~/.ollama/logs; `du -sh ~/.ollama/models` still reports 5.4G (blob deletion was permission denied).",
			},
		],
		done: false,
		plantedGap: "models still present",
	},
	{
		id: "machine-config-done",
		kind: "machine",
		checks: [
			{ command: "grep -c ollama {machine}/home/.pi/agent/models.json", expectExitCode: 1 },
			{ command: "grep -c openai-codex {machine}/home/.pi/agent/models.json" },
		],
		machine: { "home/.pi/agent/models.json": '{"providers":{"openai-codex":{},"xai":{},"llama-cpp":{}}}' },
		goal: "Remove the ollama provider entry from ~/.pi/agent/models.json and keep every other provider.",
		requirements: ["models.json has no ollama provider", "All other providers in models.json are unchanged"],
		evidence: [
			{
				kind: "file",
				summary: "`jq '.providers | keys' ~/.pi/agent/models.json` lists openai-codex, xai, llama-cpp; no ollama.",
				uri: "~/.pi/agent/models.json",
			},
			{
				kind: "tool",
				summary:
					"Diffed models.json against the pre-change backup: the only removed key is providers.ollama; every other provider block is byte-identical.",
			},
		],
		done: true,
	},
	{
		id: "machine-config-port-still-open",
		kind: "machine",
		checks: [
			{ command: "test ! -e {machine}/run/llama-server.pid" },
			{ command: "grep -c enabled {machine}/home/.config/systemd/llama-server.state", expectExitCode: 1 },
		],
		machine: { "run/llama-server.pid": "4412", "home/.config/systemd/llama-server.state": "disabled" },
		goal: "Stop the local llama-cpp server and disable it from starting at login.",
		requirements: ["No llama-cpp server process is running", "The llama-cpp autostart entry is disabled"],
		evidence: [
			{
				kind: "tool",
				summary: "Disabled the llama-server user unit; `systemctl --user is-enabled llama-server` prints disabled.",
			},
			{ kind: "tool", summary: "`ss -ltnp` still shows llama-server listening on 127.0.0.1:8090 (pid 4412)." },
		],
		done: false,
		plantedGap: "server still running",
	},
	{
		id: "repository-fix-done",
		kind: "repository",
		goal: "Make parseDuration accept a bare number of seconds such as '90'.",
		requirements: ["parseDuration('90') returns 90 seconds", "Existing unit suffixes keep working"],
		evidence: [
			{ kind: "test", summary: "vitest run test/duration.test.ts: 6 passed, including the new bare-number case." },
			{ kind: "test", summary: "The existing s/m/h suffix cases still pass in the same run." },
		],
		repositoryBase: DURATION_BASE,
		repositoryChanges: {
			"src/duration.ts":
				"export function parseDuration(text: string): number {\n\tconst match = /^(\\d+)([smh]?)$/.exec(text.trim());\n\tif (!match) throw new Error('bad duration: ' + text);\n\tconst value = Number(match[1]);\n\treturn match[2] === 'h' ? value * 3600 : match[2] === 'm' ? value * 60 : value;\n}\n",
			"test/duration.test.ts":
				"import { expect, it } from 'vitest';\nimport { parseDuration } from '../src/duration.ts';\nit('bare number is seconds', () => expect(parseDuration('90')).toBe(90));\nit('minutes', () => expect(parseDuration('2m')).toBe(120));\n",
		},
		done: true,
	},
	{
		id: "repository-fix-suffix-broken",
		kind: "repository",
		goal: "Make parseDuration accept a bare number of seconds such as '90'.",
		requirements: ["parseDuration('90') returns 90 seconds", "Existing unit suffixes keep working"],
		evidence: [
			{ kind: "test", summary: "vitest run test/duration.test.ts: the bare-number case passes." },
			{ kind: "test", summary: "vitest run test/duration.test.ts: 'minutes' case fails, expected 120, received 2." },
		],
		repositoryBase: DURATION_BASE,
		repositoryChanges: {
			"src/duration.ts":
				"export function parseDuration(text: string): number {\n\treturn Number(text.replace(/[smh]$/, ''));\n}\n",
		},
		done: false,
		plantedGap: "suffixes broken",
	},
	{
		id: "remote-publish-done",
		kind: "remote",
		goal: "Publish version 1.4.2 of the docs site to production.",
		requirements: ["Docs 1.4.2 is deployed to production", "The production site serves version 1.4.2"],
		evidence: [
			{
				kind: "tool",
				summary: "Deploy job 8812 finished with status success for tag docs-v1.4.2 to environment production.",
			},
			{ kind: "tool", summary: "`curl -s https://docs.example.test/version` returns 1.4.2." },
		],
		done: true,
	},
	{
		id: "remote-publish-stale",
		kind: "remote",
		goal: "Publish version 1.4.2 of the docs site to production.",
		requirements: ["Docs 1.4.2 is deployed to production", "The production site serves version 1.4.2"],
		evidence: [
			{
				kind: "tool",
				summary: "Deploy job 8812 finished with status success for tag docs-v1.4.2 to environment production.",
			},
			{
				kind: "tool",
				summary: "`curl -s https://docs.example.test/version` still returns 1.4.1 ten minutes after the deploy.",
			},
		],
		done: false,
		plantedGap: "old version still served",
	},
	{
		id: "information-answer-done",
		kind: "information",
		goal: "Tell me which Node.js version this repository requires and where that is declared.",
		requirements: ["Report the required Node.js version", "Name the file that declares it"],
		evidence: [
			{ kind: "file", summary: "package.json engines.node is '>=24.20.0'.", uri: "package.json" },
			{ kind: "file", summary: ".node-version pins 24.20.0 for local tooling.", uri: ".node-version" },
		],
		done: true,
	},
	{
		id: "information-answer-unsourced",
		kind: "information",
		goal: "Tell me which Node.js version this repository requires and where that is declared.",
		requirements: ["Report the required Node.js version", "Name the file that declares it"],
		evidence: [
			{ kind: "finding", summary: "Node 22 is probably required, based on the lockfile format." },
			{ kind: "finding", summary: "Likely declared somewhere in the CI configuration." },
		],
		done: false,
		plantedGap: "guessed, unsourced answer",
	},
	{
		id: "mixed-config-and-code-done",
		kind: "mixed",
		checks: [
			{ command: "grep -c ollama {machine}/home/.pi/agent/models.json", expectExitCode: 1 },
			{ command: "grep -c ollama config/defaults.json", expectExitCode: 1 },
		],
		machine: { "home/.pi/agent/models.json": '{"providers":{"openai-codex":{},"xai":{}}}' },
		goal: "Stop using the Ollama provider: remove it from ~/.pi/agent/models.json and delete the repo's ollama default in config/defaults.json.",
		requirements: ["models.json has no ollama provider", "config/defaults.json no longer names ollama"],
		evidence: [
			{
				kind: "file",
				summary: "`jq '.providers | keys' ~/.pi/agent/models.json` lists openai-codex and xai only.",
				uri: "~/.pi/agent/models.json",
			},
			{
				kind: "tool",
				summary: "`grep -c ollama config/defaults.json` prints 0; defaults.json now selects openai-codex.",
			},
		],
		repositoryBase: DEFAULTS_BASE,
		repositoryChanges: { "config/defaults.json": '{\n\t"provider": "openai-codex"\n}\n' },
		done: true,
	},
];

const FORMAT_BASE = {
	"src/format.ts": "export function formatBytes(bytes: number): string {\n\treturn bytes + ' B';\n}\n",
	"src/ui/status.ts":
		"import { formatBytes } from '../format.ts';\nexport const label = (size: number) => formatBytes(size);\n",
	"src/ui/files.ts":
		"import { formatBytes } from '../format.ts';\nexport const row = (size: number) => formatBytes(size);\n",
};

/**
 * Held-out goals: never used to choose a question or a threshold. They measure whether completion
 * generalises to new wording and new domains (`npm run eval:completion -- --set heldout`).
 */
export const COMPLETION_EVAL_HELDOUT_CASES: readonly CompletionEvalCase[] = [
	{
		id: "heldout-install-done",
		kind: "machine",
		goal: "Install ripgrep so the rg command is available.",
		requirements: ["ripgrep is installed and rg is on the PATH"],
		evidence: [{ kind: "tool", summary: "apt-get install ripgrep finished; `rg --version` prints ripgrep 14.1.0." }],
		checks: [{ command: "test -e {machine}/usr/bin/rg" }],
		machine: { "usr/bin/rg": "binary" },
		done: true,
	},
	{
		id: "heldout-install-missing",
		kind: "machine",
		goal: "Install ripgrep so the rg command is available.",
		requirements: ["ripgrep is installed and rg is on the PATH"],
		evidence: [{ kind: "tool", summary: "apt-get install ripgrep was run." }],
		checks: [{ command: "test -e {machine}/usr/bin/rg" }],
		done: false,
		plantedGap: "not actually installed",
	},
	{
		id: "heldout-logs-done",
		kind: "machine",
		goal: "Delete pi session logs older than 30 days, keeping the recent ones.",
		requirements: ["Logs older than 30 days are deleted", "Logs from the last 30 days are kept"],
		evidence: [
			{ kind: "tool", summary: "Removed 14 logs dated before 2026-08-26; `ls logs` shows none older." },
			{ kind: "tool", summary: "`ls logs` still lists the 9 logs from September." },
		],
		checks: [
			{ command: "test ! -e {machine}/logs/2026-07-01.log" },
			{ command: "test -e {machine}/logs/2026-09-20.log" },
		],
		machine: { "logs/2026-09-20.log": "recent" },
		done: true,
	},
	{
		id: "heldout-logs-deleted-all",
		kind: "machine",
		goal: "Delete pi session logs older than 30 days, keeping the recent ones.",
		requirements: ["Logs older than 30 days are deleted", "Logs from the last 30 days are kept"],
		evidence: [
			{ kind: "tool", summary: "Removed the old logs with `find logs -mtime +30 -delete`." },
			{ kind: "tool", summary: "Recent logs kept." },
		],
		checks: [
			{ command: "test ! -e {machine}/logs/2026-07-01.log" },
			{ command: "test -e {machine}/logs/2026-09-20.log" },
		],
		done: false,
		plantedGap: "recent logs deleted too",
	},
	{
		id: "heldout-rename-done",
		kind: "repository",
		goal: "Rename the helper formatBytes to formatByteSize everywhere it is used.",
		requirements: [
			"formatBytes is renamed to formatByteSize in its definition",
			"Every call site uses formatByteSize",
		],
		evidence: [
			{ kind: "tool", summary: "Renamed the export in src/format.ts." },
			{ kind: "tool", summary: "`grep -rn formatBytes src` prints nothing; both call sites use formatByteSize." },
		],
		repositoryBase: FORMAT_BASE,
		repositoryChanges: {
			"src/format.ts": "export function formatByteSize(bytes: number): string {\n\treturn bytes + ' B';\n}\n",
			"src/ui/status.ts":
				"import { formatByteSize } from '../format.ts';\nexport const label = (size: number) => formatByteSize(size);\n",
			"src/ui/files.ts":
				"import { formatByteSize } from '../format.ts';\nexport const row = (size: number) => formatByteSize(size);\n",
		},
		done: true,
	},
	{
		id: "heldout-rename-call-site-left",
		kind: "repository",
		goal: "Rename the helper formatBytes to formatByteSize everywhere it is used.",
		requirements: [
			"formatBytes is renamed to formatByteSize in its definition",
			"Every call site uses formatByteSize",
		],
		evidence: [
			{ kind: "tool", summary: "Renamed the export in src/format.ts." },
			{ kind: "tool", summary: "`grep -rn formatBytes src` still prints src/ui/files.ts:1 and src/ui/files.ts:2." },
		],
		repositoryBase: FORMAT_BASE,
		repositoryChanges: {
			"src/format.ts": "export function formatByteSize(bytes: number): string {\n\treturn bytes + ' B';\n}\n",
			"src/ui/status.ts":
				"import { formatByteSize } from '../format.ts';\nexport const label = (size: number) => formatByteSize(size);\n",
		},
		done: false,
		plantedGap: "one call site left",
	},
	{
		id: "heldout-issue-done",
		kind: "remote",
		goal: "Close issue #412 with a comment that links the fix commit abc1234.",
		requirements: ["Issue #412 is closed", "A comment on #412 links commit abc1234"],
		evidence: [
			{ kind: "tool", summary: "`gh issue view 412 --json state` returns CLOSED." },
			{ kind: "tool", summary: "The last comment on #412 reads 'Fixed in abc1234'." },
		],
		done: true,
	},
	{
		id: "heldout-issue-still-open",
		kind: "remote",
		goal: "Close issue #412 with a comment that links the fix commit abc1234.",
		requirements: ["Issue #412 is closed", "A comment on #412 links commit abc1234"],
		evidence: [
			{
				kind: "tool",
				summary:
					"`gh issue view 412 --json state` still returns OPEN after `gh issue close` reported a permissions error.",
			},
			{ kind: "tool", summary: "The last comment on #412 reads 'Fixed in abc1234'." },
		],
		done: false,
		plantedGap: "issue not closed",
	},
	{
		id: "heldout-port-answer-done",
		kind: "information",
		goal: "Tell me which process listens on port 5173 and what started it.",
		requirements: ["Name the process listening on 5173", "Say what started it"],
		evidence: [
			{ kind: "tool", summary: "`ss -ltnp` shows node (pid 4410) listening on 127.0.0.1:5173." },
			{ kind: "tool", summary: "`ps -o args= -p 4410` shows `vite` launched by `npm run dev` in ~/app." },
		],
		done: true,
	},
	{
		id: "heldout-port-answer-guessed",
		kind: "information",
		goal: "Tell me which process listens on port 5173 and what started it.",
		requirements: ["Name the process listening on 5173", "Say what started it"],
		evidence: [
			{ kind: "finding", summary: "Port 5173 is the Vite default, so it is probably a Vite dev server." },
			{ kind: "finding", summary: "It was most likely started by an npm script." },
		],
		done: false,
		plantedGap: "guessed from the port number",
	},
	{
		id: "heldout-staging-done",
		kind: "mixed",
		goal: "Point the app at the staging API: set API_URL in .env.staging and export it in ~/.bashrc.",
		requirements: [".env.staging sets API_URL to the staging URL", "~/.bashrc exports API_URL"],
		evidence: [
			{
				kind: "file",
				summary: ".env.staging now contains API_URL=https://staging.example.test.",
				uri: ".env.staging",
			},
			{ kind: "tool", summary: "`grep API_URL ~/.bashrc` prints export API_URL=https://staging.example.test." },
		],
		checks: [undefined, { command: "grep -c 'export API_URL' {machine}/home/.bashrc" }],
		machine: { "home/.bashrc": "export API_URL=https://staging.example.test\n" },
		repositoryChanges: { ".env.staging": "API_URL=https://staging.example.test\n" },
		done: true,
	},
	{
		id: "heldout-staging-bashrc-missing",
		kind: "mixed",
		goal: "Point the app at the staging API: set API_URL in .env.staging and export it in ~/.bashrc.",
		requirements: [".env.staging sets API_URL to the staging URL", "~/.bashrc exports API_URL"],
		evidence: [
			{
				kind: "file",
				summary: ".env.staging now contains API_URL=https://staging.example.test.",
				uri: ".env.staging",
			},
			{ kind: "tool", summary: "Appended the export to ~/.bashrc." },
		],
		checks: [undefined, { command: "grep -c 'export API_URL' {machine}/home/.bashrc" }],
		machine: { "home/.bashrc": "alias ll='ls -l'\n" },
		repositoryChanges: { ".env.staging": "API_URL=https://staging.example.test\n" },
		done: false,
		plantedGap: "bashrc export missing",
	},
];

export interface CompletionEvalRun {
	caseId: string;
	kind: OutcomeKind;
	done: boolean;
	verdicts: string[];
	/** The failed gate reasons of each non-complete verdict, in order. */
	reasons: string[][];
	/** System One's raw answers per attempt (absent when a check refused before it was asked). */
	answers?: Array<Record<string, unknown> | undefined>;
}

export interface CompletionEvalSummary {
	runs: CompletionEvalRun[];
	/** Share of done cases accepted on each attempt (first-try acceptance). */
	doneAccepted: number;
	/** Share of planted-incomplete attempts rejected. */
	incompleteRejected: number;
	byKind: Record<string, { doneAccepted: number; incompleteRejected: number }>;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A scratch repository whose base commit predates the goal, then the case's changes on top. */
function scratchRepository(testCase: CompletionEvalCase, goalStartedAt: string): string {
	const root = mkdtempSync(join(tmpdir(), "pi-completion-eval-"));
	const write = (files: Readonly<Record<string, string>> | undefined) => {
		for (const [path, content] of Object.entries(files ?? {})) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
	};
	git(root, ["init", "-q"]);
	writeFileSync(join(root, "README.md"), "# fixture\n");
	write(testCase.repositoryBase);
	const baseDate = new Date(Date.parse(goalStartedAt) - 60_000).toISOString();
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=eval",
			"-c",
			"user.email=eval@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: baseDate, GIT_COMMITTER_DATE: baseDate } },
	);
	write(testCase.repositoryChanges);
	return root;
}

/** The goal as a session builds it: requirements, evidence, each requirement satisfied by its evidence. */
export function buildEvalGoal(testCase: CompletionEvalCase, now: string, machineRoot = "{machine}"): GoalState {
	// Checks run in bash: the root goes in as one quoted word with forward slashes, which bash on every
	// platform reads as the same path (unquoted, a Windows path loses its backslashes to escaping).
	const shellRoot = `'${machineRoot.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
	let goal = createGoalState({ goalId: `goal-eval-${testCase.id}`, userGoal: testCase.goal, now });
	testCase.requirements.forEach((text, index) => {
		const check = testCase.checks?.[index];
		goal = applyGoalEvent(goal, {
			type: "add_requirement",
			id: `req-${index + 1}`,
			text,
			...(check ? { check: { ...check, command: check.command.replaceAll("{machine}", shellRoot) } } : {}),
			now,
		});
	});
	testCase.evidence.forEach((evidence, index) => {
		goal = applyGoalEvent(goal, {
			type: "add_evidence",
			id: `ev-${index + 1}`,
			kind: evidence.kind,
			summary: evidence.summary,
			...(evidence.uri ? { uri: evidence.uri } : {}),
			verified: evidence.kind !== "finding",
			now,
		});
		goal = applyGoalEvent(goal, {
			type: "satisfy_requirement",
			id: `req-${index + 1}`,
			evidenceIds: [`ev-${index + 1}`],
			now,
		});
	});
	return goal;
}

/** Run one case once through the production completion transaction. */
export async function evaluateCompletionOnce(
	testCase: CompletionEvalCase,
	adapter: JevAdapter,
): Promise<{ verdict: string; reasons: string[]; answers?: Record<string, unknown> }> {
	const now = new Date().toISOString();
	const machine = mkdtempSync(join(tmpdir(), "pi-completion-eval-machine-"));
	for (const [path, content] of Object.entries(testCase.machine ?? {})) {
		mkdirSync(dirname(join(machine, path)), { recursive: true });
		writeFileSync(join(machine, path), content);
	}
	const cwd = scratchRepository(testCase, now);
	try {
		// The goal tool's completion order: rerun every requirement check first; a failed one refuses
		// completion before System One is asked.
		const proof = await proveRequirementChecks({
			state: buildEvalGoal(testCase, now, machine),
			runCheck: (check, signal) => runRequirementCheck(check, { cwd, ...(signal ? { signal } : {}) }),
			now: () => new Date().toISOString(),
			save: () => {},
			requireVerifiedEvidenceForCompletion: true,
		});
		const refusal = describeRequirementCheckRefusal(proof);
		if (refusal) return { verdict: "refused_by_check", reasons: [refusal] };
		const goal = proof.state;
		const revision = git(cwd, ["rev-parse", "HEAD"]).trim();
		const store = new ExecutionStore({
			run_id: `eval-${testCase.id}`,
			objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
			repo: { root: cwd, baseline_revision: revision, current_revision: revision },
		});
		const controller = new SystemOneController({ store, adapter });
		controller.setTruthSource(() => projectCanonicalTruth({ goal, currentRevision: revision }));
		controller.setWorkDiffSource(() => readWorkDiff(cwd, goal.createdAt));
		const verdict = await controller.executeCompletionTransaction(false, { persistTerminal: false });
		// System One's raw answers for every question it was asked: what calibration is measured on.
		const answers = Object.assign({}, ...store.snapshot().decisions.map((decision) => decision.answers));
		return { verdict: verdict.verdict, reasons: verdict.failed_gates.map((gate) => gate.reason), answers };
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(machine, { recursive: true, force: true });
	}
}

/** Every case `repeats` times; a thrown evaluation is recorded as verdict "error: <message>". */
export async function runCompletionEval(
	adapter: JevAdapter,
	options: { repeats?: number; cases?: readonly CompletionEvalCase[]; onRun?: (run: CompletionEvalRun) => void } = {},
): Promise<CompletionEvalSummary> {
	const repeats = options.repeats ?? 5;
	const runs: CompletionEvalRun[] = [];
	for (const testCase of options.cases ?? COMPLETION_EVAL_CASES) {
		const run: CompletionEvalRun = {
			caseId: testCase.id,
			kind: testCase.kind,
			done: testCase.done,
			verdicts: [],
			reasons: [],
		};
		for (let attempt = 0; attempt < repeats; attempt++) {
			try {
				const result = await evaluateCompletionOnce(testCase, adapter);
				run.verdicts.push(result.verdict);
				run.reasons.push(result.reasons);
				run.answers = [...(run.answers ?? []), result.answers];
			} catch (error) {
				run.verdicts.push(`error: ${error instanceof Error ? error.message : String(error)}`);
				run.reasons.push([]);
			}
		}
		runs.push(run);
		options.onRun?.(run);
	}
	return summarizeCompletionEval(runs);
}

export function summarizeCompletionEval(runs: readonly CompletionEvalRun[]): CompletionEvalSummary {
	const rate = (selected: readonly CompletionEvalRun[], accept: boolean): number => {
		const verdicts = selected.flatMap((run) => run.verdicts);
		if (verdicts.length === 0) return Number.NaN;
		return verdicts.filter((verdict) => (verdict === "complete") === accept).length / verdicts.length;
	};
	const byKind: CompletionEvalSummary["byKind"] = {};
	for (const kind of [...new Set(runs.map((run) => run.kind))]) {
		const ofKind = runs.filter((run) => run.kind === kind);
		byKind[kind] = {
			doneAccepted: rate(
				ofKind.filter((run) => run.done),
				true,
			),
			incompleteRejected: rate(
				ofKind.filter((run) => !run.done),
				false,
			),
		};
	}
	return {
		runs: [...runs],
		doneAccepted: rate(
			runs.filter((run) => run.done),
			true,
		),
		incompleteRejected: rate(
			runs.filter((run) => !run.done),
			false,
		),
		byKind,
	};
}
