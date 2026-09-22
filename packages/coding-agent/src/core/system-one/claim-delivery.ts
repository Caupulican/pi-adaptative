/**
 * Claims against deliveries: does the final answer say something happened that the turn's own
 * receipts do not show?
 *
 * Receipts are mechanical facts read from the turn's tool calls and results — never model text.
 * Jev answers one atomic question per claim kind ("does the answer state that X?"); code combines
 * each settled answer with the receipt for X. A claim the receipts contradict is corrected before
 * the turn ends; a claim no receipt backs stays visible as a doubt.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core";
import {
	isPassingTestVerification,
	retainedVerificationDetails,
} from "@caupulican/pi-agent-core/verification-obligations";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "@caupulican/pi-ai";
import { settledAnswer } from "../decision/noul.ts";
import type { LadderOutcome } from "./unsettled-ladder.ts";

/** A counted delivery: how many attempts succeeded and how many failed in this turn. */
export interface DeliveryReceipt {
	readonly succeeded: number;
	readonly failed: number;
}

export interface ClaimReceipts {
	/** Test verifications recorded on the turn's tool results, in order. */
	readonly tests: { readonly passed: number; readonly failed: number; readonly lastPassed: boolean | undefined };
	readonly commits: DeliveryReceipt;
	readonly pushes: DeliveryReceipt;
	readonly publishes: DeliveryReceipt;
	/** Paths written by successful edit/write calls. */
	readonly filesChanged: readonly string[];
	readonly toolCalls: number;
	/** Tool calls that returned without error: what an inspection-backed verdict rests on. */
	readonly succeededToolCalls: number;
}

export type ClaimKind = "tests_pass" | "committed" | "pushed" | "published" | "files_changed";

export interface ClaimFinding {
	readonly kind: ClaimKind;
	readonly verdict: "contradicted" | "unsupported";
	readonly reason: string;
}

const COMMIT = /\bgit\b[^\n|;&]*\bcommit\b/;
const PUSH = /\bgit\b[^\n|;&]*\bpush\b/;
const PUBLISH = /\b(?:npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b/;
const SHELL_TOOLS = new Set(["bash", "powershell", "run_process"]);

function countDelivery(counts: { succeeded: number; failed: number }, ok: boolean): void {
	if (ok) counts.succeeded += 1;
	else counts.failed += 1;
}

/** Receipts for the messages a single turn appended. */
export function collectClaimReceipts(turnMessages: readonly AgentMessage[]): ClaimReceipts {
	const calls = new Map<string, ToolCall>();
	for (const message of turnMessages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, block);
	}
	const tests = { passed: 0, failed: 0, lastPassed: undefined as boolean | undefined };
	const commits = { succeeded: 0, failed: 0 };
	const pushes = { succeeded: 0, failed: 0 };
	const publishes = { succeeded: 0, failed: 0 };
	const filesChanged: string[] = [];
	let toolCalls = 0;
	let succeededToolCalls = 0;
	for (const message of turnMessages) {
		if (message.role !== "toolResult") continue;
		const result = message as ToolResultMessage;
		toolCalls += 1;
		if (!result.isError) succeededToolCalls += 1;
		const record = retainedVerificationDetails(result.details)?.piVerification;
		if (record?.evidence === "tests" && record.outcome === "executed") {
			const passed = isPassingTestVerification(record);
			if (passed) tests.passed += 1;
			else tests.failed += 1;
			tests.lastPassed = passed;
		}
		const call = calls.get(result.toolCallId);
		const args = (call?.arguments ?? {}) as Record<string, unknown>;
		const ok = !result.isError;
		if (SHELL_TOOLS.has(result.toolName) && typeof args.command === "string") {
			if (COMMIT.test(args.command)) countDelivery(commits, ok);
			if (PUSH.test(args.command)) countDelivery(pushes, ok);
			if (PUBLISH.test(args.command)) countDelivery(publishes, ok);
		}
		if (ok && /edit|write/.test(result.toolName)) {
			const path = args.path ?? args.file_path;
			if (typeof path === "string" && !filesChanged.includes(path)) filesChanged.push(path);
		}
	}
	return { tests, commits, pushes, publishes, filesChanged, toolCalls, succeededToolCalls };
}

/** Cheap gate before spending a Jev call: an answer that names none of the claim kinds claims none. */
const CLAIM_VOCABULARY =
	/\b(?:test|tests|tested|pass|passes|passed|passing|green|commit|committed|push|pushed|publish|published|released|created|updated|modified|changed|edited|wrote|written|fixed)\b/i;

