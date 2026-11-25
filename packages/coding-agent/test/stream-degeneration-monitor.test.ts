import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import { expect, it } from "vitest";
import {
	DEGENERATE_STREAM_ABORT_RUN,
	exactTiledRepeat,
	StreamingDegenerationDetector,
	shouldAbortDegenerateStream,
} from "../src/kernel/degenerate-assistant-text.ts";

function baseline(text: string): boolean {
	if (text.length < 400) return false;
	if ((exactTiledRepeat(text)?.times ?? 0) >= DEGENERATE_STREAM_ABORT_RUN) return true;
	return [text.split(/(?<=[.!?])\s+/), text.split("\n")].some((units) => {
		let count = 0;
		let previous = "";
		for (const unit of units) {
			count = unit === previous && unit.trim() ? count + 1 : 1;
			if (count >= DEGENERATE_STREAM_ABORT_RUN) return true;
			previous = unit;
		}
		return false;
	});
}

it("matches repetition detection across line, Unicode sentence, and exact tile boundaries", () => {
	const sentence = "The assistant repeated the same progress update every time!";
	const line = "A repeating output line containing no punctuation at the end";
	const texts = [
		" ".repeat(450),
		`${"\u2028".repeat(499)}\n`,
		`${sentence}\u00a0\u2028`.repeat(8),
		`${sentence}\n`.repeat(7),
		`${sentence}\n`.repeat(8),
		`${line}\n`.repeat(8),
		sentence.repeat(8),
		`${sentence.repeat(8)}\nthen a different conclusion`,
	];
	for (const text of texts) expect(shouldAbortDegenerateStream(text)).toBe(baseline(text));
});

it("rechecks in-place prose replacements and skips guard decisions while a tool call is present", () => {
	const monitor = new StreamingDegenerationDetector();
	const message: AssistantMessage = {
		role: "assistant",
		provider: "openai",
		model: "fixture",
		api: "openai-responses",
		content: [],
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: 1,
	};
	const text = { type: "text" as const, text: "Initial reply." };
	message.content.push(text);
	expect(monitor.check(message)).toBe(false);
	const line = "The assistant repeated the same progress update every time.";
	text.text = `${line}\n`.repeat(8);
	expect(monitor.check(message)).toBe(true);
	expect(monitor.check(message)).toBe(true);
	message.content.push({ type: "toolCall", id: "call", name: "read", arguments: {} });
	expect(monitor.check(message)).toBe(false);
	message.content.pop();
	text.text = "Replacement reply.";
	expect(monitor.check(message)).toBe(false);
});
