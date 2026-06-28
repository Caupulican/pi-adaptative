import { describe, expect, it } from "vitest";
import { classifyModelRouterIntent } from "../src/core/model-router/intent-classifier.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("model router intent classifier", () => {
	it("routes read-only questions to the cheap/research lane", () => {
		expect(classifyModelRouterIntent("Explain how the memory subsystem works in this repo")).toBe("research");
		expect(classifyModelRouterIntent("Summarize the differences between these two files")).toBe("research");
		expect(classifyModelRouterIntent("Explain this code block without changing it")).toBe("research");
		expect(classifyModelRouterIntent("How do I add two numbers in TypeScript?")).toBe("research");
		expect(classifyModelRouterIntent("What does git commit do?")).toBe("research");
		expect(classifyModelRouterIntent("Why would npm test run slowly here?")).toBe("research");
	});

	it("keeps explicit change requests on the expensive/modify lane even when phrased as questions", () => {
		expect(classifyModelRouterIntent("Can you fix the failing tests?")).toBe("modify");
		expect(classifyModelRouterIntent("Please update the changelog for this change")).toBe("modify");
	});

	it("routes modifying or command-running prompts to the expensive/modify lane", () => {
		expect(classifyModelRouterIntent("Fix the resources submenu cancellation bug")).toBe("modify");
		expect(classifyModelRouterIntent("Run npm check and update the failing tests")).toBe("modify");
		expect(classifyModelRouterIntent("Create a new extension for model routing")).toBe("modify");
	});

	it("keeps model routing disabled unless explicitly enabled", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getModelRouterSettings()).toEqual({ enabled: false });
	});

	it("normalizes configured router model patterns", () => {
		const settings = SettingsManager.inMemory({
			modelRouter: {
				enabled: true,
				cheapModel: "anthropic/claude-haiku-4-5",
				expensiveModel: "anthropic/claude-sonnet-4-5",
			},
		});

		expect(settings.getModelRouterSettings()).toEqual({
			enabled: true,
			cheapModel: "anthropic/claude-haiku-4-5",
			expensiveModel: "anthropic/claude-sonnet-4-5",
		});
	});
});