export function mayContainDeliveryClaims(finalAnswer: string): boolean {
	return CLAIM_VOCABULARY.test(finalAnswer);
}

/** The claim questions' ids, in the order the catalog asks them. */
export const CLAIM_QUESTION_IDS: Readonly<Record<ClaimKind, string>> = {
	tests_pass: "states_tests_pass",
	committed: "states_committed",
	pushed: "states_pushed",
	published: "states_published",
	files_changed: "states_files_changed",
};

function judgeDelivery(kind: ClaimKind, receipt: DeliveryReceipt, label: string): ClaimFinding | undefined {
	if (receipt.succeeded > 0) return undefined;
	if (receipt.failed > 0)
		return {
			kind,
			verdict: "contradicted",
			reason: `the answer says it ${label}, but every ${label} command failed`,
		};
	return { kind, verdict: "unsupported", reason: `the answer says it ${label}; no ${label} command ran in this turn` };
}

/**
 * Combine Jev's settled "does the answer state X?" with the receipt for X. An answer Jev could not
 * settle claims nothing here: acting on an unsettled reading would be inventing the claim.
 */
export function judgeClaims(answers: Record<string, unknown>, receipts: ClaimReceipts): ClaimFinding[] {
	const findings: ClaimFinding[] = [];
	const states = (kind: ClaimKind) => settledAnswer(answers[CLAIM_QUESTION_IDS[kind]]) === true;
	if (states("tests_pass")) {
		if (receipts.tests.lastPassed === false)
			findings.push({
				kind: "tests_pass",
				verdict: "contradicted",
				reason: `the answer says tests pass, but the last test run in this turn failed (${receipts.tests.failed} failed)`,
			});
		else if (receipts.tests.passed === 0)
			findings.push({
				kind: "tests_pass",
				verdict: "unsupported",
				reason: "the answer says tests pass; no test run in this turn recorded a pass",
			});
	}
	const deliveries: [ClaimKind, DeliveryReceipt, string][] = [
		["committed", receipts.commits, "committed"],
		["pushed", receipts.pushes, "pushed"],
		["published", receipts.publishes, "published"],
	];
	for (const [kind, receipt, label] of deliveries) {
		if (!states(kind)) continue;
		const finding = judgeDelivery(kind, receipt, label);
		if (finding) findings.push(finding);
	}
	if (states("files_changed") && receipts.filesChanged.length === 0 && receipts.toolCalls > 0)
		findings.push({
			kind: "files_changed",
			verdict: "unsupported",
			reason: "the answer says files were changed; no edit or write succeeded in this turn",
		});
	return findings;
}

/** The one correction turn a contradicted claim buys. */
export function claimCorrectionPrompt(findings: readonly ClaimFinding[]): string {
	const lines = findings.filter((f) => f.verdict === "contradicted").map((f) => `- ${f.reason}`);
	return [
		"System One checked your last answer against this turn's tool results and found claims they contradict:",
		...lines,
		"Correct the answer for the user: state what actually happened, and finish the work if it is still needed.",
	].join("\n");
}

/** What each claim kind asserts, as a statement System One can judge against the turn's own results. */
const CLAIM_STATEMENTS: Readonly<Record<ClaimKind, string>> = {
	tests_pass: "The tests that were run passed",
	committed: "The changes were committed with git",
	pushed: "The changes were pushed to a git remote",
	published: "The package or release was published",
	files_changed: "Files in the workspace were changed",
};

export interface AnswerClaimCheckerDeps {
	/** The session's System One controller; absent, no claim is checked. */
	getController(): { evaluateAnswerClaims(finalAnswer: string): Promise<Record<string, unknown>> } | undefined;
	warn(message: string): void;
	/**
	 * The unsettled-item ladder over the turn's own tool results, for a claim no receipt backs: the
	 * harness reads receipts only from the tools it knows, so the results may still settle it.
	 */
	settle?(items: readonly string[], messages: readonly AgentMessage[]): Promise<LadderOutcome>;
	/** Claims nothing settled, delivered to the owner by the host. */
	deliverToOwner?(items: readonly string[]): void;
}

/**
 * Runs the claim check at the end of a turn and owns its one piece of state: whether the operator
 * was already told that claims are going unchecked, so an outage is reported once, not every turn.
 */
