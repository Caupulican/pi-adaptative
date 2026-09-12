import type { Usage } from "@caupulican/pi-ai";
import { MAX_MANAGED_LANE_SUMMARY_BYTES } from "../extensions/types.ts";
import type { CollaborationBackend, CollaborationQuestionAnswer } from "./backend.ts";
import { boundCollaborationEvidence, type CollaborationTerminal } from "./job-store.ts";
import type { CollaborationPendingQuestion, CollaborationResultClaim } from "./result-claim.ts";
import { waitForTurnSettlement } from "./turn-settlement.ts";

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
	subscribeReport?: (listener: () => void) => () => void,
	isTurnActive?: () => boolean,
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

	const startTime = Date.now();
	const initialStopped = nativeQuestion
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
	if (initialStopped.terminalId !== input.terminalId) throw new Error("Collaboration pane occupant changed.");

	const settlement = await waitForTurnSettlement({
		backend,
		target: input.target,
		terminalId: input.terminalId,
		paneId: initialStopped.paneId,
		turnId: input.turnId,
		initialAgent: initialStopped,
		timeoutMs: input.timeoutMs,
		startTime,
		signal,
		readClaim,
		readQuestion,
		subscribeReport,
		isTurnActive,
	});

	signal?.throwIfAborted();
	const finalSettled = settlement.agent;
	const claim = settlement.claim;
	const question = settlement.question;

	const read = await backend.readAgent(input.target, 200);
	if (read.paneId !== finalSettled.paneId) throw new Error("Collaboration evidence belongs to another pane.");
	const current = await backend.getAgent(input.target);
	signal?.throwIfAborted();
	if (
		current.terminalId !== finalSettled.terminalId ||
		current.paneId !== finalSettled.paneId ||
		current.stateChangeSequence !== finalSettled.stateChangeSequence ||
		current.status !== finalSettled.status ||
		current.question !== finalSettled.question ||
		current.revision < finalSettled.revision
	)
		throw new Error("Collaboration stopped state changed during evidence capture.");
	if (question && JSON.stringify(readQuestion?.()) !== JSON.stringify(question))
		throw new Error("Collaboration pending question changed during evidence capture.");
	if (question) return { status: "blocked", evidence: question.evidence, usage: claim?.usage };
	const evidence = read.text.slice(-16000);
	if (claim && (finalSettled.status !== "blocked" || claim.status === "blocked"))
		return { status: claim.status, evidence: claim.evidence, usage: claim.usage };
	return {
		status: "blocked",
		usage: claim?.usage,
		evidence: boundCollaborationEvidence(
			`Worker needs review or an answer before continuation. ${claim ? "Native agent remains blocked despite its report. " : "No authenticated final report for this dispatch. "}${read.truncated ? "Pane evidence was truncated. " : ""}\n${finalSettled.status === "blocked" && finalSettled.question ? `Native agent question (peer-provided):\n${finalSettled.question}\n\nCaptured stopped pane:\n` : ""}${evidence}`,
		),
	};
}
