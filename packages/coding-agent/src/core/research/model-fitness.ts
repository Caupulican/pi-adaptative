import { runBoundedCompletion } from "../autonomy/bounded-completion.ts";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import { runWorker } from "../delegation/worker-runner.ts";
import { runRouteJudge } from "../model-router/route-judge.ts";
import { runResearch } from "./research-runner.ts";

/**
 * Model fitness probe: measures whether a candidate model can actually drive the harness's
 * subagent contracts — the research lane, the scout-worker lane, and the routing judge — by
 * running each real runner against the model and scoring parse/success rates plus judge
 * discrimination. Provider-free: the completion executor is injected, so this works against any
 * registered model (local Ollama models included) and against faux providers in tests.
 */

export interface FitnessCompletion {
	text: string;
	costUsd: number;
	stopReason: string;
	/** Output tokens generated (for tok/s). Optional: providers that don't report it are skipped. */
	outputTokens?: number;
	/** Pure generation time in ms (e.g. Ollama eval_duration). Falls back to wall-clock if absent. */
	evalMs?: number;
}

export type FitnessComplete = (args: {
	systemPrompt: string;
	userPrompt: string;
	signal?: AbortSignal;
}) => Promise<FitnessCompletion>;

export interface JudgeFitnessPrompt {
	prompt: string;
	/** True when the prompt is planning-shaped and must never route cheap. */
	planning: boolean;
}

/** Default judge probe set: three planning-shaped prompts, three trivial lookups. */
export const DEFAULT_JUDGE_FITNESS_PROMPTS: readonly JudgeFitnessPrompt[] = [
	{ prompt: "how should we plan the migration of the session storage layer?", planning: true },
	{ prompt: "design an approach for splitting the settings manager", planning: true },
	{ prompt: "draft a roadmap for the autonomy rework", planning: true },
	{ prompt: "what does the resolvePath function return?", planning: false },
	{ prompt: "list the files in the delegation module", planning: false },
	{ prompt: "why is this test flaky?", planning: false },
];

export interface ModelFitnessOptions {
	complete: FitnessComplete;
	/** Trials per lane surface. Default 3. */
	trials?: number;
	/** Wall-clock budget per call in ms. Default 120000. */
	maxWallClockMs?: number;
	judgePrompts?: readonly JudgeFitnessPrompt[];
	signal?: AbortSignal;
	/** Injected clock for latency measurement (test seam). Defaults to Date.now. */
	now?: () => number;
}

export interface LaneFitnessScore {
	succeeded: number;
	total: number;
	outcomes: string[];
	meanMs: number;
	/** Mean output tokens/second across the surface's calls; undefined when not reported. */
	tokensPerSecond?: number;
}

export interface JudgeFitnessScore {
	parsed: number;
	planningElevated: number;
	planningTotal: number;
	trivialCheap: number;
	trivialTotal: number;
	total: number;
	outcomes: string[];
	meanMs: number;
	/** Mean output tokens/second across the judge calls; undefined when not reported. */
	tokensPerSecond?: number;
}

export interface ModelFitnessReport {
	trials: number;
	/** Aggregate output tokens/second across ALL probe calls (the headline speed number). */
	tokensPerSecond?: number;
	research: LaneFitnessScore;
	worker: LaneFitnessScore;
	judge: JudgeFitnessScore;
	/** Heavy-lifter surface: can the model formulate a structured search plan? */
	search: LaneFitnessScore;
	/** Heavy-lifter surface: can the model emit a well-formed tool call against a schema? */
	toolCall: LaneFitnessScore;
	totalCostUsd: number;
}

/** Static prompts for the heavy-lifter surfaces (stable for provider prompt caching). */
export const SEARCH_PROBE_SYSTEM_PROMPT = [
	"You plan code searches for a coding agent. You never answer the question yourself.",
	"Given a question about a codebase, respond with STRICT JSON only - no prose:",
	'{"queries":[{"pattern":"<regex or literal to grep>","glob":"<file glob like **/*.ts>"}]}',
	"Return 1 to 4 queries, most specific first.",
].join("\n");

