import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

describe("extension reload while the agent is streaming", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("refuses active-turn reload, keeps the session tree intact, and serves the next turn", async () => {
		let reloadCount = 0;

		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "reload_now",
						label: "Reload Now",
						description: "Trigger a runtime reload from inside a tool call",
						parameters: Type.Object({}),
						async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
							await ctx.reload();
							reloadCount++;
							return { content: [{ type: "text", text: "reload finished" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("reload_now", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done after refused reload"),
		]);

		await harness.session.prompt("reload while working");

		expect(reloadCount).toBe(0);
		expect(getAssistantTexts(harness).at(-1)).toBe("done after refused reload");

		const branch = harness.sessionManager.getBranch();
		const branchMessages = branch.filter((entry) => entry.type === "message").map((entry) => entry.message);
		expect(branchMessages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const toolResult = branchMessages.find((message) => message.role === "toolResult");
		if (!toolResult || toolResult.role !== "toolResult") throw new Error("missing tool result");
		expect(toolResult.isError).toBe(true);

		// Every entry's parent must resolve inside the session tree.
		const entries = harness.sessionManager.getEntries();
		const ids = new Set(entries.map((entry) => entry.id));
		for (const entry of entries) {
			if (entry.parentId !== null) {
				expect(ids.has(entry.parentId)).toBe(true);
			}
		}

		// The original runtime must remain intact and serve the next turn end to end.
		harness.setResponses([fauxAssistantMessage("second turn ok")]);
		await harness.session.prompt("are you still alive?");
		expect(getAssistantTexts(harness).at(-1)).toBe("second turn ok");
	}, 30_000);
});
