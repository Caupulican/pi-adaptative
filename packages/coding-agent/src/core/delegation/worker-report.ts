/**
 * The completion handshake: how a worker that declares itself done is asked to prove it.
 *
 * When a worker's run would end and it has something the host can check (task requirement ids, commands
 * it ran, files it changed), the host sends one request: submit a report through `submit_report`,
 * citing the host's own records (receipt ids, changed files) as proof. The tool records the report and
 * ends the run through the loop's ordinary tool-batch termination, so the transcript keeps a complete
 * call and result. A worker is never forced: a text answer is still accepted, parsed as before and marked
 * `unstructured_after_request`, and nothing here turns a finished worker into a blocked one.
 *
 * The host then checks the report against its receipts in code (`judgeSubmittedReport`): a claimed pass
 * with a failing receipt is contradicted, a requirement with no evidence needs more. The verdict is
 * advice to the root, which owns the worker's lifecycle.
 */

import { isAbsolute, resolve } from "node:path";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../kernel/index.ts";
import type {
	WorkerCommandReceipt,
	WorkerHostVerdict,
	WorkerReportRequirementStatus,
	WorkerSubmittedReport,
} from "../autonomy/contracts.ts";
import {
	MAX_WORKER_CLAIM_BLOCKER_CHARS,
	MAX_WORKER_CLAIM_BLOCKERS,
	MAX_WORKER_CLAIM_CHANGED_FILE_CHARS,
	MAX_WORKER_CLAIM_COMMAND_CHARS,
	MAX_WORKER_CLAIM_REASON_CODE_CHARS,
	MAX_WORKER_CLAIM_REASON_CODES,
	MAX_WORKER_CLAIM_RECEIPT_FIELD_CHARS,
	MAX_WORKER_REPORT_ENTRIES,
	MAX_WORKER_REPORT_REFS,
	MAX_WORKER_REPORT_TEXT_CHARS,
} from "./worker-claim.ts";

export const SUBMIT_REPORT_TOOL_NAME = "submit_report";

/** Report requests one worker run may receive: the first, and one repair when it did not submit. */
export const MAX_REPORT_REQUESTS = 2;
/** Follow-up turns the host spends on a `needs_more` verdict: one. */
export const MAX_NEEDS_MORE_ROUNDS = 1;

const requirementStatus = Type.Union([
	Type.Literal("met"),
	Type.Literal("partial"),
	Type.Literal("not_met"),
	Type.Literal("not_applicable"),
]);

export const submitReportParameters = Type.Object({
	status: Type.Union([Type.Literal("completed"), Type.Literal("blocked")], {
		description: "completed when the task is done; blocked when something outside your grant stops it.",
	}),
	summary: Type.String({ minLength: 1, description: "What you did or concluded, in a few sentences." }),
	requirements: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ description: "A task requirement id, exactly as listed in the report request." }),
				status: requirementStatus,
				evidence: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"What shows it: receipt names (c1, c2) of commands you ran, changed file paths, or finding ids.",
					}),
				),
				note: Type.Optional(Type.String()),
			}),
			{ description: "One entry per task requirement id." },
		),
	),
	checks: Type.Optional(
		Type.Array(
			Type.Object({
				command: Type.String(),
				receiptId: Type.Optional(
					Type.String({ description: "The host receipt name (c1, c2, ...) or id of that command." }),
				),
				result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
				note: Type.Optional(Type.String()),
			}),
			{ description: "The checks you ran or chose not to run, with what each showed." },
		),
	),
	changes: Type.Optional(
		Type.Array(
			Type.Object({
				file: Type.String(),
				what: Type.String(),
				serves: Type.Optional(Type.Array(Type.String(), { description: "Requirement ids this change serves." })),
			}),
			{ description: "Each file you changed and what the change does." },
		),
	),
	assumptions: Type.Optional(Type.Array(Type.String())),
	regressions: Type.Optional(Type.Array(Type.String(), { description: "Behavior this change could break." })),
	remaining: Type.Optional(Type.Array(Type.String(), { description: "What is not done yet." })),
	blockers: Type.Optional(Type.Array(Type.String())),
	inconclusive: Type.Optional(
		Type.Array(Type.String(), { description: "Findings you could not settle: what is missing." }),
	),
	findings: Type.Optional(
		Type.Array(Type.Object({ summary: Type.String(), confidence: Type.Optional(Type.Number()) })),
	),
	verdict: Type.Optional(
		Type.Union([Type.Literal("accepted"), Type.Literal("rejected")], {
			description: "Verifier workers only: whether the subject's evidence proves it.",
		}),
	),
	reasonCodes: Type.Optional(Type.Array(Type.String())),
});

