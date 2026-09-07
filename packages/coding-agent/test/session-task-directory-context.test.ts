import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { expect, it } from "vitest";
import { createHarness, getMessageText } from "./suite/harness.ts";

it("reprojects saved pins after history compaction without rewriting the system prompt", async () => {
	const harness = await createHarness({
		initialActiveToolNames: ["task_directory", "task_steps"],
		settings: { modelCapability: { mode: "off" } },
	});
	const project = join(harness.tempDir, "project 日本語");
	mkdirSync(project);
	const call = (name: string, args: Record<string, unknown>) =>
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	harness.setResponses([
		call("task_steps", { action: "set", steps: [{ content: "Pinned synthetic task", status: "in_progress" }] }),
		call("task_directory", { action: "register", workspaceId: "project", path: project }),
		call("task_directory", { action: "bind", taskId: "step-1", pinned: true, workspaceId: "project" }),
		fauxAssistantMessage("Synthetic setup complete"),
	]);
	try {
		await harness.session.prompt("Set up the synthetic pin.");
		const setupResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(setupResults.filter((message) => message.isError).map(getMessageText)).toEqual([]);
		// The journal retains execution state while compacted provider history loses tool output.
		const kept = harness.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!kept) throw new Error("Expected synthetic assistant entry");
		harness.sessionManager.appendCompaction("Synthetic compacted history", kept.id, 1000);
		await harness.session.reload();
		expect(harness.session.messages.some((message) => message.role === "toolResult")).toBe(false);
		const systemPrompt = harness.session.agent.state.systemPrompt;
		let requestText = "";
		harness.setResponses([
			(context) => {
				requestText = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("Projection observed");
			},
		]);
		await harness.session.prompt("Continue the pinned task without a directory reminder.");
		expect(requestText).toContain("TASK DIRECTORY CONTEXT");
		expect(requestText).toContain(JSON.stringify(project));
		expect(requestText).toContain('"pinned":true');
		expect(harness.session.agent.state.systemPrompt).toBe(systemPrompt);
		const records = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "task_directory_context",
		);
		expect(records).toHaveLength(1);
		harness.setResponses([fauxAssistantMessage("Unchanged state observed")]);
		await harness.session.prompt("Continue again.");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "task_directory_context",
			),
		).toHaveLength(1);
	} finally {
		await harness.cleanup();
	}
});
