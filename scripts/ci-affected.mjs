#!/usr/bin/env node
/**
 * Decide which CI tests a commit actually bought.
 *
 * Push/PR runs only the workspaces (and OS-specific controls) whose files changed.
 * The complete Linux/Windows matrix is the release tag (build-binaries passes full_suite) and manual dispatch.
 */
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findCodingAgentScanIncludes } from "./ci-coding-agent-test-dependencies.mjs";
import { WORKSPACES } from "./workspace-test-plan.mjs";

const SHARED_FULL = [
	/^\.nvmrc$/,
	/^test\.sh$/,
	/^scripts\/run-workspace-tests\.mjs$/,
	/^scripts\/workspace-test-plan\.mjs$/,
	/^scripts\/ci-affected\.mjs$/,
	/^\.github\/workflows\/ci\.yml$/,
];

const LINUX_CHECK = [
	/^package\.json$/,
	/^package-lock\.json$/,
	/^biome\.json$/,
	/^tsconfig(?:\.[^/]+)?\.json$/,
];

// Files that are global to every coding-agent test (config, setupFiles) but are not reached by
// the static import graph any single test file walks. A change here must never be narrowed —
// `vitest related` would not know it touches every test.
const CODING_AGENT_GLOBAL_TEST_INFRA = [/^vitest[^/]*\.config\.ts$/u, /^test\/test-agent-dir-isolation-setup\.ts$/u];

// vitest related's affected-module walk only follows real import edges, so a changed file can
// only be trusted to carry its own dependents when it is TypeScript source under this workspace.
const CODING_AGENT_IMPORTABLE = /\.(?:ts|mts)$/u;

/** Workspace → packages that import it. A producer change is relevant to those consumers. */
export const WORKSPACE_CONSUMERS = Object.freeze({
	"packages/tui": Object.freeze(["packages/coding-agent"]),
	"packages/ai": Object.freeze(["packages/agent", "packages/coding-agent"]),
	"packages/agent": Object.freeze(["packages/coding-agent"]),
	"packages/coding-agent": Object.freeze([]),
});

export const EMPTY_PLAN = Object.freeze({
	full: false,
	qualityJob: false,
	check: false,
	codingAgent: false,
	workspaces: Object.freeze([]),
	nonCodingAgentWorkspaces: Object.freeze([]),
	os: Object.freeze([]),
	coverage: false,
	longSession: false,
	nativeProcess: false,
	windowsIncident: false,
	// null means "not narrowed": the coding-agent job runs its full sharded suite, same as today.
	codingAgentRelatedFiles: null,
});

export const FULL_PLAN = Object.freeze({
	full: true,
	qualityJob: true,
	check: true,
	codingAgent: true,
	workspaces: Object.freeze([...WORKSPACES]),
	nonCodingAgentWorkspaces: Object.freeze(WORKSPACES.filter((workspace) => workspace !== "packages/coding-agent")),
	os: Object.freeze(["ubuntu-latest", "windows-latest"]),
	coverage: true,
	longSession: true,
	nativeProcess: true,
	windowsIncident: true,
	codingAgentRelatedFiles: null,
});

export function workspaceOf(path) {
	const match = /^(packages\/[^/]+)\//u.exec(path.replaceAll("\\", "/"));
	return match?.[1];
}

export function isDocsPath(path) {
	const normalized = path.replaceAll("\\", "/");
	return normalized.endsWith(".md") || normalized.startsWith("docs/");
}

export function isReleaseMetadataSubject(subject) {
	return /^(?:Release v|Repair release v)\d+\.\d+\.\d+$/u.test((subject ?? "").split("\n", 1)[0].trim());
}

export function isTestFile(path) {
	return /\.test\.(?:ts|mts|cts|mjs|js)$/u.test(path.replaceAll("\\", "/"));
}

function clonePlan(plan) {
	return {
		...plan,
		workspaces: [...plan.workspaces],
		nonCodingAgentWorkspaces: [...plan.nonCodingAgentWorkspaces],
		os: [...plan.os],
	};
}

function addWorkspaceAndConsumers(selected, workspace, file) {
	selected.add(workspace);
	if (isTestFile(file) || isDocsPath(file)) return;
	for (const consumer of WORKSPACE_CONSUMERS[workspace] ?? []) selected.add(consumer);
}