export type SubmitReportArguments = Static<typeof submitReportParameters>;

/** The report as the host keeps it: the envelope every claim carries plus the structured sections. */
export interface SubmittedWorkerReport {
	readonly status: "completed" | "blocked";
	readonly summary: string;
	readonly blockers: readonly string[];
	readonly inconclusive: readonly string[];
	readonly findings: readonly { summary: string; confidence: number }[];
	readonly verdict?: "accepted" | "rejected";
	readonly reasonCodes: readonly string[];
	readonly report: WorkerSubmittedReport;
}

/** Where the tool leaves what the worker submitted, read by the executor when the run ends. */
export interface WorkerReportCapture {
	submitted?: SubmittedWorkerReport;
}

export interface WorkerReportContext {
	/** The task's requirement ids; empty when the task carries none. */
	readonly requirementIds: readonly string[];
	/** Whether the worker may change files (a report then explains its changes). */
	readonly writeCapable: boolean;
	/** A verifier-profile worker, whose report carries a verdict. */
	readonly verifier: boolean;
}

function clipped(values: readonly string[] | undefined, maximumCount: number, maximumChars: number): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const raw of values ?? []) {
		const value = raw.trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value.length <= maximumChars ? value : `${value.slice(0, maximumChars - 1)}…`);
		if (result.length >= maximumCount) break;
	}
	return result;
}

/** Bound what a worker submitted so it fits the claim's limits; nothing is rejected for length. */
export function submittedReportFromArguments(args: SubmitReportArguments): SubmittedWorkerReport {
	const text = (value: string | undefined): string | undefined => {
		const trimmed = value?.trim();
		return trimmed ? trimmed.slice(0, MAX_WORKER_REPORT_TEXT_CHARS) : undefined;
	};
	const refs = (values: readonly string[] | undefined) =>
		clipped(values, MAX_WORKER_REPORT_REFS, MAX_WORKER_CLAIM_RECEIPT_FIELD_CHARS);
	return {
		status: args.status,
		summary: args.summary.trim().slice(0, MAX_WORKER_REPORT_TEXT_CHARS * 4),
		blockers: clipped(args.blockers, MAX_WORKER_CLAIM_BLOCKERS, MAX_WORKER_CLAIM_BLOCKER_CHARS),
		inconclusive: clipped(args.inconclusive, MAX_WORKER_CLAIM_BLOCKERS, MAX_WORKER_CLAIM_BLOCKER_CHARS),
		findings: (args.findings ?? []).slice(0, MAX_WORKER_REPORT_ENTRIES).flatMap((finding) => {
			const summary = text(finding.summary);
			if (!summary) return [];
			const confidence =
				typeof finding.confidence === "number" && Number.isFinite(finding.confidence)
					? Math.min(1, Math.max(0, finding.confidence))
					: 0.5;
			return [{ summary, confidence }];
		}),
		...(args.verdict ? { verdict: args.verdict } : {}),
		reasonCodes: clipped(args.reasonCodes, MAX_WORKER_CLAIM_REASON_CODES, MAX_WORKER_CLAIM_REASON_CODE_CHARS),
		report: {
			requirements: (args.requirements ?? []).slice(0, MAX_WORKER_REPORT_ENTRIES).flatMap((entry) => {
				const id = entry.id.trim().slice(0, MAX_WORKER_CLAIM_RECEIPT_FIELD_CHARS);
				if (!id) return [];
				const note = text(entry.note);
				return [
					{
						id,
						status: entry.status as WorkerReportRequirementStatus,
						evidence: refs(entry.evidence),
						...(note ? { note } : {}),
					},
				];
			}),
			checks: (args.checks ?? []).slice(0, MAX_WORKER_REPORT_ENTRIES).flatMap((check) => {
				const command = check.command.trim().slice(0, MAX_WORKER_CLAIM_COMMAND_CHARS);
				if (!command) return [];
				const receiptId = check.receiptId?.trim();
				const note = text(check.note);
				return [
					{
						command,
						...(receiptId ? { receiptId: receiptId.slice(0, MAX_WORKER_CLAIM_RECEIPT_FIELD_CHARS) } : {}),
						result: check.result,
						...(note ? { note } : {}),
					},
				];
			}),
			changes: (args.changes ?? []).slice(0, MAX_WORKER_REPORT_ENTRIES).flatMap((change) => {
				const file = change.file.trim().slice(0, MAX_WORKER_CLAIM_CHANGED_FILE_CHARS);
				const what = text(change.what);
				if (!file || !what) return [];
				return [{ file, what, ...(change.serves?.length ? { serves: refs(change.serves) } : {}) }];
			}),
			assumptions: clipped(args.assumptions, MAX_WORKER_REPORT_ENTRIES, MAX_WORKER_REPORT_TEXT_CHARS),
			regressions: clipped(args.regressions, MAX_WORKER_REPORT_ENTRIES, MAX_WORKER_REPORT_TEXT_CHARS),
			remaining: clipped(args.remaining, MAX_WORKER_REPORT_ENTRIES, MAX_WORKER_REPORT_TEXT_CHARS),
		},
	};
}

