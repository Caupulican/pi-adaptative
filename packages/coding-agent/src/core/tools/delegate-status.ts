import type { Finding, WorkerClaim } from "../autonomy/contracts.ts";
import { normalizeEvidenceFinding } from "../autonomy/evidence-finding-projection.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { WORKER_COMPLETION_ERROR_CAVEMAN_GUIDANCE } from "../delegation/worker-terminal-handoff-coordinator.ts";
import { workerTerminalOutputArtifact } from "../delegation/worker-terminal-output-artifact.ts";
import type { WorkerResultContract } from "../orchestration/contracts.ts";
import {
	MAX_EVIDENCE_FINDING_ID_CHARS,
	MAX_EVIDENCE_FINDINGS,
	MAX_EVIDENCE_IDS_PER_FINDING,
	MAX_EVIDENCE_SOURCE_ID_CHARS,
	MAX_EVIDENCE_TEXT_CHARS,
} from "../research/evidence-bundle.ts";
import { utf8PrefixByBytes } from "../util/bounded-value.ts";
import type { OrchestrationPanelModel, OrchestrationPanelRow } from "./orchestration-panel.ts";

const MAX_WORKER_CONTROL_ID_CHARS = 512;

export const MAX_DELEGATE_STATUS_OUTPUT_BYTES = 16 * 1024;

export function projectClaimFindings(findings: readonly Finding[] | undefined): readonly Finding[] {
	if (!findings || !Array.isArray(findings) || findings.length === 0) return [];
	const projected: Finding[] = [];
	for (let i = 0; i < findings.length && projected.length < MAX_EVIDENCE_FINDINGS; i++) {
		const raw = findings[i];
		const normalized = normalizeEvidenceFinding(raw, MAX_EVIDENCE_TEXT_CHARS);
		if (!normalized) continue;
		if (typeof raw.id !== "string" || raw.id.trim().length === 0) continue;
		const id = raw.id.trim().slice(0, MAX_EVIDENCE_FINDING_ID_CHARS);
		const evidenceIds = Array.isArray(raw.evidenceIds)
			? (raw.evidenceIds as readonly unknown[])
					.filter(
						(evidenceId: unknown): evidenceId is string =>
							typeof evidenceId === "string" && evidenceId.trim().length > 0,
					)
					.slice(0, MAX_EVIDENCE_IDS_PER_FINDING)
					.map((evidenceId: string) => evidenceId.trim().slice(0, MAX_EVIDENCE_SOURCE_ID_CHARS))
			: [];
		projected.push({
			id,
			summary: normalized.summary,
			evidenceIds,
			...(normalized.confidence !== undefined ? { confidence: normalized.confidence } : {}),
		});
	}
	return projected;
}

export const WORKER_QUEUED_CAVEMAN_GUIDANCE =
	"CAVEMAN MODE - MANDATORY: queued is admitted durable nonterminal state, not stall or harness failure. Host starts it event-driven when dependencies, capacity, or explicit workspace reservations clear; the waiting line names which one and since when. A write reservation held by a dead owner is released automatically; one held by a live worker of another session clears only when that worker finishes. Never poll, interrupt, or cancel a healthy running worker to force the queue. Independent machine-scope workers may run in parallel; an explicit path preserves collision fencing. If you start a fresh narrower replacement, cancel this queued agent after the replacement starts; otherwise both tasks will run.";

export const DELEGATE_STATUS_ACTIONS = ["status", "review"] as const;

export type DelegateStatusAction = (typeof DELEGATE_STATUS_ACTIONS)[number];

export interface DelegateStatusInput {
	laneId?: string;
}

export interface DelegateStatusLaneView {
	laneId: string;
	label?: string;
	profileId?: string;
	modelRef?: string;
	thinkingLevel?: NonNullable<LaneRecord["thinkingLevel"]>;
	type: LaneRecord["type"];
	status: LaneRecord["status"];
	/** Binding status of the lane's logical agent when known; "retired" takes no follow_up, resume, or wait. */
	agentStatus?: NonNullable<LaneRecord["agentStatus"]>;
	reasonCode?: string;
	/** Present only for a queued lane this controller generation has evaluated and parked. */
	waitReason?: string;
	unreviewed: boolean;
}

