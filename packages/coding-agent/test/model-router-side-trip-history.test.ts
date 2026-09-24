import { DEFAULT_MAX_BYTES } from "@caupulican/pi-agent-core/truncate";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { describe, expect, it } from "vitest";
import { sideTripHistoryTool } from "../src/core/model-router/side-trip-brief.ts";

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function toolResult(toolName: string, text: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${timestamp}`,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

async function search(earlier: AgentMessage[], query: string) {
	const result = await sideTripHistoryTool(() => earlier).execute("call-1", { query });
	const block = result.content[0];
	return {
		text: block?.type === "text" ? block.text : "",
		details: result.details as { matched: number; shown: number; excerpted: number },
	};
}

describe("side trip conversation_history", () => {
	it("returns a short matching message whole (control)", async () => {
		const { text, details } = await search([user("the deploy target is staging-eu", 1)], "deploy target");
		expect(details).toMatchObject({ matched: 1, shown: 1 });
		expect(text).toContain("[user] the deploy target is staging-eu");
	});

	it("shows an excerpt around the match of a message over the output bound", async () => {
		const filler = "lorem ipsum dolor sit amet ".repeat(Math.ceil((DEFAULT_MAX_BYTES * 2) / 27));
		const oversized = user(`${filler}the deploy target is staging-eu. ${filler}`, 1);
		const { text, details } = await search([oversized], "deploy target");
		expect(details).toEqual({ matched: 1, shown: 1, excerpted: 1 });
		expect(text).toContain("the deploy target is staging-eu");
		expect(text).toMatch(/\[user\] …/);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("anchors the excerpt on the original text when lowercasing lengthens characters before the match", async () => {
		const filler = "İ".repeat(DEFAULT_MAX_BYTES);
		const { text, details } = await search([user(`${filler}the deploy target is staging-eu ${filler}`, 1)], "deploy");
		expect(details.excerpted).toBe(1);
		expect(text).toContain("the deploy target is staging-eu");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("returns a tool result with a normal tool name whole (control)", async () => {
		const { text, details } = await search([toolResult("bash", "needle", 1)], "needle");
		expect(details).toEqual({ matched: 1, shown: 1, excerpted: 0 });
		expect(text).toContain("[tool bash] needle");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("bounds the output and keeps the matched body visible when the tool name alone exceeds the bound", async () => {
		for (const name of ["X".repeat(DEFAULT_MAX_BYTES * 2), "é🙂".repeat(DEFAULT_MAX_BYTES)]) {
			const { text, details } = await search([toolResult(name, "needle", 1)], "needle");
			expect(details).toEqual({ matched: 1, shown: 1, excerpted: 1 });
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			expect(text).not.toContain("\uFFFD");
			expect(text).toMatch(/\[tool .+…\] needle$/u);
		}
	});

	it("keeps room for other matches beside an oversized one", async () => {
		const filler = "x".repeat(DEFAULT_MAX_BYTES * 2);
		const { text, details } = await search(
			[user(`deploy notes ${filler}`, 1), user("deploy target is staging-eu", 2)],
			"deploy",
		);
		expect(details).toEqual({ matched: 2, shown: 2, excerpted: 1 });
		expect(text).toContain("[user] deploy target is staging-eu");
		expect(text).toContain("[user] deploy notes x");
	});

	it("stays within the output bound for many oversized multi-byte messages and a huge query", async () => {
		const filler = "é🙂".repeat(DEFAULT_MAX_BYTES);
		const earlier = Array.from({ length: 8 }, (_, index) => user(`${filler} deploy ${filler}`, index));
		const query = `deploy ${"q".repeat(DEFAULT_MAX_BYTES * 2)}`;
		const { text, details } = await search(earlier, query);
		expect(details.matched).toBe(8);
		expect(details.shown).toBeGreaterThan(0);
		expect(details.shown).toBe(details.excerpted);
		expect(text).not.toContain("�");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("excerpts the end of an oversized message when nothing matches", async () => {
		const { text, details } = await search([user(`${"a".repeat(DEFAULT_MAX_BYTES * 2)} latest words`, 1)], "zebra");
		expect(details).toEqual({ matched: 0, shown: 1, excerpted: 1 });
		expect(text).toMatch(/latest words$/);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});
});
