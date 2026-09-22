/**
 * The ladder an unsettled item climbs before it may reach the owner.
 *
 * An agent that honestly could not settle something (a worker's `inconclusive` finding) does not get
 * that item rounded up, and it does not stall the run either:
 *
 *   1. System One judges the item against evidence the agent did not hand it: the agent's own tool
 *      results. Settled only on a decisive band, either way.
 *   2. Still unsettled: a stronger model looks for the one fact in that evidence that settles it,
 *      and System One judges both that the evidence states the fact and that the fact settles the
 *      item. The model finds; System One decides. A model's word alone settles nothing.
 *   3. Still unsettled: it goes to the owner. With the owner in the loop the parent asks them;
 *      under a handoff it is written to the owner's follow-up document and the work goes on around it.
 *
 * Each rung is one evidence pass with evidence the previous pass did not have, so the ladder spends at
 * most {@link GATHER_MORE_LIMIT} System One passes and never re-asks System One on unchanged evidence.
 */

import { isDecisivelyTrue } from "../decision/noul.ts";
import { GATHER_MORE_LIMIT } from "./authority-line.ts";

export type UnsettledVerdict = "confirmed" | "refuted";

export interface SettledItem {
	readonly item: string;
	readonly verdict: UnsettledVerdict;
	/** Who settled it: System One alone, or System One over a stronger model's fact. */
	readonly by: string;
	/** The fact from the evidence that settled it, when a stronger model found it. */
	readonly basis?: string;
}

export interface UnsettledItem {
	readonly item: string;
	/** What evidence would settle it, or why the ladder could not run. */
	readonly missing: string;
}

export interface LadderOutcome {
	readonly settled: readonly SettledItem[];
	readonly unsettled: readonly UnsettledItem[];
}

/** What a stronger model found in the evidence for one item. */
export type ItemConsult =
	| { readonly kind: "fact"; readonly fact: string; readonly model: string }
	| { readonly kind: "missing"; readonly missing: string; readonly model: string };

export interface UnsettledItemJudge {
	evaluateUnsettledItems(
		checks: readonly { readonly statement: string; readonly evidence: string }[],
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
}

export interface UnsettledLadderDeps {
	getJudge(): UnsettledItemJudge | undefined;
	/** The stronger model's rung; absent when no stronger model is configured. */
	consult?(input: { item: string; evidence: string; signal?: AbortSignal }): Promise<ItemConsult | undefined>;
}

/**
 * The decisions an owner keeps even after handing work off, one condition each. A question that is
 * decisively none of these is the agents' to settle; any other answer keeps it for the owner.
 */
export const RESERVED_DECISION_KINDS: Readonly<
	Record<string, { readonly instructions: string; readonly criteria?: { true: string; false: string } }>
> = {
	reserved_scope: {
		instructions:
			"Does `question` ask whether to add or drop a feature, requirement or deliverable that `request` does not already settle?",
		criteria: {
			true: "Adding, removing or changing what gets delivered",
			false: "How to build something already requested: data structures, file layout, naming, libraries, algorithms",
		},
	},
	reserved_spending: { instructions: "Does `question` ask to decide whether to spend money or buy something?" },
	reserved_risk: { instructions: "Does `question` ask to accept a security, privacy or data-loss risk?" },
	reserved_irreversible: {
		instructions:
			"Does `question` ask to decide on an action that cannot be undone or that leaves the machine (publishing, sending, deleting, releasing)?",
	},
	reserved_taste: {
		instructions:
			"Does `question` ask for the owner's personal preference on how something looks or reads, which `request` does not settle?",
		criteria: {
			true: "Visual design, colours, wording, tone, branding",
			false: "Technical implementation choices, even when several would work",
		},
	},
};

/**
 * A consult answer grounded in the request: whether the quoted basis backs the answer. Whether the
 * request contains the quote is a fact code checks (`quotedIn`), not a question for System One.
 */
export const CONSULT_GROUNDING_QUESTIONS: Readonly<
	Record<
		string,
		{ readonly type: "boolean"; readonly instructions: string; readonly criteria?: { true: string; false: string } }
	>
> = {
	basis_backs_answer: {
		type: "boolean",
		instructions: "Does `basis` tell the agent to do what `answer` says, for `question`?",
	},
};

export function unsettledQuestionId(kind: "shows_true" | "shows_false", index: number): string {
	return `${kind}_${index}`;
}

export const UNSETTLED_ITEM_CONSULT_PROMPT = [
	"An agent could not settle the item below from the evidence. Find the one fact in the evidence that settles it, either way.",
	"Quote the fact as the evidence states it. Never supply a fact the evidence does not contain.",
	"Reply with exactly one line:",
	"FACT: <the fact, as the evidence states it>",
	"or",
	"MISSING: <what evidence would settle it, in one sentence>",
].join("\n");

export function itemConsultMessage(input: { item: string; evidence: string }): string {
	return [`Item to settle:\n${input.item}`, `Evidence:\n${input.evidence || "(none)"}`].join("\n\n");
}

/** The stronger model's one-line reply, or undefined when it answered neither way. */
export function parseItemConsult(reply: string, model: string): ItemConsult | undefined {
	const line = reply
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => /^(FACT|MISSING):/i.test(entry));
	if (!line) return undefined;
	const separator = line.indexOf(":");
	const text = line.slice(separator + 1).trim();
	if (!text) return undefined;
	return line.slice(0, separator).toUpperCase() === "FACT"
		? { kind: "fact", fact: text, model }
		: { kind: "missing", missing: text, model };
}