/**
 * The per-attempt report tool. It has no side effect beyond recording the arguments and ends the run
 * after its result; it is not part of the worker's granted tool surface, so the grant, the gateway and
 * the operation gate never see it, and the executor admits it by name.
 */
export function createSubmitReportTool(capture: WorkerReportCapture): AgentTool<typeof submitReportParameters> {
	return {
		name: SUBMIT_REPORT_TOOL_NAME,
		label: "Submit report",
		description:
			"Submit your final report: what you did, the status of each task requirement with its evidence, the checks you ran (cite the host's receipt ids), the files you changed, what remains. Calling it ends your task. A plain text answer is also accepted, but it cannot be checked against the host's records.",
		parameters: submitReportParameters,
		execute: async (_toolCallId, params) => {
			capture.submitted = submittedReportFromArguments(params);
			return {
				content: [{ type: "text", text: "Report received." }],
				details: { requirements: capture.submitted.report.requirements.length },
				terminate: true,
			};
		},
	};
}

/** Whether the host has anything to check a report against: if not, a plain answer is enough. */
export function reportWorthRequesting(input: {
	context: WorkerReportContext;
	receipts: readonly WorkerCommandReceipt[];
	changedFiles: readonly string[];
}): boolean {
	return input.context.requirementIds.length > 0 || input.receipts.length > 0 || input.changedFiles.length > 0;
}

/** The short name a report may use for the n-th receipt (call ids are long); the host accepts either. */
export function receiptAlias(index: number): string {
	return `c${index + 1}`;
}

/** Receipts by id and by alias, for resolving what a report cites. */
function receiptIndex(receipts: readonly WorkerCommandReceipt[]): Map<string, WorkerCommandReceipt> {
	const index = new Map<string, WorkerCommandReceipt>();
	receipts.forEach((receipt, position) => {
		index.set(receipt.id, receipt);
		index.set(receiptAlias(position), receipt);
	});
	return index;
}

function receiptLine(receipt: WorkerCommandReceipt, position: number): string {
	const outcome =
		receipt.exitCode !== undefined ? `exit ${receipt.exitCode}` : receipt.isError ? "error" : "completed";
	return `- ${receiptAlias(position)} ${receipt.tool}: ${receipt.command} -> ${outcome}`;
}