export interface DelegateStatusToolDetails {
	started: boolean;
	action: DelegateStatusAction;
	kind: "overview" | "lane" | "review" | "error";
	count?: number;
	queued?: number;
	running?: number;
	terminal?: number;
	unreviewedCount?: number;
	unreviewedLaneIds?: readonly string[];
	lanes?: readonly DelegateStatusLaneView[];
	laneId?: string;
	status?: LaneRecord["status"];
	unreviewed?: boolean;
	reviewed?: boolean;
	reviewedAt?: string;
	reason?: string;
	claimSummary?: string;
	outputArtifactUri?: string;
	outputArtifactSizeBytes?: number;
	changedFiles?: readonly string[];
	omittedChangedFilesCount?: number;
	blockers?: readonly string[];
	omittedBlockersCount?: number;
	findings?: readonly Finding[];
	omittedFindingsCount?: number;
}

export type AcknowledgeWorkerReviewResult =
	| { ok: true; requestId: string; reviewedAt: string }
	| { ok: false; reason: "unknown_worker_claim" | "not_flagged" | "already_reviewed" };

export interface DelegateStatusDependencies {
	getLaneRecords(): LaneRecord[];
	getWorkerClaimSnapshots(): WorkerClaim[];
	getWorkerResult?(laneId: string): Pick<WorkerResultContract, "artifacts"> | undefined;
	acknowledgeWorkerReview?(requestId: string): AcknowledgeWorkerReviewResult;
	/** Mark only terminal records that made it into this bounded status response as exposed. */
	observeExposedTerminalRecords?(records: readonly LaneRecord[]): void;
}

function isUnreviewed(claim: WorkerClaim | undefined): boolean {
	return claim?.parentReviewRequired === true && claim.parentReviewedAt === undefined;
}

function isDelegatedWorkerLane(record: LaneRecord): boolean {
	return record.type === "worker" || record.type === "tmux-worker";
}

function formattedRecordStatus(record: LaneRecord): string {
	const retryReason =
		record.status === "running" && record.reasonCode?.startsWith("retry_scheduled:")
			? record.reasonCode.slice("retry_scheduled:".length)
			: undefined;
	if (retryReason) {
		return `retrying after transient ${retryReason} (nonterminal; durable state preserved; terminal handoff pending)`;
	}
	return `${record.status}${record.reasonCode ? ` (${record.reasonCode})` : ""}`;
}

class RecordTextBudgetBuilder {
	private readonly lines: string[] = [];
	private currentBytes = 0;
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	get byteLength(): number {
		return this.lines.length === 0 ? 0 : this.currentBytes + (this.lines.length - 1);
	}

	get remainingBytes(): number {
		return Math.max(0, this.maxBytes - this.byteLength);
	}

	canFit(candidateLines: readonly string[]): boolean {
		if (candidateLines.length === 0) return true;
		let addition = 0;
		for (let i = 0; i < candidateLines.length; i++) {
			addition += Buffer.byteLength(candidateLines[i], "utf8");
		}
		const newTotalLines = this.lines.length + candidateLines.length;
		const newTotalBytes = this.currentBytes + addition + (newTotalLines - 1);
		return newTotalBytes <= this.maxBytes;
	}

	tryAppend(candidateLines: readonly string[]): boolean {
		if (!this.canFit(candidateLines)) return false;
		for (let i = 0; i < candidateLines.length; i++) {
			this.lines.push(candidateLines[i]);
			this.currentBytes += Buffer.byteLength(candidateLines[i], "utf8");
		}
		return true;
	}

	build(): string {
		return this.lines.join("\n");
	}
}

interface BudgetedDetailsFieldResult<TItem> {
	items: TItem[];
	omittedCount: number;
}

