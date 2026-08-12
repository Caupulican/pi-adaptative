import { describe, expect, it } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";
import { executeDelegateStatusAction } from "../src/core/tools/delegate-status.ts";

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
				modelRef: "openai-codex/gpt-5.6-terra",
				thinkingLevel: "low",
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
		expect(text).toContain("effective model: openai-codex/gpt-5.6-terra; thinking: low");
		expect(result.details).toMatchObject({
			lanes: [
				{
					laneId: "worker-1",
					label: "Inspect the router",
					profileId: "fast-reviewer",
					modelRef: "openai-codex/gpt-5.6-terra",
					thinkingLevel: "low",
				},
			],
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

	it("identifies a durable transient retry as nonterminal instead of presenting a failure token", () => {
		const retrying: LaneRecord = {
			laneId: "worker-retrying",
			type: "worker",
			status: "running",
			reasonCode: "retry_scheduled:overloaded",
		};

		const result = executeDelegateStatusAction(
			"status",
			{},
			{
				getLaneRecords: () => [retrying],
				getWorkerClaimSnapshots: () => [],
			},
		);

		expect(result.content[0]?.text).toContain(
			"worker-retrying: retrying after transient overloaded (nonterminal; durable state preserved; terminal handoff pending)",
		);
		expect(result.content[0]?.text).not.toContain("worker-retrying: running (retry_scheduled:overloaded)");
	});

	it("classifies a queued worker as admitted safety state instead of harness failure", () => {
		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-queued" },
			{
				getLaneRecords: () => [{ laneId: "worker-queued", type: "worker", status: "queued" }],
				getWorkerClaimSnapshots: () => [],
			},
		);

		expect(result.content[0]?.text).toContain(
			"CAVEMAN MODE - MANDATORY: queued is admitted durable nonterminal state",
		);
		expect(result.content[0]?.text).toContain("not stall or harness failure");
		expect(result.content[0]?.text).toContain(
			"Never poll, interrupt, or cancel a healthy running worker to force the queue",
		);
		expect(result.content[0]?.text).toContain("authority.toolNames omits write and edit");
		expect(result.content[0]?.text).toContain(
			"If you start a fresh narrower replacement, cancel this queued agent after the replacement starts",
		);
		expect(result.content[0]?.text).toContain("otherwise both tasks will run");
	});

	it("labels a delivered blocked claim as task evidence instead of harness failure", () => {
		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-blocked" },
			{
				getLaneRecords: () => [
					{
						laneId: "worker-blocked",
						type: "worker",
						status: "blocked",
						reasonCode: "worker_blocked",
					},
				],
				getWorkerClaimSnapshots: () => [
					{
						requestId: "worker-blocked",
						status: "blocked",
						summary: "Task could not run one check.",
						changedFiles: [],
						blockers: ["missing task dependency"],
					},
				],
			},
		);

		expect(result.content[0]?.text).toContain("CAVEMAN MODE - MANDATORY");
		expect(result.content[0]?.text).toContain("worker_blocked is a delivered task claim with blockers");
		expect(result.content[0]?.text).toContain("not harness failure or lost state");
		expect(result.content[0]?.text).toContain("continue or replan the parent task");
	});

	it("does not turn one completion error into a harness failure or sibling cancellation", () => {
		const result = executeDelegateStatusAction(
			"status",
			{ laneId: "worker-failed" },
			{
				getLaneRecords: () => [
					{
						laneId: "worker-failed",
						type: "worker",
						status: "failed",
						reasonCode: "completion_error",
					},
				],
				getWorkerClaimSnapshots: () => [
					{
						requestId: "worker-failed",
						status: "failed",
						summary: "Worker did not complete: completion_error — provider unavailable.",
						changedFiles: [],
					},
				],
			},
		);

		expect(result.content[0]?.text).toContain(
			"CAVEMAN MODE - MANDATORY: completion_error means a worker execution failed",
		);
		expect(result.content[0]?.text).toContain("Tool timeout, provider/model/API/network/WebSocket/fetch/overload");
		expect(result.content[0]?.text).toContain("NEVER call any of them harness failure");
		expect(result.content[0]?.text).toContain("NEVER stop, cancel, or interrupt healthy siblings for them");
		expect(result.content[0]?.text).toContain("A delivered terminal handoff proves persistence and delivery worked");
		expect(result.content[0]?.text).toContain("continue or replan");
	});
});
