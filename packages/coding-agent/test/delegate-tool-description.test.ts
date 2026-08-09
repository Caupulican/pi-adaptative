import { describe, expect, it } from "vitest";
import { MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES } from "../src/core/delegation/worker-conversation-store.ts";
import {
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
} from "../src/core/orchestration/contracts.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createDelegateToolDefinition, DELEGATE_ACTIONS } from "../src/core/tools/delegate.ts";

describe("delegate tool capability description", () => {
	it("derives the tool action schema from the canonical action registry", () => {
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});
		const parameters = definition.parameters as unknown as {
			properties?: { action?: { enum?: readonly string[] } };
		};

		expect(parameters.properties?.action?.enum).toEqual(DELEGATE_ACTIONS);
		expect(new Set(DELEGATE_ACTIONS).size).toBe(DELEGATE_ACTIONS.length);
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
		const authority = parameters.properties.authority as unknown as {
			properties: Record<
				string,
				{ maxItems?: number; items?: { maxLength?: number }; properties?: Record<string, { maxLength?: number }> }
			>;
		};

		expect(parameters.properties.instructions.maxLength).toBe(MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH);
		for (const field of ["profileId", "agentId", "threadId", "replyToMessageId", "requestMessageId", "messageId"]) {
			expect(parameters.properties[field]?.maxLength).toBe(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		}
		expect(parameters.properties.agentIds.maxItems).toBe(MAX_ORCHESTRATION_COLLECTION_LENGTH);
		expect(parameters.properties.agentIds.items?.maxLength).toBe(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
		expect(parameters.properties.maxMessages.maximum).toBe(MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES);
		expect(authority.properties.model.properties?.provider?.maxLength).toBe(MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH);
		expect(authority.properties.model.properties?.modelId?.maxLength).toBe(MAX_ORCHESTRATION_MODEL_ID_LENGTH);
		expect(authority.properties.toolNames.maxItems).toBe(MAX_ORCHESTRATION_COLLECTION_LENGTH);
		expect(authority.properties.toolNames.items?.maxLength).toBe(MAX_ORCHESTRATION_IDENTIFIER_LENGTH);
	});

	it("stays accurate when worker write settings change without a runtime rebuild", () => {
		const settings = SettingsManager.inMemory({
			workerDelegation: { writeEnabled: false, writePaths: [] },
		});
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});
		const descriptionBefore = definition.description;

		settings.setWorkerDelegationSettings({ writeEnabled: true, writePaths: ["src"] });

		expect(settings.getWorkerDelegationSettings()).toMatchObject({ writeEnabled: true, writePaths: ["src"] });
		expect(definition.description).toBe(descriptionBefore);
		expect(definition.description).toContain("inherits the caller's execution authority by default");
		expect(definition.description).toContain("loaded profile as a preset");
		expect(definition.description).toContain("host scheduler manages bounded depth");
		expect(definition.description).toContain("Workers are persistent specialists");
		expect(definition.description).toContain("start with agentId dispatches a new task onto an existing idle worker");
		expect(definition.description).toContain(
			"when inherited parent context would mislead the task, also set forkTurns to none",
		);

		const parameters = definition.parameters as unknown as {
			properties?: {
				instructions?: { description?: string };
				message?: { description?: string };
				maxMessages?: { description?: string };
				profileId?: { description?: string };
				authority?: object;
			};
		};
		expect(parameters.properties?.instructions?.description).toContain("inherits the caller's admitted grant");
		expect(parameters.properties?.instructions?.description).toContain("may recursively delegate");
		expect(parameters.properties?.instructions?.description).toContain("bounds depth");
		expect(parameters.properties?.message?.description).toContain("reply");
		expect(parameters.properties?.maxMessages?.description).toContain("inbox");
		expect(parameters.properties?.profileId?.description).toContain("profile preset");
		expect(parameters.properties?.authority).toBeDefined();
		expect((definition.promptGuidelines ?? []).join("\n")).toContain("authority to choose the model");
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