function budgetDetailsField<TItem>(
	baseDetails: DelegateStatusToolDetails,
	field: string,
	omittedField: string,
	items: readonly TItem[],
	maxBytes: number,
): BudgetedDetailsFieldResult<TItem> {
	if (items.length === 0) {
		return { items: [], omittedCount: 0 };
	}
	const included: TItem[] = [];
	let omittedCount = 0;

	for (let i = 0; i < items.length; i++) {
		const remainingOmitted = items.length - (i + 1);
		const trial = {
			...baseDetails,
			[field]: [...included, items[i]],
			...(remainingOmitted > 0 ? { [omittedField]: remainingOmitted } : {}),
		};
		if (Buffer.byteLength(JSON.stringify(trial), "utf8") > maxBytes) {
			omittedCount = items.length - i;
			break;
		}
		included.push(items[i]);
	}

	let finalOmitted = 0;
	if (omittedCount > 0) {
		const trialWithOmission = {
			...baseDetails,
			...(included.length > 0 ? { [field]: included } : {}),
			[omittedField]: omittedCount,
		};
		if (Buffer.byteLength(JSON.stringify(trialWithOmission), "utf8") <= maxBytes) {
			finalOmitted = omittedCount;
		}
	}

	return { items: included, omittedCount: finalOmitted };
}

interface FormattedRecordResult {
	text: string;
	complete: boolean;
}

