import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { FileStoreProvider } from "../../../src/core/memory/providers/file-store.ts";
import { wrapToolDefinition } from "../../../src/core/tools/tool-definition-wrapper.ts";
import { createHarness, getMessageText } from "../harness.ts";

describe("memory validation recovery", () => {
	it("rejects missing content before storage execution, then executes a corrected call once", async () => {
		const provider = new FileStoreProvider();
		const tool = wrapToolDefinition(provider.getToolDefinitions()[0]);
		const execute = vi.fn(tool.execute);
		const harness = await createHarness({ tools: [{ ...tool, execute }] });
		await provider.initialize("preflight", {
			agentDir: join(harness.tempDir, "memory-fixture"),
			cwd: harness.tempDir,
			isChildSession: false,
		});
		const incomplete = {
			action: "add",
			target: "okf",
			type: "Debugging Finding",
			title: "Memory validation",
			description: "Required fields are validated before execution.",
			scope: "project",
			evidenceRefs: ["test/suite/regressions/memory-action-preflight.test.ts"],
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("memory", incomplete, { id: "invalid" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall(
					"memory",
					{ ...incomplete, content: "Action validation precedes storage access." },
					{ id: "corrected" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Stored the verified finding."),
		]);
		await harness.session.prompt("Store the verified memory validation finding.");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		const rejected = results.find((message) => message.toolCallId === "invalid");
		expect(rejected).toMatchObject({ isError: true });
		expect(getMessageText(rejected)).toContain("invalid_arguments");
		expect(getMessageText(rejected)).toContain("content");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(results.find((message) => message.toolCallId === "corrected")).toMatchObject({ isError: false });
	});
});
