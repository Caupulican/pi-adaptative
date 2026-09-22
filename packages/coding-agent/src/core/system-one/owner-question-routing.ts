/**
 * Owner questions under a full handoff.
 *
 * Outside a handoff a question for the owner always reaches the owner. Under a handoff the agents
 * settle what they can: System One first (clarification arbitration), then a stronger model. Only a
 * decision nobody was given a green light to make is written to the owner's follow-up document, and
 * the run continues with the rest of its work instead of waiting on a human who handed it off.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type UnsettledItemJudge, verdictAt } from "./unsettled-ladder.ts";

/** What the stronger model concluded about one owner question. */
export type OwnerQuestionConsult =
	| { readonly kind: "answered"; readonly answer: string; readonly basis: string; readonly model: string }
	| { readonly kind: "needs_owner"; readonly reason: string; readonly model: string };

/** The system prompt the stronger model answers under: settle it, or name why only the owner can. */
export const OWNER_QUESTION_CONSULT_PROMPT = [
	"You settle a question an agent wanted to ask its human owner, who handed the work off and asked not to be asked.",
	"Answer it yourself when the request, the stated context and ordinary engineering judgment are enough.",
	"Only when the question is a real decision the owner reserved (scope, money, risk, irreversible or outward-facing action, taste the request does not settle) say it needs the owner.",
	"Reply with either two lines:",
	"ANSWER: <the answer the agent should proceed with>",
	"BASIS: <the words of the owner's request that settle it, quoted>",
	"or one line:",
	"NEEDS_OWNER: <why only the owner can decide, in one sentence>",
	"An answer the request does not settle is not yours to give: say NEEDS_OWNER.",
].join("\n");

export function consultMessage(input: { request: string; question: string }): string {
	return [
		`Owner's request:\n${input.request || "(not recorded)"}`,
		`Question the agent wanted to ask:\n${input.question}`,
	].join("\n\n");
}

/** The stronger model's verdict, or undefined when it answered neither way. */
export function parseConsultReply(reply: string, model: string): OwnerQuestionConsult | undefined {
	const lines = reply.split("\n").map((entry) => entry.trim());
	const field = (name: string): string | undefined => {
		const line = lines.find((entry) => entry.toUpperCase().startsWith(`${name}:`));
		const text = line?.slice(name.length + 1).trim();
		return text ? text : undefined;
	};
	const answer = field("ANSWER");
	const needsOwner = field("NEEDS_OWNER");
	if (answer) {
		const basis = field("BASIS");
		// An answer with nothing in the request behind it is the model deciding for the owner.
		return basis
			? { kind: "answered", answer, basis, model }
			: { kind: "needs_owner", reason: `${model} answered without a basis in the request: ${answer}`, model };
	}
	return needsOwner ? { kind: "needs_owner", reason: needsOwner, model } : undefined;
}

/**
 * The model finds, Jev decides: an answer stands only when System One judges, decisively, that the
 * owner's request states its basis and that the basis settles the question with that answer.
 * Anything short of that, an outage included, leaves the question for the owner.
 */
export async function groundConsultAnswer(
	judge: UnsettledItemJudge | undefined,
	input: {
		readonly consult: Extract<OwnerQuestionConsult, { kind: "answered" }>;
		readonly request: string;
		readonly question: string;
		readonly signal?: AbortSignal;
	},
): Promise<OwnerQuestionConsult> {
	const { consult } = input;
	const unsettled = (why: string): OwnerQuestionConsult => ({
		kind: "needs_owner",
		reason: `${consult.model} answered "${consult.answer}", but ${why}`,
		model: consult.model,
	});
	if (!judge) return unsettled("System One is not bound to check it");
	try {
		const answers = await judge.evaluateUnsettledItems(
			[
				{ statement: consult.basis, evidence: input.request },
				{
					statement: `The answer to this question is: ${consult.answer}\nQuestion: ${input.question}`,
					evidence: consult.basis,
				},
			],
			input.signal,
		);
		if (verdictAt(answers, 0) !== "confirmed") return unsettled("the owner's request does not show its basis");
		if (verdictAt(answers, 1) !== "confirmed") return unsettled("its basis does not settle the question");
		return consult;
	} catch (error) {
		return unsettled(`System One could not check it (${error instanceof Error ? error.message : String(error)})`);
	}
}

/** The owner's follow-up document for one session: one per session, appended, never rewritten. */
export function ownerFollowUpPath(agentDir: string, sessionId: string): string {
	return join(agentDir, "follow-ups", `${sessionId}.md`);
}

/** Append one decision the owner must make to the follow-up document and return its path. */
export function appendOwnerFollowUp(
	path: string,
	entry: { readonly question: string; readonly reason: string; readonly request: string; readonly at: string },
): string {
	mkdirSync(dirname(path), { recursive: true });
	const header = existsSync(path)
		? ""
		: "# Owner follow-ups\n\nDecisions the agents were not given a green light to make during a handed-off run. Answer them to start the next round of work.\n";
	appendFileSync(
		path,
		`${header}\n## ${entry.at}\n\n**Question:** ${entry.question}\n\n**Why it needs you:** ${entry.reason}\n\n**Request it came from:** ${entry.request || "(not recorded)"}\n`,
	);
	return path;
}