function formatRecord(
	record: LaneRecord,
	claim: WorkerClaim | undefined,
	result?: Pick<WorkerResultContract, "artifacts">,
	maxRecordBytes = MAX_DELEGATE_STATUS_OUTPUT_BYTES,
): FormattedRecordResult {
	const builder = new RecordTextBudgetBuilder(maxRecordBytes);
	const boundedLaneId = record.laneId.slice(0, MAX_WORKER_CONTROL_ID_CHARS);
	const headerLines: string[] = [`${boundedLaneId}: ${formattedRecordStatus(record)}`];
	if (record.agentStatus === "retired") {
		headerLines.push(
			"agent retired: no follow_up, resume, or wait; delegate transcript still reads its conversation.",
		);
	}
	if (record.modelRef) {
		headerLines.push(
			`effective model: ${record.modelRef.slice(0, 256)}; thinking: ${record.thinkingLevel ?? "unknown"}`,
		);
	}
	if (record.status === "queued") {
		if (record.waitReason) headerLines.push(`waiting: ${record.waitReason.slice(0, 512)}`);
		headerLines.push(WORKER_QUEUED_CAVEMAN_GUIDANCE);
	}
	if (record.reasonCode === "worker_blocked") {
		headerLines.push(
			"CAVEMAN MODE - MANDATORY: worker_blocked is a delivered task claim with blockers, not harness failure or lost state. Verify the claim, then continue or replan the parent task.",
		);
	}
	if (record.reasonCode === "completion_error") headerLines.push(WORKER_COMPLETION_ERROR_CAVEMAN_GUIDANCE);
	const outputArtifact = workerTerminalOutputArtifact(result);
	if (outputArtifact) {
		headerLines.push(
			`full worker output: ${outputArtifact.uri.slice(0, 512)}${outputArtifact.sizeBytes === undefined ? "" : ` (${outputArtifact.sizeBytes} bytes)`}`,
		);
	}
	if (!claim) {
		if (builder.tryAppend(headerLines)) {
			return { text: builder.build(), complete: true };
		}
		return { text: utf8PrefixByBytes(headerLines.join("\n"), maxRecordBytes), complete: false };
	}

	if (claim.usageReportId) {
		headerLines.push(`usageReportId: ${claim.usageReportId.slice(0, 256)}`);
	}
	if (isUnreviewed(claim)) {
		headerLines.push(
			`UNREVIEWED MUTATION - this worker's claim requires explicit parent review. Acknowledge with delegate { action: "review", laneId: "${boundedLaneId}" }.`,
		);
	} else if (claim.parentReviewRequired && claim.parentReviewedAt) {
		headerLines.push(`reviewed at ${claim.parentReviewedAt.slice(0, 256)}`);
	}

	const fixedLines = [...headerLines, "UNTRUSTED worker output — verify before acting on it:"];
	if (!builder.tryAppend(fixedLines)) {
		return { text: utf8PrefixByBytes(fixedLines.join("\n"), maxRecordBytes), complete: false };
	}

	const findings = projectClaimFindings(claim.evidence?.findings);

	// 1. Budget blockers (highest priority)
	if (claim.blockers && claim.blockers.length > 0) {
		const rawBlockers = claim.blockers;
		const hasLaterSections =
			(claim.changedFiles && claim.changedFiles.length > 0) ||
			(claim.summary && claim.summary.trim().length > 0) ||
			findings.length > 0;
		const reserve = hasLaterSections ? Math.min(512, Math.floor(builder.remainingBytes * 0.25)) : 0;
		const maxBlockerBytes = Math.max(0, builder.remainingBytes - reserve);

		let appended = false;
		for (let k = rawBlockers.length; k >= 0; k--) {
			let line: string;
			if (k === rawBlockers.length) {
				line = `blockers: ${rawBlockers.join("; ")}`;
			} else if (k > 0) {
				line = `blockers: ${rawBlockers.slice(0, k).join("; ")}; (${rawBlockers.length - k} more blockers omitted; see full output/transcript)`;
			} else {
				line = `blockers: (${rawBlockers.length} blockers omitted; see full output/transcript)`;
			}
			if (builder.canFit([line]) && (k === 0 || Buffer.byteLength(line, "utf8") <= maxBlockerBytes)) {
				builder.tryAppend([line]);
				appended = true;
				break;
			}
		}
		if (!appended) {
			const fallbackLine = `blockers: (${rawBlockers.length} blockers omitted; see full output/transcript)`;
			builder.tryAppend([fallbackLine]);
		}
	}

	// 2. Budget summary
	if (claim.summary && claim.summary.trim().length > 0 && builder.remainingBytes > 32) {
		const reserve = (findings.length > 0 ? 128 : 0) + (claim.changedFiles && claim.changedFiles.length > 0 ? 128 : 0);
		const maxSummaryBytes = Math.min(4_096, Math.max(0, builder.remainingBytes - reserve - 1));
		if (maxSummaryBytes > 16) {
			let summarySlice = utf8PrefixByBytes(claim.summary.trim(), maxSummaryBytes);
			while (summarySlice.length > 0 && !builder.canFit([summarySlice])) {
				summarySlice = summarySlice.slice(0, -10);
			}
			if (summarySlice.length > 0) {
				builder.tryAppend([summarySlice]);
			}
		}
	}

	// 3. Budget findings
	if (findings.length > 0 && builder.remainingBytes > 16) {
		const reserve = claim.changedFiles && claim.changedFiles.length > 0 ? 128 : 0;
		const maxFindingsBytes = Math.max(0, builder.remainingBytes - reserve);
		for (let k = findings.length; k >= 0; k--) {
			const candidateLines: string[] = ["findings:"];
			if (k === 0) {
				candidateLines.push(`  (${findings.length} findings omitted; see full output/transcript)`);
			} else {
				for (let i = 0; i < k; i++) {
					const finding = findings[i];
					const confidence = finding.confidence !== undefined ? ` (confidence: ${finding.confidence})` : "";
					candidateLines.push(`- finding: ${finding.summary}${confidence}`);
				}
				if (k < findings.length) {
					candidateLines.push(`  (${findings.length - k} more findings omitted)`);
				}
			}
			let candidateBytes = 0;
			for (let i = 0; i < candidateLines.length; i++) {
				candidateBytes += Buffer.byteLength(candidateLines[i], "utf8");
			}
			const totalCandidateWithSeparators = candidateBytes + (candidateLines.length - 1);
			if (builder.canFit(candidateLines) && (k === 0 || totalCandidateWithSeparators <= maxFindingsBytes)) {
				builder.tryAppend(candidateLines);
				break;
			}
		}
	}

	// 4. Budget changed files
	if (claim.changedFiles && claim.changedFiles.length > 0 && builder.remainingBytes > 16) {
		const rawFiles = claim.changedFiles;
		for (let k = rawFiles.length; k >= 0; k--) {
			let line: string;
			if (k === rawFiles.length) {
				line = `changed files: ${rawFiles.join(", ")}`;
			} else if (k > 0) {
				line = `changed files: ${rawFiles.slice(0, k).join(", ")}, and ${rawFiles.length - k} more`;
			} else {
				line = `changed files: (${rawFiles.length} files omitted)`;
			}
			if (builder.canFit([line])) {
				builder.tryAppend([line]);
				break;
			}
		}
	}

	return { text: builder.build(), complete: true };
}

