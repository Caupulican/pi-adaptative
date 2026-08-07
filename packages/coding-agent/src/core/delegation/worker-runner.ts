import { runBoundedCompletion } from "../autonomy/bounded-completion.ts";
import type { EvidenceRef, GateOutcome, WorkerClaim, WorkerRequest } from "../autonomy/contracts.ts";
import {
	type EvidenceFindingDraft,
	normalizeEvidenceFinding,
	projectEvidenceFindings,
} from "../autonomy/evidence-finding-projection.ts";
import type { LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import { createEvidenceBundle } from "../research/evidence-bundle.ts";
import {
	type AppliedActionsReport,
	parseWorkerActions,
	type RejectedWorkerActions,
	type WorkerAction,
} from "./worker-actions.ts";
import {
	collectBoundedWorkerClaimBlockers,
	collectBoundedWorkerClaimChangedFiles,
	MAX_WORKER_CLAIM_BLOCKER_CHARS,
	MAX_WORKER_CLAIM_BLOCKERS,
	MAX_WORKER_CLAIM_SUMMARY_CHARS,
	normalizeWorkerClaimForHost,
	validateWorkerClaim,
} from "./worker-claim.ts";

/**
 * Pure execution for one bounded specialist delegation: bounded isolated completion ->
 * parse -> untrusted `WorkerClaim` -> parent validation via {@link validateWorkerClaim}.
 *
 * The injected completion may be a bounded child tool loop. Its tool surface is built and gated by
 * the host; this module keeps the structured-output contract and treats every claim as untrusted
 * until parent validation succeeds.
 */

/** Builds one capability-exact prompt; no role text may deny a tool already granted by policy. */
export function buildWorkerSystemPrompt(capabilities: {
	write: boolean;
	process: boolean;
	delegate?: boolean;
}): string {
	const resultShape = capabilities.write
		? '{"summary":"<what you did>","status":"completed"|"blocked","blockers":[],"findings":[{"summary":"<finding>","confidence":<0..1>}],"actions":[{"op":"write","path":"<relative path>","content":"<full file content>"},{"op":"edit","path":"<relative path>","old":"<exact text>","new":"<replacement>"}]}'
		: '{"summary":"<what you concluded>","status":"completed"|"blocked","blockers":["<failure or missing authority>"],"findings":[{"summary":"<one concrete finding>","confidence":<0..1>}]}';
	return [
		"You are an autonomous agent in a durable orchestration tree.",
		"Use every provided tool when it improves the result; the host enforces the exact inherited grant at execution time.",
		...(capabilities.delegate
			? [
					"You may create agents recursively without a depth or fan-out cap. Use list/transcript/threaded messages to coordinate the tree; the scheduler owns concurrency, budgets, leases, cycle rejection, and cancellation.",
				]
			: []),
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

export function buildVerifierSystemPrompt(subjectTaskId: string, capabilities: { delegate?: boolean } = {}): string {
	return [
		"You are an independent verifier. You did not perform the implementation under review.",
		"Use the provided read-only and test tools. Do not modify files.",
		...(capabilities.delegate
			? ["You may delegate independent evidence gathering and coordinate it through the orchestration tree."]
			: []),
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
	 * Pre-allocated spawned-usage report id. Always stamped on the claim so parent validation can
	 * enforce the cost-visibility invariant (a completed claim without a usage report is blocked).
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
	/** Enables recursive delegation and orchestration-tree coordination guidance. */
	delegationCapable?: boolean;
	/** Session cwd — the baseline for relative changed-file and envelope paths in parent
	 * validation. Defaults to process.cwd(). */
	cwd?: string;
	/** Turns the child into a read-only semantic verifier for this exact durable task. */
	verificationSubjectTaskId?: string;
}

export interface WorkerRunOutcome {
	claim: WorkerClaim;
	/** Parent-review verdict from {@link validateWorkerClaim}; worker output stays untrusted. */
	acceptance: GateOutcome;
	accepted: boolean;
	laneStatus: LaneTerminalStatus;
	reasonCode: string;
	/** Underlying executor error for bounded failures; drives the in-process retry decision. */
	reasonDetail?: string;
	costUsd: number;
}

export function buildWorkerUserPrompt(request: WorkerRequest): string {
	return [
		"Delegated task:",
		"<task>",
		request.instructions,
		"</task>",
		"",
		"The task may request a custom output format. Do not replace the worker claim envelope.",
		'Always return the JSON object required by the system prompt; put requested details inside "summary" and "findings".',
	].join("\n");
}

export interface ParsedWorkerOutput {
	summary: string;
	status: "completed" | "blocked";
	blockers: string[];
	findings: EvidenceFindingDraft[];
	actions: WorkerAction[];
	/** Present when the model emitted an action list that cannot safely reach execution. */
	actionRejection?: RejectedWorkerActions;
	verdict?: "accepted" | "rejected";
	reasonCodes: string[];
}

const MAX_WORKER_OUTPUT_CHARS = 512 * 1024;
const MAX_WORKER_JSON_CANDIDATES = 64;
const MAX_WORKER_JSON_DEPTH = 256;
const MAX_WORKER_FINDINGS = 64;
const MAX_WORKER_FINDING_CHARS = 2_000;
const MAX_WORKER_REASON_CODES = 32;
const MAX_WORKER_REASON_CODE_CHARS = 128;

function balancedObjectCandidates(text: string): string[] {
	const ranges: Array<{ start: number; end: number }> = [];
	const starts: number[] = [];
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{") {
			if (starts.length >= MAX_WORKER_JSON_DEPTH) return ranges.map(({ start, end }) => text.slice(start, end));
			starts.push(index);
			continue;
		}
		if (character !== "}") continue;
		const start = starts.pop();
		if (start === undefined || ranges.length >= MAX_WORKER_JSON_CANDIDATES) continue;
		const end = index + 1;
		if (end - start <= MAX_WORKER_OUTPUT_CHARS) ranges.push({ start, end });
	}
	return ranges.map(({ start, end }) => text.slice(start, end));
}

function workerOutputRecords(text: string): Record<string, unknown>[] {
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_WORKER_OUTPUT_CHARS) return [];
	const candidates: string[] = [trimmed];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	if (fenced?.[1]) candidates.push(fenced[1].trim());
	candidates.push(...balancedObjectCandidates(trimmed));
	const records: Record<string, unknown>[] = [];
	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
				records.push(parsed as Record<string, unknown>);
		} catch {
			// Candidate extraction is deliberately best-effort; a later balanced candidate may still be valid.
		}
	}
	return records;
}

