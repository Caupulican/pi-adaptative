import { expect, it, vi } from "vitest";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { runAgentLoop } from "../src/kernel/agent-loop.ts";
import { convertToLlm } from "../src/kernel/messages.ts";
import { calls, ScriptedProvider, text } from "./fixtures/harness/scripted-provider.ts";

it("teaches the first rejected spawn on the wire and keeps the same advertised start shape on retry", async () => {
	const runWorkerDelegation = vi.fn(async () => ({ started: false }));
	const tool = wrapToolDefinition(
		createDelegateToolDefinition({ caller: { kind: "session_root" }, runWorkerDelegation }),
	);
	const provider = new ScriptedProvider();
	const model = provider.model("root");
	provider.enqueue(
		model.id,
		calls("invalid-start", [
			{ id: "s1", name: "delegate", arguments: { action: "spawn", task: "Keep this brief." } },
		]),
		text("done", "Done."),
	);
	provider.register();
	try {
		const messages = await runAgentLoop(
			[{ role: "user", content: "Start a worker.", timestamp: 1 }],
			{ systemPrompt: "Coordinate this task.", messages: [], tools: [tool] },
			{ model, convertToLlm, maxProviderTurns: 2 },
			() => {},
		);
		await provider.waitForProducers();
		provider.assertDrained();
		const descriptions = provider.requests.map(
			({ context }) => context.tools?.find(({ name }) => name === "delegate")?.description,
		);
		expect(descriptions).toHaveLength(2);
		expect(descriptions[0]).toContain('"action":"start","instructions":');
		expect(descriptions[0]).toContain('"model":{"provider":');
		expect(descriptions[0]).not.toContain('"action":"follow_up"');
		expect(descriptions[1]).toBe(descriptions[0]);
		const result = messages.find((message) => message.role === "toolResult");
		expect(result?.isError).toBe(true);
		expect(result?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: expect.stringContaining("with the original brief") }),
			]),
		);
		expect(runWorkerDelegation).not.toHaveBeenCalled();
	} finally {
		await provider.dispose();
	}
});
