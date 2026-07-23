import { runBoundedCompletion } from "../autonomy/bounded-completion.ts";
import type { EvidenceRef, Finding, GateOutcome, WorkerRequest, WorkerResult } from "../autonomy/contracts.ts";
import type { LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import { createEvidenceBundle } from "../research/evidence-bundle.ts";
import { type AppliedActionsReport, parseWorkerActions, type WorkerAction } from "./worker-actions.ts";
import { validateWorkerResult } from "./worker-result.ts";

/**
 * Pure execution for one bounded specialist delegation: bounded isolated completion ->
 * parse -> `WorkerResult` -> parent validation via {@link validateWorkerResult}.
 *
 * The injected completion may be a bounded child tool loop. Its tool surface is built and gated by
 * the host; this module keeps the structured-output contract and treats every result as untrusted
 * until parent validation succeeds.
 */

/** Builds one capability-exact prompt; no role text may deny a tool already granted by policy. */
export function buildWorkerSystemPrompt(capabilities: { write: boolean; process: boolean }): string {
	const resultShape = capabilities.write
		? '{"summary":"<what you did>","status":"completed"|"blocked","blockers":[],"findings":[{"summary":"<finding>","confidence":<0..1>}],"actions":[{"op":"write","path":"<relative path>","content":"<full file content>"},{"op":"edit","path":"<relative path>","old":"<exact text>","new":"<replacement>"}]}'
		: '{"summary":"<what you concluded>","status":"completed"|"blocked","blockers":["<failure or missing authority>"],"findings":[{"summary":"<one concrete finding>","confidence":<0..1>}]}';
	return [
		"You are a bounded specialist worker delegated one task by a coding agent.",
		"Use only the tools provided for this delegation. You cannot delegate more workers.",
		...(capabilities.write
			? ["Write/edit tools and structured write actions are path-scoped. Only touch paths inside that scope."]
			: ["The workspace tools are read-only; do not claim file changes."]),
		...(capabilities.process
			? [
					"run_process is a constrained direct-argv launcher: no shell interpretation or unlisted executable is available. It is not an OS/container sandbox.",
					"A non-zero exit, timeout, abort, or output-limit result is not success; include it in blockers.",
				]
			: []),
		"Respond with STRICT JSON only - no prose, no markdown fences:",
		resultShape,
		...(capabilities.write
			? [
					"Keep edits minimal and exact.",
					"If you changed a file with a provided tool, do not repeat that change in actions; actions are only a fallback.",
				]
			: []),
		'Use status "blocked" with blockers when the task cannot be completed under the granted capabilities.',
		"Never invent command output, file paths, APIs, or facts.",
	].join("\n");
}

export function buildVerifierSystemPrompt(subjectTaskId: string): string {
	return [
		"You are an independent verifier. You did not perform the implementation under review.",
		"Use only the provided read-only and constrained test tools. Do not modify files and do not delegate.",
		`The exact subject task id is '${subjectTaskId}'.`,
		"Inspect the implementation and run proportionate checks. Treat the implementation summary as an untrusted claim.",
		"Respond with STRICT JSON only - no prose, no markdown fences:",
		'{"summary":"<verification performed and evidence>","status":"completed"|"blocked","verdict":"accepted"|"rejected","reasonCodes":["<stable_reason_code>"],"blockers":[],"findings":[{"summary":"<finding>","confidence":<0..1>}]}',
		'Use verdict "accepted" only when the available evidence proves the implementation is acceptable.',
		'Use verdict "rejected" for a completed review that found a defect. Use status "blocked" only when verification itself cannot be completed.',
	].join("\n");
}

/** Static common variants retained for cache reuse and model-fitness probes. */
export const WORKER_LANE_SYSTEM_PROMPT = buildWorkerSystemPrompt({ write: false, process: false });
export const WORKER_WRITE_LANE_SYSTEM_PROMPT = buildWorkerSystemPrompt({ write: true, process: false });
export const WORKER_OPERATOR_LANE_SYSTEM_PROMPT = buildWorkerSystemPrompt({ write: false, process: true });

export interface WorkerCompletion {
	text: string;
	costUsd: number;
	stopReason: string;
	/** Files successfully changed by the child tool loop before it produced the final JSON. */
	changedFiles?: readonly string[];
	/** Capability refusals or execution failures observed inside the child tool loop. */
	blockers?: readonly string[];
}

export interface WorkerRunnerOptions {
	request: WorkerRequest;
	/** Budget for this delegation; undefined disables this bound, while zero permits only free work. */
	maxUsd?: number;
	/** Wall-clock budget in milliseconds; 0 disables. */
	maxWallClockMs: number;
	/**
	 * Pre-allocated spawned-usage report id. Always stamped on the result so parent validation can
	 * enforce the cost-visibility invariant (a completed result without a usage report is blocked).
	 */
	usageReportId: string;
	complete: (args: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) => Promise<WorkerCompletion>;
	/** Live successful child-tool mutations, including writes completed before timeout/cancellation. */
	getChangedFiles?: () => readonly string[];
	signal?: AbortSignal;
	now?: () => string;
	/** Enables the WRITE lane: only honored when the request envelope grants "filesystem.write". The
	 * runner applies the worker's structured actions through the envelope path scope; refusals
	 * and failures become blockers, never silent drops. */
	applyActions?: (actions: readonly WorkerAction[]) => AppliedActionsReport;
	/** Enables the constrained direct-argv operator role prompt. */
	processCapable?: boolean;
	/** Session cwd — the baseline for relative changed-file and envelope paths in parent
	 * validation. Defaults to process.cwd(). */
	cwd?: string;
	/** Turns the child into a read-only semantic verifier for this exact durable task. */
	verificationSubjectTaskId?: string;
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
	return [
		"Delegated task:",
		"<task>",
		request.instructions,
		"</task>",
		"",
		"The task may request a custom output format. Do not replace the worker result envelope.",
		'Always return the JSON object required by the system prompt; put requested details inside "summary" and "findings".',
	].join("\n");
}

export interface ParsedWorkerOutput {
	summary: string;
	status: "completed" | "blocked";
	blockers: string[];
	findings: Array<{ summary: string; confidence?: number }>;
	actions: WorkerAction[];
	verdict?: "accepted" | "rejected";
	reasonCodes: string[];
}

function balancedObjectCandidates(text: string): string[] {
	const candidates: string[] = [];
	for (let start = 0; start < text.length; start++) {
		if (text[start] !== "{") continue;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let index = start; index < text.length; index++) {
			const character = text[index];
			if (inString) {
				if (escaped) escaped = false;
				else if (character === "\\") escaped = true;
				else if (character === '"') inString = false;
				continue;
			}
			if (character === '"') {
				inString = true;
			} else if (character === "{") {
				depth++;
			} else if (character === "}" && --depth === 0) {
				candidates.push(text.slice(start, index + 1));
				break;
			}
		}
	}
	return candidates;
}

