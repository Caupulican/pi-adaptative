import { runBoundedCompletion } from "../autonomy/bounded-completion.ts";
import type { EvidenceBundle, EvidenceRef, GateOutcome, WorkerClaim, WorkerRequest } from "../autonomy/contracts.ts";
import {
	type EvidenceFindingDraft,
	normalizeEvidenceFinding,
	projectEvidenceFindings,
} from "../autonomy/evidence-finding-projection.ts";
import type { LaneTerminalStatus } from "../autonomy/lane-tracker.ts";
import type { WorkerRole } from "../orchestration/contracts.ts";
import {
	buildVerifierSystemPrompt,
	buildWorkerSystemPrompt,
	WORKER_LANE_SYSTEM_PROMPT,
	WORKER_OPERATOR_LANE_SYSTEM_PROMPT,
	WORKER_WRITE_LANE_SYSTEM_PROMPT,
} from "../provider-prompt-contracts.ts";
import { createEvidenceBundle } from "../research/evidence-bundle.ts";
import {
	type AppliedActionsReport,
	parseWorkerActions,
	type RejectedWorkerActions,
	type WorkerAction,
} from "./worker-actions.ts";
import {
	clipWorkerClaimSummary,
	collectBoundedWorkerClaimBlockers,
	collectBoundedWorkerClaimChangedFiles,
	MAX_WORKER_CLAIM_BLOCKER_CHARS,
	MAX_WORKER_CLAIM_BLOCKERS,
	normalizeWorkerClaimForHost,
	validateWorkerClaim,
} from "./worker-claim.ts";

export {
	buildVerifierSystemPrompt,
	buildWorkerSystemPrompt,
	WORKER_LANE_SYSTEM_PROMPT,
	WORKER_OPERATOR_LANE_SYSTEM_PROMPT,
	WORKER_WRITE_LANE_SYSTEM_PROMPT,
};

/**
 * Pure execution for one bounded specialist delegation: bounded isolated completion ->
 * parse -> untrusted `WorkerClaim` -> parent validation via {@link validateWorkerClaim}.
 *
 * The injected completion may be a bounded worker tool loop. Its tool surface is built and gated by
 * the host; this module keeps the structured-output contract and treats every claim as untrusted
 * until parent validation succeeds.
 */

export interface WorkerCompletion {
	text: string;
	costUsd: number;
	stopReason: string;
	/** Files successfully changed by the worker tool loop before it produced the final JSON. */
	changedFiles?: readonly string[];
	/** Capability refusals or execution failures observed inside the worker tool loop. */
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
	complete: (args: { systemPrompt: string; userPrompt: string; signal: AbortSignal }) => Promise<WorkerCompletion>;
	/** Live successful worker-tool mutations, including writes completed before timeout/cancellation. */
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
	/** Turns the worker into a read-only semantic verifier for this exact durable task. */
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
	/**
	 * Set by the caller (worker-delegation-controller.ts admission), never by runWorker itself, when
	 * a pin policy is active, the effective role has no pin, and the caller requested an explicit
	 * model — i.e. the owner's model pin was evaded, not merely inapplicable. Diagnostics only.
	 */
	modelPinBypass?: WorkerRole;
}