/** The request the worker receives when it declares itself done: what to report and how to prove it. */
export function buildReportRequest(input: {
	context: WorkerReportContext;
	receipts: readonly WorkerCommandReceipt[];
	changedFiles: readonly string[];
	/** Set on the second request, after the worker answered in text. */
	repeat?: boolean;
}): string {
	const { context, receipts, changedFiles } = input;
	const lines = [
		"REPORT REQUEST",
		input.repeat
			? "You answered in text. Submit the same report with the submit_report tool so the host can check it against its records; if you cannot, a short text answer stays acceptable."
			: "You declared the task done. Submit your report with the submit_report tool so the host can check it against its records. A plain text answer is also accepted, but it cannot be checked.",
	];
	if (context.requirementIds.length > 0) {
		lines.push(
			`Task requirement ids: ${context.requirementIds.join(", ")}. Give each one an entry: met, partial, not_met or not_applicable, with the evidence you rely on (receipt names, changed file paths).`,
		);
	}
	if (receipts.length > 0) {
		lines.push("Commands the host recorded; cite the receipt name (c1, c2, ...) for each check:");
		lines.push(
			...receipts
				.slice(-24)
				.map((receipt, offset) => receiptLine(receipt, receipts.length - Math.min(receipts.length, 24) + offset)),
		);
	}
	if (changedFiles.length > 0) {
		lines.push(
			`Files the host recorded as changed: ${changedFiles.slice(0, 40).join(", ")}${changedFiles.length > 40 ? ", ..." : ""}. List each under changes with what changed and which requirement it serves.`,
		);
	}
	lines.push(
		"Say what remains, what you assumed and what could regress. If something is still unproven, run the check now, then report. If you cannot finish, submit status blocked with the blocker.",
	);
	return lines.join("\n");
}

/** The follow-up the host sends once when its checks find named proof missing. */
export function buildNeedsMoreRequest(verdict: WorkerHostVerdict): string {
	return [
		"REPORT REVIEW",
		"The host checked your report against its records and found:",
		...verdict.missing.map((line) => `- ${line}`),
		"Run what is missing or correct the report, then submit it again with submit_report. If something cannot be done, say so in the report and mark it not_met or blocked; that is accepted.",
	].join("\n");
}

function verdict(
	kind: WorkerHostVerdict["verdict"],
	parts: { covered?: readonly string[]; missing?: readonly string[]; reasonCodes: readonly string[] },
	now: () => string,
): WorkerHostVerdict {
	return {
		verdict: kind,
		coveredRequirementIds: [...(parts.covered ?? [])],
		missing: [...(parts.missing ?? [])].slice(0, MAX_WORKER_REPORT_ENTRIES),
		reasonCodes: [...new Set(parts.reasonCodes)].slice(0, MAX_WORKER_CLAIM_REASON_CODES),
		judgedBy: "code",
		at: now(),
	};
}

/**
 * Check a submitted report against the host's records, in code. Contradicted claims reject; named
 * proof that is missing needs more; otherwise the report is accepted. Nothing here reads the worker's
 * prose: a check passes only if its receipt says so, a changed file only if the host recorded it.
 */