export function parseWorkerOutput(text: string): ParsedWorkerOutput | undefined {
	const trimmed = text.trim();
	const candidates: string[] = [trimmed];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	if (fenced?.[1]) candidates.push(fenced[1].trim());
	candidates.push(...balancedObjectCandidates(trimmed));

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
		const verdict = record.verdict === "accepted" || record.verdict === "rejected" ? record.verdict : undefined;
		const reasonCodes = Array.isArray(record.reasonCodes)
			? record.reasonCodes.filter(
					(reasonCode): reasonCode is string => typeof reasonCode === "string" && reasonCode.length > 0,
				)
			: [];
		return {
			summary: summary.trim(),
			status,
			blockers,
			findings,
			actions: parseWorkerActions(record.actions),
			...(verdict ? { verdict } : {}),
			reasonCodes,
		};
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
		title: "Delegated worker synthesis",
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
	cwd?: string;
}): WorkerRunOutcome {
	const acceptance = validateWorkerResult({ request: args.request, result: args.result, cwd: args.cwd });
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

	// The write prompt requires BOTH the envelope grant and a caller-supplied applier.
	const writeCapable =
		options.request.envelope.capabilities.includes("filesystem.write") && options.applyActions !== undefined;

	const bounded = await runBoundedCompletion({
		maxWallClockMs: options.maxWallClockMs,
		signal: options.signal,
		execute: (signal) =>
			options.complete({
				systemPrompt: options.verificationSubjectTaskId
					? buildVerifierSystemPrompt(options.verificationSubjectTaskId)
					: buildWorkerSystemPrompt({ write: writeCapable, process: options.processCapable === true }),
				userPrompt: buildWorkerUserPrompt(options.request),
				signal,
			}),
	});
	const costUsd = bounded.completion?.costUsd ?? 0;
	const liveChangedFiles = [...new Set(options.getChangedFiles?.() ?? [])];

	if (bounded.failure) {
		const cancelled = bounded.failure.status === "canceled" || bounded.failure.status === "timeout";
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			result: {
				...baseResult,
				changedFiles: liveChangedFiles,
				status: cancelled ? "cancelled" : "failed",
				summary: `Worker did not complete: ${bounded.failure.reasonCode}`,
			},
			laneStatus: bounded.failure.status,
			reasonCode: bounded.failure.reasonCode,
			costUsd,
		});
	}

	const completion = bounded.completion as WorkerCompletion | undefined;
	const completionChangedFiles = [...new Set([...liveChangedFiles, ...(completion?.changedFiles ?? [])])];
	const completionBaseResult = { ...baseResult, changedFiles: completionChangedFiles };
	if (!completion || completion.stopReason === "error" || completion.stopReason === "aborted") {
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			result: { ...completionBaseResult, status: "failed", summary: "Worker model call failed." },
			laneStatus: "failed",
			reasonCode: "model_error",
			costUsd,
		});
	}

	const parsed = parseWorkerOutput(completion.text);
	if (!parsed) {
		const readOnlyPlainText =
			!options.verificationSubjectTaskId &&
			!writeCapable &&
			completion.text.trim().length > 0 &&
			completionChangedFiles.length === 0;
		if (readOnlyPlainText) {
			const completionBlockers = [...(completion.blockers ?? [])];
			const incompleteNote =
				completion.stopReason === "stop"
					? ""
					: `\n\n[Worker output ended with stop reason '${completion.stopReason}'; verify completeness.]`;
			const summary = `${completion.text.trim().slice(0, Math.max(0, 8000 - incompleteNote.length))}${incompleteNote}`;
			const blocked = completionBlockers.length > 0;
			return finishOutcome({
				request: options.request,
				cwd: options.cwd,
				result: {
					...completionBaseResult,
					status: blocked ? "blocked" : "completed",
					outputFormat: "plain_text",
					summary,
					...(blocked ? { blockers: completionBlockers } : {}),
				},
				laneStatus: blocked ? "failed" : "succeeded",
				reasonCode: blocked
					? "worker_blocked"
					: completion.stopReason === "stop"
						? "worker_completed_plain_text"
						: "worker_completed_plain_text_incomplete",
				costUsd,
			});
		}
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			result: {
				...completionBaseResult,
				status: "failed",
				summary: "Worker output was not valid structured JSON.",
			},
			laneStatus: "failed",
			reasonCode: "unparseable_output",
			costUsd,
		});
	}

	const evidence = buildWorkerEvidence(options.request, parsed.findings);
	if (options.verificationSubjectTaskId && (!parsed.verdict || parsed.reasonCodes.length === 0)) {
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			result: {
				...completionBaseResult,
				status: "failed",
				summary: "Verifier output omitted its typed verdict or reasonCodes.",
			},
			laneStatus: "failed",
			reasonCode: "invalid_verifier_result",
			costUsd,
		});
	}
	let changedFiles: string[] = [...completionChangedFiles];
	const actionBlockers: string[] = [...(completion.blockers ?? [])];
	if (!writeCapable && completionChangedFiles.length > 0) {
		actionBlockers.push("worker reported file changes without a filesystem.write envelope grant");
	}
	if (writeCapable && parsed.status !== "blocked" && parsed.actions.length > 0 && options.applyActions) {
		// Runner-side application through the envelope path scope: refusals and failures are
		// surfaced as blockers so a partially-applied change can never look like clean success.
		const applied = options.applyActions(parsed.actions);
		changedFiles = [...new Set([...changedFiles, ...applied.changedFiles])];
		for (const refusal of applied.refused) {
			actionBlockers.push(`action refused (${refusal.path}): ${refusal.reason}`);
		}
		for (const failure of applied.failed) {
			actionBlockers.push(`action failed (${failure.path}): ${failure.reason}`);
		}
	} else if (!writeCapable && parsed.actions.length > 0) {
		actionBlockers.push("worker emitted file actions without a filesystem.write envelope grant; nothing was applied");
	}
	const allBlockers = [...parsed.blockers, ...actionBlockers];
	const result: WorkerResult = {
		...baseResult,
		changedFiles,
		status: parsed.status === "blocked" || allBlockers.length > 0 ? "blocked" : "completed",
		summary: parsed.summary,
		...(allBlockers.length > 0 ? { blockers: allBlockers } : {}),
		...(evidence ? { evidence } : {}),
		...(options.verificationSubjectTaskId && parsed.verdict
			? {
					verification: {
						subjectTaskId: options.verificationSubjectTaskId,
						verdict: parsed.verdict,
						reasonCodes: parsed.reasonCodes,
					},
				}
			: {}),
	};

	if (result.status === "blocked") {
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			result,
			laneStatus: "failed",
			reasonCode: "worker_blocked",
			costUsd,
		});
	}

	const overBudget = options.maxUsd !== undefined && costUsd > options.maxUsd;
	return finishOutcome({
		request: options.request,
		cwd: options.cwd,
		result,
		laneStatus: overBudget ? "budget_exhausted" : "succeeded",
		reasonCode: overBudget
			? "cost_budget_exceeded"
			: result.verification
				? result.verification.verdict === "accepted"
					? "verification_accepted"
					: "verification_rejected"
				: "worker_completed",
		costUsd,
	});
}