/**
 * Test-file-level narrowing for the coding-agent workspace: the workspace-relative paths to feed
 * `vitest related`, or null when narrowing is not safe and the workspace must run its full suite.
 *
 * Sound-by-construction: this only narrows when every changed file inside
 * packages/coding-agent is real TypeScript source (so the import graph can see it) and none of
 * them is global test infrastructure (config/setupFiles, which no single test's import graph
 * reaches). Any other changed file in the workspace — a fixture, an asset, a script, docs inside
 * src/ — falls back to null (full suite), and a file changed only in another workspace (pulled in
 * as a consumer) is not "local" here and also leaves this null, unchanged from today's behavior.
 */
function producesCodingAgent(workspace) {
	return (WORKSPACE_CONSUMERS[workspace] ?? []).includes("packages/coding-agent");
}

export function codingAgentRelatedFiles(files) {
	const prefix = "packages/coding-agent/";
	const local = [];
	for (const file of files) {
		const workspace = workspaceOf(file);
		if (workspace && workspace !== "packages/coding-agent" && producesCodingAgent(workspace)) {
			// A producer change (tui/ai/agent) pulls coding-agent in only as a consumer; that
			// blast radius crosses a node_modules workspace boundary the import-graph walk does
			// not follow, so it is not provable from here — widen to the full suite, same as
			// today, regardless of what else changed locally in coding-agent.
			if (!isTestFile(file) && !isDocsPath(file)) return null;
			continue;
		}
		if (!file.startsWith(prefix)) continue;
		const relative = file.slice(prefix.length);
		if (CODING_AGENT_GLOBAL_TEST_INFRA.some((pattern) => pattern.test(relative))) return null;
		if (!CODING_AGENT_IMPORTABLE.test(relative)) return null;
		local.push(relative);
	}
	return local.length > 0 ? local : null;
}

function planFromSelected(selectedSet, check) {
	const selected = WORKSPACES.filter((workspace) => selectedSet.has(workspace));
	const codingAgent = selectedSet.has("packages/coding-agent");
	const agent = selectedSet.has("packages/agent");
	const qualityJob = selected.length > 0 || check;
	if (!qualityJob) return clonePlan(EMPTY_PLAN);
	return {
		full: false,
		qualityJob: true,
		check,
		codingAgent,
		workspaces: selected,
		nonCodingAgentWorkspaces: selected.filter((workspace) => workspace !== "packages/coding-agent"),
		os: codingAgent || agent ? ["ubuntu-latest", "windows-latest"] : ["ubuntu-latest"],
		coverage: agent || codingAgent,
		longSession: codingAgent,
		nativeProcess: agent,
		windowsIncident: codingAgent,
	};
}

export function planAffected({ paths = [], fullSuite = false, subject = "" } = {}) {
	if (fullSuite) return clonePlan(FULL_PLAN);
	if (isReleaseMetadataSubject(subject)) return clonePlan(EMPTY_PLAN);

	const files = paths.map((path) => path.replaceAll("\\", "/"));
	if (files.length === 0) return clonePlan(EMPTY_PLAN);
	if (files.some((file) => SHARED_FULL.some((pattern) => pattern.test(file)))) return clonePlan(FULL_PLAN);
	if (files.every(isDocsPath)) return clonePlan(EMPTY_PLAN);

	const selected = new Set();
	let check = false;
	for (const file of files) {
		if (LINUX_CHECK.some((pattern) => pattern.test(file))) check = true;
		else if (file.startsWith("scripts/") || file.startsWith(".github/")) check = true;
		else if (!isDocsPath(file) && !isTestFile(file)) check = true;
		const workspace = workspaceOf(file);
		if (workspace && WORKSPACES.includes(workspace)) addWorkspaceAndConsumers(selected, workspace, file);
	}

	const plan = planFromSelected(selected, check);
	plan.codingAgentRelatedFiles = plan.codingAgent ? codingAgentRelatedFiles(files) : null;
	return plan;
}

export function listChangedFiles({ eventName, before, baseSha } = {}, read = defaultGitDiff) {
	let range;
	if (eventName === "pull_request" && baseSha) range = `${baseSha}...HEAD`;
	else if (before && !/^0+$/u.test(before)) range = `${before}...HEAD`;
	else range = "HEAD~1...HEAD";
	return read(range);
}

function defaultGitDiff(range) {
	return execFileSync("git", ["diff", "--name-only", "-z", range], { encoding: "utf8" })
		.split("\0")
		.filter(Boolean);
}

// Narrowed coding-agent runs skip the 4-way shard split entirely: the affected set is resolved
// once by `vitest related` (see run-coding-agent-related.mjs) instead of being pre-partitioned,
// so a single job per OS is the whole run. Unnarrowed runs keep today's 4 shards unchanged.
export function codingAgentShards(plan) {
	return plan.codingAgentRelatedFiles ? [1] : [1, 2, 3, 4];
}