function isWorkerStatus(value: unknown): value is ParsedWorkerOutput["status"] {
	return value === "completed" || value === "blocked";
}

/**
 * Plain-text fallback is for output that never attempted the worker claim envelope. A JSON object
 * with a claim summary but malformed typed fields is a contract failure, never an implicit success.
 */
function hasMalformedWorkerClaimEnvelope(text: string): boolean {
	return workerOutputRecords(text).some((record) => {
		if (typeof record.summary !== "string" || record.summary.trim().length === 0) return false;
		if (!isWorkerStatus(record.status)) return true;
		if (record.verdict !== undefined && record.verdict !== "accepted" && record.verdict !== "rejected") return true;
		return (
			record.reasonCodes !== undefined &&
			(!Array.isArray(record.reasonCodes) ||
				record.reasonCodes.some((reasonCode) => typeof reasonCode !== "string" || reasonCode.trim().length === 0))
		);
	});
}

export function parseWorkerOutput(text: string): ParsedWorkerOutput | undefined {
	for (const record of workerOutputRecords(text)) {
		const summary = record.summary;
		if (typeof summary !== "string" || summary.trim().length === 0) continue;
		if (!isWorkerStatus(record.status)) continue;
		if (record.verdict !== undefined && record.verdict !== "accepted" && record.verdict !== "rejected") continue;
		if (
			record.reasonCodes !== undefined &&
			(!Array.isArray(record.reasonCodes) ||
				record.reasonCodes.some((reasonCode) => typeof reasonCode !== "string" || reasonCode.trim().length === 0))
		) {
			continue;
		}

		const status = record.status;
		const blockers = Array.isArray(record.blockers)
			? record.blockers
					.filter((blocker): blocker is string => typeof blocker === "string" && blocker.trim().length > 0)
					.slice(0, MAX_WORKER_CLAIM_BLOCKERS)
					.map((blocker) => blocker.trim().slice(0, MAX_WORKER_CLAIM_BLOCKER_CHARS))
			: [];
		const findings: EvidenceFindingDraft[] = [];
		if (Array.isArray(record.findings)) {
			for (let index = 0; index < record.findings.length && index < MAX_WORKER_FINDINGS; index++) {
				const finding = normalizeEvidenceFinding(record.findings[index], MAX_WORKER_FINDING_CHARS);
				if (finding) findings.push(finding);
			}
		}
		const verdict = record.verdict === "accepted" || record.verdict === "rejected" ? record.verdict : undefined;
		const reasonCodes = Array.isArray(record.reasonCodes)
			? record.reasonCodes
					.filter(
						(reasonCode): reasonCode is string => typeof reasonCode === "string" && reasonCode.trim().length > 0,
					)
					.slice(0, MAX_WORKER_REASON_CODES)
					.map((reasonCode) => reasonCode.trim().slice(0, MAX_WORKER_REASON_CODE_CHARS))
			: [];
		const actionOutcome = parseWorkerActions(record.actions);
		return {
			summary: summary.trim().slice(0, MAX_WORKER_CLAIM_SUMMARY_CHARS),
			status,
			blockers,
			findings,
			actions: actionOutcome.kind === "accepted" ? actionOutcome.actions : [],
			...(actionOutcome.kind === "rejected" ? { actionRejection: actionOutcome } : {}),
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
	return createEvidenceBundle({
		query: `worker:${request.id}`,
		sources: [instructionsRef, synthesisRef],
		findings: projectEvidenceFindings(findings, synthesisRef.id),
	});
}

function finishOutcome(args: {
	request: WorkerRequest;
	claim: WorkerClaim;
	laneStatus: LaneTerminalStatus;
	reasonCode: string;
	reasonDetail?: string;
	costUsd: number;
	cwd?: string;
}): WorkerRunOutcome {
	const claim = normalizeWorkerClaimForHost(args.claim);
	const acceptance = validateWorkerClaim({ request: args.request, claim, cwd: args.cwd });
	return {
		claim,
		acceptance,
		accepted: acceptance.outcome === "allow",
		laneStatus: args.laneStatus,
		reasonCode: args.reasonCode,
		...(args.reasonDetail ? { reasonDetail: args.reasonDetail } : {}),
		costUsd: args.costUsd,
	};
}

export async function runWorker(options: WorkerRunnerOptions): Promise<WorkerRunOutcome> {
	const now = options.now ?? (() => new Date().toISOString());
	const baseClaim = {
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
					? buildVerifierSystemPrompt(options.verificationSubjectTaskId, {
							delegate: options.delegationCapable === true,
						})
					: buildWorkerSystemPrompt({
							write: writeCapable,
							process: options.processCapable === true,
							delegate: options.delegationCapable === true,
						}),
				userPrompt: buildWorkerUserPrompt(options.request),
				signal,
			}),
	});
	const costUsd = bounded.completion?.costUsd ?? 0;
	const liveChangedFilesReport = collectBoundedWorkerClaimChangedFiles(options.getChangedFiles?.() ?? []);
	const liveChangedFiles = liveChangedFilesReport.values;

	if (bounded.failure) {
		const cancelled = bounded.failure.status === "canceled" || bounded.failure.status === "timeout";
		const blockers = liveChangedFilesReport.overflowed
			? ["worker changed-file report exceeded the durable claim bound; parent review is required"]
			: undefined;
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			claim: {
				...baseClaim,
				changedFiles: liveChangedFiles,
				status: cancelled ? "cancelled" : "failed",
				summary: `Worker did not complete: ${bounded.failure.reasonCode}${
					bounded.failure.detail ? ` — ${bounded.failure.detail}` : ""
				}`,
				...(blockers ? { blockers } : {}),
			},
			laneStatus: bounded.failure.status,
			reasonCode: bounded.failure.reasonCode,
			...(bounded.failure.detail ? { reasonDetail: bounded.failure.detail } : {}),
			costUsd,
		});
	}

	const completion = bounded.completion as WorkerCompletion | undefined;
	const completionChangedFilesReport = collectBoundedWorkerClaimChangedFiles(completion?.changedFiles ?? []);
	const mergedChangedFilesReport = collectBoundedWorkerClaimChangedFiles([
		...liveChangedFiles,
		...completionChangedFilesReport.values,
	]);
	const changedFilesOverflowed =
		liveChangedFilesReport.overflowed ||
		completionChangedFilesReport.overflowed ||
		mergedChangedFilesReport.overflowed;
	const completionChangedFiles = mergedChangedFilesReport.values;
	const completionBaseClaim = { ...baseClaim, changedFiles: completionChangedFiles };
	if (!completion || completion.stopReason === "error" || completion.stopReason === "aborted") {
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			claim: { ...completionBaseClaim, status: "failed", summary: "Worker model call failed." },
			laneStatus: "failed",
			reasonCode: "model_error",
			costUsd,
		});
	}

	const parsed = parseWorkerOutput(completion.text);
	if (!parsed) {
		if (hasMalformedWorkerClaimEnvelope(completion.text)) {
			return finishOutcome({
				request: options.request,
				cwd: options.cwd,
				claim: {
					...completionBaseClaim,
					status: "failed",
					summary: "Worker output used a malformed structured claim envelope.",
				},
				laneStatus: "failed",
				reasonCode: "unparseable_output",
				costUsd,
			});
		}
		const readOnlyPlainText =
			!options.verificationSubjectTaskId &&
			!writeCapable &&
			completion.text.trim().length > 0 &&
			completionChangedFiles.length === 0 &&
			!changedFilesOverflowed;
		if (readOnlyPlainText) {
			const completionBlockersReport = collectBoundedWorkerClaimBlockers(completion.blockers ?? []);
			const completionBlockers = completionBlockersReport.overflowed
				? [
						...completionBlockersReport.values.slice(0, Math.max(0, MAX_WORKER_CLAIM_BLOCKERS - 1)),
						"worker blocker report exceeded the durable claim bound; parent review is required",
					]
				: completionBlockersReport.values;
			const incompleteNote =
				completion.stopReason === "stop"
					? ""
					: `\n\n[Worker output ended with stop reason '${completion.stopReason}'; verify completeness.]`;
			const summary = `${completion.text.trim().slice(0, Math.max(0, MAX_WORKER_CLAIM_SUMMARY_CHARS - incompleteNote.length))}${incompleteNote}`;
			const blocked = completionBlockers.length > 0;
			return finishOutcome({
				request: options.request,
				cwd: options.cwd,
				claim: {
					...completionBaseClaim,
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
			claim: {
				...completionBaseClaim,
				status: "failed",
				summary: "Worker output was not valid structured JSON.",
				...(changedFilesOverflowed
					? {
							blockers: [
								"worker changed-file report exceeded the durable claim bound; parent review is required",
							],
						}
					: {}),
			},
			laneStatus: "failed",
			reasonCode: "unparseable_output",
			costUsd,
		});
	}

	const evidence = buildWorkerEvidence(options.request, parsed.findings);
	if (parsed.actionRejection) {
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			claim: {
				...completionBaseClaim,
				status: "failed",
				summary: "Worker output contained invalid structured actions.",
				blockers: [parsed.actionRejection.reasonCode],
			},
			laneStatus: "failed",
			reasonCode: "unparseable_output",
			costUsd,
		});
	}
	if (options.verificationSubjectTaskId && (!parsed.verdict || parsed.reasonCodes.length === 0)) {
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			claim: {
				...completionBaseClaim,
				status: "failed",
				summary: "Verifier output omitted its typed verdict or reasonCodes.",
			},
			laneStatus: "failed",
			reasonCode: "invalid_verifier_result",
			costUsd,
		});
	}
	let changedFiles: string[] = [...completionChangedFiles];
	const completionBlockersReport = collectBoundedWorkerClaimBlockers(completion.blockers ?? []);
	const actionBlockers: string[] = [...completionBlockersReport.values];
	if (changedFilesOverflowed) {
		actionBlockers.push("worker changed-file report exceeded the durable claim bound; parent review is required");
	}
	if (completionBlockersReport.overflowed) {
		actionBlockers.push("worker blocker report exceeded the durable claim bound; parent review is required");
	}
	if (!writeCapable && completionChangedFiles.length > 0) {
		actionBlockers.push("worker reported file changes without a filesystem.write envelope grant");
	}
	if (writeCapable && parsed.status !== "blocked" && parsed.actions.length > 0 && options.applyActions) {
		// Runner-side application through the envelope path scope: refusals and failures are
		// surfaced as blockers so a partially-applied change can never look like clean success.
		const applied = options.applyActions(parsed.actions);
		const appliedChangedFilesReport = collectBoundedWorkerClaimChangedFiles(applied.changedFiles);
		const mergedAppliedChangedFilesReport = collectBoundedWorkerClaimChangedFiles([
			...changedFiles,
			...appliedChangedFilesReport.values,
		]);
		changedFiles = mergedAppliedChangedFilesReport.values;
		if (appliedChangedFilesReport.overflowed || mergedAppliedChangedFilesReport.overflowed) {
			actionBlockers.push("applied changed-file report exceeded the durable claim bound; parent review is required");
		}
		for (const refusal of applied.refused) {
			actionBlockers.push(`action refused (${refusal.path}): ${refusal.reason}`);
		}
		for (const failure of applied.failed) {
			actionBlockers.push(`action failed (${failure.path}): ${failure.reason}`);
		}
		for (const inspection of applied.inspectionRequired) {
			actionBlockers.push(
				`action requires workspace/evidence inspection (${inspection.path}, ${inspection.state}): ${inspection.reasonCode}`,
			);
		}
	} else if (!writeCapable && parsed.actions.length > 0) {
		actionBlockers.push("worker emitted file actions without a filesystem.write envelope grant; nothing was applied");
	}
	const allBlockersReport = collectBoundedWorkerClaimBlockers([...parsed.blockers, ...actionBlockers]);
	const allBlockers = allBlockersReport.overflowed
		? [
				...allBlockersReport.values.slice(0, Math.max(0, MAX_WORKER_CLAIM_BLOCKERS - 1)),
				"worker blocker report exceeded the durable claim bound; parent review is required",
			]
		: allBlockersReport.values;
	const claim: WorkerClaim = {
		...baseClaim,
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

	if (claim.status === "blocked") {
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			claim,
			laneStatus: "failed",
			reasonCode: "worker_blocked",
			costUsd,
		});
	}

	const overBudget = options.maxUsd !== undefined && costUsd > options.maxUsd;
	return finishOutcome({
		request: options.request,
		cwd: options.cwd,
		claim,
		laneStatus: overBudget ? "budget_exhausted" : "succeeded",
		reasonCode: overBudget
			? "cost_budget_exceeded"
			: claim.verification
				? claim.verification.verdict === "accepted"
					? "verification_accepted"
					: "verification_rejected"
				: "worker_completed",
		costUsd,
	});
}
