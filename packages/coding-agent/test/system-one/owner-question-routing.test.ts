import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendOwnerFollowUp,
	groundConsultAnswer,
	parseConsultReply,
} from "../../src/core/system-one/owner-question-routing.ts";

const yes = { type: "noul", noul: 0.97 };
const no = { type: "noul", noul: 0.03 };
const unsure = { type: "noul", noul: 0.6 };

/** A judge answering each check's pair of Nouls in order. */
function judge(...pairs: [unknown, unknown][]) {
	const calls: { statement: string; evidence: string }[][] = [];
	return {
		calls,
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
			basis: '"keep the importer"',
			model: "m",
		});
		// An answer the request does not back is the model deciding for the owner.
		expect(parseConsultReply("ANSWER: keep it", "m")).toEqual({
			kind: "needs_owner",
			reason: "m answered without a basis in the request: keep it",
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

	describe("the model finds, Jev decides", () => {
		const consult = { kind: "answered" as const, answer: "keep it", basis: "keep the importer", model: "m" };
		const input = { consult, request: "tidy the screen but keep the importer", question: "Drop the importer?" };

		it("keeps an answer only when the request shows its basis and the basis settles the question", async () => {
			const both = judge([yes, no], [yes, no]);
			expect(await groundConsultAnswer(both, input)).toEqual(consult);
			expect(both.calls).toHaveLength(1);
			expect(both.calls[0]?.map((check) => check.evidence)).toEqual([input.request, consult.basis]);
		});

		it("hands the question to the owner when the basis is not in the request", async () => {
			const result = await groundConsultAnswer(judge([unsure, no], [yes, no]), input);
			expect(result).toMatchObject({
				kind: "needs_owner",
				reason: expect.stringContaining("does not show its basis"),
			});
		});

		it("hands the question to the owner when the basis does not settle it", async () => {
			const result = await groundConsultAnswer(judge([yes, no], [no, yes]), input);
			expect(result).toMatchObject({ kind: "needs_owner", reason: expect.stringContaining("does not settle") });
		});

		it("never lets an outage or a missing judge pass the answer through", async () => {
			const down = {
				evaluateUnsettledItems: async () => {
					throw new Error("Jev down");
				},
			};
			expect((await groundConsultAnswer(down, input)).kind).toBe("needs_owner");
			expect((await groundConsultAnswer(undefined, input)).kind).toBe("needs_owner");
		});
	});
});
