import { runBoundedCompletion } from "../autonomy/bounded-completion.ts";
import type { EvidenceRef, Finding, GateOutcome, WorkerRequest, WorkerResult } from "../autonomy/contracts.ts";
import type { LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import { createEvidenceBundle } from "../research/evidence-bundle.ts";
import { validateWorkerResult } from "./worker-result.ts";

/**
 * Pure orchestration for one bounded scout-worker delegation: bounded isolated completion ->
 * parse -> `WorkerResult` -> parent validation via {@link validateWorkerResult}.
 *
 * Slice scope: scout (read-only) workers only — the completion receives text prompts, no tools, so
 * `changedFiles` is always empty. Code-writing workers stay out until a real execution envelope
 * enforces path scope at tool level. Worker output is untrusted until the parent verifies it.
 */

/** Static across calls so callers can use `cacheRetention: "short"`. */
export const WORKER_LANE_SYSTEM_PROMPT = [
	"You are a bounded read-only scout worker delegated one task by a coding agent.",
	"You cannot run tools or change files; produce your best analysis of the delegated task.",
	"Respond with STRICT JSON only - no prose, no markdown fences:",
	'{"summary":"<what you concluded>","status":"completed"|"blocked","blockers":["<why you are stuck>"],"findings":[{"summary":"<one concrete finding>","confidence":<0..1>}]}',
	'Use status "blocked" with blockers only when the task cannot be answered from the provided context.',
	"Never invent file paths, APIs, or facts.",
].join("\n");

export interface WorkerCompletion {
	text: string;
	costUsd: number;
	stopReason: string;
}

export interface WorkerRunnerOptions {
	request: WorkerRequest;
	/** Budget for this delegation; a post-hoc breach marks the lane budget_exhausted. */
	maxUsd: number;
	/** Wall-clock budget in milliseconds; 0 disables. */
	maxWallClockMs: number;
	/**
	 * Pre-allocated spawned-usage report id. Always stamped on the result so parent validation can
	 * enforce the cost-visibility invariant (a completed result without a usage report is blocked).
	 */
	usageReportId: string;
	complete: (args: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) => Promise<WorkerCompletion>;
	signal?: AbortSignal;
	now?: () => string;
}

export interface WorkerRunOutcome {
	result: WorkerResult;
	/** Parent-review verdict from {@link validateWorkerResult}; worker output stays untrusted. */
	acceptance: GateOutcome;
	accepted: boolean;
	laneStatus: LaneTerminalStatus;
	reasonCode: string;
	costUsd: number;
}

export function buildWorkerUserPrompt(request: WorkerRequest): string {
	return `Delegated task: ${request.instructions}`;
}

export interface ParsedWorkerOutput {
	summary: string;
	status: "completed" | "blocked";
	blockers: string[];
	findings: Array<{ summary: string; confidence?: number }>;
}

export function parseWorkerOutput(text: string): ParsedWorkerOutput | undefined {
	const trimmed = text.trim();
	const candidates: string[] = [trimmed];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	if (fenced?.[1]) candidates.push(fenced[1].trim());
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const record = parsed as Record<string, unknown>;
		const summary = record.summary;
		if (typeof summary !== "string" || summary.trim().length === 0) continue;

		const status = record.status === "blocked" ? "blocked" : "completed";
		const blockers = Array.isArray(record.blockers)
			? record.blockers.filter((blocker): blocker is string => typeof blocker === "string" && blocker.length > 0)
			: [];
		const findings: Array<{ summary: string; confidence?: number }> = [];
		if (Array.isArray(record.findings)) {
			for (const item of record.findings) {
				if (!item || typeof item !== "object" || Array.isArray(item)) continue;
				const findingSummary = (item as { summary?: unknown }).summary;
				if (typeof findingSummary !== "string" || findingSummary.trim().length === 0) continue;
				const confidenceRaw = (item as { confidence?: unknown }).confidence;
				const confidence =
					typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
						? Math.min(Math.max(confidenceRaw, 0), 1)
						: undefined;
				findings.push({ summary: findingSummary.trim(), confidence });
			}
		}
		return { summary: summary.trim(), status, blockers, findings };
	}
	return undefined;
}

