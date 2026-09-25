/**
 * Owner questions under a full handoff.
 *
 * Outside a handoff a question for the owner always reaches the owner. Under a handoff the agents
 * settle what they can: System One first (clarification arbitration), then a stronger model. Only a
 * decision nobody was given a green light to make is written to the owner's follow-up document, and
 * the run continues with the rest of its work instead of waiting on a human who handed it off.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDecisivelyFalse, isDecisivelyTrue } from "../decision/noul.ts";
import { quotedIn, RESERVED_DECISION_KINDS, type UnsettledItemJudge } from "./unsettled-ladder.ts";

/**
 * What the stronger model concluded about one owner question. An answer rests either on words the
 * owner's request states (`request`) or on the agents' own judgment (`judgment`), which a handoff
 * allows only for a decision the owner did not reserve.
 */
export type OwnerQuestionConsult =
	| {
			readonly kind: "answered";
			readonly answer: string;
			readonly grounds: "request" | "judgment";
			readonly basis: string;
			readonly model: string;
	  }
	| { readonly kind: "needs_owner"; readonly reason: string; readonly model: string };

/** What System One judges a consult answer with: the item ladder's Nouls and the reserved kinds. */
export interface OwnerQuestionJudge extends UnsettledItemJudge {
	evaluateConsultGrounding(
		input: { readonly basis: string; readonly question: string; readonly answer: string },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
	evaluateReservedDecision(
		input: { readonly question: string; readonly request: string },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
}

/** The system prompt the stronger model answers under: settle it, or name why only the owner can. */
export const OWNER_QUESTION_CONSULT_PROMPT = [
	"You settle a question an agent wanted to ask its human owner, who handed the work off to the agents.",
	"The agents may decide anything the owner did not reserve. The owner reserves: what the work should include beyond the request, spending money, accepting security, privacy or data-loss risk, actions that cannot be undone or leave the machine, and personal preferences the request does not settle.",
	"Reply with one of:",
	"ANSWER: <the answer the agent should proceed with>",
	"BASIS: <the words of the owner's request that settle it, copied exactly>",
	"or",
	"ANSWER: <the answer the agent should proceed with>",
	"JUDGMENT: <the engineering reason, when the request does not settle it and the decision is not reserved>",
	"or",
	"NEEDS_OWNER: <why only the owner can decide, in one sentence>",
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
		if (basis) return { kind: "answered", answer, grounds: "request", basis, model };
		const judgment = field("JUDGMENT");
		if (judgment) return { kind: "answered", answer, grounds: "judgment", basis: judgment, model };
		// An answer with no grounds at all is the model deciding for the owner.
		return { kind: "needs_owner", reason: `${model} answered without grounds: ${answer}`, model };
	}
	return needsOwner ? { kind: "needs_owner", reason: needsOwner, model } : undefined;
}

/**
 * The model finds, System One decides. An answer grounded in the request stands only when the request
 * contains the quoted basis (a fact code checks) and System One judges, decisively, that the basis
 * settles the question. An answer grounded in judgment stands only when System One judges,
 * decisively, that the question is none of the kinds the owner reserves. Anything short of that, an
 * outage included, leaves it for the owner.
 */
export async function groundConsultAnswer(
	judge: OwnerQuestionJudge | undefined,
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
		if (consult.grounds === "judgment") {
			const answers = await judge.evaluateReservedDecision(
				{ question: input.question, request: input.request },
				input.signal,
			);
			const reserved = Object.keys(RESERVED_DECISION_KINDS).filter((id) => !isDecisivelyFalse(answers[id]));
			return reserved.length === 0
				? consult
				: unsettled(`the decision may be one the owner reserves (${reserved.join(", ")})`);
		}
		// Whether the request holds the quote is a fact; whether the quote backs the answer is System One's.
		if (!quotedIn(consult.basis, input.request)) return unsettled("the owner's request does not contain its basis");
		const answers = await judge.evaluateConsultGrounding(
			{ basis: consult.basis, question: input.question, answer: consult.answer },
			input.signal,
		);
		if (!isDecisivelyTrue(answers.basis_backs_answer)) return unsettled("its basis does not settle the question");
		return consult;
	} catch (error) {
		return unsettled(`System One could not check it (${error instanceof Error ? error.message : String(error)})`);
	}
}

/** The owner's follow-up document for one session: one per session, appended, never rewritten. */
export function ownerFollowUpPath(agentDir: string, sessionId: string): string {
	return join(agentDir, "follow-ups", `${sessionId}.md`);
}

export function ownerFollowUpBytes(path: string): number {
	try {
		return statSync(path).size;
	} catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return 0;
		throw error;
	}
}

function requestMarker(request: string): string {
	return `<!-- request:${createHash("sha256").update(request).digest("hex").slice(0, 16)} -->`;
}

/**
 * Append one decision the owner must make to the follow-up document and return its path. Entries
 * are grouped under one heading per request, and a question the document already holds is not
 * written again, so a long unassisted run grows it by decisions, not by repeats.
 */
export function appendOwnerFollowUp(
	path: string,
	entry: { readonly question: string; readonly reason: string; readonly request: string; readonly at: string },
): string {
	mkdirSync(dirname(path), { recursive: true });
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	const questionLine = `**Question:** ${entry.question}\n`;
	if (existing.includes(questionLine)) return path;
	const marker = requestMarker(entry.request);
	const lastMarker = existing.match(/<!-- request:[0-9a-f]{16} -->/g)?.at(-1);
	const header = existing
		? ""
		: "# Owner follow-ups\n\nDecisions the agents were not given a green light to make during a handed-off run. Answer them to start the next round of work.\n";
	const section =
		lastMarker === marker
			? ""
			: `\n## Request (${entry.at})\n${marker}\n\n${(entry.request || "(not recorded)")
					.split("\n")
					.map((line) => `> ${line}`)
					.join("\n")}\n`;
	appendFileSync(path, `${header}${section}\n${questionLine}\n**Why it needs you:** ${entry.reason}\n`);
	return path;
}