export const TOOL_CALL_PROBE_SYSTEM_PROMPT = [
	"You operate tools for a coding agent. You have exactly one tool:",
	"grep(pattern: string, path: string) - search files under a path for a pattern.",
	"Respond to every task with STRICT JSON only - no prose:",
	'{"tool":"grep","arguments":{"pattern":"<pattern>","path":"<path>"}}',
].join("\n");

const SEARCH_PROBE_TASKS: readonly string[] = [
	"Where is the retry/backoff logic for HTTP requests implemented?",
	"Which files define the settings for background research?",
	"Find where session entries of type custom are appended.",
];

const TOOL_CALL_PROBE_TASKS: readonly string[] = [
	"Find usages of the function resolveCliModel under src/.",
	"Search for the string 'budget_exhausted' in the core directory.",
	"Locate where LaneTracker is instantiated under src/core.",
];

function parseSearchPlan(text: string): boolean {
	const parsed = extractJsonObject(text);
	if (!parsed) return false;
	const queries = (parsed as { queries?: unknown }).queries;
	if (!Array.isArray(queries) || queries.length === 0 || queries.length > 8) return false;
	return queries.every(
		(query) =>
			query &&
			typeof query === "object" &&
			typeof (query as { pattern?: unknown }).pattern === "string" &&
			(query as { pattern: string }).pattern.trim().length > 0,
	);
}

function parseToolCall(text: string): boolean {
	const parsed = extractJsonObject(text);
	if (!parsed) return false;
	const record = parsed as { tool?: unknown; arguments?: unknown };
	if (record.tool !== "grep") return false;
	const args = record.arguments;
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	const pattern = (args as { pattern?: unknown }).pattern;
	const path = (args as { path?: unknown }).path;
	return (
		typeof pattern === "string" && pattern.trim().length > 0 && typeof path === "string" && path.trim().length > 0
	);
}

