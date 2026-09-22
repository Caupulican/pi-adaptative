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

	return planFromSelected(selected, check);
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

function writeGithubOutput(plan) {
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
	].join("\n");
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${payload}\n`);
	console.log(JSON.stringify(plan, null, 2));
}

function isFullSuite(value) {
	return value === "true" || value === "1";
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
	}
	writeGithubOutput(
		planAffected({
			paths,
			fullSuite,
			subject: process.env.CI_COMMIT_SUBJECT ?? "",
		}),
	);
}