/** A decisive answer either way, or undefined: the measurement every rung settles on. */
export function verdictAt(answers: Record<string, unknown>, index: number): UnsettledVerdict | undefined {
	const shownTrue = isDecisivelyTrue(answers[unsettledQuestionId("shows_true", index)]);
	const shownFalse = isDecisivelyTrue(answers[unsettledQuestionId("shows_false", index)]);
	if (shownTrue === shownFalse) return undefined;
	return shownTrue ? "confirmed" : "refuted";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function settleUnsettledItems(
	deps: UnsettledLadderDeps,
	input: { readonly items: readonly string[]; readonly evidence: string; readonly signal?: AbortSignal },
): Promise<LadderOutcome> {
	const items = [...new Set(input.items.map((item) => item.trim()).filter((item) => item.length > 0))];
	if (items.length === 0) return { settled: [], unsettled: [] };
	const judge = deps.getJudge();
	if (!judge) return { settled: [], unsettled: items.map((item) => ({ item, missing: "System One is not bound" })) };
	// No results to judge is not a question for System One: there is nothing it could read an answer from.
	if (!input.evidence.trim())
		return { settled: [], unsettled: items.map((item) => ({ item, missing: "the agent recorded no tool results" })) };
	let passes = 0;

	const settled: SettledItem[] = [];
	// Rung 1: the agent's own tool results, which it did not send to System One itself.
	let open: { item: string; missing: string }[];
	try {
		passes += 1;
		const answers = await judge.evaluateUnsettledItems(
			items.map((item) => ({ statement: item, evidence: input.evidence })),
			input.signal,
		);
		open = [];
		items.forEach((item, index) => {
			const verdict = verdictAt(answers, index);
			if (verdict) settled.push({ item, verdict, by: "system_one" });
			else open.push({ item, missing: "the agent's own results do not settle it" });
		});
	} catch (error) {
		// An outage is not a verdict: the items stay open, named, for the owner.
		return {
			settled,
			unsettled: items.map((item) => ({ item, missing: `System One unavailable: ${errorText(error)}` })),
		};
	}
	if (open.length === 0 || !deps.consult || passes >= GATHER_MORE_LIMIT) return { settled, unsettled: open };

	// Rung 2: a stronger model names the settling fact; System One judges the fact and what it settles.
	const consults = await Promise.all(
		open.map((entry) =>
			deps
				.consult?.({
					item: entry.item,
					evidence: input.evidence,
					...(input.signal ? { signal: input.signal } : {}),
				})
				.catch(() => undefined),
		),
	);
	const withFact = open.flatMap((entry, index) => {
		const consult = consults[index];
		return consult?.kind === "fact" ? [{ entry, consult }] : [];
	});
	const unsettled: UnsettledItem[] = open.flatMap((entry, index) => {
		const consult = consults[index];
		if (consult?.kind === "fact") return [];
		return [{ item: entry.item, missing: consult?.kind === "missing" ? consult.missing : entry.missing }];
	});
	if (withFact.length === 0) return { settled, unsettled };
	try {
		// Per item: [evidence states the fact, the fact settles the item], all in one request.
		const answers = await judge.evaluateUnsettledItems(
			withFact.flatMap(({ entry, consult }) => [
				{ statement: consult.fact, evidence: input.evidence },
				{ statement: entry.item, evidence: consult.fact },
			]),
			input.signal,
		);
		withFact.forEach(({ entry, consult }, index) => {
			const grounded = verdictAt(answers, index * 2) === "confirmed";
			const verdict = grounded ? verdictAt(answers, index * 2 + 1) : undefined;
			if (verdict)
				settled.push({ item: entry.item, verdict, by: `system_one+${consult.model}`, basis: consult.fact });
			else
				unsettled.push({
					item: entry.item,
					missing: grounded
						? `${consult.model} named a fact the evidence states, but it does not settle the item: ${consult.fact}`
						: `${consult.model} named a fact the evidence does not show: ${consult.fact}`,
				});
		});
	} catch (error) {
		for (const { entry } of withFact)
			unsettled.push({ item: entry.item, missing: `System One unavailable: ${errorText(error)}` });
	}
	return { settled, unsettled };
}

/** The text of the tool results in a transcript, newest last, bounded from the end. */
export function toolResultEvidence(
	messages: readonly { readonly role: string; readonly content?: unknown; readonly toolName?: unknown }[],
	maxChars = 12_000,
): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
		const text = message.content
			.map((block: { type?: unknown; text?: unknown }) =>
				block?.type === "text" && typeof block.text === "string" ? block.text : "",
			)
			.join("");
		if (text.trim())
			parts.push(`[${typeof message.toolName === "string" ? message.toolName : "tool"}] ${text.trim()}`);
	}
	const joined = parts.join("\n");
	return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/** Case, punctuation and spacing folded away, so a quote matches the text it was copied from. */
function foldForQuote(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** Whether `quote` appears in `text`, ignoring case, punctuation and spacing. An empty quote never does. */
export function quotedIn(quote: string, text: string): boolean {
	const needle = foldForQuote(quote.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, ""));
	return needle.length > 0 && ` ${foldForQuote(text)} `.includes(` ${needle} `);
}
