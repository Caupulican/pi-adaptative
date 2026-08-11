import { describe, expect, it, vi } from "vitest";
import { getDefaultActiveToolNames } from "../src/core/default-tool-surface.ts";
import type { WorkerAgentControlPort } from "../src/core/delegation/worker-agent-control.ts";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";

const context = {} as ExtensionContext;

function actionEnum(tool: ToolDefinition): string[] {
	const parameters = tool.parameters as {
		properties?: { action?: { enum?: unknown[] } };
	};
	return (parameters.properties?.action?.enum ?? []).filter((value): value is string => typeof value === "string");
}

function createUnifiedDelegate() {
	const acknowledgeWorkerReview = vi.fn(() => ({
		ok: true as const,
		requestId: "worker-1",
		reviewedAt: "2026-08-10T12:00:00.000Z",
	}));
	const createTaskProfile = vi.fn(() => ({
		created: true,
		profileId: "task-1",
		baseProfileId: "base-1",
		changedFields: ["description"],
	}));
	const tool = createDelegateToolDefinition({
		caller: { kind: "session_root" },
		runWorkerDelegation: () => Promise.resolve({ started: false, skipReason: "unused" }),
		status: {
			getLaneRecords: () => [{ laneId: "worker-1", type: "worker", status: "succeeded" }],
			getWorkerClaimSnapshots: () => [
				{
					requestId: "worker-1",
					status: "completed",
					outputFormat: "plain_text",
					summary: "verified worker claim",
					changedFiles: ["src/a.ts"],
					parentReviewRequired: true,
				},
			],
			acknowledgeWorkerReview,
		},
		profileWriter: {
			inspectTaskProfileOptions: () => ({
				baseProfiles: [{ profileId: "base-1", role: "builder", description: "bounded builder" }],
				models: [],
			}),
			createTaskProfile,
		},
	});
	return { acknowledgeWorkerReview, createTaskProfile, tool };
}

describe("unified delegate model surface", () => {
	it("advertises status, review, and profile actions only on the delegate tool", () => {
		const { tool } = createUnifiedDelegate();
		expect(actionEnum(tool)).toEqual(
			expect.arrayContaining(["start", "status", "review", "profile_inspect", "profile_create"]),
		);
		expect(actionEnum(tool)).not.toEqual(expect.arrayContaining(["wait", "reply", "inbox"]));

		const workerTool = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "child-1" },
			runWorkerDelegation: () => Promise.resolve({ started: false, skipReason: "unused" }),
		});
		expect(actionEnum(workerTool)).toEqual(["start"]);
		expect(actionEnum(workerTool)).not.toEqual(
			expect.arrayContaining(["status", "review", "profile_inspect", "profile_create"]),
		);
	});

	it("advertises role-specific control actions only when worker control is wired", () => {
		const workerAgentControl = {} as WorkerAgentControlPort;
		const root = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: () => Promise.resolve({ started: false, skipReason: "unused" }),
			workerAgentControl,
			resolveMessageReplayScope: () => ({ sessionId: "session-1", branchId: "branch-1" }),
		});
		expect(actionEnum(root)).toEqual(expect.arrayContaining(["start", "wait", "inbox", "inbox_wait", "inbox_ack"]));
		expect(actionEnum(root)).not.toContain("reply");

		const worker = createDelegateToolDefinition({
			caller: { kind: "worker", agentId: "child-1" },
			runWorkerDelegation: () => Promise.resolve({ started: false, skipReason: "unused" }),
			workerAgentControl,
			resolveMessageReplayScope: () => ({ sessionId: "session-1", branchId: "branch-1" }),
		});
		expect(actionEnum(worker)).toEqual(expect.arrayContaining(["start", "wait", "reply"]));
		expect(actionEnum(worker)).not.toEqual(expect.arrayContaining(["inbox", "inbox_wait", "inbox_ack"]));
	});

	it("inspects and reviews worker claims through delegate", async () => {
		const { acknowledgeWorkerReview, tool } = createUnifiedDelegate();
		const inspected = await tool.execute(
			"status-call",
			{ action: "status", laneId: "worker-1" } as never,
			undefined,
			undefined,
			context,
		);
		expect(inspected.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining("UNTRUSTED") }),
			]),
		);
		expect(inspected.details).toMatchObject({
			started: true,
			action: "status",
			kind: "lane",
			laneId: "worker-1",
		});

		const reviewed = await tool.execute(
			"review-call",
			{ action: "review", laneId: "worker-1" } as never,
			undefined,
			undefined,
			context,
		);
		expect(reviewed.details).toMatchObject({ started: true, action: "review", reviewed: true });
		expect(acknowledgeWorkerReview).toHaveBeenCalledWith("worker-1");
	});

	it("inspects and creates task profiles through delegate", async () => {
		const { createTaskProfile, tool } = createUnifiedDelegate();
		const inspected = await tool.execute(
			"profile-inspect",
			{ action: "profile_inspect" } as never,
			undefined,
			undefined,
			context,
		);
		expect(inspected.details).toMatchObject({
			started: true,
			action: "profile_inspect",
			kind: "profile",
			created: false,
		});

		const created = await tool.execute(
			"profile-create",
			{ action: "profile_create", task: "Implement the bounded fix", baseProfileId: "base-1" } as never,
			undefined,
			undefined,
			context,
		);
		expect(created.details).toMatchObject({
			started: true,
			action: "profile_create",
			kind: "profile",
			created: true,
			profileId: "task-1",
		});
		expect(createTaskProfile).toHaveBeenCalledWith({ task: "Implement the bounded fix", baseProfileId: "base-1" });
	});

	it("keeps diagnostics registered separately but removes them and split delegate tools from defaults", () => {
		const defaults = getDefaultActiveToolNames();
		expect(defaults).toContain("delegate");
		expect(defaults).not.toEqual(expect.arrayContaining(["context_audit", "delegate_status", "profile_writer"]));
	});
});
