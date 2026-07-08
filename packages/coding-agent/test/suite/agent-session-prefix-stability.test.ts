import { type Context, fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function serializeProviderContext(context: Context): string {
	return JSON.stringify({
		systemPrompt: context.systemPrompt,
		tools: context.tools ?? [],
		messages: context.messages,
	});
}

function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index++;
	return index;
}

describe("agent session provider prefix stability", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("keeps the standing provider prefix byte-identical across consecutive turns", async () => {
		const harness = await createHarness({ systemPrompt: "You are a stable-prefix test assistant." });
		harnesses.push(harness);
		const payloads: string[] = [];
		harness.setResponses([
			(context) => {
				payloads.push(serializeProviderContext(context));
				return fauxAssistantMessage("first done");
			},
			(context) => {
				payloads.push(serializeProviderContext(context));
				return fauxAssistantMessage("second done");
			},
		]);

		await harness.session.prompt("first prompt");
		await harness.session.prompt("second prompt");

		expect(payloads).toHaveLength(2);
		const standingPrefixMarker = '"messages":[';
		const standingPrefixEnd = payloads[0].indexOf(standingPrefixMarker) + standingPrefixMarker.length;
		expect(standingPrefixEnd).toBeGreaterThanOrEqual(standingPrefixMarker.length);
		expect(commonPrefixLength(payloads[0], payloads[1])).toBeGreaterThanOrEqual(standingPrefixEnd);
	});
});