function extractJsonObject(text: string): unknown | undefined {
	const trimmed = text.trim();
	const candidates: string[] = [trimmed];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	if (fenced?.[1]) candidates.push(fenced[1].trim());
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

function fitnessEnvelope(): CapabilityEnvelope {
	return {
		id: "model-fitness-probe",
		capabilities: ["research", "read_files", "memory_read"],
		maxEstimatedUsd: 1,
		createdAt: new Date().toISOString(),
	};
}

export async function runModelFitnessProbe(options: ModelFitnessOptions): Promise<ModelFitnessReport> {
	const trials = Math.max(1, Math.min(options.trials ?? 3, 20));
	const maxWallClockMs = options.maxWallClockMs ?? 120_000;
	const judgePrompts = options.judgePrompts ?? DEFAULT_JUDGE_FITNESS_PROMPTS;
	const now = options.now ?? Date.now;
	let totalCostUsd = 0;

	// Token-speed instrumentation: the lane runners' own contracts carry text/cost only, so the
	// completer is wrapped once here and generation stats are accumulated per surface.
	const overallSpeed = { tokens: 0, evalMs: 0 };
	let surfaceSpeed = { tokens: 0, evalMs: 0 };
	const complete: FitnessComplete = async (args) => {
		const completion = await options.complete(args);
		const tokens = completion.outputTokens ?? 0;
		const evalMs = completion.evalMs ?? 0;
		if (tokens > 0 && evalMs > 0) {
			surfaceSpeed.tokens += tokens;
			surfaceSpeed.evalMs += evalMs;
			overallSpeed.tokens += tokens;
			overallSpeed.evalMs += evalMs;
		}
		return completion;
	};
	const takeSurfaceSpeed = (): number | undefined => {
		const speed =
			surfaceSpeed.evalMs > 0 ? Math.round((surfaceSpeed.tokens / surfaceSpeed.evalMs) * 1000) : undefined;
		surfaceSpeed = { tokens: 0, evalMs: 0 };
		return speed;
	};

	const research: LaneFitnessScore = { succeeded: 0, total: trials, outcomes: [], meanMs: 0 };
	for (let i = 0; i < trials; i++) {
		const started = now();
		const result = await runResearch({
			query: `fitness:probe requirements:req-${i}`,
			context: [
				"Goal: add a retry helper to the HTTP client module",
				"Open requirements:",
				"- Find what retry/backoff conventions the codebase already uses",
				"- Identify which call sites would adopt the helper",
			].join("\n"),
			envelope: fitnessEnvelope(),
			maxUsd: 1,
			maxSources: 8,
			maxFindings: 5,
			maxWallClockMs,
			signal: options.signal,
			complete,
		});
		research.meanMs += now() - started;
		totalCostUsd += result.costUsd;
		if (result.status === "succeeded") research.succeeded++;
		research.outcomes.push(`${result.status}/${result.reasonCode}`);
	}
	research.meanMs = Math.round(research.meanMs / trials);
	research.tokensPerSecond = takeSurfaceSpeed();

	const worker: LaneFitnessScore = { succeeded: 0, total: trials, outcomes: [], meanMs: 0 };
	for (let i = 0; i < trials; i++) {
		const started = now();
		const outcome = await runWorker({
			request: {
				id: `fitness-worker-${i}`,
				instructions:
					"Summarize in two sentences what a capability envelope is: a declared set of allowed tools, paths, and capability names that bounds what a delegated worker may do.",
				route: { tier: "cheap", risk: "read-only", confidence: 1, reasonCode: "fitness_probe", reasons: [] },
				envelope: { id: `fitness-env-${i}`, capabilities: ["read_files"], maxEstimatedUsd: 1 },
				maxEstimatedUsd: 1,
			},
			maxUsd: 1,
			maxWallClockMs,
			usageReportId: `fitness:${i}`,
			signal: options.signal,
			complete,
		});
		worker.meanMs += now() - started;
		totalCostUsd += outcome.costUsd;
		if (outcome.result.status === "completed" && outcome.accepted) worker.succeeded++;
		worker.outcomes.push(`${outcome.result.status}/${outcome.reasonCode}`);
	}
	worker.meanMs = Math.round(worker.meanMs / trials);
	worker.tokensPerSecond = takeSurfaceSpeed();

	const judge: JudgeFitnessScore = {
		parsed: 0,
		planningElevated: 0,
		planningTotal: judgePrompts.filter((entry) => entry.planning).length,
		trivialCheap: 0,
		trivialTotal: judgePrompts.filter((entry) => !entry.planning).length,
		total: judgePrompts.length,
		outcomes: [],
		meanMs: 0,
	};
	for (const entry of judgePrompts) {
		const started = now();
		const result = await runRouteJudge({
			prompt: entry.prompt,
			baseline: { tier: "cheap", risk: "read-only", confidence: 0.5, reasonCode: "fitness_probe", reasons: [] },
			maxWallClockMs,
			signal: options.signal,
			complete,
		});
		judge.meanMs += now() - started;
		totalCostUsd += result.costUsd;
		const tier = result.decision.tier;
		if (result.verdict) {
			judge.parsed++;
			// A useful judge must both keep planning off the cheap tier AND actually send trivial
			// prompts there — all-medium verdicts are safe but save nothing.
			if (entry.planning && tier !== "cheap") judge.planningElevated++;
			if (!entry.planning && tier === "cheap") judge.trivialCheap++;
		}
		judge.outcomes.push(
			`"${entry.prompt.slice(0, 40)}" -> ${tier}${result.fallbackReason ? ` (${result.fallbackReason})` : ""}`,
		);
	}
	judge.meanMs = judgePrompts.length > 0 ? Math.round(judge.meanMs / judgePrompts.length) : 0;
	judge.tokensPerSecond = takeSurfaceSpeed();

	const probeSurface = async (
		systemPrompt: string,
		tasks: readonly string[],
		accepts: (text: string) => boolean,
	): Promise<LaneFitnessScore> => {
		const score: LaneFitnessScore = { succeeded: 0, total: tasks.length, outcomes: [], meanMs: 0 };
		for (const task of tasks) {
			const started = now();
			// Same wall-clock envelope as the lane surfaces — a hung model must not hang the probe.
			const bounded = await runBoundedCompletion({
				maxWallClockMs,
				signal: options.signal,
				execute: (signal) => complete({ systemPrompt, userPrompt: task, signal }),
			});
			if (bounded.completion) totalCostUsd += bounded.completion.costUsd;
			if (bounded.failure || !bounded.completion) {
				score.outcomes.push(bounded.failure ? bounded.failure.status : "completion_error");
			} else {
				const ok = accepts(bounded.completion.text);
				if (ok) score.succeeded++;
				score.outcomes.push(ok ? "ok" : "unparseable_output");
			}
			score.meanMs += now() - started;
		}
		score.meanMs = tasks.length > 0 ? Math.round(score.meanMs / tasks.length) : 0;
		return score;
	};

	const search = await probeSurface(SEARCH_PROBE_SYSTEM_PROMPT, SEARCH_PROBE_TASKS, parseSearchPlan);
	search.tokensPerSecond = takeSurfaceSpeed();
	const toolCall = await probeSurface(TOOL_CALL_PROBE_SYSTEM_PROMPT, TOOL_CALL_PROBE_TASKS, parseToolCall);
	toolCall.tokensPerSecond = takeSurfaceSpeed();

	const tokensPerSecond =
		overallSpeed.evalMs > 0 ? Math.round((overallSpeed.tokens / overallSpeed.evalMs) * 1000) : undefined;

	return { trials, tokensPerSecond, research, worker, judge, search, toolCall, totalCostUsd };
}

/** Compact human-readable report for tool output / interactive display. Bounded, no raw dumps. */
export function formatModelFitnessReport(model: string, report: ModelFitnessReport): string {
	const speed = (tokensPerSecond: number | undefined) =>
		tokensPerSecond !== undefined ? `, ~${tokensPerSecond} tok/s` : "";
	const lines = [
		`Model fitness: ${model} (${report.trials} trials/lane${speed(report.tokensPerSecond)})`,
		`- research lane: ${report.research.succeeded}/${report.research.total} succeeded, mean ${report.research.meanMs}ms${speed(report.research.tokensPerSecond)} [${report.research.outcomes.join(", ")}]`,
		`- worker lane:   ${report.worker.succeeded}/${report.worker.total} completed+accepted, mean ${report.worker.meanMs}ms${speed(report.worker.tokensPerSecond)} [${report.worker.outcomes.join(", ")}]`,
		`- search plans:  ${report.search.succeeded}/${report.search.total} well-formed, mean ${report.search.meanMs}ms${speed(report.search.tokensPerSecond)}`,
		`- tool calls:    ${report.toolCall.succeeded}/${report.toolCall.total} well-formed, mean ${report.toolCall.meanMs}ms${speed(report.toolCall.tokensPerSecond)}`,
		`- route judge:   parsed ${report.judge.parsed}/${report.judge.total}, planning-elevated ${report.judge.planningElevated}/${report.judge.planningTotal}, trivial-cheap ${report.judge.trivialCheap}/${report.judge.trivialTotal}, mean ${report.judge.meanMs}ms${speed(report.judge.tokensPerSecond)}`,
		...report.judge.outcomes.map((outcome) => `    ${outcome}`),
	];
	if (report.totalCostUsd > 0) {
		lines.push(`- probe cost: $${report.totalCostUsd.toFixed(4)}`);
	}
	return lines.join("\n");
}
