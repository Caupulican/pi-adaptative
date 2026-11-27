import type { ToolCall } from "@caupulican/pi-ai";
import type { SessionManager } from "../../kernel/node.ts";
import { isPassingTestVerification, retainedVerificationDetails } from "../../kernel/verification-obligations.ts";
import { type BackgroundToolTaskRecord, findBackgroundToolTask } from "../background-tool-task-controller.ts";
import { textContentPrefix } from "../context/message-text.ts";
import { awaitPreflight } from "../preflight.ts";
import { redactKnownSecrets, redactTokenShapes } from "../security/secret-text.ts";
import type { GoalToolDependencies, GoalToolEvidenceResolution, GoalUserEvidenceResolution } from "../tools/goal.ts";
import { shellWord } from "../tools/shell-command-parser.ts";
import { ownerOriginKind, stampedHistoryStart } from "../turn-origin.ts";

import { resolveNativeGoalFileEvidence } from "./file-evidence.ts";
import { requirementKey } from "./goal-acceptance.ts";
import type { GoalEvidenceKind, GoalEvidenceOutcome, GoalEvidenceRef, GoalState, Requirement } from "./goal-state.ts";
import { isExplicitRequirementCheckContract } from "./requirement-checks.ts";
import { resolvedGoalEvidenceObservation } from "./requirement-coverage.ts";

type EvidenceTask = Pick<
	BackgroundToolTaskRecord,
	"taskId" | "toolCallId" | "goalId" | "status" | "piVerification" | "output"
>;

/** Live evidence reader shared by goal tools and the completion reviewer's canonical projection. */
export function createSessionGoalEvidenceReader(ports: {
	manager(): SessionManager;
	tasks(): readonly BackgroundToolTaskRecord[];
	isBuiltin(toolName: string): boolean;
}) {
	const resolve = (uri: string, kind: "tool" | "test", observe = false) =>
		resolveSessionToolEvidence(ports.manager(), ports.tasks(), uri, kind, ports.isBuiltin, observe);
	return {
		resolve,
		observe: (evidence: GoalEvidenceRef) => resolvedGoalEvidenceObservation(evidence, resolve),
	};
}

/** Deterministic coverage is available when the owner stated exactly the command and outcome being measured. */
export function ownerSpecifiedRequirementCheck(
	sessionManager: Pick<SessionManager, "getBranch" | "getSessionId">,
	goal: GoalState | undefined,
	requirement: Requirement,
): boolean {
	if (!goal || !isExplicitRequirementCheckContract(requirement)) return false;
	const current = goal.requirements.find((item) => item.id === requirement.id);
	if (!current || requirementKey(current) !== requirementKey(requirement)) return false;
	const prefix = `${sessionManager.getSessionId()}/`;
	const initial = goal.ownerSourceId?.startsWith(prefix) ? goal.ownerSourceId.slice(prefix.length) : undefined;
	return [initial, goal.amendmentOwnerEntryId].some(
		(entryId) =>
			entryId !== undefined &&
			resolveSessionUserEvidence(sessionManager, requirement.text, `user-message:${entryId}`).verified,
	);
}

function toolObservation(call: ToolCall, output: string | undefined): string {
	const bounded = (text: string, limit: number) => {
		const safe = redactTokenShapes(redactKnownSecrets(text));
		return safe.length > limit ? `${safe.slice(0, limit)} [truncated]` : safe;
	};
	return [
		`Tool ${call.name}, receipt ${call.id}, completed successfully.`,
		`Operation: ${bounded(producingCommand(call) ?? JSON.stringify(call.arguments ?? {}), 1024)}`,
		`Observed output: ${output ? bounded(output, 4096) : "(no text retained)"}`,
	].join("\n");
}

/**
 * Prove that the cited statement came from a user message on this branch. Internal continuation
 * and reflection turns are custom messages, not user evidence. Requiring the complete text avoids
 * manufacturing a confirmation by extracting a positive phrase from a denial or qualification.
 * This verifies provenance; deciding whether the statement supports a requirement remains review work.
 */