function laneView(record: LaneRecord, claim: WorkerClaim | undefined): DelegateStatusLaneView {
	return {
		laneId: record.laneId.slice(0, MAX_WORKER_CONTROL_ID_CHARS),
		...(record.label ? { label: record.label.slice(0, 256) } : {}),
		...(record.profileId ? { profileId: record.profileId.slice(0, 256) } : {}),
		...(record.modelRef ? { modelRef: record.modelRef.slice(0, 256) } : {}),
		...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
		type: record.type,
		status: record.status,
		...(record.agentStatus ? { agentStatus: record.agentStatus } : {}),
		...(record.reasonCode ? { reasonCode: record.reasonCode.slice(0, 256) } : {}),
		...(record.status === "queued" && record.waitReason ? { waitReason: record.waitReason.slice(0, 512) } : {}),
		unreviewed: isUnreviewed(claim),
	};
}

function lanePanelRow(view: DelegateStatusLaneView, details?: DelegateStatusToolDetails): OrchestrationPanelRow {
	const meta = [
		view.label ? view.laneId : undefined,
		view.profileId ? `profile ${view.profileId}` : undefined,
		view.modelRef ? `model ${view.modelRef}` : undefined,
		view.thinkingLevel ? `thinking ${view.thinkingLevel}` : undefined,
		view.type === "tmux-worker" ? "tmux" : undefined,
		view.reasonCode,
		view.agentStatus === "retired" ? "retired" : undefined,
		view.unreviewed ? "review required" : undefined,
	].filter((value): value is string => value !== undefined);
	const expandedDetails = [
		details?.outputArtifactUri ? `full output: ${details.outputArtifactUri}` : undefined,
		details?.claimSummary ? `untrusted claim: ${details.claimSummary}` : undefined,
		details?.changedFiles?.length ? `changed: ${details.changedFiles.join(", ")}` : undefined,
		...(details?.blockers ?? []).map((blocker) => `blocker: ${blocker}`),
		...(details?.findings ?? []).map((finding) => `finding: ${finding.summary}`),
	].filter((value): value is string => value !== undefined);
	return {
		status: view.status,
		label: view.label ?? view.laneId,
		meta,
		details: expandedDetails,
	};
}

export function delegateStatusPanelModel(details: DelegateStatusToolDetails): OrchestrationPanelModel {
	if (details.kind === "error") {
		return {
			label: "workers",
			action: "status",
			status: "error",
			emptyText: details.reason ?? "Worker status is unavailable.",
		};
	}
	if (details.kind === "review") {
		return {
			label: "workers",
			action: details.reviewed ? "reviewed" : "review required",
			status: details.reviewed ? "success" : "warning",
			rows: details.laneId
				? [
						{
							status: details.reviewed ? "reviewed" : "blocked",
							label: details.laneId,
							meta: details.reviewedAt ? [`reviewed ${details.reviewedAt}`] : undefined,
						},
					]
				: undefined,
			emptyText: details.reason,
		};
	}
	const lanes = details.lanes ?? [];
	const rows = lanes.map((view) => lanePanelRow(view, details.kind === "lane" ? details : undefined));
	const running = details.running ?? lanes.filter((lane) => lane.status === "running").length;
	const queued = details.queued ?? lanes.filter((lane) => lane.status === "queued").length;
	const terminal = details.terminal ?? lanes.length - running - queued;
	const unreviewed = details.unreviewedCount ?? lanes.filter((lane) => lane.unreviewed).length;
	return {
		label: "workers",
		action: details.kind === "lane" ? "lane" : "status",
		status: unreviewed > 0 ? "warning" : running + queued > 0 ? "running" : lanes.length > 0 ? "success" : "idle",
		summary: [
			running ? `${running} running` : undefined,
			queued ? `${queued} queued` : undefined,
			terminal ? `${terminal} terminal` : undefined,
		].filter((value): value is string => value !== undefined),
		rows,
		emptyText: "No worker lanes.",
		notices:
			unreviewed > 0
				? [
						{
							status: "warning",
							text: `${unreviewed} worker mutation${unreviewed === 1 ? "" : "s"} awaiting parent review.`,
						},
					]
				: undefined,
	};
}

