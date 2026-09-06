import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { retainedVerificationDetails } from "@caupulican/pi-agent-core/verification-obligations";
import type { ToolCall } from "@caupulican/pi-ai";
import { type BackgroundToolTaskRecord, findBackgroundToolTask } from "../background-tool-task-controller.ts";
import type { GoalToolEvidenceResolution, GoalUserEvidenceResolution } from "../tools/goal.ts";

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
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entryId && entry.id !== entryId) continue;
		if (entry.type !== "message" || entry.message.role !== "user") continue;
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
	const command = locator.replace(/^(?:command|cmd|run|shell|tool)\s*[:=]\s*/i, "").trim();
	const branch = sessionManager.getBranch();
	let call: ToolCall | undefined;
	let callIndex = -1;
	// Prefer an exact id over command text, even if a later command happens to spell that id.
	for (const matchCommand of [false, true]) {
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			call = entry.message.content.findLast(
				(part): part is ToolCall =>
					part.type === "toolCall" &&
					(matchCommand
						? !task &&
							(part.name === "bash" || part.name === "run_process") &&
							part.arguments?.command === command
						: part.id === callId),
			);
			if (call) {
				callIndex = index;
				break;
			}
		}
		if (call) break;
	}
	if (!call)
		return { verified: false, reason: "no producing call matches this id or exact command on the active branch" };

	const background = task ?? findBackgroundToolTask(backgroundTasks, call.id);
	if (background) {
		if (background.status === "running") {
			return { verified: false, reason: `the producing background task is ${background.status}` };
		}
		const verification = retainedVerificationDetails(background)?.piVerification;
		if (
			kind === "test" &&
			(background.status !== "completed" ||
				verification?.status !== "passed" ||
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
			(result.isError || verification?.status !== "passed" || verification.originTaskId !== undefined)
		) {
			return { verified: false, reason: "the producing call has no trusted passing verification receipt" };
		}
		return { verified: true, toolCallId: call.id, outcome: result.isError ? "failed" : "succeeded" };
	}
	return { verified: false, reason: "the producing call has no terminal result on the active branch" };
}
