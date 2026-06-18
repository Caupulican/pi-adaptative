import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringEnum } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { getAgentDir } from "../config.ts";
import { defineTool, type ToolDefinition } from "./extensions/types.ts";

export type MetricDirection = "lower" | "higher";
export type ImprovementDecision = "keep" | "discard" | "retry" | "blocked";
export type ImprovementDecisionReason =
	| "baseline"
	| "metric_improved"
	| "checks_failed"
	| "metric_missing"
	| "metric_invalid"
	| "not_better_than_best"
	| "below_min_delta"
	| "below_min_relative_delta"
	| "insufficient_noise_evidence"
	| "below_confidence";
export type ConfidenceMode = "none" | "mad";
export type LowConfidenceAction = "retry" | "discard";

export interface MetricComparison {
	current: number;
	best: number | null;
	direction: MetricDirection;
	delta: number;
	relativeDelta: number | null;
	improved: boolean;
}

export interface ConfidenceResult {
	mode: ConfidenceMode;
	value: number | null;
	noiseFloor: number | null;
	sampleCount: number;
}

export interface ImprovementDecisionInput {
	currentMetric: number | null | undefined;
	bestMetric?: number | null;
	baselineMetric?: number | null;
	direction?: MetricDirection;
	checksPass?: boolean | null;
	minDelta?: number;
	minRelativeDelta?: number;
	confidenceMode?: ConfidenceMode;
	minConfidence?: number;
	lowConfidenceAction?: LowConfidenceAction;
	noiseMetrics?: number[];
}

export interface ImprovementDecisionResult {
	decision: ImprovementDecision;
	reason: ImprovementDecisionReason;
	comparison: MetricComparison | null;
	confidence: ConfidenceResult;
}

export interface ImprovementRunRecord {
	runId: string | number;
	objective?: string;
	hypothesis?: string;
	metricName: string;
	metricUnit?: string;
	direction: MetricDirection;
	metric: number | null;
	secondaryMetrics?: Record<string, number>;
	checksPass: boolean | null;
	decision: ImprovementDecision;
	reason: ImprovementDecisionReason;
	confidence?: number | null;
	changedFiles?: string[];
	evidenceRef?: string;
	nextHint?: string;
	timestamp: number;
}

export interface GitStatusEntry {
	index: string;
	workingTree: string;
	path: string;
	origPath?: string;
}

export interface OwnedDiscardPlanInput {
	beforeStatus: string | GitStatusEntry[];
	afterStatus: string | GitStatusEntry[];
	ownedPaths: string[];
	preservePaths?: string[];
}

export interface OwnedDiscardPlan {
	revertPaths: string[];
	preservePaths: string[];
	protectedUserDirtyPaths: string[];
	unownedChangedPaths: string[];
	canDiscardOwnedChanges: boolean;
}

export interface ImprovementLoopConfig {
	loopId: string;
	objective: string;
	metricName: string;
	metricUnit?: string;
	direction: MetricDirection;
	minDelta: number;
	minRelativeDelta: number;
	confidenceMode: ConfidenceMode;
	minConfidence: number;
	lowConfidenceAction: LowConfidenceAction;
	createdAt: number;
	cwd: string;
}

export interface ImprovementSandboxRecord {
	sandboxId: string;
	status: "active" | "cleaned";
	repoPath: string;
	worktreePath: string;
	baseRef: string;
	createdAt: number;
	cleanedAt?: number;
	exportedAt?: number;
	patchPath?: string;
	patchBytes?: number;
	reason?: string;
}

export interface ImprovementLoopState {
	config: ImprovementLoopConfig;
	runs: ImprovementRunRecord[];
	sandboxes: ImprovementSandboxRecord[];
	activeSandbox: ImprovementSandboxRecord | null;
	baselineMetric: number | null;
	bestMetric: number | null;
	bestRunId: string | number | null;
	lastDecision: ImprovementDecisionResult | null;
	logPath: string;
}

export interface ImprovementLoopPaths {
	rootDir: string;
	workspaceDir: string;
	logPath: string;
	sandboxDir: string;
	artifactDir: string;
	workspaceKey: string;
	loopId: string;
}

export interface ImprovementLoopInitInput {
	cwd: string;
	objective: string;
	metricName: string;
	metricUnit?: string;
	direction?: MetricDirection;
	loopId?: string;
	minDelta?: number;
	minRelativeDelta?: number;
	confidenceMode?: ConfidenceMode;
	minConfidence?: number;
	lowConfidenceAction?: LowConfidenceAction;
	agentDir?: string;
	reset?: boolean;
}

export interface ImprovementLoopRecordInput {
	cwd: string;
	loopId?: string;
	runId?: string | number;
	metric: number | null | undefined;
	secondaryMetrics?: Record<string, number>;
	checksPass?: boolean | null;
	hypothesis?: string;
	changedFiles?: string[];
	evidenceRef?: string;
	nextHint?: string;
	agentDir?: string;
}

export interface ImprovementLoopStatusInput {
	cwd: string;
	loopId?: string;
	agentDir?: string;
}

export interface ImprovementSandboxCreateInput extends ImprovementLoopStatusInput {
	exec: ImprovementLoopExec;
	baseRef?: string;
	allowDirtyRepo?: boolean;
	sandboxId?: string;
	signal?: AbortSignal;
}

export interface ImprovementSandboxCleanupInput extends ImprovementLoopStatusInput {
	exec: ImprovementLoopExec;
	sandboxId?: string;
	reason?: string;
	signal?: AbortSignal;
}

export interface ImprovementSandboxExportInput extends ImprovementLoopStatusInput {
	exec: ImprovementLoopExec;
	sandboxId?: string;
	allowEmptyPatch?: boolean;
	signal?: AbortSignal;
}

type ImprovementLoopLogEntry =
	| ({ type: "config" } & ImprovementLoopConfig)
	| ({ type: "run" } & ImprovementRunRecord)
	| ({ type: "sandbox" } & ImprovementSandboxRecord);

