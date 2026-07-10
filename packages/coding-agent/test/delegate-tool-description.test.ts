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
			properties?: { instructions?: { description?: string } };
		};
		expect(parameters.properties?.instructions?.description).toContain("workerDelegation.writeEnabled");
		expect(parameters.properties?.instructions?.description).toContain("path-scoped");
	});
});