export function resolveSessionUserEvidence(
	sessionManager: Pick<SessionManager, "getBranch">,
	summary: string,
	uri?: string,
): GoalUserEvidenceResolution {
	const quote = summary.trim();
	const locator = uri?.trim();
	const entryId = locator?.replace(/^user-message:/, "");
	if (locator && !entryId) return { verified: false, reason: "the user-message locator is missing its entry id" };
	if (!quote) return { verified: false, reason: "quote the complete user statement" };
	const branch = sessionManager.getBranch();
	const stampedStart = stampedHistoryStart(branch);
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entryId && entry.id !== entryId) continue;
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		// Only the owner's own words are evidence: typed at the terminal or sent from a verified owner channel (or typed before
		// inputs carried an identity, in the branch's legacy prefix). A harness, routine, extension or third-party entry, and an
		// entry whose origin names nobody after that prefix, is not the owner's statement (see `ownerOriginKind`).
		if (ownerOriginKind(entry, index, stampedStart) === undefined) continue;
		const text = textContentPrefix(entry.message.content);
		if (text.trim() === quote) return { verified: true, messageEntryId: entry.id };
	}
	return { verified: false, reason: "no user message on the active branch matches the complete quoted statement" };
}

/** The command a bash/python/run_process call actually ran, or undefined for any other call. */
export function producingCommand(call: ToolCall): string | undefined {
	if (call.name === "bash") {
		const command = call.arguments?.command;
		return typeof command === "string" ? command : undefined;
	}
	if (call.name === "run_process") {
		// The tool runs its argv without a shell (`executable` and `args`): the same program written as one command line.
		const executable = call.arguments?.executable;
		if (typeof executable !== "string" || executable.length === 0) return undefined;
		const args: unknown = call.arguments?.args;
		if (args !== undefined && (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")))
			return undefined;
		const words = (args ?? []) as string[];
		return [shellWord(executable), ...words.map(shellWord)].join(" ");
	}
	if (call.name === "python") {
		const code = call.arguments?.code ?? call.arguments?.scriptPath;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

/**
 * The language of a python call's recorded command: `python` for source the call ran (`code`), `python-file` for a file it ran
 * (`scriptPath`), whose source the host reads for its stakes when the call runs (`details.scriptStakes`); those stakes, never
 * the path, are its facts. Undefined for any other call.
 */
export function pythonCallLanguage(call: ToolCall): "python" | "python-file" | undefined {
	if (call.name !== "python") return undefined;
	return typeof call.arguments?.code === "string" ? "python" : "python-file";
}

/** Only unquoted shell words have layout-insensitive separators; source and quoted bytes remain exact. */
function simpleShellCommand(value: string): string | undefined {
	const command = value
		.replace(/^[ \t]+|[ \t]+$/g, "")
		.replace(/;$/, "")
		.replace(/[ \t]+$/g, "");
	const words = command.split(/[ \t]+/);
	return words.length > 0 && words.every((word) => word.length > 0 && shellWord(word) === word)
		? words.join(" ")
		: undefined;
}

function matchesProducingCommand(call: ToolCall, citation: string): boolean {
	const produced = producingCommand(call);
	if (produced === undefined) return false;
	if (produced === citation) return true;
	if (call.name === "python") return false;
	const simple = simpleShellCommand(produced);
	return simple !== undefined && simple === simpleShellCommand(citation);
}

const MAX_COMMAND_EXCERPT_CHARS = 60;
const MAX_SUGGESTED_CALLS = 3;

/**
 * What the model should cite next when nothing matched. "No producing call matches" alone left it
 * guessing at spellings across whole turns; the newest bash/python call ids with an excerpt each
 * make the next citation exact.
 */
function unmatchedCommandReason(branch: ReturnType<SessionManager["getBranch"]>): string {
	const suggestions: string[] = [];
	for (let index = branch.length - 1; index >= 0 && suggestions.length < MAX_SUGGESTED_CALLS; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		for (let part = content.length - 1; part >= 0 && suggestions.length < MAX_SUGGESTED_CALLS; part--) {
			const call = content[part];
			if (call?.type !== "toolCall") continue;
			const command = producingCommand(call);
			if (command === undefined) continue;
			const excerpt = command;
			suggestions.push(
				`${call.id} (${excerpt.length > MAX_COMMAND_EXCERPT_CHARS ? `${excerpt.slice(0, MAX_COMMAND_EXCERPT_CHARS)}…` : excerpt})`,
			);
		}
	}
	const base = "no producing call matches this id or exact command on the active branch";
	return suggestions.length === 0
		? `${base}; no bash or python call is recorded on it`
		: `${base}; cite one of the most recent calls: ${suggestions.join(", ")}`;
}

/**
 * Session adapter for the goal tool's evidence port. A locator selects one producing call; its
 * outcome decides trust. Exact command citations select the newest attempt, including failures and
 * unanswered calls, so they cannot fall back to an earlier pass. Arbitrary argument substrings and
 * model-written summaries never establish either identity or a passing test outcome.
 *
 * A verification receipt (`details.piVerification`) is trusted only when the producing call names a tool the host's registry
 * holds as its builtin definition (`isBuiltinTool`). A tool an extension registers, under any name or over a builtin's name,
 * can return the same details, so its receipt never proves a test.
 */
export function resolveSessionToolEvidence(
	sessionManager: Pick<SessionManager, "getBranch">,
	backgroundTasks: readonly EvidenceTask[],
	uri: string,
	kind: "tool" | "test",
	isBuiltinTool: (toolName: string) => boolean,
	observe = false,
): GoalToolEvidenceResolution {
	const locator = uri.trim();
	if (!locator) return { verified: false, reason: "cite a producing toolCallId or its exact command" };
	const task = findBackgroundToolTask(backgroundTasks, locator);
	const callId = task?.toolCallId ?? locator;
	const labeledCommand = uri.replace(/^[ \t]*(?:command|cmd|run|shell|tool)[ \t]*[:=][ \t]*/i, "");
	const branch = sessionManager.getBranch();
	let call: ToolCall | undefined;
	let callIndex = -1;
	// Prefer an exact id over command text, even if a later command happens to spell that id.
	for (const selection of ["id", "command", "labeled-command"] as const) {
		if (selection === "labeled-command" && labeledCommand === uri) continue;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			call = entry.message.content.findLast((part): part is ToolCall => {
				if (part.type !== "toolCall") return false;
				if (selection === "id") return part.id === callId;
				if (task) return false;
				if (selection === "labeled-command" && part.name === "python") return false;
				return matchesProducingCommand(part, selection === "labeled-command" ? labeledCommand : uri);
			});
			if (call) {
				callIndex = index;
				break;
			}
		}
		if (call) break;
	}
	if (!call) return { verified: false, reason: unmatchedCommandReason(branch) };
	// Only the host's builtin definition of the producing tool may prove a verification (see the function's note).
	const builtinProducer = isBuiltinTool(call.name);

	const background = task ?? findBackgroundToolTask(backgroundTasks, call.id);
	if (background) {
		if (background.status === "running") {
			return { verified: false, reason: `the producing background task is ${background.status}` };
		}
		const verification = builtinProducer ? retainedVerificationDetails(background)?.piVerification : undefined;
		if (
			kind === "test" &&
			(background.status !== "completed" ||
				!isPassingTestVerification(verification) ||
				verification.originTaskId !== background.taskId)
		) {
			return { verified: false, reason: "the background task has no trusted passing verification receipt" };
		}
		return {
			verified: true,
			toolCallId: call.id,
			outcome: background.status === "completed" ? "succeeded" : background.status,
			...(observe && builtinProducer && background.status === "completed"
				? { observation: toolObservation(call, background.output) }
				: {}),
		};
	}

	for (let index = branch.length - 1; index > callIndex; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolCallId !== call.id)
			continue;
		const result = entry.message;
		if (result.toolName !== call.name) {
			return { verified: false, reason: "the result does not match the called tool" };
		}
		// Background placeholders and status observations are not completed foreground operations.
		if (result.details && typeof result.details === "object" && "taskId" in result.details) {
			return { verified: false, reason: "the background task's authoritative outcome is unavailable" };
		}
		const verification = builtinProducer ? retainedVerificationDetails(result.details)?.piVerification : undefined;
		if (
			kind === "test" &&
			(result.isError || !isPassingTestVerification(verification) || verification.originTaskId !== undefined)
		) {
			return { verified: false, reason: "the producing call has no trusted passing verification receipt" };
		}
		return {
			verified: true,
			toolCallId: call.id,
			outcome: result.isError ? "failed" : "succeeded",
			...(observe && builtinProducer && !result.isError
				? { observation: toolObservation(call, textContentPrefix(result.content)) }
				: {}),
		};
	}
	return { verified: false, reason: "the producing call has no terminal result on the active branch" };
}

/**
 * Validate an evidence ref's `uri` against session records ("tool") or the filesystem ("file").
 * Returns `undefined` for kinds/refs that carry nothing checkable (e.g. "finding",
 * or a missing `uri`) -- absence of a ref is not the same as a ref that failed to verify.
 */
export async function resolveEvidenceVerified(
	kind: GoalEvidenceKind,
	uri: string | undefined,
	summary: string,
	deps: GoalToolDependencies,
	signal?: AbortSignal,
): Promise<{ verified: boolean | undefined; uri?: string; reason?: string; outcome?: GoalEvidenceOutcome }> {
	if (kind === "file" && uri) {
		return awaitPreflight(
			() =>
				deps.resolveFileEvidence
					? deps.resolveFileEvidence(uri, signal)
					: resolveNativeGoalFileEvidence(uri, deps.cwd?.() ?? process.cwd(), signal),
			signal,
		);
	}
	if (kind === "user") {
		const resolved = deps.resolveUserEvidence?.(summary, uri);
		if (!resolved) return { verified: false, reason: "user-statement verification is unavailable" };
		return resolved.verified
			? { verified: true, uri: `user-message:${resolved.messageEntryId}` }
			: { verified: false, reason: resolved.reason };
	}
	const trimmedUri = uri?.trim();
	if (!trimmedUri) return { verified: undefined };
	if (kind === "tool" || kind === "test") {
		const resolved = deps.resolveToolEvidence?.(uri!, kind);
		if (!resolved) return { verified: false, reason: "session evidence verification is unavailable" };
		return resolved.verified
			? { verified: true, uri: resolved.toolCallId, outcome: resolved.outcome }
			: { verified: false, reason: resolved.reason };
	}
	if (kind === "worker") {
		if (!deps.getLaneRecords || !deps.getWorkerClaimSnapshots) return { verified: false };
		const laneId = trimmedUri;
		const record = deps.getLaneRecords().find((candidate) => candidate.laneId === laneId);
		if (!record) return { verified: false };
		const claim = deps.getWorkerClaimSnapshots().find((candidate) => candidate.requestId === laneId);
		if (!claim) return { verified: false };
		// An unreviewed mutation (parentReviewRequired && no parentReviewedAt) can never verify true --
		// this is what stops an unreviewed worker completion from ungating goal completion through
		// the existing verified/complete gate (goal-tool-core's isVerifiedOrUserEvidence/complete).
		if (claim.parentReviewRequired === true && claim.parentReviewedAt === undefined) return { verified: false };
		// The host's own check of the report can refuse what the worker's status claims: a report whose
		// stated claims are contradicted or missing named proof does not verify a requirement. Absent (an
		// older claim, or one with nothing to check) and `accepted` verify as before; `unverified` (a text
		// answer after a report request) stands as it always did, because nothing was checked either way.
		const verdict = claim.hostVerdict?.verdict;
		if (verdict === "needs_more" || verdict === "rejected" || verdict === "blocked") return { verified: false };
		return { verified: claim.status === "completed" };
	}
	return { verified: undefined };
}