function buildWorkerEvidence(request: WorkerRequest, findings: ParsedWorkerOutput["findings"]) {
	if (findings.length === 0) return undefined;
	const instructionsRef: EvidenceRef = {
		id: "src-instructions",
		kind: "user",
		title: "Delegated task instructions",
		trusted: true,
		excerpt: request.instructions.slice(0, 2000),
	};
	const synthesisRef: EvidenceRef = {
		id: "src-worker",
		kind: "tool",
		title: "Scout-worker synthesis",
		trusted: false,
	};
	const bundleFindings: Finding[] = findings.map((finding, index) => ({
		id: `finding-${index + 1}`,
		summary: finding.summary,
		evidenceIds: [synthesisRef.id],
		...(finding.confidence !== undefined ? { confidence: finding.confidence } : {}),
	}));
	return createEvidenceBundle({
		query: `worker:${request.id}`,
		sources: [instructionsRef, synthesisRef],
		findings: bundleFindings,
	});
}

function finishOutcome(args: {
	request: WorkerRequest;
	result: WorkerResult;
	laneStatus: LaneTerminalStatus;
	reasonCode: string;
	costUsd: number;
}): WorkerRunOutcome {
	const acceptance = validateWorkerResult({ request: args.request, result: args.result });
	return {
		result: args.result,
		acceptance,
		accepted: acceptance.outcome === "allow",
		laneStatus: args.laneStatus,
		reasonCode: args.reasonCode,
		costUsd: args.costUsd,
	};
}

export async function runWorker(options: WorkerRunnerOptions): Promise<WorkerRunOutcome> {
	const now = options.now ?? (() => new Date().toISOString());
	const baseResult = {
		requestId: options.request.id,
		changedFiles: [] as string[],
		usageReportId: options.usageReportId,
		createdAt: now(),
	};

	const bounded = await runBoundedCompletion({
		maxWallClockMs: options.maxWallClockMs,
		signal: options.signal,
		execute: (signal) =>
			options.complete({
				systemPrompt: WORKER_LANE_SYSTEM_PROMPT,
				userPrompt: buildWorkerUserPrompt(options.request),
				signal,
			}),
	});
	const costUsd = bounded.completion?.costUsd ?? 0;

	if (bounded.failure) {
		const cancelled = bounded.failure.status === "canceled" || bounded.failure.status === "timeout";
		return finishOutcome({
			request: options.request,
			result: {
				...baseResult,
				status: cancelled ? "cancelled" : "failed",
				summary: `Worker did not complete: ${bounded.failure.reasonCode}`,
			},
			laneStatus: bounded.failure.status,
			reasonCode: bounded.failure.reasonCode,
			costUsd,
		});
	}

	const completion = bounded.completion;
	if (!completion || completion.stopReason === "error" || completion.stopReason === "aborted") {
		return finishOutcome({
			request: options.request,
			result: { ...baseResult, status: "failed", summary: "Worker model call failed." },
			laneStatus: "failed",
			reasonCode: "model_error",
			costUsd,
		});
	}

	const parsed = parseWorkerOutput(completion.text);
	if (!parsed) {
		return finishOutcome({
			request: options.request,
			result: { ...baseResult, status: "failed", summary: "Worker output was not valid structured JSON." },
			laneStatus: "failed",
			reasonCode: "unparseable_output",
			costUsd,
		});
	}

	const evidence = buildWorkerEvidence(options.request, parsed.findings);
	const result: WorkerResult = {
		...baseResult,
		status: parsed.status === "blocked" || parsed.blockers.length > 0 ? "blocked" : "completed",
		summary: parsed.summary,
		...(parsed.blockers.length > 0 ? { blockers: parsed.blockers } : {}),
		...(evidence ? { evidence } : {}),
	};

	if (result.status === "blocked") {
		return finishOutcome({
			request: options.request,
			result,
			laneStatus: "failed",
			reasonCode: "worker_blocked",
			costUsd,
		});
	}

	const overBudget = options.maxUsd > 0 && costUsd > options.maxUsd;
	return finishOutcome({
		request: options.request,
		result,
		laneStatus: overBudget ? "budget_exhausted" : "succeeded",
		reasonCode: overBudget ? "cost_budget_exceeded" : "worker_completed",
		costUsd,
	});
}
