import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness, getMessageText } from "../harness.ts";

describe("credential repair projection", () => {
	it("runs a broad search in the owner session and mocks only the credential lines it returns", async () => {
		// Superseded contract: a broad search was refused with a narrow-glob repair. Owner sessions
		// now keep the capability and lose only the secret values (worker lanes still refuse).
		const executed: string[] = [];
		const schema = Type.Object({ command: Type.String() });
		const output = [".env:1:TOKEN=abc123", "src/app.ts:4:const token = readToken();"].join("\n");
		const tool: AgentTool<typeof schema, Record<string, never>> = {
			name: "bash",
			label: "Bash",
			description: "Deterministic shell adapter",
			parameters: schema,
			async execute(_id, args) {
				executed.push(args.command);
				return { content: [{ type: "text", text: output }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		const broad = "rg TOKEN src";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: broad }, { id: "broad" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The search completed."),
		]);
		await harness.session.prompt("Search the source files for TOKEN.");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(executed).toEqual([broad]);
		const result = results.find((message) => message.toolCallId === "broad");
		expect(result).toMatchObject({ isError: false });
		expect(getMessageText(result)).toBe(
			[".env:1:TOKEN=<mocked:TOKEN>", "src/app.ts:4:const token = readToken();"].join("\n"),
		);
	});
});

import type { AgentTool } from "@caupulican/pi-agent-core";
