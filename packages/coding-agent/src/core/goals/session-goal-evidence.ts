import type { ToolCall } from "@caupulican/pi-ai";
import type { SessionManager } from "../../kernel/node.ts";
import { isPassingTestVerification, retainedVerificationDetails } from "../../kernel/verification-obligations.ts";
import { type BackgroundToolTaskRecord, findBackgroundToolTask } from "../background-tool-task-controller.ts";
import type { GoalToolEvidenceResolution, GoalUserEvidenceResolution } from "../tools/goal.ts";
import { shellWord } from "../tools/shell-command-parser.ts";
import { ownerOriginKind, stampedHistoryStart } from "../turn-origin.ts";

type EvidenceTask = Pick<BackgroundToolTaskRecord, "taskId" | "toolCallId" | "goalId" | "status" | "piVerification">;

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
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
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
		if (typeof executable !== "string" || executable.trim() === "") return undefined;
		const args: unknown = call.arguments?.args;
		const words = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [];
		return [shellWord(executable.trim()), ...words.map(shellWord)].join(" ");
	}
	if (call.name === "python") {
		const code = call.arguments?.code ?? call.arguments?.scriptPath;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

/**
 * The language of a python call's recorded command: `python` for source the call ran (`code`), `python-file` for a file it ran
 * (`scriptPath`), whose source the host never reads, so the stakes reader takes no code fact from it. Undefined for any other call.
 */
export function pythonCallLanguage(call: ToolCall): "python" | "python-file" | undefined {
	if (call.name !== "python") return undefined;
	return typeof call.arguments?.code === "string" ? "python" : "python-file";
}

/**
 * One spelling for a cited command and for the command a call actually ran, so the two compare on
 * what was executed rather than on how it was typed.
 *
 * Identity still comes from the text itself: only layout is normalized (surrounding and internal
 * whitespace, one trailing `;`). Case, flags, ordering and every other character stay significant,
 * so a paraphrase or a different invocation can never select a call it did not produce. Measured
 * live, a re-typed command with a collapsed run of spaces cost a rejected goal turn each time.
 */
function normalizeProducingCommand(value: string): string {
	return value.trim().replace(/\s+/g, " ").replace(/;$/, "").trim();
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
			const excerpt = normalizeProducingCommand(command);
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
 */
export function resolveSessionToolEvidence(
	sessionManager: Pick<SessionManager, "getBranch">,
	backgroundTasks: readonly EvidenceTask[],
	uri: string,
	kind: "tool" | "test",
): GoalToolEvidenceResolution {
	const locator = uri.trim();
	if (!locator) return { verified: false, reason: "cite a producing toolCallId or its exact command" };
	const task = findBackgroundToolTask(backgroundTasks, locator);
	const callId = task?.toolCallId ?? locator;
	const command = normalizeProducingCommand(locator.replace(/^(?:command|cmd|run|shell|tool)\s*[:=]\s*/i, ""));
	const branch = sessionManager.getBranch();
	let call: ToolCall | undefined;
	let callIndex = -1;
	// Prefer an exact id over command text, even if a later command happens to spell that id.
	for (const matchCommand of [false, true]) {
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			call = entry.message.content.findLast((part): part is ToolCall => {
				if (part.type !== "toolCall") return false;
				if (!matchCommand) return part.id === callId;
				if (task) return false;
				const produced = producingCommand(part);
				return produced !== undefined && normalizeProducingCommand(produced) === command;
			});
			if (call) {
				callIndex = index;
				break;
			}
		}
		if (call) break;
	}
	if (!call) return { verified: false, reason: unmatchedCommandReason(branch) };

	const background = task ?? findBackgroundToolTask(backgroundTasks, call.id);
	if (background) {
		if (background.status === "running") {
			return { verified: false, reason: `the producing background task is ${background.status}` };
		}
		const verification = retainedVerificationDetails(background)?.piVerification;
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
		const verification = retainedVerificationDetails(result.details)?.piVerification;
		if (
			kind === "test" &&
			(result.isError || !isPassingTestVerification(verification) || verification.originTaskId !== undefined)
		) {
			return { verified: false, reason: "the producing call has no trusted passing verification receipt" };
		}
		return { verified: true, toolCallId: call.id, outcome: result.isError ? "failed" : "succeeded" };
	}
	return { verified: false, reason: "the producing call has no terminal result on the active branch" };
}
