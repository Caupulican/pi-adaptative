import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createDelegateStatusToolDefinition } from "../src/core/tools/delegate-status.ts";

const context = {} as ExtensionContext;

const tool = createDelegateStatusToolDefinition({
	getLaneRecords: () => [
		{ laneId: "worker-1", type: "worker", status: "succeeded", reasonCode: "worker_completed" },
		{ laneId: "worker-2", type: "worker", status: "running" },
	],
	getWorkerResultSnapshots: () => [
		{
			requestId: "worker-1",
			status: "completed",
			outputFormat: "plain_text",
			summary: "inspect this",
			changedFiles: [],
			usageReportId: "usage-1",
		},
	],
});

describe("delegate_status", () => {
	it("returns bounded untrusted terminal output", async () => {
		const result = await tool.execute("call", { laneId: "worker-1" }, undefined, undefined, context);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toContain("UNTRUSTED");
		expect(text).toContain("inspect this");
		expect(text).toContain("usage-1");
	});

	it("does not disclose unknown lane data", async () => {
		const result = await tool.execute("call", { laneId: "worker-foreign" }, undefined, undefined, context);
		expect(
			result.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n"),
		).toBe("unknown_worker_lane");
	});

	it("lists only the session's worker lanes", async () => {
		const result = await tool.execute("call", {}, undefined, undefined, context);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toContain("worker-1");
		expect(text).toContain("worker-2");
		expect(text).not.toContain("worker-foreign");
	});
});