export type ImprovementLoopToolAction =
	| "init"
	| "status"
	| "record"
	| "measure"
	| "sandbox_create"
	| "sandbox_export"
	| "sandbox_cleanup";

export interface ImprovementMeasurementCommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
}

export interface ImprovementMeasurementResult {
	command: string;
	exitCode: number;
	timedOut: boolean;
	durationMs: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	parsedMetrics: Record<string, number>;
	primaryMetric: number | null;
	checksCommand?: string;
	checksExitCode?: number;
	checksTimedOut?: boolean;
	checksPass: boolean;
	checksStdout?: string;
	checksStderr?: string;
}

export type ImprovementLoopExec = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number; signal?: AbortSignal; maxBuffer?: number },
) => Promise<ImprovementMeasurementCommandResult>;

export interface ImprovementLoopToolDetails {
	action: ImprovementLoopToolAction;
	state: ImprovementLoopState | null;
	decision?: ImprovementDecisionResult;
	measurement?: ImprovementMeasurementResult;
	sandbox?: ImprovementSandboxRecord;
	logPath: string;
}

const METRIC_LINE_PREFIX = "METRIC";
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const METRIC_NAME_RE = /^[\w.µ]+$/u;
const DECIMAL_NUMBER_RE = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

function normalizeFiniteNumber(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return value;
}

function normalizeNonNegative(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	return value;
}

function normalizeDirection(direction: MetricDirection | undefined): MetricDirection {
	return direction === "higher" ? "higher" : "lower";
}

export function parseMetricLines(output: string): Map<string, number> {
	const metrics = new Map<string, number>();
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith(`${METRIC_LINE_PREFIX} `)) continue;
		const body = trimmed.slice(METRIC_LINE_PREFIX.length).trim();
		const equals = body.indexOf("=");
		if (equals <= 0) continue;
		const name = body.slice(0, equals);
		const rawValue = body.slice(equals + 1).trim();
		if (!METRIC_NAME_RE.test(name) || DENIED_METRIC_NAMES.has(name)) continue;
		if (!DECIMAL_NUMBER_RE.test(rawValue)) continue;
		const value = Number(rawValue);
		if (Number.isFinite(value)) metrics.set(name, value);
	}
	return metrics;
}

export function metricMapFromOutput(output: string): Record<string, number> {
	return Object.fromEntries(parseMetricLines(output));
}

export function selectPrimaryMetric(
	metrics: Map<string, number> | Record<string, number>,
	metricName: string,
): number | null {
	const value = metrics instanceof Map ? metrics.get(metricName) : metrics[metricName];
	return normalizeFiniteNumber(value);
}

export function compareMetric(
	current: number,
	best: number | null | undefined,
	direction: MetricDirection = "lower",
): MetricComparison {
	const normalizedBest = normalizeFiniteNumber(best) ?? null;
	if (normalizedBest === null) {
		return {
			current,
			best: null,
			direction,
			delta: Number.POSITIVE_INFINITY,
			relativeDelta: null,
			improved: true,
		};
	}

	const delta = direction === "lower" ? normalizedBest - current : current - normalizedBest;
	const relativeDelta = normalizedBest === 0 ? null : delta / Math.abs(normalizedBest);
	return {
		current,
		best: normalizedBest,
		direction,
		delta,
		relativeDelta,
		improved: delta > 0,
	};
}

export function median(values: number[]): number | null {
	const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (finite.length === 0) return null;
	const mid = Math.floor(finite.length / 2);
	return finite.length % 2 === 0 ? (finite[mid - 1] + finite[mid]) / 2 : finite[mid];
}

export function medianAbsoluteDeviation(values: number[]): number | null {
	const m = median(values);
	if (m === null) return null;
	return median(values.filter(Number.isFinite).map((value) => Math.abs(value - m)));
}

export function computeMadConfidence(improvementDelta: number, samples: number[]): ConfidenceResult {
	const finite = samples.filter(Number.isFinite);
	if (finite.length < 3) {
		return { mode: "mad", value: null, noiseFloor: null, sampleCount: finite.length };
	}
	const mad = medianAbsoluteDeviation(finite);
	if (mad === null || mad === 0) {
		return { mode: "mad", value: null, noiseFloor: mad, sampleCount: finite.length };
	}
	return {
		mode: "mad",
		value: Math.abs(improvementDelta) / mad,
		noiseFloor: mad,
		sampleCount: finite.length,
	};
}

export function decideImprovement(input: ImprovementDecisionInput): ImprovementDecisionResult {
	const direction = normalizeDirection(input.direction);
	const minDelta = normalizeNonNegative(input.minDelta, 0);
	const minRelativeDelta = normalizeNonNegative(input.minRelativeDelta, 0);
	const minConfidence = normalizeNonNegative(input.minConfidence, 0);
	const confidenceMode = input.confidenceMode ?? (minConfidence > 0 ? "mad" : "none");
	const lowConfidenceAction = input.lowConfidenceAction ?? "retry";

	const emptyConfidence: ConfidenceResult = { mode: confidenceMode, value: null, noiseFloor: null, sampleCount: 0 };

	if (input.checksPass === false) {
		return { decision: "discard", reason: "checks_failed", comparison: null, confidence: emptyConfidence };
	}

	const current = normalizeFiniteNumber(input.currentMetric);
	if (current === null) {
		return {
			decision: "blocked",
			reason: input.currentMetric == null ? "metric_missing" : "metric_invalid",
			comparison: null,
			confidence: emptyConfidence,
		};
	}

	const best = normalizeFiniteNumber(input.bestMetric) ?? null;
	const comparison = compareMetric(current, best, direction);
	if (best === null) {
		return { decision: "keep", reason: "baseline", comparison, confidence: emptyConfidence };
	}
	if (!comparison.improved) {
		return { decision: "discard", reason: "not_better_than_best", comparison, confidence: emptyConfidence };
	}
	if (comparison.delta < minDelta) {
		return { decision: "discard", reason: "below_min_delta", comparison, confidence: emptyConfidence };
	}
	if (comparison.relativeDelta !== null && comparison.relativeDelta < minRelativeDelta) {
		return { decision: "discard", reason: "below_min_relative_delta", comparison, confidence: emptyConfidence };
	}

	if (confidenceMode === "mad" && minConfidence > 0) {
		const samples = [...(input.noiseMetrics ?? []), current];
		const confidence = computeMadConfidence(comparison.delta, samples);
		if (confidence.value === null) {
			return {
				decision: lowConfidenceAction,
				reason: "insufficient_noise_evidence",
				comparison,
				confidence,
			};
		}
		if (confidence.value < minConfidence) {
			return {
				decision: lowConfidenceAction,
				reason: "below_confidence",
				comparison,
				confidence,
			};
		}
		return { decision: "keep", reason: "metric_improved", comparison, confidence };
	}

	return { decision: "keep", reason: "metric_improved", comparison, confidence: emptyConfidence };
}

