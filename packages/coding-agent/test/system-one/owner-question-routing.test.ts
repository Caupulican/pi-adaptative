import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendOwnerFollowUp,
	groundConsultAnswer,
	parseConsultReply,
} from "../../src/core/system-one/owner-question-routing.ts";
import { quotedIn } from "../../src/core/system-one/unsettled-ladder.ts";

const yes = { type: "noul", noul: 0.97 };
const unsure = { type: "noul", noul: 0.6 };

/**
 * A judge answering the grounding Nouls from `inRequest` and `backs`, the reserved kinds from
 * `reserved`, and each item check's pair of Nouls in order.
 */
function judge(inRequest?: unknown, backs?: unknown, ...pairs: [unknown, unknown][]) {
	const calls: { statement: string; evidence: string }[][] = [];
	const grounding: Record<string, unknown>[] = [];
	return {
		calls,
		grounding,
		reserved: {} as Record<string, unknown>,
		async evaluateReservedDecision() {
			return this.reserved;
		},
		evaluateConsultGrounding: async (input: Record<string, unknown>) => {
			grounding.push(input);
			return { basis_in_request: inRequest, basis_backs_answer: backs };
		},
		evaluateUnsettledItems: async (checks: readonly { statement: string; evidence: string }[]) => {
			calls.push([...checks]);
			const answers: Record<string, unknown> = {};
			checks.forEach((_, index) => {
				answers[`shows_true_${index}`] = pairs[index]?.[0];
				answers[`shows_false_${index}`] = pairs[index]?.[1];
			});
			return answers;
		},
	};
}

