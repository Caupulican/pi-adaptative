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
		expect(definition.description).toContain("read-only by default");
		expect(definition.description).toContain("workerDelegation.writeEnabled");
		expect(definition.description).toContain("non-empty writePaths");
		expect(definition.description).toContain("lane profile grant write/edit");
		expect(definition.description).toContain("parent review");

		const parameters = definition.parameters as unknown as {
			properties?: {
				instructions?: { description?: string };
				memoryRead?: { description?: string };
			};
		};
		expect(parameters.properties?.instructions?.description).toContain("workerDelegation.writeEnabled");
		expect(parameters.properties?.instructions?.description).toContain("path-scoped");
		expect(parameters.properties?.memoryRead?.description).toContain("read-only memory");
		expect(parameters.properties?.memoryRead?.description).toContain("lane profile");
		expect(parameters.properties?.memoryRead?.description).toContain("never granted");
	});

	it("forwards an explicit read-only memory request to the worker orchestrator", async () => {
		let received: { instructions: string; systemPrompt?: string; memoryRead?: boolean } | undefined;
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

		expect(received).toEqual({ instructions: "Recall the relevant convention", memoryRead: true });
	});
});
