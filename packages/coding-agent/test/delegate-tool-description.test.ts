import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES } from "../src/core/delegation/worker-conversation-store.ts";
import {
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
	MAX_WORKER_AUTHORITY_PATH_LENGTH,
} from "../src/core/orchestration/contracts.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createDelegateToolDefinition, DELEGATE_ACTIONS } from "../src/core/tools/delegate.ts";

const EXPECTED_AUTHORITY_GUIDELINE = "Optional model/thinkingLevel/path/toolNames only";

describe("delegate tool capability description", () => {
	it("derives the tool action schema from the canonical action registry", () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});
		const parameters = definition.parameters as unknown as {
			properties?: { action?: { enum?: readonly string[] } };
		};

		expect(parameters.properties?.action?.enum).toEqual(["start"]);
		const fullDefinition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
			status: {
				getLaneRecords: () => [],
				getWorkerClaimSnapshots: () => [],
				acknowledgeWorkerReview: () => ({
					ok: true,
					requestId: "worker-1",
					reviewedAt: "2026-08-10T12:00:00.000Z",
				}),
			},
			profileWriter: {
				inspectTaskProfileOptions: () => ({ baseProfiles: [], models: [], inheritedToolNames: [] }),
				createTaskProfile: () => ({ created: false, reason: "test" }),
			},
		});
		const fullParameters = fullDefinition.parameters as unknown as {
			properties?: { action?: { enum?: readonly string[] } };
		};
		expect(fullParameters.properties?.action?.enum).toEqual([
			"start",
			"status",
			"review",
			"profile_inspect",
			"profile_create",
		]);
		expect(new Set(DELEGATE_ACTIONS).size).toBe(DELEGATE_ACTIONS.length);
	});

	it("declares its wait actions foreground waits and nothing else", () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});
		const isWait = (input: Record<string, unknown>) => definition.foregroundWait?.(input as never) === true;
		expect(isWait({ action: "wait", agentId: "worker-1", timeoutMs: 300_000 })).toBe(true);
		expect(isWait({ action: "wait_many", agentIds: ["worker-1"], mode: "all" })).toBe(true);
		expect(isWait({ action: "inbox_wait", timeoutMs: 300_000 })).toBe(true);
		expect(isWait({ action: "status", agentIds: ["worker-1"] })).toBe(false);
		expect(isWait({ action: "start", task: "do it" })).toBe(false);
	});

	it("derives durable dispatch and authority bounds from the orchestration contracts", () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});
		const parameters = definition.parameters as unknown as {
			properties: Record<
				string,
				{
					maxLength?: number;
					maxItems?: number;
					maximum?: number;
					items?: { maxLength?: number };
					properties?: Record<string, unknown>;
				}
			>;
		};
		const model = parameters.properties.model as { properties: Record<string, { maxLength?: number }> };

		expect(parameters.properties.instructions.maxLength).toBe(MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH);
		for (const field of [
			"profileId",
			"agentId",
			"threadId",
			"replyToMessageId",
			"requestMessageId",
			"messageId",
			"laneId",
			"baseProfileId",
		]) {
			expect(parameters.properties[field]?.maxLength).toBe(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		}
		expect(parameters.properties.agentIds.maxItems).toBe(MAX_ORCHESTRATION_COLLECTION_LENGTH);
		expect((parameters.properties.agentIds as { uniqueItems?: boolean }).uniqueItems).toBe(true);
		expect(parameters.properties.agentIds.items?.maxLength).toBe(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		expect(parameters.properties.maxMessages.maximum).toBe(MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES);
		expect(model.properties.provider.maxLength).toBe(MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH);
		expect(model.properties.modelId.maxLength).toBe(MAX_ORCHESTRATION_MODEL_ID_LENGTH);
		expect(parameters.properties.toolNames.maxItems).toBe(MAX_ORCHESTRATION_COLLECTION_LENGTH);
		expect((parameters.properties.toolNames as { uniqueItems?: boolean }).uniqueItems).toBe(true);
		expect(parameters.properties.toolNames.items?.maxLength).toBe(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		expect(parameters.properties.path.maxLength).toBe(MAX_WORKER_AUTHORITY_PATH_LENGTH);
		expect(parameters.properties).not.toHaveProperty("authority");
	});

	it("requires exact registered unprefixed authority tool names", () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});
		expect((definition.promptGuidelines ?? []).join("\n")).toContain(EXPECTED_AUTHORITY_GUIDELINE);

		expect(
			Value.Check(definition.parameters, {
				action: "start",
				instructions: "Inspect the repository",
				toolNames: ["read", "bash"],
			}),
		).toBe(true);
		expect(
			Value.Check(definition.parameters, {
				action: "start",
				instructions: "Inspect the repository",
				toolNames: ["functions.read"],
			}),
		).toBe(false);
		expect(
			Value.Check(definition.parameters, {
				action: "start",
				instructions: "Inspect the repository",
				toolNames: ["functions.bash"],
			}),
		).toBe(false);
	});

	it("bounds one workspace path and lowers lightweight overrides into the host request", async () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: vi.fn(() => ({
				started: true as const,
				record: { laneId: "worker-1", type: "worker" as const, status: "queued" as const },
			})),
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		const overrides = { toolNames: ["read", "bash"], path: "src" };
		expect((definition.promptGuidelines ?? []).join("\n")).toContain(EXPECTED_AUTHORITY_GUIDELINE);

		expect(
			Value.Check(definition.parameters, {
				action: "start",
				instructions: "Inspect the repository",
				...overrides,
			}),
		).toBe(true);
		expect(
			Value.Check(definition.parameters, {
				action: "start",
				instructions: "Inspect the repository",
				path: "x".repeat(MAX_WORKER_AUTHORITY_PATH_LENGTH + 1),
			}),
		).toBe(false);

		let received: unknown;
		const forwardingDefinition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: (request) => {
				received = request;
				return {
					started: true as const,
					record: { laneId: "worker-1", type: "worker" as const, status: "queued" as const },
				};
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		await forwardingDefinition.execute(
			"call-path-scopes",
			{ action: "start", instructions: "Inspect the repository", ...overrides },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		expect(received).toMatchObject({
			instructions: "Inspect the repository",
			authority: overrides,
		});
	});

	it("observes terminal records for status reads without observing mutation review", async () => {
		const records = [{ laneId: "worker-1", type: "worker", status: "completed" }] as never;
		const observeWorkerTerminalRecords = vi.fn();
		const getLaneRecords = vi.fn(() => records);
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			workerAgentControl: { observeWorkerTerminalRecords } as never,
			status: {
				getLaneRecords,
				getWorkerClaimSnapshots: () => [],
				acknowledgeWorkerReview: () => ({ ok: true as const, requestId: "worker-1", reviewedAt: "T1" }),
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		await definition.execute("status", { action: "status" }, new AbortController().signal, () => {}, {} as never);
		expect(getLaneRecords).toHaveBeenCalledTimes(1);
		expect(observeWorkerTerminalRecords).toHaveBeenCalledWith(records);
		expect(observeWorkerTerminalRecords.mock.calls[0]?.[0]).toBe(records);
		observeWorkerTerminalRecords.mockClear();

		await definition.execute(
			"review",
			{ action: "review", laneId: "worker-1" },
			new AbortController().signal,
			() => {},
			{} as never,
		);
		expect(observeWorkerTerminalRecords).not.toHaveBeenCalled();
	});

	it("stays accurate when worker write settings change without a runtime rebuild", () => {
		const settings = SettingsManager.inMemory({
			workerDelegation: { writeEnabled: false },
		});
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});
		const descriptionBefore = definition.description;

		settings.setWorkerDelegationSettings({ writeEnabled: true });

		expect(settings.getWorkerDelegationSettings()).toMatchObject({ writeEnabled: true });
		expect(settings.getWorkerDelegationSettings()).not.toHaveProperty("writePaths");
		expect(definition.description).toBe(descriptionBefore);
		expect(definition.description).toContain("inherits the foreground model, reasoning, every compatible tool");
		expect(definition.description).toContain("loaded profile is a reusable preset");
		expect(definition.description).toContain("persistent leaf workers");
		expect(definition.description).not.toMatch(/descendant|subtree|recursive/i);
		expect(definition.description).toContain("start with agentId dispatches a new task onto an existing idle worker");
		expect(definition.description).toContain("New workers default to their self-contained instructions only");
		expect(definition.description).toContain("Explicitly set forkTurns to all");

		const parameters = definition.parameters as unknown as {
			properties?: {
				instructions?: { description?: string };
				message?: { description?: string };
				maxMessages?: { description?: string };
				profileId?: { description?: string };
				forkTurns?: { description?: string };
				path?: { description?: string };
				toolNames?: { description?: string };
			};
		};
		expect(parameters.properties?.forkTurns?.description).toContain("Omitted starts use none");
		expect(parameters.properties?.forkTurns?.description).not.toContain("inherit bounded all");
		expect(parameters.properties?.instructions?.description).toContain("machine-wide project access");
		expect(parameters.properties?.instructions?.description).toContain("leaf-worker task");
		expect(parameters.properties?.message?.description).toContain("reply");
		expect(parameters.properties?.maxMessages?.description).toContain("inbox");
		expect(parameters.properties?.profileId?.description).toContain("profile preset");
		expect(parameters.properties?.path?.description).toContain("workspace and cwd");
		expect(parameters.properties?.toolNames?.description).toContain("inherits every compatible foreground tool");
		expect(parameters.properties).not.toHaveProperty("authority");
		const promptGuidelines = (definition.promptGuidelines ?? []).join("\n");
		expect(promptGuidelines).toContain("Optional model/thinkingLevel/path/toolNames only");
		expect(promptGuidelines).toContain("CAVEMAN MODE - MANDATORY: fresh=no agentId");
		expect(promptGuidelines).toContain("reuse=returned agentId");
		expect(promptGuidelines).toContain("task=instructions");
		expect(promptGuidelines.toLowerCase()).toContain("compiles and persists grant");
		expect(promptGuidelines).toContain("queued=admitted");
		expect(parameters.properties).not.toHaveProperty("memoryRead");
	});

	it("sanitizes extraneous fields on start dispatches so execution proceeds cleanly", async () => {
		let received: { instructions: string; profileId?: string } | undefined;
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: (request) => {
				received = request;
				return {
					started: true,
					record: { laneId: "worker-1", type: "worker", status: "queued" },
				};
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		const result = await definition.execute(
			"call-1",
			{ instructions: "Recall the relevant convention", memoryRead: true },
			new AbortController().signal,
			() => {},
			{} as never,
		);

		expect(received).toEqual({ instructions: "Recall the relevant convention" });
		expect(result.details).toMatchObject({
			started: true,
		});
	});
});