export function executeDelegateStatusAction(
	action: DelegateStatusAction,
	input: DelegateStatusInput,
	deps: DelegateStatusDependencies,
): { content: Array<{ type: "text"; text: string }>; details: DelegateStatusToolDetails } {
	if (action === "review") {
		if (!input.laneId?.trim()) {
			return {
				content: [{ type: "text", text: "delegate review requires laneId" }],
				details: { started: false, action, kind: "review", reviewed: false, reason: "missing_lane_id" },
			};
		}
		if (input.laneId.length > MAX_WORKER_CONTROL_ID_CHARS) {
			return {
				content: [{ type: "text", text: "delegate review laneId is invalid" }],
				details: { started: false, action, kind: "review", reviewed: false, reason: "invalid_lane_id" },
			};
		}
		const laneId = input.laneId.trim();
		if (!deps.acknowledgeWorkerReview) {
			return {
				content: [{ type: "text", text: "review acknowledgement is not available in this session" }],
				details: { started: false, action, kind: "review", reviewed: false, reason: "review_unsupported" },
			};
		}
		const outcome = deps.acknowledgeWorkerReview(laneId);
		if (!outcome.ok) {
			return {
				content: [{ type: "text", text: `review not acknowledged (${laneId}): ${outcome.reason}` }],
				details: { started: false, action, kind: "review", laneId, reviewed: false, reason: outcome.reason },
			};
		}
		return {
			content: [{ type: "text", text: `reviewed ${laneId} at ${outcome.reviewedAt} — notice cleared` }],
			details: { started: true, action, kind: "review", laneId, reviewed: true, reviewedAt: outcome.reviewedAt },
		};
	}

	const records = deps.getLaneRecords().filter(isDelegatedWorkerLane);
	const claims = new Map(deps.getWorkerClaimSnapshots().map((claim) => [claim.requestId, claim]));
	const unreviewedRecords = records.filter((record) => isUnreviewed(claims.get(record.laneId)));

	if (input.laneId !== undefined) {
		if (input.laneId.length > MAX_WORKER_CONTROL_ID_CHARS || !input.laneId.trim()) {
			return {
				content: [{ type: "text", text: "worker lane id is invalid" }],
				details: { started: false, action, kind: "error", reason: "invalid_lane_id" },
			};
		}
		const laneId = input.laneId.trim();
		const record = records.find((candidate) => candidate.laneId === laneId);
		if (!record) {
			return {
				content: [{ type: "text", text: "unknown_worker_lane" }],
				details: { started: false, action, kind: "error", reason: "unknown_worker_lane" },
			};
		}
		const claim = claims.get(record.laneId);
		const workerResult = deps.getWorkerResult?.(record.laneId);
		const outputArtifact = workerTerminalOutputArtifact(workerResult);
		const findings = projectClaimFindings(claim?.evidence?.findings);
		const claimSummary = claim?.summary ? utf8PrefixByBytes(claim.summary, 1_024) : undefined;
		const rawBlockers = claim?.blockers ?? [];
		const rawChangedFiles = claim?.changedFiles ?? [];
		const detailsBase: DelegateStatusToolDetails = {
			started: true,
			action,
			kind: "lane",
			laneId: record.laneId.slice(0, MAX_WORKER_CONTROL_ID_CHARS),
			status: record.status,
			unreviewed: isUnreviewed(claim),
			lanes: [laneView(record, claim)],
			...(claimSummary ? { claimSummary } : {}),
			...(outputArtifact
				? {
						outputArtifactUri: outputArtifact.uri.slice(0, 512),
						...(outputArtifact.sizeBytes === undefined
							? {}
							: { outputArtifactSizeBytes: outputArtifact.sizeBytes }),
					}
				: {}),
		};

		const maxDetailsBudget = MAX_DELEGATE_STATUS_OUTPUT_BYTES - 64;

		// 1. Budget blockers first (highest priority)
		if (rawBlockers.length > 0) {
			const reserveForOthers = (rawChangedFiles.length > 0 ? 512 : 0) + (findings.length > 0 ? 512 : 0);
			const budgeted = budgetDetailsField(
				detailsBase,
				"blockers",
				"omittedBlockersCount",
				rawBlockers,
				maxDetailsBudget - reserveForOthers,
			);
			if (budgeted.items.length > 0) {
				detailsBase.blockers = budgeted.items;
			}
			if (budgeted.omittedCount > 0) {
				detailsBase.omittedBlockersCount = budgeted.omittedCount;
			}
		}

		// 2. Budget changed files
		if (rawChangedFiles.length > 0) {
			const reserveForFindings = findings.length > 0 ? 512 : 0;
			const budgeted = budgetDetailsField(
				detailsBase,
				"changedFiles",
				"omittedChangedFilesCount",
				rawChangedFiles,
				maxDetailsBudget - reserveForFindings,
			);
			if (budgeted.items.length > 0) {
				detailsBase.changedFiles = budgeted.items;
			}
			if (budgeted.omittedCount > 0) {
				detailsBase.omittedChangedFilesCount = budgeted.omittedCount;
			}
		}

		// 3. Budget findings
		if (findings.length > 0) {
			const candidateFindings: Finding[] = findings.map((f) => ({
				id: f.id,
				summary: utf8PrefixByBytes(f.summary, 500),
				evidenceIds: f.evidenceIds.slice(0, 4),
				...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
			}));
			const budgeted = budgetDetailsField(
				detailsBase,
				"findings",
				"omittedFindingsCount",
				candidateFindings,
				maxDetailsBudget,
			);
			if (budgeted.items.length > 0) {
				detailsBase.findings = budgeted.items;
			}
			if (budgeted.omittedCount > 0) {
				detailsBase.omittedFindingsCount = budgeted.omittedCount;
			}
		}

		// Hard ceiling guard for details
		if (
			Buffer.byteLength(JSON.stringify(detailsBase), "utf8") > MAX_DELEGATE_STATUS_OUTPUT_BYTES &&
			detailsBase.claimSummary
		) {
			delete detailsBase.claimSummary;
		}

		const formatted = formatRecord(record, claim, workerResult);
		if (record.status !== "queued" && record.status !== "running" && formatted.complete) {
			deps.observeExposedTerminalRecords?.([record]);
		}

		return {
			content: [{ type: "text", text: formatted.text }],
			details: detailsBase,
		};
	}

	const recentRecords = records.slice(-10);
	const recentLaneIds = new Set(recentRecords.map((record) => record.laneId));
	const queued = records.filter((record) => record.status === "queued").length;
	const running = records.filter((record) => record.status === "running").length;
	const terminal = records.length - queued - running;
	const olderUnreviewed = unreviewedRecords.filter((record) => !recentLaneIds.has(record.laneId));

	const overviewLines = [`workers: ${running} running, ${queued} queued, ${terminal} terminal`];
	if (unreviewedRecords.length > 0) {
		const maxUnreviewedTextBudget = 2_048;
		const visibleUnreviewedIds: string[] = [];
		let omitted = 0;
		let accumulatedBytes = 0;
		for (let i = 0; i < unreviewedRecords.length; i++) {
			const id = unreviewedRecords[i].laneId;
			const remaining = unreviewedRecords.length - i;
			const suffix = remaining > 1 ? `, and ${remaining} more` : "";
			const candidate = (visibleUnreviewedIds.length === 0 ? "" : ", ") + id;
			if (accumulatedBytes + Buffer.byteLength(candidate + suffix, "utf8") > maxUnreviewedTextBudget) {
				omitted = remaining;
				break;
			}
			visibleUnreviewedIds.push(id);
			accumulatedBytes += Buffer.byteLength(candidate, "utf8");
		}
		const listText =
			visibleUnreviewedIds.length > 0
				? `${visibleUnreviewedIds.join(", ")}${omitted > 0 ? `, and ${omitted} more` : ""}`
				: `(${unreviewedRecords.length} omitted)`;
		overviewLines.push(
			`${unreviewedRecords.length} unreviewed worker mutation${unreviewedRecords.length === 1 ? "" : "s"} pending review: ${listText}. Acknowledge each with delegate { action: "review", laneId }.`,
		);
	}
	const overview = overviewLines.join("\n");

	const deliveredRecent: string[] = [];
	const deliveredRecords: LaneRecord[] = [];
	let currentBudgetRemaining = MAX_DELEGATE_STATUS_OUTPUT_BYTES - Buffer.byteLength(overview, "utf8");

	for (const record of recentRecords) {
		const formatted = formatRecord(record, claims.get(record.laneId), deps.getWorkerResult?.(record.laneId), 2_048);
		if (!formatted.complete) {
			break;
		}
		const needed = 2 + Buffer.byteLength(formatted.text, "utf8");
		if (currentBudgetRemaining < needed) {
			break;
		}
		deliveredRecent.push(formatted.text);
		deliveredRecords.push(record);
		currentBudgetRemaining -= needed;
	}

	const olderDelivered: string[] = [];
	const olderCandidates = olderUnreviewed.slice(0, 10);
	if (olderCandidates.length > 0) {
		const olderHeader = "\n\nOlder unreviewed workers (outside the recent list):";
		const olderHeaderBytes = Buffer.byteLength(olderHeader, "utf8");
		if (currentBudgetRemaining >= olderHeaderBytes) {
			currentBudgetRemaining -= olderHeaderBytes;
			for (const record of olderCandidates) {
				const formatted = formatRecord(
					record,
					claims.get(record.laneId),
					deps.getWorkerResult?.(record.laneId),
					2_048,
				);
				if (!formatted.complete) {
					break;
				}
				const needed = 2 + Buffer.byteLength(formatted.text, "utf8");
				if (currentBudgetRemaining < needed) {
					break;
				}
				olderDelivered.push(formatted.text);
				deliveredRecords.push(record);
				currentBudgetRemaining -= needed;
			}
		}
	}

	deps.observeExposedTerminalRecords?.(
		deliveredRecords.filter((record) => record.status !== "queued" && record.status !== "running"),
	);

	const olderUnreviewedText =
		olderDelivered.length > 0
			? `\n\nOlder unreviewed workers (outside the recent list):\n${olderDelivered.join("\n\n")}`
			: "";

	const text =
		deliveredRecent.length > 0
			? `${overview}\n\n${deliveredRecent.join("\n\n")}${olderUnreviewedText}`
			: records.length > 0
				? overview
				: "No worker lanes.";

	const overviewDetails: DelegateStatusToolDetails = {
		started: true,
		action,
		kind: "overview",
		count: deliveredRecent.length,
		queued,
		running,
		terminal,
		unreviewedCount: unreviewedRecords.length,
	};

	if (unreviewedRecords.length > 0) {
		const visibleLaneIds: string[] = [];
		for (const rec of unreviewedRecords.slice(0, 64)) {
			const trial = {
				...overviewDetails,
				unreviewedLaneIds: [...visibleLaneIds, rec.laneId.slice(0, MAX_WORKER_CONTROL_ID_CHARS)],
			};
			if (Buffer.byteLength(JSON.stringify(trial), "utf8") > MAX_DELEGATE_STATUS_OUTPUT_BYTES / 2) {
				break;
			}
			visibleLaneIds.push(rec.laneId.slice(0, MAX_WORKER_CONTROL_ID_CHARS));
		}
		overviewDetails.unreviewedLaneIds = visibleLaneIds;
	}

	const visibleLanes: DelegateStatusLaneView[] = [];
	for (const rec of deliveredRecords) {
		const trial = {
			...overviewDetails,
			lanes: [...visibleLanes, laneView(rec, claims.get(rec.laneId))],
		};
		if (Buffer.byteLength(JSON.stringify(trial), "utf8") > MAX_DELEGATE_STATUS_OUTPUT_BYTES - 64) {
			break;
		}
		visibleLanes.push(laneView(rec, claims.get(rec.laneId)));
	}
	overviewDetails.lanes = visibleLanes;

	return {
		content: [{ type: "text", text }],
		details: overviewDetails,
	};
}
