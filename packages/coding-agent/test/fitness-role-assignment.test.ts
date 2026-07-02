import { describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type AssignContext = {
	settingsManager: SettingsManager;
	showStatus: (text: string) => void;
};

const assignFitnessRole = Reflect.get(InteractiveMode.prototype, "assignFitnessRole") as (
	this: AssignContext,
	modelRef: string,
	role: string,
) => void;

function context(): AssignContext & { statuses: string[] } {
	const statuses: string[] = [];
	return {
		settingsManager: SettingsManager.inMemory(),
		showStatus: vi.fn((text: string) => statuses.push(text)),
		statuses,
	};
}

describe("/fitness role assignment", () => {
	it("curator role enables curation with the probed model", () => {
		const ctx = context();
		assignFitnessRole.call(ctx, "ollama/pi-lifter:latest", "curator");
		const settings = ctx.settingsManager.getContextCurationSettings();
		expect(settings.enabled).toBe(true);
		expect(settings.model).toBe("ollama/pi-lifter:latest");
	});

	it("router roles persist the tier model and hint when the router is disabled", () => {
		const ctx = context();
		assignFitnessRole.call(ctx, "ollama/qwen3:1.7b", "router-cheap");
		expect(ctx.settingsManager.getModelRouterSettings().cheapModel).toBe("ollama/qwen3:1.7b");
		expect(ctx.statuses.some((line) => line.includes("router is currently disabled"))).toBe(true);

		assignFitnessRole.call(ctx, "ollama/pi-lifter:latest", "judge");
		expect(ctx.settingsManager.getModelRouterSettings().judgeModel).toBe("ollama/pi-lifter:latest");
	});

	it("executor role persists modelRouter.executorModel", () => {
		const ctx = context();
		assignFitnessRole.call(ctx, "ollama/qwen3:1.7b", "executor");
		expect(ctx.settingsManager.getModelRouterSettings().executorModel).toBe("ollama/qwen3:1.7b");
	});

	it("none records nothing but confirms where the result lives", () => {
		const ctx = context();
		assignFitnessRole.call(ctx, "ollama/x", "none");
		expect(ctx.settingsManager.getContextCurationSettings().enabled).toBe(false);
		expect(ctx.statuses[0]).toContain("Fitness result");
	});
});
