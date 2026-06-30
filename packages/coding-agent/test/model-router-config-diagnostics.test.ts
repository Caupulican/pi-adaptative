import type { Model } from "@caupulican/pi-ai";
import { getModel } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { collectModelRouterConfigDiagnostics } from "../src/core/model-router/config-diagnostics.ts";

type RegistryStub = {
	getAll: () => Model<any>[];
	hasConfiguredAuth: (model: Model<any>) => boolean;
};

const cheapModel = getModel("anthropic", "claude-haiku-4-5")!;
const mediumModel = getModel("anthropic", "claude-3-5-sonnet-20241022")!;
const expensiveModel = getModel("anthropic", "claude-sonnet-4-5")!;

function createRegistry(authenticatedModels: Model<any>[] = [cheapModel, mediumModel, expensiveModel]): RegistryStub {
	return {
		getAll: () => [cheapModel, mediumModel, expensiveModel],
		hasConfiguredAuth: (model) =>
			authenticatedModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id),
	};
}

describe("model router config diagnostics", () => {
	it("does not warn when model routing is disabled", () => {
		expect(
			collectModelRouterConfigDiagnostics({ enabled: false }, createRegistry() as unknown as ModelRegistry),
		).toEqual([]);
	});

	it("warns about unset enabled model-router config keys before the first prompt", () => {
		expect(
			collectModelRouterConfigDiagnostics({ enabled: true }, createRegistry() as unknown as ModelRegistry),
		).toEqual([
			"Model router cheap model is unset; configure modelRouter.cheapModel or disable modelRouter.enabled.",
			"Model router medium model is unset; configure modelRouter.mediumModel or disable modelRouter.enabled.",
			"Model router expensive model is unset; configure modelRouter.expensiveModel or disable modelRouter.enabled.",
		]);
	});

	it("warns about unresolved configured model-router model patterns", () => {
		expect(
			collectModelRouterConfigDiagnostics(
				{
					enabled: true,
					cheapModel: "definitely-not-a-model",
					mediumModel: "anthropic/claude-3-5-sonnet-20241022",
					expensiveModel: "anthropic/claude-sonnet-4-5",
				},
				createRegistry() as unknown as ModelRegistry,
			),
		).toEqual(["Model router cheap model is unresolved: definitely-not-a-model."]);
	});

	it("warns about unresolved configured medium model pattern", () => {
		expect(
			collectModelRouterConfigDiagnostics(
				{
					enabled: true,
					cheapModel: "anthropic/claude-haiku-4-5",
					mediumModel: "definitely-not-a-model",
					expensiveModel: "anthropic/claude-sonnet-4-5",
				},
				createRegistry() as unknown as ModelRegistry,
			),
		).toEqual(["Model router medium model is unresolved: definitely-not-a-model."]);
	});

	it("warns about resolved model-router models without configured auth", () => {
		expect(
			collectModelRouterConfigDiagnostics(
				{
					enabled: true,
					cheapModel: "anthropic/claude-haiku-4-5",
					mediumModel: "anthropic/claude-3-5-sonnet-20241022",
					expensiveModel: "anthropic/claude-sonnet-4-5",
				},
				createRegistry([cheapModel, expensiveModel]) as unknown as ModelRegistry,
			),
		).toEqual(["Model router medium model is missing auth: anthropic/claude-3-5-sonnet-20241022."]);
	});
});