export function serializeRunRecord(record: ImprovementRunRecord): string {
	return JSON.stringify(record);
}

export async function appendRunRecord(filePath: string, record: ImprovementRunRecord): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, `${serializeRunRecord(record)}\n`, { flag: "a" });
}

export async function readRunRecords(filePath: string): Promise<ImprovementRunRecord[]> {
	let text = "";
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: ImprovementRunRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const parsed = JSON.parse(line) as ImprovementRunRecord;
		records.push(parsed);
	}
	return records;
}

function normalizeLoopId(loopId: string | undefined): string {
	const normalized = (loopId ?? "default")
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "default";
}

function workspaceKeyFor(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function improvementLoopPaths(input: ImprovementLoopStatusInput): ImprovementLoopPaths {
	const rootDir = join(input.agentDir ?? getAgentDir(), "improvement-loop");
	const workspaceKey = workspaceKeyFor(input.cwd);
	const loopId = normalizeLoopId(input.loopId);
	const workspaceDir = join(rootDir, "workspaces", workspaceKey);
	return {
		rootDir,
		workspaceDir,
		logPath: join(workspaceDir, `${loopId}.jsonl`),
		sandboxDir: join(workspaceDir, "sandboxes", loopId),
		artifactDir: join(workspaceDir, "artifacts", loopId),
		workspaceKey,
		loopId,
	};
}

function finiteRunMetric(run: ImprovementRunRecord): number | null {
	return normalizeFiniteNumber(run.metric);
}

function betterRun(
	current: ImprovementRunRecord,
	best: ImprovementRunRecord | null,
	direction: MetricDirection,
): ImprovementRunRecord {
	if (!best) return current;
	const currentMetric = finiteRunMetric(current);
	const bestMetric = finiteRunMetric(best);
	if (currentMetric === null || bestMetric === null) return best;
	return compareMetric(currentMetric, bestMetric, direction).improved ? current : best;
}

function configFromInit(input: ImprovementLoopInitInput, loopId: string): ImprovementLoopConfig {
	return {
		loopId,
		objective: input.objective,
		metricName: input.metricName,
		metricUnit: input.metricUnit ?? "",
		direction: normalizeDirection(input.direction),
		minDelta: normalizeNonNegative(input.minDelta, 0),
		minRelativeDelta: normalizeNonNegative(input.minRelativeDelta, 0),
		confidenceMode: input.confidenceMode ?? (normalizeNonNegative(input.minConfidence, 0) > 0 ? "mad" : "none"),
		minConfidence: normalizeNonNegative(input.minConfidence, 0),
		lowConfidenceAction: input.lowConfidenceAction ?? "retry",
		createdAt: Date.now(),
		cwd: input.cwd,
	};
}

async function readLoopLogEntries(logPath: string): Promise<ImprovementLoopLogEntry[]> {
	let text = "";
	try {
		text = await readFile(logPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ImprovementLoopLogEntry);
}

function reconstructImprovementLoopState(
	entries: ImprovementLoopLogEntry[],
	logPath: string,
): ImprovementLoopState | null {
	let config: ImprovementLoopConfig | null = null;
	let runs: ImprovementRunRecord[] = [];
	const sandboxById = new Map<string, ImprovementSandboxRecord>();
	for (const entry of entries) {
		if (entry.type === "config") {
			const { type: _type, ...rest } = entry;
			config = rest;
			runs = [];
			sandboxById.clear();
			continue;
		}
		if (entry.type === "run") {
			const { type: _type, ...run } = entry;
			runs.push(run);
			continue;
		}
		if (entry.type === "sandbox") {
			const { type: _type, ...sandbox } = entry;
			sandboxById.set(sandbox.sandboxId, sandbox);
		}
	}
	if (!config) return null;

	const baselineMetric = finiteRunMetric(runs[0] ?? ({} as ImprovementRunRecord));
	let bestRun: ImprovementRunRecord | null = null;
	for (const run of runs) {
		if (run.decision !== "keep" || finiteRunMetric(run) === null) continue;
		bestRun = betterRun(run, bestRun, config.direction);
	}

	const sandboxes = [...sandboxById.values()].sort((a, b) => a.createdAt - b.createdAt);
	const activeSandbox = [...sandboxes].reverse().find((sandbox) => sandbox.status === "active") ?? null;
	return {
		config,
		runs,
		sandboxes,
		activeSandbox,
		baselineMetric,
		bestMetric: bestRun ? finiteRunMetric(bestRun) : null,
		bestRunId: bestRun?.runId ?? null,
		lastDecision: null,
		logPath,
	};
}

export async function initImprovementLoop(input: ImprovementLoopInitInput): Promise<ImprovementLoopState> {
	const paths = improvementLoopPaths(input);
	const existing = await readLoopLogEntries(paths.logPath);
	if (existing.length > 0 && !input.reset) {
		throw new Error(
			`Improvement loop already exists at ${paths.logPath}; pass reset=true to replace user-level loop state.`,
		);
	}
	const config = configFromInit(input, paths.loopId);
	await mkdir(dirname(paths.logPath), { recursive: true });
	await writeFile(paths.logPath, `${JSON.stringify({ type: "config", ...config })}\n`);
	const state = reconstructImprovementLoopState([{ type: "config", ...config }], paths.logPath);
	if (!state) throw new Error("Failed to initialize improvement loop state");
	return state;
}

export async function readImprovementLoopState(
	input: ImprovementLoopStatusInput,
): Promise<ImprovementLoopState | null> {
	const paths = improvementLoopPaths(input);
	return reconstructImprovementLoopState(await readLoopLogEntries(paths.logPath), paths.logPath);
}

function createSandboxId(input: ImprovementSandboxCreateInput): string {
	if (input.sandboxId) return normalizeLoopId(input.sandboxId);
	const seed = `${input.cwd}:${input.loopId ?? "default"}:${Date.now()}:${Math.random()}`;
	return `${Date.now()}-${createHash("sha256").update(seed).digest("hex").slice(0, 8)}`;
}

async function appendSandboxRecord(
	input: ImprovementLoopStatusInput,
	sandbox: ImprovementSandboxRecord,
): Promise<ImprovementLoopState> {
	const paths = improvementLoopPaths(input);
	await mkdir(dirname(paths.logPath), { recursive: true });
	await writeFile(paths.logPath, `${JSON.stringify({ type: "sandbox", ...sandbox })}\n`, { flag: "a" });
	const updated = await readImprovementLoopState(input);
	if (!updated) throw new Error("Failed to read improvement loop after sandbox update");
	return updated;
}

async function runGit(
	exec: ImprovementLoopExec,
	cwd: string,
	args: string[],
	signal?: AbortSignal,
): Promise<ImprovementMeasurementCommandResult> {
	return exec("git", args, { cwd, timeout: 60_000, signal, maxBuffer: 64 * 1024 });
}

export async function createImprovementSandbox(input: ImprovementSandboxCreateInput): Promise<ImprovementLoopState> {
	const state = await readImprovementLoopState(input);
	if (!state) throw new Error("Improvement loop is not initialized; call init first.");
	if (state.activeSandbox) {
		throw new Error(
			`Active sandbox already exists at ${state.activeSandbox.worktreePath}; clean it before creating another.`,
		);
	}
	const status = await runGit(input.exec, input.cwd, ["status", "--porcelain"], input.signal);
	if (status.code !== 0) throw new Error(`Cannot inspect git status: ${(status.stderr || status.stdout).trim()}`);
	if (status.stdout.trim() && !input.allowDirtyRepo) {
		throw new Error(
			"Refusing to create sandbox from dirty repository; commit/stash changes or pass allowDirtyRepo=true.",
		);
	}
	const baseRef = input.baseRef?.trim() || "HEAD";
	const sandboxId = createSandboxId(input);
	const paths = improvementLoopPaths(input);
	const worktreePath = join(paths.sandboxDir, sandboxId);
	await mkdir(dirname(worktreePath), { recursive: true });
	const add = await runGit(
		input.exec,
		input.cwd,
		["worktree", "add", "--detach", worktreePath, baseRef],
		input.signal,
	);
	if (add.code !== 0) throw new Error(`Failed to create git worktree sandbox: ${(add.stderr || add.stdout).trim()}`);
	const sandbox: ImprovementSandboxRecord = {
		sandboxId,
		status: "active",
		repoPath: input.cwd,
		worktreePath,
		baseRef,
		createdAt: Date.now(),
	};
	return appendSandboxRecord(input, sandbox);
}

export async function exportImprovementSandboxPatch(
	input: ImprovementSandboxExportInput,
): Promise<ImprovementLoopState> {
	const state = await readImprovementLoopState(input);
	if (!state) throw new Error("Improvement loop is not initialized; call init first.");
	const sandbox = input.sandboxId
		? state.sandboxes.find((candidate) => candidate.sandboxId === normalizeLoopId(input.sandboxId))
		: state.activeSandbox;
	if (!sandbox || sandbox.status !== "active") throw new Error("No active sandbox found to export.");
	const diff = await runGit(input.exec, sandbox.worktreePath, ["diff", "--binary", "HEAD"], input.signal);
	if (diff.code !== 0) throw new Error(`Failed to export sandbox patch: ${(diff.stderr || diff.stdout).trim()}`);
	if (!diff.stdout.trim() && !input.allowEmptyPatch) throw new Error("Sandbox has no changes to export.");
	const paths = improvementLoopPaths(input);
	await mkdir(paths.artifactDir, { recursive: true });
	const patchPath = join(paths.artifactDir, `${sandbox.sandboxId}.patch`);
	await writeFile(patchPath, diff.stdout);
	return appendSandboxRecord(input, {
		...sandbox,
		exportedAt: Date.now(),
		patchPath,
		patchBytes: Buffer.byteLength(diff.stdout),
	});
}

export async function cleanupImprovementSandbox(input: ImprovementSandboxCleanupInput): Promise<ImprovementLoopState> {
	const state = await readImprovementLoopState(input);
	if (!state) throw new Error("Improvement loop is not initialized; call init first.");
	const sandbox = input.sandboxId
		? state.sandboxes.find((candidate) => candidate.sandboxId === normalizeLoopId(input.sandboxId))
		: state.activeSandbox;
	if (!sandbox || sandbox.status !== "active") throw new Error("No active sandbox found to clean up.");
	const remove = await runGit(
		input.exec,
		sandbox.repoPath,
		["worktree", "remove", "--force", sandbox.worktreePath],
		input.signal,
	);
	if (remove.code !== 0)
		throw new Error(`Failed to remove git worktree sandbox: ${(remove.stderr || remove.stdout).trim()}`);
	await runGit(input.exec, sandbox.repoPath, ["worktree", "prune"], input.signal);
	return appendSandboxRecord(input, {
		...sandbox,
		status: "cleaned",
		cleanedAt: Date.now(),
		reason: input.reason,
	});
}

export async function recordImprovementRun(input: ImprovementLoopRecordInput): Promise<ImprovementLoopState> {
	const state = await readImprovementLoopState(input);
	if (!state) throw new Error("Improvement loop is not initialized; call init first.");
	const runId = input.runId ?? state.runs.length + 1;
	const priorMetrics = state.runs
		.map((run) => run.metric)
		.filter((metric): metric is number => Number.isFinite(metric));
	const decision = decideImprovement({
		currentMetric: input.metric,
		bestMetric: state.bestMetric,
		direction: state.config.direction,
		checksPass: input.checksPass ?? null,
		minDelta: state.config.minDelta,
		minRelativeDelta: state.config.minRelativeDelta,
		confidenceMode: state.config.confidenceMode,
		minConfidence: state.config.minConfidence,
		lowConfidenceAction: state.config.lowConfidenceAction,
		noiseMetrics: priorMetrics,
	});
	const record: ImprovementRunRecord = {
		runId,
		objective: state.config.objective,
		hypothesis: input.hypothesis,
		metricName: state.config.metricName,
		metricUnit: state.config.metricUnit,
		direction: state.config.direction,
		metric: normalizeFiniteNumber(input.metric),
		secondaryMetrics: input.secondaryMetrics,
		checksPass: input.checksPass ?? null,
		decision: decision.decision,
		reason: decision.reason,
		confidence: decision.confidence.value,
		changedFiles: input.changedFiles,
		evidenceRef: input.evidenceRef,
		nextHint: input.nextHint,
		timestamp: Date.now(),
	};
	await mkdir(dirname(state.logPath), { recursive: true });
	await writeFile(state.logPath, `${JSON.stringify({ type: "run", ...record })}\n`, { flag: "a" });
	const updated = await readImprovementLoopState(input);
	if (!updated) throw new Error("Failed to read improvement loop after recording run");
	return { ...updated, lastDecision: decision };
}

function secondaryMetricsFrom(
	parsedMetrics: Record<string, number>,
	primaryName: string,
): Record<string, number> | undefined {
	const secondary = Object.fromEntries(Object.entries(parsedMetrics).filter(([name]) => name !== primaryName));
	return Object.keys(secondary).length > 0 ? secondary : undefined;
}

export async function runImprovementMeasurement(input: {
	exec: ImprovementLoopExec;
	cwd: string;
	command: string;
	metricName: string;
	checksCommand?: string;
	timeoutSeconds?: number;
	checksTimeoutSeconds?: number;
	maxOutputBytes?: number;
	signal?: AbortSignal;
}): Promise<ImprovementMeasurementResult> {
	const command = input.command.trim();
	if (!command) throw new Error("command is required");
	const timeoutMs = Math.max(1, Math.floor(input.timeoutSeconds ?? 600)) * 1000;
	const checksTimeoutMs = Math.max(1, Math.floor(input.checksTimeoutSeconds ?? 300)) * 1000;
	const maxBuffer = Math.max(1024, Math.floor(input.maxOutputBytes ?? 64 * 1024));
	const started = Date.now();
	const result = await input.exec("bash", ["-c", command], {
		cwd: input.cwd,
		timeout: timeoutMs,
		signal: input.signal,
		maxBuffer,
	});
	const durationMs = Date.now() - started;
	const output = `${result.stdout}\n${result.stderr}`;
	const parsedMetrics = metricMapFromOutput(output);
	const primaryMetric = selectPrimaryMetric(parsedMetrics, input.metricName);
	let checksPass = result.code === 0 && !result.killed;
	let checksExitCode: number | undefined;
	let checksTimedOut: boolean | undefined;
	let checksStdout: string | undefined;
	let checksStderr: string | undefined;
	const checksCommand = input.checksCommand?.trim();
	if (checksPass && checksCommand) {
		const checks = await input.exec("bash", ["-c", checksCommand], {
			cwd: input.cwd,
			timeout: checksTimeoutMs,
			signal: input.signal,
			maxBuffer,
		});
		checksExitCode = checks.code;
		checksTimedOut = checks.killed;
		checksStdout = checks.stdout;
		checksStderr = checks.stderr;
		checksPass = checks.code === 0 && !checks.killed;
	}

	return {
		command,
		exitCode: result.code,
		timedOut: result.killed,
		durationMs,
		stdout: result.stdout,
		stderr: result.stderr,
		stdoutTruncated: !!result.stdoutTruncated,
		stderrTruncated: !!result.stderrTruncated,
		parsedMetrics,
		primaryMetric,
		checksCommand: checksCommand || undefined,
		checksExitCode,
		checksTimedOut,
		checksPass,
		checksStdout,
		checksStderr,
	};
}

export function parseGitPorcelainStatus(status: string): GitStatusEntry[] {
	return status
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => {
			const index = line[0] ?? " ";
			const workingTree = line[1] ?? " ";
			const rawPath = line.slice(3);
			const renameParts = rawPath.split(" -> ");
			if (renameParts.length === 2) {
				return { index, workingTree, origPath: renameParts[0], path: renameParts[1] };
			}
			return { index, workingTree, path: rawPath };
		});
}

function entriesFromStatus(status: string | GitStatusEntry[]): GitStatusEntry[] {
	return Array.isArray(status) ? status : parseGitPorcelainStatus(status);
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathSet(paths: string[]): Set<string> {
	return new Set(paths.map(normalizePath).filter(Boolean));
}

function entryPaths(entry: GitStatusEntry): string[] {
	return [entry.path, entry.origPath].filter((value): value is string => typeof value === "string").map(normalizePath);
}

function statusPathSet(entries: GitStatusEntry[]): Set<string> {
	const paths = new Set<string>();
	for (const entry of entries) {
		for (const path of entryPaths(entry)) paths.add(path);
	}
	return paths;
}

function isPreserved(path: string, preservePaths: Set<string>): boolean {
	for (const preserve of preservePaths) {
		if (path === preserve || path.startsWith(`${preserve}/`)) return true;
	}
	return false;
}

export function planOwnedDiscard(input: OwnedDiscardPlanInput): OwnedDiscardPlan {
	const beforePaths = statusPathSet(entriesFromStatus(input.beforeStatus));
	const afterPaths = statusPathSet(entriesFromStatus(input.afterStatus));
	const ownedPaths = pathSet(input.ownedPaths);
	const preservePaths = pathSet(input.preservePaths ?? []);
	const revertPaths: string[] = [];
	const protectedUserDirtyPaths: string[] = [];
	const unownedChangedPaths: string[] = [];
	const preservedChangedPaths: string[] = [];

	for (const path of afterPaths) {
		if (isPreserved(path, preservePaths)) {
			preservedChangedPaths.push(path);
			continue;
		}
		if (!ownedPaths.has(path)) {
			unownedChangedPaths.push(path);
			continue;
		}
		if (beforePaths.has(path)) {
			protectedUserDirtyPaths.push(path);
			continue;
		}
		revertPaths.push(path);
	}

	return {
		revertPaths: [...new Set(revertPaths)].sort(),
		preservePaths: [...new Set(preservedChangedPaths)].sort(),
		protectedUserDirtyPaths: [...new Set(protectedUserDirtyPaths)].sort(),
		unownedChangedPaths: [...new Set(unownedChangedPaths)].sort(),
		canDiscardOwnedChanges: protectedUserDirtyPaths.length === 0,
	};
}

const DecisionToolParams = Type.Object(
	{
		currentMetric: Type.Number({ description: "Measured primary metric for the candidate run." }),
		bestMetric: Type.Optional(Type.Number({ description: "Best kept primary metric so far. Omit for baseline." })),
		direction: StringEnum(["lower", "higher"] as const, {
			description: "Whether lower or higher metric values are better. Default lower.",
		}),
		checksPass: Type.Optional(
			Type.Boolean({ description: "Whether correctness checks passed. false forces discard." }),
		),
		minDelta: Type.Optional(
			Type.Number({ description: "Minimum absolute improvement required to keep. Default 0." }),
		),
		minRelativeDelta: Type.Optional(
			Type.Number({ description: "Minimum relative improvement required to keep, e.g. 0.01 for 1%. Default 0." }),
		),
		confidenceMode: Type.Optional(
			StringEnum(["none", "mad"] as const, {
				description: "Noise/confidence policy. Use mad with minConfidence to reject noisy wins.",
			}),
		),
		minConfidence: Type.Optional(
			Type.Number({ description: "Minimum confidence multiple over MAD noise floor. Default 0." }),
		),
		lowConfidenceAction: Type.Optional(
			StringEnum(["retry", "discard"] as const, {
				description: "Decision when confidence evidence is missing or too low. Default retry.",
			}),
		),
		noiseMetrics: Type.Optional(
			Type.Array(Type.Number(), { description: "Previous metric samples for MAD confidence calculation." }),
		),
	},
	{ additionalProperties: false },
);

export function createImprovementDecisionTool(): ToolDefinition<typeof DecisionToolParams, ImprovementDecisionResult> {
	return defineTool({
		name: "improvement_decision",
		label: "Improvement Decision",
		description:
			"Deterministically decide keep/discard/retry/blocked for an improvement candidate from metric, direction, thresholds, checks, and optional noise samples. The model proposes; code judges.",
		promptSnippet: "Decide keep/discard for a measured improvement candidate using deterministic metric gates",
		promptGuidelines: [
			"Use improvement_decision after measuring a candidate when keep/discard must be based on metric evidence rather than model intuition.",
			"Do not claim a candidate is kept unless this tool returns decision=keep or a stronger project-specific validator passes.",
			"Correctness failures override metric wins; checksPass=false always discards.",
		],
		parameters: DecisionToolParams,
		async execute(_toolCallId, params) {
			const decision = decideImprovement(params);
			const comparison = decision.comparison;
			const confidenceText = decision.confidence.value === null ? "n/a" : decision.confidence.value.toFixed(2);
			const deltaText = comparison ? comparison.delta.toString() : "n/a";
			return {
				content: [
					{
						type: "text",
						text: `Decision: ${decision.decision} (${decision.reason})\nDelta: ${deltaText}\nConfidence: ${confidenceText}`,
					},
				],
				details: decision,
			};
		},
	});
}

const LoopToolParams = Type.Object(
	{
		action: StringEnum(
			["init", "status", "record", "measure", "sandbox_create", "sandbox_export", "sandbox_cleanup"] as const,
			{
				description:
					"init creates user-level loop state, status reads it, record appends a supplied measurement, measure runs and records a bounded command, sandbox_create/export/cleanup manage disposable git worktrees and keep patches.",
			},
		),
		loopId: Type.Optional(Type.String({ description: "Loop id within the current workspace. Default: default." })),
		objective: Type.Optional(Type.String({ description: "Loop objective. Required for action=init." })),
		metricName: Type.Optional(Type.String({ description: "Primary metric name. Required for action=init." })),
		metricUnit: Type.Optional(Type.String({ description: "Display unit for the primary metric." })),
		direction: Type.Optional(
			StringEnum(["lower", "higher"] as const, {
				description: "Whether lower or higher metric values are better. Default lower.",
			}),
		),
		reset: Type.Optional(
			Type.Boolean({
				description: "For action=init, replace existing user-level loop state for this workspace/loop id.",
			}),
		),
		minDelta: Type.Optional(
			Type.Number({ description: "Minimum absolute improvement required to keep. Default 0." }),
		),
		minRelativeDelta: Type.Optional(
			Type.Number({ description: "Minimum relative improvement required to keep. Default 0." }),
		),
		confidenceMode: Type.Optional(
			StringEnum(["none", "mad"] as const, {
				description: "Noise/confidence policy. Default none unless minConfidence > 0.",
			}),
		),
		minConfidence: Type.Optional(
			Type.Number({ description: "Minimum confidence multiple over MAD noise floor. Default 0." }),
		),
		lowConfidenceAction: Type.Optional(
			StringEnum(["retry", "discard"] as const, {
				description: "Decision when confidence evidence is missing or low. Default retry.",
			}),
		),
		currentMetric: Type.Optional(Type.Number({ description: "Measured primary metric for action=record." })),
		checksPass: Type.Optional(
			Type.Boolean({ description: "Correctness check result for action=record. false forces discard." }),
		),
		hypothesis: Type.Optional(Type.String({ description: "What this run tried." })),
		secondaryMetrics: Type.Optional(
			Type.Object(
				{},
				{ additionalProperties: Type.Number(), description: "Secondary metric map for action=record." },
			),
		),
		changedFiles: Type.Optional(Type.Array(Type.String(), { description: "Files changed by this candidate run." })),
		evidenceRef: Type.Optional(
			Type.String({ description: "Path, command, or artifact reference proving the measurement/check result." }),
		),
		nextHint: Type.Optional(
			Type.String({ description: "Useful next-step hint for later runs, especially after discard/retry/blocked." }),
		),
		command: Type.Optional(
			Type.String({
				description:
					"Measurement command for action=measure. Runs via bash -c in ctx.cwd or active sandbox when useSandbox=true.",
			}),
		),
		checksCommand: Type.Optional(
			Type.String({
				description:
					"Optional correctness command for action=measure. Runs only if the measurement command exits 0.",
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Number({ description: "Measurement command timeout in seconds. Default 600." }),
		),
		checksTimeoutSeconds: Type.Optional(
			Type.Number({ description: "Checks command timeout in seconds. Default 300." }),
		),
		maxOutputBytes: Type.Optional(
			Type.Number({ description: "Maximum stdout/stderr tail retained per command. Default 65536." }),
		),
		useSandbox: Type.Optional(
			Type.Boolean({
				description: "For action=measure, run command/checks inside the active sandbox worktree. Default false.",
			}),
		),
		sandboxId: Type.Optional(
			Type.String({
				description:
					"Sandbox id for sandbox_create/sandbox_export/sandbox_cleanup. Defaults to generated id or active sandbox.",
			}),
		),
		baseRef: Type.Optional(Type.String({ description: "Git base ref for sandbox_create. Default HEAD." })),
		allowDirtyRepo: Type.Optional(
			Type.Boolean({
				description: "Allow sandbox_create when the real repo has uncommitted changes. Default false.",
			}),
		),
		cleanupReason: Type.Optional(
			Type.String({ description: "Optional reason recorded when sandbox_cleanup removes a sandbox." }),
		),
		allowEmptyPatch: Type.Optional(
			Type.Boolean({ description: "For sandbox_export, allow writing an empty patch. Default false." }),
		),
	},
	{ additionalProperties: false },
);

function requireString(value: string | undefined, label: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`${label} is required`);
	return trimmed;
}

function summarizeLoopState(state: ImprovementLoopState | null): string {
	if (!state) return "Improvement loop is not initialized.";
	const lines = [
		`Loop ${state.config.loopId}: ${state.config.objective}`,
		`Metric: ${state.config.metricName} (${state.config.metricUnit || "unitless"}, ${state.config.direction} is better)`,
		`Runs: ${state.runs.length}`,
		`Baseline: ${state.baselineMetric ?? "none"}`,
		`Best: ${state.bestMetric ?? "none"}${state.bestRunId === null ? "" : ` (#${state.bestRunId})`}`,
		`Log: ${state.logPath}`,
	];
	const lastRun = state.runs.at(-1);
	if (lastRun) lines.push(`Last: ${lastRun.decision} (${lastRun.reason}) metric=${lastRun.metric ?? "missing"}`);
	if (state.activeSandbox) lines.push(`Active sandbox: ${state.activeSandbox.worktreePath}`);
	return lines.join("\n");
}

export function createImprovementLoopTool(
	exec?: ImprovementLoopExec,
): ToolDefinition<typeof LoopToolParams, ImprovementLoopToolDetails> {
	return defineTool({
		name: "improvement_loop",
		label: "Improvement Loop",
		description:
			"Persist and evaluate a deterministic improvement loop in user-level state: init objective/metric policy, measure bounded commands, record measured runs, manage disposable git worktree sandboxes, and status current baseline/best/decision log. Does not commit/apply/revert real-repo files.",
		promptSnippet: "Track deterministic improvement-loop state and record measured keep/discard decisions",
		promptGuidelines: [
			"Use improvement_loop init before iterative optimization that needs metric-based keep/discard state.",
			"Use improvement_loop measure to run a bounded measurement command and optional checks command, then record the deterministic decision.",
			"Use improvement_loop sandbox_create before risky self-modifying experiments so edits happen in a disposable git worktree, not the real repository.",
			"Use improvement_loop sandbox_export to capture the sandbox diff as a user-level patch artifact before cleanup when the decision is keep.",
			"Use improvement_loop sandbox_cleanup after discard or after exporting/approving a patch; cleanup removes the disposable worktree record, not the real repository.",
			"Use improvement_loop record when measurement already happened elsewhere; code decides keep/discard/retry/blocked from metrics and gates.",
			"This tool does not commit/apply/revert real-repo files; keep/discard is a decision record until a later approved executor applies it.",
			"Operational state is stored under the user-level agent directory, not in the target repository.",
		],
		parameters: LoopToolParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			if (params.action === "init") {
				const state = await initImprovementLoop({
					cwd,
					loopId: params.loopId,
					objective: requireString(params.objective, "objective"),
					metricName: requireString(params.metricName, "metricName"),
					metricUnit: params.metricUnit,
					direction: params.direction,
					minDelta: params.minDelta,
					minRelativeDelta: params.minRelativeDelta,
					confidenceMode: params.confidenceMode,
					minConfidence: params.minConfidence,
					lowConfidenceAction: params.lowConfidenceAction,
					reset: params.reset,
				});
				return {
					content: [{ type: "text", text: `Initialized improvement loop.\n${summarizeLoopState(state)}` }],
					details: { action: "init", state, logPath: state.logPath },
				};
			}

			if (params.action === "record") {
				const state = await recordImprovementRun({
					cwd,
					loopId: params.loopId,
					metric: params.currentMetric,
					secondaryMetrics: params.secondaryMetrics as Record<string, number> | undefined,
					checksPass: params.checksPass ?? null,
					hypothesis: params.hypothesis,
					changedFiles: params.changedFiles,
					evidenceRef: params.evidenceRef,
					nextHint: params.nextHint,
				});
				const decision = state.lastDecision;
				return {
					content: [
						{
							type: "text",
							text: `Recorded run: ${decision?.decision ?? "unknown"} (${decision?.reason ?? "unknown"}).\n${summarizeLoopState(state)}`,
						},
					],
					details: { action: "record", state, decision: decision ?? undefined, logPath: state.logPath },
				};
			}

			if (params.action === "measure") {
				if (!exec) throw new Error("improvement_loop measure requires createImprovementLoopTool(pi.exec)");
				const before = await readImprovementLoopState({ cwd, loopId: params.loopId });
				if (!before) throw new Error("Improvement loop is not initialized; call init first.");
				const measurementCwd = params.useSandbox
					? (before.activeSandbox?.worktreePath ??
						(() => {
							throw new Error("useSandbox=true requires an active sandbox.");
						})())
					: cwd;
				const measurement = await runImprovementMeasurement({
					exec,
					cwd: measurementCwd,
					command: requireString(params.command, "command"),
					metricName: before.config.metricName,
					checksCommand: params.checksCommand,
					timeoutSeconds: params.timeoutSeconds,
					checksTimeoutSeconds: params.checksTimeoutSeconds,
					maxOutputBytes: params.maxOutputBytes,
					signal,
				});
				const state = await recordImprovementRun({
					cwd,
					loopId: params.loopId,
					metric: measurement.primaryMetric,
					secondaryMetrics: secondaryMetricsFrom(measurement.parsedMetrics, before.config.metricName),
					checksPass: measurement.checksPass,
					hypothesis: params.hypothesis,
					changedFiles: params.changedFiles,
					evidenceRef: params.evidenceRef ?? `command:${measurement.command};cwd:${measurementCwd}`,
					nextHint: params.nextHint,
				});
				const decision = state.lastDecision;
				return {
					content: [
						{
							type: "text",
							text: `Measured ${before.config.metricName}=${measurement.primaryMetric ?? "missing"}; decision: ${decision?.decision ?? "unknown"} (${decision?.reason ?? "unknown"}).\n${summarizeLoopState(state)}`,
						},
					],
					details: {
						action: "measure",
						state,
						decision: decision ?? undefined,
						measurement,
						logPath: state.logPath,
					},
				};
			}

			if (params.action === "sandbox_create") {
				if (!exec) throw new Error("improvement_loop sandbox_create requires createImprovementLoopTool(pi.exec)");
				const state = await createImprovementSandbox({
					cwd,
					loopId: params.loopId,
					exec,
					baseRef: params.baseRef,
					allowDirtyRepo: params.allowDirtyRepo,
					sandboxId: params.sandboxId,
					signal,
				});
				const sandbox = state.activeSandbox ?? undefined;
				return {
					content: [
						{
							type: "text",
							text: `Created sandbox: ${sandbox?.worktreePath ?? "unknown"}\n${summarizeLoopState(state)}`,
						},
					],
					details: { action: "sandbox_create", state, sandbox, logPath: state.logPath },
				};
			}

			if (params.action === "sandbox_export") {
				if (!exec) throw new Error("improvement_loop sandbox_export requires createImprovementLoopTool(pi.exec)");
				const state = await exportImprovementSandboxPatch({
					cwd,
					loopId: params.loopId,
					exec,
					sandboxId: params.sandboxId,
					allowEmptyPatch: params.allowEmptyPatch,
					signal,
				});
				const sandbox = params.sandboxId
					? state.sandboxes.find((candidate) => candidate.sandboxId === normalizeLoopId(params.sandboxId))
					: (state.activeSandbox ?? state.sandboxes.at(-1));
				return {
					content: [
						{
							type: "text",
							text: `Exported sandbox patch: ${sandbox?.patchPath ?? "unknown"}\n${summarizeLoopState(state)}`,
						},
					],
					details: { action: "sandbox_export", state, sandbox, logPath: state.logPath },
				};
			}

			if (params.action === "sandbox_cleanup") {
				if (!exec) throw new Error("improvement_loop sandbox_cleanup requires createImprovementLoopTool(pi.exec)");
				const state = await cleanupImprovementSandbox({
					cwd,
					loopId: params.loopId,
					exec,
					sandboxId: params.sandboxId,
					reason: params.cleanupReason,
					signal,
				});
				const sandbox = params.sandboxId
					? state.sandboxes.find((candidate) => candidate.sandboxId === normalizeLoopId(params.sandboxId))
					: state.sandboxes.at(-1);
				return {
					content: [{ type: "text", text: `Cleaned sandbox.\n${summarizeLoopState(state)}` }],
					details: { action: "sandbox_cleanup", state, sandbox, logPath: state.logPath },
				};
			}

			const state = await readImprovementLoopState({ cwd, loopId: params.loopId });
			const paths = improvementLoopPaths({ cwd, loopId: params.loopId });
			return {
				content: [{ type: "text", text: summarizeLoopState(state) }],
				details: { action: "status", state, logPath: state?.logPath ?? paths.logPath },
			};
		},
	});
}