export function buildWorkerUserPrompt(request: WorkerRequest): string {
	return [
		"TASK",
		request.instructions,
		"END TASK",
		'Do not replace the worker claim envelope; put requested detail inside "summary" and "findings".',
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
	let start: number | undefined;
	let depth = 0;
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
			if (depth === 0) start = index;
			depth++;
			if (depth > MAX_WORKER_JSON_DEPTH) return ranges.map((range) => text.slice(range.start, range.end));
			continue;
		}
		if (character !== "}") continue;
		if (depth === 0) continue;
		depth--;
		if (depth !== 0 || start === undefined || ranges.length >= MAX_WORKER_JSON_CANDIDATES) continue;
		const end = index + 1;
		if (end - start <= MAX_WORKER_OUTPUT_CHARS) ranges.push({ start, end });
		start = undefined;
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
function extractMalformedWorkerRecord(text: string): Record<string, unknown> | undefined {
	return workerOutputRecords(text).find((record) => {
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

function extractWorkerFindingDrafts(rawFindings: unknown): EvidenceFindingDraft[] {
	if (!Array.isArray(rawFindings)) return [];
	const findings: EvidenceFindingDraft[] = [];
	for (let index = 0; index < rawFindings.length && index < MAX_WORKER_FINDINGS; index++) {
		const finding = normalizeEvidenceFinding(rawFindings[index], MAX_WORKER_FINDING_CHARS);
		if (finding) findings.push(finding);
	}
	return findings;
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
		const findings = extractWorkerFindingDrafts(record.findings);
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
			summary: clipWorkerClaimSummary(summary.trim()),
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

function buildWorkerEvidenceBundle(args: {
	request: WorkerRequest;
	findings?: readonly EvidenceFindingDraft[];
	rawText?: string;
	summary?: string;
}): EvidenceBundle | undefined {
	const raw = args.rawText?.trim();
	const drafts: EvidenceFindingDraft[] = [];
	if (args.findings && args.findings.length > 0) {
		drafts.push(...args.findings.slice(0, MAX_WORKER_FINDINGS));
	} else if (raw && raw.length > 0) {
		const usefulSummary = args.summary?.trim() || raw;
		drafts.push({
			summary: clipWorkerClaimSummary(usefulSummary).slice(0, MAX_WORKER_FINDING_CHARS),
		});
	} else {
		return undefined;
	}

	const instructionsRef: EvidenceRef = {
		id: "src-instructions",
		kind: "user",
		title: "Delegated task instructions",
		trusted: true,
		excerpt: args.request.instructions.slice(0, 2000),
	};
	const synthesisRef: EvidenceRef = {
		id: "src-worker",
		kind: "tool",
		title: raw ? "Delegated worker report" : "Delegated worker synthesis",
		trusted: false,
		...(raw ? { excerpt: raw.slice(0, 8_000) } : {}),
	};
	return createEvidenceBundle({
		query: `worker:${args.request.id}`,
		sources: [instructionsRef, synthesisRef],
		findings: projectEvidenceFindings(drafts, synthesisRef.id),
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

function finalizeTerminalClaim(args: {
	request: WorkerRequest;
	claim: WorkerClaim;
	defaultReasonCode: string;
	costUsd: number;
	maxUsd?: number;
	cwd?: string;
}): WorkerRunOutcome {
	if (args.claim.status === "blocked") {
		return finishOutcome({
			request: args.request,
			cwd: args.cwd,
			claim: args.claim,
			laneStatus: "blocked",
			reasonCode: "worker_blocked",
			costUsd: args.costUsd,
		});
	}

	const overBudget = args.maxUsd !== undefined && args.costUsd > args.maxUsd;
	const finalClaim: WorkerClaim = overBudget
		? {
				...args.claim,
				status: "partial",
				blockers: [...(args.claim.blockers ?? []), "cost_budget_exceeded"],
			}
		: args.claim;
	return finishOutcome({
		request: args.request,
		cwd: args.cwd,
		claim: finalClaim,
		laneStatus: overBudget ? "budget_exhausted" : "succeeded",
		reasonCode: overBudget ? "cost_budget_exceeded" : args.defaultReasonCode,
		costUsd: args.costUsd,
	});
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
					? buildVerifierSystemPrompt(options.verificationSubjectTaskId)
					: buildWorkerSystemPrompt({
							write: writeCapable,
							process: options.processCapable === true,
						}),
				userPrompt: buildWorkerUserPrompt(options.request),
				signal,
			}),
	});
	const costUsd = bounded.completion?.costUsd ?? 0;
	const liveChangedFilesReport = collectBoundedWorkerClaimChangedFiles(options.getChangedFiles?.() ?? []);
	const liveChangedFiles = liveChangedFilesReport.values;

	if (bounded.failure) {
		const isBudgetExhausted =
			bounded.failure.status === "budget_exhausted" ||
			bounded.failure.reasonCode.includes("budget_exhausted") ||
			bounded.failure.reasonCode.includes("cost_budget_exceeded");
		const cancelled = bounded.failure.status === "canceled" || bounded.failure.status === "timeout";
		const blockers = [
			...(liveChangedFilesReport.overflowed
				? ["worker changed-file report exceeded the durable claim bound; parent review is required"]
				: []),
			...(isBudgetExhausted ? [`budget limit reached: ${bounded.failure.reasonCode}`] : []),
		];
		const status = isBudgetExhausted ? "partial" : cancelled ? "cancelled" : "failed";
		const summary = isBudgetExhausted
			? `Worker paused at budget limit (${bounded.failure.reasonCode})${
					bounded.failure.detail ? `: ${bounded.failure.detail}` : "."
				}`
			: `Worker did not complete: ${bounded.failure.reasonCode}${
					bounded.failure.detail ? ` — ${bounded.failure.detail}` : ""
				}${
					bounded.failure.reasonCode === "wall_clock_exceeded"
						? " (the cap is workerDelegation.maxWallClockMs; raise it or narrow the task)"
						: ""
				}`;
		const failureEvidence = bounded.completion?.text?.trim()
			? buildWorkerEvidenceBundle({
					request: options.request,
					rawText: bounded.completion.text,
				})
			: undefined;
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			claim: {
				...baseClaim,
				changedFiles: liveChangedFiles,
				status,
				summary,
				...(blockers.length > 0 ? { blockers } : {}),
				...(failureEvidence ? { evidence: failureEvidence } : {}),
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
		const modelErrorEvidence = completion?.text?.trim()
			? buildWorkerEvidenceBundle({
					request: options.request,
					rawText: completion.text,
				})
			: undefined;
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			claim: {
				...completionBaseClaim,
				status: "failed",
				summary: "Worker model call failed.",
				...(modelErrorEvidence ? { evidence: modelErrorEvidence } : {}),
			},
			laneStatus: "failed",
			reasonCode: "model_error",
			costUsd,
		});
	}

	const parsed = parseWorkerOutput(completion.text);
	if (!parsed) {
		const malformedRecord = extractMalformedWorkerRecord(completion.text);
		if (malformedRecord) {
			const malformedFindings = extractWorkerFindingDrafts(malformedRecord.findings);
			const malformedSummary =
				typeof malformedRecord.summary === "string" && malformedRecord.summary.trim().length > 0
					? malformedRecord.summary
					: undefined;
			const malformedEvidence = buildWorkerEvidenceBundle({
				request: options.request,
				rawText: completion.text,
				findings: malformedFindings.length > 0 ? malformedFindings : undefined,
				summary: malformedSummary,
			});
			return finishOutcome({
				request: options.request,
				cwd: options.cwd,
				claim: {
					...completionBaseClaim,
					status: "failed",
					summary: "Worker output used a malformed structured claim envelope.",
					...(malformedEvidence ? { evidence: malformedEvidence } : {}),
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
			const summary = clipWorkerClaimSummary(completion.text.trim(), incompleteNote);
			const blocked = completionBlockers.length > 0;
			const claim: WorkerClaim = {
				...completionBaseClaim,
				status: blocked ? "blocked" : "completed",
				outputFormat: "plain_text",
				summary,
				...(blocked ? { blockers: completionBlockers } : {}),
			};
			return finalizeTerminalClaim({
				request: options.request,
				cwd: options.cwd,
				claim,
				defaultReasonCode:
					completion.stopReason === "stop"
						? "worker_completed_plain_text"
						: "worker_completed_plain_text_incomplete",
				costUsd,
				maxUsd: options.maxUsd,
			});
		}
		// A provider length stop is a truncation, not a format failure: the worker was cut off before
		// its envelope could close (measured live: two complete envelopes cut at a 2048-token cap were
		// reported as invalid JSON). Name the real cause so the parent re-runs with a tighter ask
		// instead of blaming the worker's output format.
		const truncated = completion.stopReason === "length";
		const unparseableEvidence =
			completion.text.trim().length > 0
				? buildWorkerEvidenceBundle({
						request: options.request,
						rawText: completion.text,
					})
				: undefined;
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			claim: {
				...completionBaseClaim,
				status: "failed",
				summary: truncated
					? "Worker output was cut off at the provider output-token limit (stop reason 'length') before a valid claim envelope closed."
					: "Worker output was not valid structured JSON.",
				...(changedFilesOverflowed
					? {
							blockers: [
								"worker changed-file report exceeded the durable claim bound; parent review is required",
							],
						}
					: {}),
				...(unparseableEvidence ? { evidence: unparseableEvidence } : {}),
			},
			laneStatus: "failed",
			reasonCode: truncated ? "output_truncated" : "unparseable_output",
			costUsd,
		});
	}

	const evidence = buildWorkerEvidenceBundle({ request: options.request, findings: parsed.findings });
	if (parsed.actionRejection) {
		const rejectionEvidence = buildWorkerEvidenceBundle({
			request: options.request,
			findings: parsed.findings,
			rawText: completion.text,
			summary: parsed.summary,
		});
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			claim: {
				...completionBaseClaim,
				status: "failed",
				summary: clipWorkerClaimSummary(parsed.summary.trim()),
				blockers: [parsed.actionRejection.reasonCode],
				...(rejectionEvidence ? { evidence: rejectionEvidence } : {}),
			},
			laneStatus: "failed",
			reasonCode: "unparseable_output",
			costUsd,
		});
	}
	if (options.verificationSubjectTaskId && (!parsed.verdict || parsed.reasonCodes.length === 0)) {
		const verifierEvidence = buildWorkerEvidenceBundle({
			request: options.request,
			findings: parsed.findings.length > 0 ? parsed.findings : undefined,
			rawText: completion.text,
			summary: parsed.summary,
		});
		return finishOutcome({
			request: options.request,
			cwd: options.cwd,
			claim: {
				...completionBaseClaim,
				status: "failed",
				summary: "Verifier output omitted its typed verdict or reasonCodes.",
				...(verifierEvidence ? { evidence: verifierEvidence } : {}),
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

	return finalizeTerminalClaim({
		request: options.request,
		cwd: options.cwd,
		claim,
		defaultReasonCode: claim.verification
			? claim.verification.verdict === "accepted"
				? "verification_accepted"
				: "verification_rejected"
			: "worker_completed",
		costUsd,
		maxUsd: options.maxUsd,
	});
}