describe("owner question routing", () => {
	it("parses the stronger model's one-line verdict, and nothing else", () => {
		expect(parseConsultReply('ANSWER: keep it\nBASIS: "keep the importer"', "m")).toEqual({
			kind: "answered",
			answer: "keep it",
			grounds: "request",
			basis: '"keep the importer"',
			model: "m",
		});
		expect(parseConsultReply("ANSWER: use a map\nJUDGMENT: lookups by id dominate", "m")).toEqual({
			kind: "answered",
			answer: "use a map",
			grounds: "judgment",
			basis: "lookups by id dominate",
			model: "m",
		});
		// An answer with no grounds is the model deciding for the owner.
		expect(parseConsultReply("ANSWER: keep it", "m")).toEqual({
			kind: "needs_owner",
			reason: "m answered without grounds: keep it",
			model: "m",
		});
		expect(parseConsultReply("thinking...\nNEEDS_OWNER: it is a pricing call", "m")).toEqual({
			kind: "needs_owner",
			reason: "it is a pricing call",
			model: "m",
		});
		expect(parseConsultReply("I think we should keep it", "m")).toBeUndefined();
		expect(parseConsultReply("ANSWER:", "m")).toBeUndefined();
	});

	it("appends follow-ups to one document per session, with a header once", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-follow-ups-"));
		try {
			const path = join(dir, "follow-ups", "s.md");
			appendOwnerFollowUp(path, { question: "Q1?", reason: "scope", request: "R", at: "t1" });
			appendOwnerFollowUp(path, { question: "Q2?", reason: "risk", request: "R", at: "t2" });
			const text = readFileSync(path, "utf8");
			expect(text.match(/# Owner follow-ups/g)).toHaveLength(1);
			expect(text).toContain("**Question:** Q1?");
			expect(text).toContain("**Why it needs you:** risk");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe("the model finds, System One decides", () => {
		const consult = {
			kind: "answered" as const,
			answer: "keep it",
			grounds: "request" as const,
			basis: "keep the importer",
			model: "m",
		};
		const input = { consult, request: "tidy the screen but keep the importer", question: "Drop the importer?" };

		it("keeps an answer only when the request shows its basis and the basis settles the question", async () => {
			const both = judge(undefined, yes);
			expect(await groundConsultAnswer(both, input)).toEqual(consult);
			// The quote is checked in code; System One judges only whether it backs the answer.
			expect(both.grounding).toEqual([{ basis: consult.basis, question: input.question, answer: consult.answer }]);
		});

		it("hands the question to the owner when the basis is not in the request", async () => {
			const checker = judge(undefined, yes);
			const result = await groundConsultAnswer(checker, {
				...input,
				consult: { ...consult, basis: "remove the importer" },
			});
			expect(result).toMatchObject({
				kind: "needs_owner",
				reason: expect.stringContaining("does not contain its basis"),
			});
			expect(checker.grounding).toEqual([]);
		});

		it("hands the question to the owner when the basis does not settle it", async () => {
			const result = await groundConsultAnswer(judge(undefined, unsure), input);
			expect(result).toMatchObject({ kind: "needs_owner", reason: expect.stringContaining("does not settle") });
		});

		it("never lets an outage or a missing judge pass the answer through", async () => {
			const down = {
				evaluateUnsettledItems: async () => {
					throw new Error("System One down");
				},
				evaluateReservedDecision: async () => {
					throw new Error("System One down");
				},
				evaluateConsultGrounding: async () => {
					throw new Error("System One down");
				},
			};
			expect((await groundConsultAnswer(down, input)).kind).toBe("needs_owner");
			expect((await groundConsultAnswer(undefined, input)).kind).toBe("needs_owner");
		});
	});

	describe("an answer on the agents' own judgment", () => {
		const consult = {
			kind: "answered" as const,
			answer: "use a map",
			grounds: "judgment" as const,
			basis: "lookups by id dominate",
			model: "m",
		};
		const input = { consult, request: "make the lookup fast", question: "Array or map for the index?" };
		const none = { type: "noul", noul: 0.02 };
		const allNone = {
			reserved_scope: none,
			reserved_spending: none,
			reserved_risk: none,
			reserved_irreversible: none,
			reserved_taste: none,
		};

		it("stands when System One finds the decision is none the owner reserves", async () => {
			const checker = judge();
			checker.reserved = allNone;
			expect(await groundConsultAnswer(checker, input)).toEqual(consult);
			expect(checker.calls).toHaveLength(0);
		});

		it("goes to the owner when any reserved kind is not decisively ruled out", async () => {
			const checker = judge();
			checker.reserved = { ...allNone, reserved_taste: unsure };
			const result = await groundConsultAnswer(checker, input);
			expect(result).toMatchObject({ kind: "needs_owner", reason: expect.stringContaining("reserved_taste") });
		});
	});

	it("groups follow-ups under one heading per request and never repeats a question", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-follow-ups-group-"));
		try {
			const path = join(dir, "s.md");
			appendOwnerFollowUp(path, { question: "Q1?", reason: "scope", request: "Ship v2", at: "t1" });
			appendOwnerFollowUp(path, { question: "Q1?", reason: "scope", request: "Ship v2", at: "t2" });
			appendOwnerFollowUp(path, { question: "Q2?", reason: "risk", request: "Ship v2", at: "t3" });
			appendOwnerFollowUp(path, { question: "Q3?", reason: "money", request: "Buy a domain", at: "t4" });
			const text = readFileSync(path, "utf8");
			expect(text.match(/\*\*Question:\*\* Q1\?/g)).toHaveLength(1);
			expect(text.match(/^## Request/gm)).toHaveLength(2);
			expect(text.match(/^> Ship v2$/gm)).toHaveLength(1);
			expect(text.indexOf("Q2?")).toBeLessThan(text.indexOf("> Buy a domain"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("finds a quote in the request by its words, never by a fragment of one", () => {
		expect(quotedIn('"keep the importer"', "Tidy the settings screen, but keep the importer.")).toBe(true);
		expect(quotedIn("Do not touch the CI config", "Speed up the build.  Do NOT touch the CI-config!")).toBe(true);
		expect(quotedIn("keep the import", "keep the importer")).toBe(false);
		expect(quotedIn("remove the importer", "keep the importer")).toBe(false);
		expect(quotedIn("  ", "anything")).toBe(false);
	});
});
