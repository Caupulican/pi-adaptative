import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * An extension's system-prompt change is a cache break on every lane that shares the prompt. It waits
 * for a cold moment unless the extension asks for it now; per-turn content belongs in `message`.
 */
describe("extension system prompt through cache custody", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function run(urgency?: "now"): Promise<string[]> {
		let turns = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						turns++;
						if (turns < 2) return undefined;
						return {
							systemPrompt: `${event.systemPrompt}\n\nEXTENSION-MARKER`,
							...(urgency ? { systemPromptUrgency: urgency } : {}),
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const systemPrompts: string[] = [];
		const reply = (text: string) => (context: { systemPrompt?: string }) => {
			systemPrompts.push(context.systemPrompt ?? "");
			return fauxAssistantMessage(text);
		};
		harness.setResponses([reply("first"), reply("second")]);
		await harness.session.prompt("first question");
		await harness.session.prompt("second question");
		return systemPrompts;
	}

	it("keeps the sent system prompt while the lane's cache is warm", async () => {
		const systemPrompts = await run();
		expect(systemPrompts).toHaveLength(2);
		expect(systemPrompts[1]).toBe(systemPrompts[0]);
		expect(systemPrompts[1]).not.toContain("EXTENSION-MARKER");
	});

	it("applies the change at once when the extension asks for it now", async () => {
		const systemPrompts = await run("now");
		expect(systemPrompts[0]).not.toContain("EXTENSION-MARKER");
		expect(systemPrompts[1]).toContain("EXTENSION-MARKER");
	});
});
