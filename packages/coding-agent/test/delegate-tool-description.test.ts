import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";

describe("delegate tool capability description", () => {
	it("stays accurate when worker write settings change without a runtime rebuild", () => {
		const settings = SettingsManager.inMemory({
			workerDelegation: { writeEnabled: false, writePaths: [] },
		});
		const definition = createDelegateToolDefinition({
			runWorkerDelegation: async () => ({ started: false, skipReason: "test" }),
		});
		const descriptionBefore = definition.description;

		settings.setWorkerDelegationSettings({ writeEnabled: true, writePaths: ["src"] });

		expect(settings.getWorkerDelegationSettings()).toMatchObject({ writeEnabled: true, writePaths: ["src"] });
		expect(definition.description).toBe(descriptionBefore);
		expect(definition.description).toContain("inherits the caller's execution authority");
		expect(definition.description).toContain("loaded profile as a preset");
		expect(definition.description).toContain("host scheduler manages concurrency");
		expect(definition.description).toContain("Workers are persistent specialists");
		expect(definition.description).toContain("start with agentId dispatches a new task onto an existing idle worker");

		const parameters = definition.parameters as unknown as {
			properties?: {
				instructions?: { description?: string };
				profileId?: { description?: string };
				authority?: object;
			};
		};
		expect(parameters.properties?.instructions?.description).toContain("inherits the caller's full admitted grant");
		expect(parameters.properties?.profileId?.description).toContain("preset, not an authority allowlist");
		expect(parameters.properties?.authority).toBeDefined();
		expect((definition.promptGuidelines ?? []).join("\n")).toContain("authority to choose the model");
		expect(parameters.properties).not.toHaveProperty("memoryRead");
	});

	it("does not forward a delegate-call memory override to the worker orchestrator", async () => {
		let received: { instructions: string; profileId?: string } | undefined;
		const definition = createDelegateToolDefinition({
			startWorkerDelegation: (request) => {
				received = request;
				return {
					started: true,
					record: { laneId: "worker-1", type: "worker", status: "queued" },
				};
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});

		await definition.execute(
			"call-1",
			{ instructions: "Recall the relevant convention", memoryRead: true },
			new AbortController().signal,
			() => {},
			{} as never,
		);

		expect(received).toEqual({ instructions: "Recall the relevant convention" });
	});
});
