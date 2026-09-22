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

/** What the stronger model concluded about one owner question. */
export type OwnerQuestionConsult =
	| { readonly kind: "answered"; readonly answer: string; readonly model: string }
	| { readonly kind: "needs_owner"; readonly reason: string; readonly model: string };

/** The system prompt the stronger model answers under: settle it, or name why only the owner can. */
export const OWNER_QUESTION_CONSULT_PROMPT = [
	"You settle a question an agent wanted to ask its human owner, who handed the work off and asked not to be asked.",
	"Answer it yourself when the request, the stated context and ordinary engineering judgment are enough.",
	"Only when the question is a real decision the owner reserved (scope, money, risk, irreversible or outward-facing action, taste the request does not settle) say it needs the owner.",
	"Reply with exactly one line:",
	"ANSWER: <the answer the agent should proceed with>",
	"or",
	"NEEDS_OWNER: <why only the owner can decide, in one sentence>",
].join("\n");

export function consultMessage(input: { request: string; question: string }): string {
	return [
		`Owner's request:\n${input.request || "(not recorded)"}`,
		`Question the agent wanted to ask:\n${input.question}`,
	].join("\n\n");
}

/** The stronger model's one-line verdict, or undefined when it answered neither way. */
export function parseConsultReply(reply: string, model: string): OwnerQuestionConsult | undefined {
	const line = reply
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => /^(ANSWER|NEEDS_OWNER):/i.test(entry));
	if (!line) return undefined;
	const separator = line.indexOf(":");
	const verdict = line.slice(0, separator).toUpperCase();
	const text = line.slice(separator + 1).trim();
	if (!text) return undefined;
	return verdict === "ANSWER"
		? { kind: "answered", answer: text, model }
		: { kind: "needs_owner", reason: text, model };
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
