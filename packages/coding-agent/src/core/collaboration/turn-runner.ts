import type { Usage } from "@caupulican/pi-ai";
import { MAX_MANAGED_LANE_SUMMARY_BYTES } from "../extensions/types.ts";
import type { CollaborationBackend, CollaborationQuestionAnswer } from "./backend.ts";
import { boundCollaborationEvidence, type CollaborationTerminal } from "./job-store.ts";
import {
	type CollaborationPendingQuestion,
	type CollaborationResultClaim,
	validateCollaborationPendingQuestion,
	validateCollaborationResultClaim,
} from "./result-claim.ts";

export interface CollaborationTurnInput {
	target: string;
	terminalId: string;
	turnId: string;
	reportCommand: string;
	text: string;
	timeoutMs: number;
}

export function collaborationPrompt(input: CollaborationTurnInput): string {
	return [
		input.text,
		"Work inside the assigned scope. Keep thinking, tool activity, and progress inside this persistent session.",
		"If you need a decision or answer, stop work and state the precise question and relevant choices/context. Do not invent approval or widen authority.",
		`Your current dispatch identity is ${input.turnId}. After completing and verifying your task, or when blocked, submit your bounded final evidence through the authenticated report command as your last tool action. Printed terminal markers are not completion evidence.`,
		`Immediately before EVERY report, including after an answer or keyboard selection resumes you, run this command and read its returned turnId (answers create a fresh identity; never reuse an older one):\n${input.reportCommand} current`,
		`Then run: ${input.reportCommand} report <returned-turnId> <done|blocked> <quoted-evidence> [optional-usage-json]`,
		`Use done only for verified completed work. Use blocked for a precise question or missing condition. Evidence must be nonempty and at most ${MAX_MANAGED_LANE_SUMMARY_BYTES} UTF-8 bytes. Optional advisory token usage must be directly measured; never estimate it. Never display the peer token environment variable.`,
		"After a successful report, end your response and stop working. The orchestrator waits for the native stopped event before accepting your report. Do not issue another tool call or task until the orchestrator resumes you. If a report receipt is lost, retry the exact same turn ID, status, evidence and usage; never replace an accepted claim.",
	].join("\n\n");
}

/** A single stopped-work boundary: no incremental output or progress callback exists by design. */
export async function executeCollaborationTurn(
	backend: CollaborationBackend,
	input: CollaborationTurnInput,
	signal?: AbortSignal,
	answer?: Pick<CollaborationQuestionAnswer, "text" | "keys">,
	readClaim?: () => CollaborationResultClaim | undefined,
	readQuestion?: () => CollaborationPendingQuestion | undefined,
): Promise<{ status: CollaborationTerminal; evidence: string; usage?: Usage }> {
	signal?.throwIfAborted();
	let nativeQuestion = false;
	if (answer) {
		const current = await backend.getAgent(input.target);
		signal?.throwIfAborted();
		if (current.terminalId !== input.terminalId || current.launchPending)
			throw new Error("Collaboration pane occupant changed before answering.");
		nativeQuestion = current.status === "blocked";
		if (
			!nativeQuestion &&
			(!["idle", "done"].includes(current.status) || !answer.text?.trim() || answer.keys?.length)
		)
			throw new Error("Collaboration textual question requires a stopped agent and a text answer without keys.");
	}
	const stopped = nativeQuestion
		? await backend.answerQuestion(
				{ ...answer, target: input.target, terminalId: input.terminalId, timeoutMs: input.timeoutMs },
				signal,
			)
		: await backend.prompt(
				{
					...input,
					text: collaborationPrompt(
						answer
							? {
									...input,
									text: `Continue the original task in this persistent conversation using the following answer. Do not restart or replay completed work.\n\nAnswer:\n${answer.text}\n\nContinuation context:\n${input.text}`,
								}
							: input,
					),
				},
				signal,
			);
	signal?.throwIfAborted();
	if (!["idle", "done", "blocked"].includes(stopped.status))
		throw new Error("Collaboration agent has not stopped working.");
	if (stopped.terminalId !== input.terminalId) throw new Error("Collaboration pane occupant changed.");
	let claim = readClaim?.();
	try {
		if (claim) validateCollaborationResultClaim(claim);
		if (claim?.turnId !== input.turnId) claim = undefined;
	} catch {
		claim = undefined;
	}
	let question = stopped.status === "blocked" ? readQuestion?.() : undefined;
	try {
		if (question) validateCollaborationPendingQuestion(question);
		if (question?.turnId !== input.turnId) question = undefined;
	} catch {
		question = undefined;
	}
	const read = await backend.readAgent(input.target, 200);
	if (read.paneId !== stopped.paneId) throw new Error("Collaboration evidence belongs to another pane.");
	const current = await backend.getAgent(input.target);
	signal?.throwIfAborted();
	if (
		current.terminalId !== stopped.terminalId ||
		current.paneId !== stopped.paneId ||
		current.stateChangeSequence !== stopped.stateChangeSequence ||
		current.status !== stopped.status ||
		current.question !== stopped.question ||
		current.launchPending ||
		// Agent metadata revisions are comparable to each other, not to a terminal snapshot's
		// revision (Herdr 0.8.2 agent.read returns an unversioned placeholder of zero).
		current.revision < stopped.revision
	)
		throw new Error("Collaboration stopped state changed during evidence capture.");
	if (question && JSON.stringify(readQuestion?.()) !== JSON.stringify(question))
		throw new Error("Collaboration pending question changed during evidence capture.");
	// Attribution belongs to the managed lane envelope; prefixing a maximum-size question loses choices.
	if (question) return { status: "blocked", evidence: question.evidence, usage: claim?.usage };
	const evidence = read.text.slice(-16000);
	if (claim && (stopped.status !== "blocked" || claim.status === "blocked"))
		return { status: claim.status, evidence: claim.evidence, usage: claim.usage };
	return {
		status: "blocked",
		usage: claim?.usage,
		evidence: boundCollaborationEvidence(
			`Worker needs review or an answer before continuation. ${claim ? "Native agent remains blocked despite its report. " : "No authenticated final report for this dispatch. "}${read.truncated ? "Pane evidence was truncated. " : ""}\n${stopped.status === "blocked" && stopped.question ? `Native agent question (peer-provided):\n${stopped.question}\n\nCaptured stopped pane:\n` : ""}${evidence}`,
		),
	};
}
