import type { FauxProviderRegistration } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";

const registrations: FauxProviderRegistration[] = [];

function createFauxRegistration(): FauxProviderRegistration {
	const registration = registerFauxProvider();
	registrations.push(registration);
	return registration;
}

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

const countSchema = Type.Object({ count: Type.Number() });
const countTool: AgentTool<typeof countSchema, undefined> = {
	label: "Count",
	name: "count",
	description: "Count",
	parameters: countSchema,
	execute: async (_toolCallId, args) => ({
		content: [{ type: "text", text: String(args.count) }],
		details: undefined,
	}),
};

describe("tool repair visibility", () => {
	it("can disable repair teaching notes without disabling repair", async () => {
		const faux = createFauxRegistration();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("count", { count: "2" }, { id: "call-1" })]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const agent = new Agent({
			initialState: { model: faux.getModel(), systemPrompt: "", tools: [countTool] },
			toolArgumentTeachEnabled: false,
		});

		await agent.prompt("count");

		const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(toolResult)).toContain("2");
		expect(JSON.stringify(toolResult)).not.toContain("Tool argument repair note");
		const assistant = agent.state.messages.find((message) => message.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("expected assistant");
		const toolCall = assistant.content.find((content) => content.type === "toolCall");
		expect(toolCall).toMatchObject({ arguments: { count: 2 }, rawArguments: { count: "2" } });
	});

	it("emits repaired execution args with a repair marker for RPC consumers", async () => {
		const faux = createFauxRegistration();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("count", { count: "2" }, { id: "call-1" })]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const events: AgentEvent[] = [];
		const agent = new Agent({
			initialState: { model: faux.getModel(), systemPrompt: "", tools: [countTool] },
		});
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") events.push(event);
		});

		await agent.prompt("count");

		const start = events.find((event) => event.type === "tool_execution_start");
		expect(start).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "count",
			args: { count: 2 },
			repair: {
				repaired: true,
				rawArguments: { count: "2" },
				notes: [expect.stringContaining("numberFromString")],
			},
		});
	});
});
