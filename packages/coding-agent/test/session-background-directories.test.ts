import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionContextScope, retainedToolInvocation } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import {
	BACKGROUND_TOOL_TASK_CUSTOM_TYPE,
	type BackgroundToolTaskRecord,
} from "../src/core/background-tool-task-controller.ts";
import { createHarness } from "./suite/harness.ts";

it("keeps native background execution and all durable receipt edges in the admitted project", async () => {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const running = Promise.withResolvers<void>();
	const terminal = Promise.withResolvers<void>();
	const harness = await createHarness({
		initialActiveToolNames: ["task_directory", "fixture_slow", "tool_task"],
		settings: { modelCapability: { mode: "off" } },
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "fixture_slow",
					label: "Synthetic slow read",
					description: "Controlled fixture read",
					parameters: Type.Object({}),
					async execute(_id, _params, _signal, _update, ctx) {
						started.resolve();
						await finish.promise;
						return {
							content: [{ type: "text", text: readFileSync(join(ctx.cwd, "marker.txt"), "utf8") }],
							details: {},
						};
					},
				});
			},
		],
	});
	const project = join(harness.tempDir, "background project 日本語");
	mkdirSync(project);
	writeFileSync(join(project, "marker.txt"), "SELECTED_ONLY");
	writeFileSync(join(harness.tempDir, "marker.txt"), "AMBIENT_ONLY");
	let sawRunning = false;
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type !== "background_tools") return;
		if (event.tasks.length > 0) {
			sawRunning = true;
			running.resolve();
		} else if (sawRunning) terminal.resolve();
	});
	harness.session.agent.backgroundToolCallAfterMs = undefined;
	harness.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("task_directory", { action: "register", workspaceId: "project", path: project })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxToolCall("task_directory", { action: "select", workspaceId: "project" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("fixture_slow", {}, { id: "slow" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Independent foreground turn complete"),
		fauxAssistantMessage("Background terminal acknowledged"),
	]);
	const prompt = harness.session.prompt("Read the synthetic project in the background.", { autoContinueGoal: false });
	try {
		await started.promise;
		expect(harness.session.backgroundRunningToolCalls("slow")).toBe(1);
		await running.promise;
		await prompt;
		finish.resolve();
		await terminal.promise;
		const edges = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === BACKGROUND_TOOL_TASK_CUSTOM_TYPE
					? [entry.data as BackgroundToolTaskRecord]
					: [],
			);
		expect(edges.map((edge) => edge.status)).toContain("running");
		const completed = edges.find((edge) => edge.status === "completed")!;
		expect(completed.output).toContain("SELECTED_ONLY");
		expect(completed.output).not.toContain("AMBIENT_ONLY");
		const context = completed.executionContext!;
		expect(context).toMatchObject({ cwd: project, attachment: { workspaceId: "project" } });
		const scope = executionContextScope(context);
		for (const edge of edges) {
			expect(edge.executionContext).toEqual(context);
			expect(edge.piToolInvocation?.executionScope).toBe(scope);
		}
		const foreground = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "slow",
		);
		expect(foreground?.role).toBe("toolResult");
		if (foreground?.role === "toolResult")
			expect(retainedToolInvocation(foreground.details)?.executionScope).toBe(scope);
	} finally {
		finish.resolve();
		await prompt;
		unsubscribe();
	}
});