export function judgeSubmittedReport(input: {
	submitted: SubmittedWorkerReport;
	context: WorkerReportContext;
	receipts: readonly WorkerCommandReceipt[];
	changedFiles: readonly string[];
	/** The worker's working directory: a path is the same file whether it was spelled absolute or relative. */
	cwd: string;
	now?: () => string;
}): WorkerHostVerdict {
	const now = input.now ?? (() => new Date().toISOString());
	const { submitted, context } = input;
	if (submitted.status === "blocked" || submitted.blockers.length > 0) {
		return verdict("blocked", { reasonCodes: ["worker_reported_blocker"] }, now);
	}
	const receipts = receiptIndex(input.receipts);
	const spelled = (file: string): string => (isAbsolute(file) ? resolve(file) : resolve(input.cwd, file));
	const changed = new Set(input.changedFiles.map(spelled));
	const contradicted: string[] = [];
	const missing: string[] = [];
	const reasons: string[] = [];

	for (const check of submitted.report.checks) {
		const receipt = check.receiptId ? receipts.get(check.receiptId) : undefined;
		if (check.result !== "passed") continue;
		if (!check.receiptId) {
			missing.push(`check "${check.command}" is reported passed with no receipt id`);
			reasons.push("check_without_receipt");
		} else if (!receipt) {
			missing.push(`check "${check.command}" cites receipt ${check.receiptId}, which the host has no record of`);
			reasons.push("check_unknown_receipt");
		} else if (receipt.isError || (receipt.exitCode !== undefined && receipt.exitCode !== 0)) {
			contradicted.push(
				`check "${check.command}" is reported passed but receipt ${receipt.id} shows ${receipt.exitCode !== undefined ? `exit ${receipt.exitCode}` : "an error"}`,
			);
			reasons.push("check_contradicted_by_receipt");
		}
	}
	for (const change of submitted.report.changes) {
		if (!changed.has(spelled(change.file))) {
			contradicted.push(`change to ${change.file} is reported but the host recorded no change to it`);
			reasons.push("change_not_recorded");
		}
	}
	if (context.writeCapable) {
		const reported = new Set(submitted.report.changes.map((change) => spelled(change.file)));
		const unreported = input.changedFiles.filter((file) => !reported.has(spelled(file)));
		if (unreported.length > 0) {
			missing.push(`changed files with no explanation: ${unreported.slice(0, 12).join(", ")}`);
			reasons.push("unreported_changes");
		}
	}

	const evidenceKnown = (ref: string) => receipts.has(ref) || changed.has(spelled(ref));
	const entries = new Map(submitted.report.requirements.map((entry) => [entry.id, entry]));
	const covered: string[] = [];
	for (const id of context.requirementIds) {
		const entry = entries.get(id);
		if (!entry) {
			missing.push(`requirement ${id} has no entry`);
			reasons.push("requirement_missing");
		} else if (entry.status === "met") {
			const unknown = entry.evidence.filter((ref) => !evidenceKnown(ref));
			if (entry.evidence.length === 0) {
				missing.push(`requirement ${id} is reported met with no evidence`);
				reasons.push("requirement_without_evidence");
			} else if (unknown.length === entry.evidence.length) {
				missing.push(
					`requirement ${id} cites evidence the host has no record of: ${unknown.slice(0, 6).join(", ")}`,
				);
				reasons.push("requirement_unknown_evidence");
			} else covered.push(id);
		} else if (entry.status === "partial" || entry.status === "not_met") {
			missing.push(`requirement ${id} is ${entry.status}${entry.note ? `: ${entry.note}` : ""}`);
			reasons.push(`requirement_${entry.status}`);
		} else covered.push(id);
	}
	for (const entry of submitted.report.requirements) {
		if (!context.requirementIds.includes(entry.id) && context.requirementIds.length > 0) {
			reasons.push("requirement_id_unknown");
		}
	}
	if (context.verifier && !submitted.verdict) {
		missing.push("a verifier's report carries a verdict (accepted or rejected)");
		reasons.push("verifier_without_verdict");
	}

	if (contradicted.length > 0)
		return verdict("rejected", { covered, missing: [...contradicted, ...missing], reasonCodes: reasons }, now);
	if (missing.length > 0) return verdict("needs_more", { covered, missing, reasonCodes: reasons }, now);
	return verdict("accepted", { covered, reasonCodes: ["report_matches_receipts"] }, now);
}

/**
 * What System One's claim check reads for a claim: the summary, plus every statement a submitted report
 * makes about its requirements and changes. The check already judges a worker's stated claims against the
 * worker's own tool results; a structured report adds claims it should see, and no second judge is built.
 */
export function workerReportClaimText(claim: {
	readonly summary: string;
	readonly report?: WorkerSubmittedReport;
}): string {
	const report = claim.report;
	if (!report) return claim.summary;
	const lines = [claim.summary];
	for (const requirement of report.requirements) {
		lines.push(
			`Requirement ${requirement.id} is ${requirement.status.replace("_", " ")}${requirement.note ? `: ${requirement.note}` : "."}`,
		);
	}
	for (const change of report.changes) lines.push(`Changed ${change.file}: ${change.what}`);
	for (const check of report.checks) {
		if (check.note) lines.push(`Check "${check.command}" ${check.result.replace("_", " ")}: ${check.note}`);
	}
	return lines.join("\n").slice(0, 16_000);
}