function writeGithubOutput(plan) {
	const shards = codingAgentShards(plan);
	const payload = [
		`quality_job=${plan.qualityJob}`,
		`check=${plan.check}`,
		`coding_agent=${plan.codingAgent}`,
		`coverage=${plan.coverage}`,
		`long_session=${plan.longSession}`,
		`native_process=${plan.nativeProcess}`,
		`windows_incident=${plan.windowsIncident}`,
		`os=${JSON.stringify(plan.os)}`,
		`non_coding_agent_workspaces=${JSON.stringify(plan.nonCodingAgentWorkspaces)}`,
		`coding_agent_narrow=${Boolean(plan.codingAgentRelatedFiles)}`,
		`coding_agent_related_files=${JSON.stringify(plan.codingAgentRelatedFiles ?? [])}`,
		`coding_agent_shards=${JSON.stringify(shards)}`,
		`coding_agent_shard_count=${shards.length}`,
	].join("\n");
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${payload}\n`);
	console.log(JSON.stringify(plan, null, 2));
}

function isFullSuite(value) {
	return value === "true" || value === "1";
}

// The carry-forward step (see ci-carry-forward.mjs) reports one of two things: `{ full: false,
// files: [...] }` — the previous push-to-main run's failure, if any, is fully accounted for by
// named coding-agent test files safe to add to this commit's own selection — or `{ full: true,
// reason }` — it could not prove that, so this commit must run the complete suite. An EMPTY/absent
// value means the carry-forward step did not run at all (not a push to main), which is not a
// failure signal: it is treated the same as "nothing to carry" so an ordinary diff-based plan
// still applies. Any other shape (malformed JSON, wrong type, missing fields) is an unexplained
// carry-forward failure and fails closed to the full suite too — this is a safety gate, not an
// optional enhancement, so an unreadable answer must never be read as "narrow anyway".
export function parseCarriedFiles(raw) {
	if (!raw) return { full: false, files: [] };
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { full: true, reason: "carry-forward output was not valid JSON" };
	}
	if (parsed && typeof parsed === "object" && parsed.full === true) {
		return { full: true, reason: typeof parsed.reason === "string" ? parsed.reason : "carry-forward requested the full suite" };
	}
	if (parsed && typeof parsed === "object" && parsed.full === false && Array.isArray(parsed.files)) {
		return { full: false, files: parsed.files.filter((file) => typeof file === "string") };
	}
	return { full: true, reason: "carry-forward output had an unrecognized shape" };
}

/**
 * Adds tests that depend on a narrowed change WITHOUT importing it — text-reads, directory scans,
 * and whole-program spawns of a coding-agent source file (see ci-coding-agent-test-dependencies.mjs)
 * — to a plan that already narrowed by import-graph alone. Never touches a full-suite plan: this
 * only ever grows a narrowed file list, it never narrows or widens the decision to narrow at all.
 * `scan` is injected so this stays testable without touching the real filesystem; the CLI below
 * supplies the real one.
 */
export function enrichWithScanIncludes(plan, scan) {
	if (!plan.codingAgentRelatedFiles) return plan;
	const changed = plan.codingAgentRelatedFiles.map((file) => `packages/coding-agent/${file}`);
	const extra = scan(changed);
	if (extra.length === 0) return plan;
	return { ...plan, codingAgentRelatedFiles: Array.from(new Set([...plan.codingAgentRelatedFiles, ...extra])) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const fullSuite = isFullSuite(process.env.CI_FULL_SUITE);
	let paths = [];
	if (!fullSuite) {
		try {
			paths = listChangedFiles({
				eventName: process.env.CI_EVENT_NAME || process.env.GITHUB_EVENT_NAME,
				before: process.env.CI_BEFORE,
				baseSha: process.env.CI_BASE_SHA,
			});
		} catch (error) {
			console.error(`ci-affected: could not list changed files (${error instanceof Error ? error.message : String(error)}); running the full suite`);
			writeGithubOutput(planAffected({ fullSuite: true }));
			process.exit(0);
		}
		const carried = parseCarriedFiles(process.env.CI_CARRIED_FILES);
		if (carried.full) {
			console.error(`ci-affected: carry-forward requires the full suite (${carried.reason})`);
			writeGithubOutput(planAffected({ fullSuite: true }));
			process.exit(0);
		}
		paths = [...paths, ...carried.files];
	}
	const plan = planAffected({
		paths,
		fullSuite,
		subject: process.env.CI_COMMIT_SUBJECT ?? "",
	});
	writeGithubOutput(enrichWithScanIncludes(plan, findCodingAgentScanIncludes));
}
