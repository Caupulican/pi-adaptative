import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendOwnerFollowUp, parseConsultReply } from "../../src/core/system-one/owner-question-routing.ts";

describe("owner question routing", () => {
	it("parses the stronger model's one-line verdict, and nothing else", () => {
		expect(parseConsultReply("ANSWER: keep it", "m")).toEqual({ kind: "answered", answer: "keep it", model: "m" });
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
});
