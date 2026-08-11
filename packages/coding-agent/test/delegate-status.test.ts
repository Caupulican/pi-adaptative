import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";

const context = {} as ExtensionContext;

const tool = createDelegateToolDefinition({
	caller: { kind: "session_root" },
	runWorkerDelegation: () => Promise.resolve({ started: false, skipReason: "unused" }),
	status: {
		getLaneRecords: () => [
			{
				laneId: "worker-1",
				type: "worker",
				status: "succeeded",
				reasonCode: "worker_completed",
				label: "Inspect the router",
				profileId: "fast-reviewer",
			},
			{ laneId: "worker-2", type: "worker", status: "running" },
			{ laneId: "tmux-worker-1", type: "tmux-worker", status: "succeeded", reasonCode: "worker_completed" },
		],
		getWorkerClaimSnapshots: () => [
			{
				requestId: "worker-1",
				status: "completed",
				outputFormat: "plain_text",
				summary: "inspect this",
				changedFiles: [],
				usageReportId: "usage-1",
			},
		],
	},
});

describe("delegate status", () => {
	it("returns bounded untrusted terminal output", async () => {
		const result = await tool.execute(
			"call",
			{ action: "status", laneId: "worker-1" },
			undefined,
			undefined,
			context,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toContain("UNTRUSTED");
		expect(text).toContain("inspect this");
		expect(text).toContain("usage-1");
		expect(result.details).toMatchObject({
			lanes: [{ laneId: "worker-1", label: "Inspect the router", profileId: "fast-reviewer" }],
		});
	});

	it("does not disclose unknown lane data", async () => {
		const result = await tool.execute(
			"call",
			{ action: "status", laneId: "worker-foreign" },
			undefined,
			undefined,
			context,
		);
		expect(
			result.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n"),
		).toBe("unknown_worker_lane");
	});

	it("lists in-process worker lanes and out-of-process tmux-worker lanes together", async () => {
		const result = await tool.execute("call", { action: "status" }, undefined, undefined, context);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toContain("workers: 1 running, 0 queued, 2 terminal");
		expect(text).toContain("worker-1");
		expect(text).toContain("worker-2");
		expect(text).toContain("tmux-worker-1");
		expect(text).not.toContain("worker-foreign");
	});

	it("inspects a tmux-worker lane by laneId the same as an in-process worker lane", async () => {
		const result = await tool.execute(
			"call",
			{ action: "status", laneId: "tmux-worker-1" },
			undefined,
			undefined,
			context,
		);
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		expect(text).toContain("tmux-worker-1: succeeded (worker_completed)");
	});
});
