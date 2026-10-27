/**
 * Claims against deliveries: does the final answer say something happened that the work's own
 * receipts do not show? The work is the current or most recent work unit (see work-units.ts), with the
 * receipts of the workers whose reports were accepted during it; with no work unit, the turn.
 *
 * Receipts are mechanical facts read from the turn's tool calls and results — never model text.
 * System One answers one atomic question per claim kind ("does the answer state that X?"); code combines
 * each settled answer with the receipt for X. A claim the receipts contradict is corrected before
 * the turn ends; a claim no receipt backs stays visible as a doubt.
 */

import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage, TextContent, ToolCall, ToolResultMessage } from "@caupulican/pi-ai";
import type { AgentMessage } from "../../kernel/index.ts";
import { retainedToolInvocation } from "../../kernel/tool-invocation-receipt.ts";
import { isPassingTestVerification, retainedVerificationDetails } from "../../kernel/verification-obligations.ts";
import type { WorkerCommandReceipt } from "../autonomy/contracts.ts";
import { DEFAULT_NOUL_BAND_THRESHOLDS, isNoulProbability, settledAnswer } from "../decision/noul.ts";
import { commandReceiptFor, workerCommandOutcome, workerCommandReceiptId } from "../delegation/worker-receipts.ts";
import { GOAL_LIFECYCLE_TOOL_NAMES, LEGACY_GOAL_TOOL_NAME } from "../goals/goal-tool-names.ts";
import type { ClaimReceipts, DeliveryReceipt } from "../orchestration/claim-receipts.ts";
import type { WorkUnitRecord } from "../work-units.ts";
import type { LadderOutcome } from "./unsettled-ladder.ts";

export type ClaimReceiptEvent =
	| { readonly kind: "message"; readonly message: AgentMessage }
	| {
			readonly kind: "worker";
			readonly entryId: string;
			readonly receipts: ClaimReceipts;
			readonly identity?: { readonly id: string; readonly signature: string };
	  };

function emptyClaimReceipts() {
	return {
		tests: { passed: 0, failed: 0, lastPassed: undefined as boolean | undefined },
		checks: { passed: 0, failed: 0, lastPassed: undefined as boolean | undefined },
		commits: { succeeded: 0, failed: 0 },
		pushes: { succeeded: 0, failed: 0 },
		publishes: { succeeded: 0, failed: 0 },
		filesChanged: [] as string[],
		toolCalls: 0,
		succeededToolCalls: 0,
	};
}

export type ClaimKind = "tests_pass" | "checks_pass" | "committed" | "pushed" | "published" | "files_changed";

/** Describes the receipt boundary, never whether an action succeeded. */
export interface AnswerClaimScope {
	readonly request: string;
	readonly boundary: "work_unit" | "turn";
	readonly openingEntryId: string | null;
	readonly workUnit?: WorkUnitRecord;
}

const ANSWER_CLAIM_SCOPE_TEXT_LIMIT = 8_000;

/** One bounded projection for extraction and fallback settlement; descriptive context never becomes a receipt. */
export function projectAnswerClaimScope(
	scope: AnswerClaimScope,
	redact: (text: string) => string,
): Record<string, unknown> {
	return {
		request: redact(scope.request.slice(0, ANSWER_CLAIM_SCOPE_TEXT_LIMIT)),
		request_truncated: scope.request.length > ANSWER_CLAIM_SCOPE_TEXT_LIMIT,
		boundary: scope.boundary,
		opening_entry_id: scope.openingEntryId,
		...(scope.workUnit
			? {
					workUnit: {
						kind: scope.workUnit.kind,
						startEntryId: scope.workUnit.startEntryId,
						openedAt: scope.workUnit.openedAt,
						reason: redact(scope.workUnit.reason.slice(0, ANSWER_CLAIM_SCOPE_TEXT_LIMIT)),
						reason_truncated: scope.workUnit.reason.length > ANSWER_CLAIM_SCOPE_TEXT_LIMIT,
					},
				}
			: {}),
	};
}

export interface ClaimFinding {
	readonly kind: ClaimKind;
	readonly verdict: "contradicted" | "unsupported";
	readonly reason: string;
}