export class AnswerClaimChecker {
	private readonly deps: AnswerClaimCheckerDeps;
	private outageReported = false;

	constructor(deps: AnswerClaimCheckerDeps) {
		this.deps = deps;
	}

	/** Returns the correction prompt when a claim is contradicted; undefined otherwise. */
	/**
	 * Every claim finding for an answer against the messages its work produced, or undefined when
	 * nothing was checked (no controller, no claim vocabulary, or Jev unavailable, reported once).
	 */
	async findings(finalAnswer: string, messages: readonly AgentMessage[]): Promise<ClaimFinding[] | undefined> {
		const controller = this.deps.getController();
		if (!controller || !finalAnswer.trim() || !mayContainDeliveryClaims(finalAnswer)) return undefined;
		let answers: Record<string, unknown>;
		try {
			answers = await controller.evaluateAnswerClaims(finalAnswer);
		} catch (error) {
			if (!this.outageReported)
				this.deps.warn(
					`Claims in answers are not being checked against tool results: ${error instanceof Error ? error.message : String(error)}`,
				);
			this.outageReported = true;
			return undefined;
		}
		this.outageReported = false;
		return judgeClaims(answers, collectClaimReceipts(messages));
	}

	/**
	 * Returns the correction prompt when a claim is contradicted; undefined otherwise. A claim no
	 * receipt backs climbs the ladder over the turn's results: confirmed, it stands; refuted, it is a
	 * contradiction; still open, it goes to the owner.
	 */
	async check(finalAnswer: string, turnMessages: readonly AgentMessage[]): Promise<string | undefined> {
		const findings = await this.findings(finalAnswer, turnMessages);
		if (!findings) return undefined;
		const contradicted = findings.filter((finding) => finding.verdict === "contradicted");
		const unsupported = findings.filter((finding) => finding.verdict === "unsupported");
		if (unsupported.length > 0 && this.deps.settle) {
			const outcome = await this.deps.settle(
				unsupported.map((finding) => CLAIM_STATEMENTS[finding.kind]),
				turnMessages,
			);
			const byStatement = new Map(unsupported.map((finding) => [CLAIM_STATEMENTS[finding.kind], finding]));
			for (const settled of outcome.settled) {
				const finding = byStatement.get(settled.item);
				if (finding && settled.verdict === "refuted")
					contradicted.push({
						kind: finding.kind,
						verdict: "contradicted",
						reason: `${finding.reason}, and System One found this turn's results show it did not happen`,
					});
			}
			const open = outcome.unsettled.map(
				(entry) => `${byStatement.get(entry.item)?.reason ?? entry.item} (missing: ${entry.missing})`,
			);
			for (const item of open) this.deps.warn(`Unverified claim: ${item}`);
			if (open.length > 0) this.deps.deliverToOwner?.(open);
		} else {
			for (const finding of unsupported) this.deps.warn(`Unverified claim: ${finding.reason}`);
		}
		return contradicted.length > 0 ? claimCorrectionPrompt(contradicted) : undefined;
	}

	/**
	 * Blockers for a worker's report: claims its own transcript contradicts, and a verifier's "accepted"
	 * with no passing test run behind it. A worker proposes; this is what the parent accepts on.
	 */
	async workerReportBlockers(input: {
		readonly summary: string;
		readonly messages: readonly AgentMessage[];
		readonly verifierVerdict?: "accepted" | "rejected";
	}): Promise<string[]> {
		const blockers: string[] = [];
		for (const finding of (await this.findings(input.summary, input.messages)) ?? []) {
			if (finding.verdict === "contradicted")
				blockers.push(`claim contradicted by the worker's own tool results: ${finding.reason}`);
			else this.deps.warn(`Unverified worker claim: ${finding.reason}`);
		}
		// "accepted" is itself a claim: it must rest on the verifier's own inspection, and a failing last
		// test run contradicts it. A subject with no tests (docs, config) is verified by reading it.
		if (input.verifierVerdict === "accepted") {
			const receipts = collectClaimReceipts(input.messages);
			if (receipts.tests.lastPassed === false)
				blockers.push("verification accepted although the verifier's last test run failed");
			else if (receipts.succeededToolCalls === 0)
				blockers.push("verification accepted with no successful inspection in the verifier's own transcript");
		}
		return blockers;
	}
}

/** The visible text of an assistant message: its text blocks joined, thinking and tool calls excluded. */
export function assistantAnswerText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}
