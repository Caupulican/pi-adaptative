import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@caupulican/pi-ai";
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

	it("settles the in-flight turn, keeps the session tree intact, and serves the next turn", async () => {
		let reloadCount = 0;
		let postReloadFaux: FauxProviderRegistration | undefined;

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
							// reload() resets the api provider registry; a real custom-provider
							// extension re-registers on activation. Mirror that for the faux api
							// and queue the post-reload assistant turn on the new registration.
							postReloadFaux = registerFauxProvider({ api: harness.faux.api });
							postReloadFaux.setResponses([fauxAssistantMessage("done after reload")]);
							return { content: [{ type: "text", text: "reload finished" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage([fauxToolCall("reload_now", {})], { stopReason: "toolUse" })]);

		await harness.session.prompt("reload while working");

		expect(reloadCount).toBe(1);
		expect(getAssistantTexts(harness).at(-1)).toBe("done after reload");

		const branch = harness.sessionManager.getBranch();
		const branchMessages = branch.filter((entry) => entry.type === "message").map((entry) => entry.message);
		expect(branchMessages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const toolResult = branchMessages.find((message) => message.role === "toolResult");
		if (!toolResult || toolResult.role !== "toolResult") throw new Error("missing tool result");
		expect(toolResult.isError).toBe(false);

		// Every entry's parent must resolve inside the session tree.
		const entries = harness.sessionManager.getEntries();
		const ids = new Set(entries.map((entry) => entry.id));
		for (const entry of entries) {
			if (entry.parentId !== null) {
				expect(ids.has(entry.parentId)).toBe(true);
			}
		}

		// The swapped-in runtime must serve the next turn end to end.
		if (!postReloadFaux) throw new Error("post-reload faux registration missing");
		postReloadFaux.setResponses([fauxAssistantMessage("second turn ok")]);
		await harness.session.prompt("are you still alive?");
		expect(getAssistantTexts(harness).at(-1)).toBe("second turn ok");
	}, 30_000);
});
