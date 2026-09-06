import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "../harness.ts";

describe("credential repair projection", () => {
	it("retains the narrow-search repair on first refusal and replay, and executes the repaired command", async () => {
		const executed: string[] = [];
		const schema = Type.Object({ command: Type.String() });
		const tool: AgentTool<typeof schema, Record<string, never>> = {
			name: "bash",
			label: "Bash",
			description: "Deterministic shell adapter",
			parameters: schema,
			async execute(_id, args) {
				executed.push(args.command);
				return { content: [{ type: "text", text: "search complete" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		const broad = "rg TOKEN src";
		const repaired = "rg TOKEN src -g '*.ts'";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: broad }, { id: "broad" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: broad }, { id: "replay" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: repaired }, { id: "repaired" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The narrowed search completed."),
		]);
		await harness.session.prompt("Search the source files for TOKEN.");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(executed).toEqual([repaired]);
		for (const id of ["broad", "replay"]) {
			const result = results.find((message) => message.toolCallId === id);
			expect(result).toMatchObject({ isError: true });
			expect(getMessageText(result)).toContain("-g '*.ts'");
			expect(getMessageText(result)).toContain('"next_action":');
		}
		expect(getMessageText(results.find((message) => message.toolCallId === "replay"))).toContain(
			"Not executed: unchanged",
		);
		expect(results.find((message) => message.toolCallId === "repaired")).toMatchObject({ isError: false });
	});
});

import type { AgentTool } from "@caupulican/pi-agent-core";