const COMMIT = /\bgit\b[^\n|;&]*\bcommit\b/;
const PUSH = /\bgit\b[^\n|;&]*\bpush\b/;
const PUBLISH = /\b(?:npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b/;
const SHELL_TOOLS = new Set(["bash", "powershell", "run_process"]);
const GOAL_TOOLS: ReadonlySet<string> = new Set([LEGACY_GOAL_TOOL_NAME, ...GOAL_LIFECYCLE_TOOL_NAMES]);

/** The requirement checks a goal completion reran, as its result's receipt reports them. */
function goalCheckRuns(details: unknown): { passed: number; failed: number } | undefined {
	if (!details || typeof details !== "object") return undefined;
	const receipts = (details as { piReceipts?: unknown }).piReceipts;
	if (!receipts || typeof receipts !== "object") return undefined;
	const runs = (receipts as { requirementChecks?: unknown }).requirementChecks;
	if (!runs || typeof runs !== "object") return undefined;
	const { passed, failed } = runs as { passed?: unknown; failed?: unknown };
	return typeof passed === "number" && typeof failed === "number" ? { passed, failed } : undefined;
}

function countDelivery(counts: { succeeded: number; failed: number }, ok: boolean): void {
	if (ok) counts.succeeded += 1;
	else counts.failed += 1;
}

/** Receipts for the messages a single turn appended. */
export function collectClaimReceipts(
	turnMessages: readonly AgentMessage[],
	verifiedChecks: readonly WorkerCommandReceipt[] = [],
): ClaimReceipts {
	return collectClaimReceiptEvents(
		turnMessages.map((message) => ({ kind: "message", message })),
		verifiedChecks,
	);
}

/** One stateful fold: a worker record does not interrupt an outstanding root tool call. */
export function collectClaimReceiptEvents(
	events: readonly ClaimReceiptEvent[],
	verifiedChecks: readonly WorkerCommandReceipt[] = [],
): ClaimReceipts {
	const calls = new Map<string, ToolCall | undefined>();
	const seenRequests = new Map<string, Set<string>>();
	const seenWorkerEntries = new Set<string>();
	const workerEvidence = new Map<string, Extract<ClaimReceiptEvent, { kind: "worker" }> | undefined>();
	for (const event of events) {
		if (event.kind !== "worker") continue;
		const key = event.identity?.id ?? event.entryId;
		if (!workerEvidence.has(key)) workerEvidence.set(key, event);
		else {
			const earlier = workerEvidence.get(key);
			if (
				!earlier ||
				earlier.identity?.signature !== event.identity?.signature ||
				!isDeepStrictEqual(earlier.receipts, event.receipts)
			)
				workerEvidence.set(key, undefined);
		}
	}
	const segments: ClaimReceipts[] = [];
	const checks = new Map<string, WorkerCommandReceipt | undefined>();
	for (const check of verifiedChecks) checks.set(check.id, checks.has(check.id) ? undefined : check);
	let totals = emptyClaimReceipts();
	for (const event of events) {
		if (event.kind === "worker") {
			const key = event.identity?.id ?? event.entryId;
			if (!workerEvidence.get(key) || seenWorkerEntries.has(key)) continue;
			seenWorkerEntries.add(key);
			segments.push(totals, event.receipts);
			totals = emptyClaimReceipts();
			continue;
		}
		const message = event.message;
		const { tests, checks: nonTestChecks, commits, pushes, publishes, filesChanged } = totals;
		if (message.role === "assistant") {
			// Provider call IDs belong to this assistant request, never to later requests.
			calls.clear();
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				calls.set(block.id, calls.has(block.id) ? undefined : block);
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const result = message as ToolResultMessage;
		const call = calls.get(result.toolCallId);
		if (!call || call.name !== result.toolName) continue;
		calls.delete(result.toolCallId);
		const invocation = retainedToolInvocation(result.details);
		if (
			!invocation &&
			result.details &&
			typeof result.details === "object" &&
			Object.hasOwn(result.details, "piToolInvocation")
		)
			continue;
		if (invocation) {
			if (invocation.execution !== "completed") continue;
			const seen = seenRequests.get(invocation.requestId) ?? new Set<string>();
			if (seen.has(result.toolCallId)) continue;
			seen.add(result.toolCallId);
			seenRequests.set(invocation.requestId, seen);
		}
		const ok = invocation ? invocation.operationStatus === "success" : !result.isError;
		totals.toolCalls += 1;
		if (ok) totals.succeededToolCalls += 1;
		const record = retainedVerificationDetails(result.details)?.piVerification;
		let checkPassed: boolean | undefined;
		let counts = nonTestChecks;
		if (record?.evidence !== undefined && record.outcome === "executed") {
			counts = record.evidence === "tests" ? tests : nonTestChecks;
			checkPassed =
				ok && (record.evidence === "tests" ? isPassingTestVerification(record) : record.status === "passed");
		} else if (invocation && checks.size > 0) {
			const proof = checks.get(workerCommandReceiptId(invocation.requestId, result.toolCallId));
			const observed = proof
				? commandReceiptFor({
						requestId: invocation.requestId,
						toolCallId: result.toolCallId,
						toolName: result.toolName,
						args: call.arguments,
						isError: !ok,
						result,
					})
				: undefined;
			if (proof?.commandDigest && observed?.commandDigest === proof.commandDigest && observed.tool === proof.tool) {
				const outcome = workerCommandOutcome(observed);
				if (outcome !== undefined && outcome === workerCommandOutcome(proof)) checkPassed = outcome === "passed";
			}
		}
		if (checkPassed !== undefined) {
			if (checkPassed) counts.passed += 1;
			else counts.failed += 1;
			counts.lastPassed = checkPassed;
		}
		const goalChecks = GOAL_TOOLS.has(result.toolName) ? goalCheckRuns(result.details) : undefined;
		if (goalChecks && goalChecks.passed + goalChecks.failed > 0) {
			// Goal requirements and cited worker commands have no executed-test provenance.
			nonTestChecks.passed += goalChecks.passed;
			nonTestChecks.failed += goalChecks.failed;
			nonTestChecks.lastPassed = goalChecks.failed === 0;
		}
		const args = (call.arguments ?? {}) as Record<string, unknown>;
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
	return segments.length > 0 ? mergeClaimReceipts([...segments, totals]) : totals;
}

/** Fold cited checks at their actual transcript positions; each invocation contributes once. */
export function collectWorkerReportClaimReceipts(input: {
	readonly messages: readonly AgentMessage[];
	readonly hostVerifiedChecks?: readonly WorkerCommandReceipt[];
}): ClaimReceipts {
	return collectClaimReceipts(input.messages, input.hostVerifiedChecks);
}

/** Receipts of several sources (the root's window and accepted workers) as one. */
export function mergeClaimReceipts(receipts: readonly ClaimReceipts[]): ClaimReceipts {
	const sum = (pick: (r: ClaimReceipts) => DeliveryReceipt) => ({
		succeeded: receipts.reduce((total, r) => total + pick(r).succeeded, 0),
		failed: receipts.reduce((total, r) => total + pick(r).failed, 0),
	});
	const lastTests = [...receipts].reverse().find((r) => r.tests.lastPassed !== undefined)?.tests.lastPassed;
	const lastChecks = [...receipts].reverse().find((r) => r.checks?.lastPassed !== undefined)?.checks?.lastPassed;
	return {
		tests: {
			passed: receipts.reduce((total, r) => total + r.tests.passed, 0),
			failed: receipts.reduce((total, r) => total + r.tests.failed, 0),
			lastPassed: lastTests,
		},
		checks: {
			passed: receipts.reduce((total, r) => total + (r.checks?.passed ?? 0), 0),
			failed: receipts.reduce((total, r) => total + (r.checks?.failed ?? 0), 0),
			lastPassed: lastChecks,
		},
		commits: sum((r) => r.commits),
		pushes: sum((r) => r.pushes),
		publishes: sum((r) => r.publishes),
		filesChanged: [...new Set(receipts.flatMap((r) => r.filesChanged))],
		toolCalls: receipts.reduce((total, r) => total + r.toolCalls, 0),
		succeededToolCalls: receipts.reduce((total, r) => total + r.succeededToolCalls, 0),
	};
}

/** Cheap gate before spending a System One call: an answer that names none of the claim kinds claims none. */
const CLAIM_VOCABULARY =
	/\b(?:test|tests|tested|testing|check|checks|checked|typecheck|typechecks|typechecked|tsc|lint|lints|linted|linter|linting|build|builds|built|compile|compiles|compiled|verify|verified|verification|pass|passes|passed|passing|green|succeed|succeeds|succeeded|success|successful|successfully|clean|commit|committed|push|pushed|publish|published|released|created|updated|modified|changed|edited|wrote|written|fixed)\b/i;

export function mayContainDeliveryClaims(finalAnswer: string): boolean {
	return CLAIM_VOCABULARY.test(finalAnswer);
}

/** The claim questions' ids, in the order the catalog asks them. */
export const CLAIM_QUESTION_IDS: Readonly<Record<ClaimKind, string>> = {
	tests_pass: "states_tests_pass",
	checks_pass: "states_checks_pass",
	committed: "states_committed",
	pushed: "states_pushed",
	published: "states_published",
	files_changed: "states_files_changed",
};

type VerificationClaimProvenance = "current_success" | "historical_only" | "no_current_success";

function settledVerificationClaimProvenance(answer: unknown): VerificationClaimProvenance | undefined {
	if (!answer || typeof answer !== "object") return undefined;
	const record = answer as { choice?: unknown; confidence?: unknown };
	if (!isNoulProbability(record.confidence) || record.confidence < DEFAULT_NOUL_BAND_THRESHOLDS.requiredTrue.softPass)
		return undefined;
	return record.choice === "current_success" ||
		record.choice === "historical_only" ||
		record.choice === "no_current_success"
		? record.choice
		: undefined;
}

function judgeDelivery(kind: ClaimKind, receipt: DeliveryReceipt, label: string): ClaimFinding | undefined {
	if (receipt.succeeded > 0) return undefined;
	if (receipt.failed > 0)
		return {
			kind,
			verdict: "contradicted",
			reason: `the answer says it ${label}, but every ${label} command failed`,
		};
	return {
		kind,
		verdict: "unsupported",
		reason: `the answer says it ${label}; no ${label} command ran during this work`,
	};
}

/**
 * Combine System One's settled "does the answer state X?" with the receipt for X. An answer System One could not
 * settle claims nothing here: acting on an unsettled reading would be inventing the claim.
 */
export function judgeClaims(answers: Record<string, unknown>, receipts: ClaimReceipts): ClaimFinding[] {
	const findings: ClaimFinding[] = [];
	const states = (kind: ClaimKind) => settledAnswer(answers[CLAIM_QUESTION_IDS[kind]]) === true;
	const verifications = [
		["tests_pass", receipts.tests, "tests"],
		["checks_pass", receipts.checks, "non-test checks"],
	] as const;
	for (const [kind, receipt, label] of verifications) {
		if (settledVerificationClaimProvenance(answers[CLAIM_QUESTION_IDS[kind]]) !== "current_success") continue;
		if (receipt?.lastPassed === false)
			findings.push({
				kind,
				verdict: "contradicted",
				reason: `the answer says ${label} pass, but the last recorded run during this work failed (${receipt.failed} failed)`,
			});
		else if (!receipt?.passed)
			findings.push({
				kind,
				verdict: "unsupported",
				reason: `the answer says ${label} pass; no matching run during this work recorded a pass`,
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
			reason: "the answer says files were changed; no edit or write succeeded during this work",
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
	tests_pass:
		"Actual tests executed during this work passed; static checks, lint and builds alone do not establish this",
	checks_pass: "The non-test verification performed during this work passed",
	committed: "The agent created a new git commit during this work",
	pushed: "The agent pushed changes to a git remote during this work",
	published: "The agent published a package or release during this work",
	files_changed: "The agent created, edited or wrote workspace files during this work",
};

export interface AnswerClaimCheckerDeps {
	/** The session's System One controller; absent, no claim is checked. */
	getController():
		| { evaluateAnswerClaims(finalAnswer: string, scope?: AnswerClaimScope): Promise<Record<string, unknown>> }
		| undefined;
	warn(message: string): void;
	/**
	 * The unsettled-item ladder over the turn's own tool results, for a claim no receipt backs: the
	 * harness reads receipts only from the tools it knows, so the results may still settle it.
	 */
	settle?(
		items: readonly string[],
		messages: readonly AgentMessage[],
		interpretationContext?: string,
	): Promise<LadderOutcome>;
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
	 * nothing was checked (no controller, no claim vocabulary, or System One unavailable, reported once).
	 */
	async findings(
		finalAnswer: string,
		messages: readonly AgentMessage[],
		events?: readonly ClaimReceiptEvent[],
		verifiedChecks: readonly WorkerCommandReceipt[] = [],
		scope?: AnswerClaimScope,
	): Promise<ClaimFinding[] | undefined> {
		const controller = this.deps.getController();
		if (!controller || !finalAnswer.trim() || !mayContainDeliveryClaims(finalAnswer)) return undefined;
		let answers: Record<string, unknown>;
		try {
			answers = await controller.evaluateAnswerClaims(finalAnswer, scope);
		} catch (error) {
			if (!this.outageReported)
				this.deps.warn(
					`Claims in answers are not being checked against tool results: ${error instanceof Error ? error.message : String(error)}`,
				);
			this.outageReported = true;
			return undefined;
		}
		this.outageReported = false;
		return judgeClaims(
			answers,
			events ? collectClaimReceiptEvents(events, verifiedChecks) : collectClaimReceipts(messages, verifiedChecks),
		);
	}

	/**
	 * Returns the correction prompt when a claim is contradicted; undefined otherwise. A claim no
	 * receipt backs climbs the ladder over the turn's results: confirmed, it stands; refuted, it is a
	 * contradiction; still open, it goes to the owner.
	 */
	async check(
		finalAnswer: string,
		turnMessages: readonly AgentMessage[],
		events?: readonly ClaimReceiptEvent[],
		scope?: AnswerClaimScope,
	): Promise<string | undefined> {
		const findings = await this.findings(finalAnswer, turnMessages, events, [], scope);
		if (!findings) return undefined;
		const contradicted = findings.filter((finding) => finding.verdict === "contradicted");
		const unsupported = findings.filter((finding) => finding.verdict === "unsupported");
		if (unsupported.length > 0 && this.deps.settle) {
			const byStatement = new Map(unsupported.map((finding) => [CLAIM_STATEMENTS[finding.kind], finding]));
			const outcome = await this.deps.settle(
				[...byStatement.keys()],
				turnMessages,
				JSON.stringify({
					final_answer: finalAnswer,
					...(scope ? { work_scope: projectAnswerClaimScope(scope, (text) => text) } : {}),
				}),
			);
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
		/** Checks the report cites against the host's command receipts: they back a "checks passed" claim. */
		readonly hostVerifiedChecks?: readonly WorkerCommandReceipt[];
	}): Promise<string[]> {
		const blockers: string[] = [];
		for (const finding of (await this.findings(input.summary, input.messages, undefined, input.hostVerifiedChecks)) ??
			[]) {
			if (finding.verdict === "contradicted")
				blockers.push(`claim contradicted by the worker's own tool results: ${finding.reason}`);
			else this.deps.warn(`Unverified worker claim: ${finding.reason}`);
		}
		// "accepted" is itself a claim: it must rest on the verifier's own inspection, and a failing last
		// test run contradicts it. A subject with no tests (docs, config) is verified by reading it.
		if (input.verifierVerdict === "accepted") {
			const receipts = collectWorkerReportClaimReceipts(input);
			if (receipts.tests.lastPassed === false)
				blockers.push("verification accepted although the verifier's last test run failed");
			else if (receipts.checks?.lastPassed === false)
				blockers.push("verification accepted although the verifier's last non-test check failed");
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
