import { afterEach, describe, expect, it } from "vitest";
import { resolveModelScopeWithDiagnostics } from "../../../src/core/model-resolver.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #6210 bracketed scoped model IDs", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("resolves brackets as a literal exact ID before glob matching", async () => {
		const harness = await createHarness({
			models: [{ id: "bracketed-model[1m]", name: "Bracketed Model", reasoning: true }],
		});
		harnesses.push(harness);
		const model = harness.models[0];

		const result = await resolveModelScopeWithDiagnostics(
			[`${model.provider}/${model.id}:high`],
			harness.session.modelRegistry,
		);

		expect(result.scopedModels).toEqual([
			{ model: expect.objectContaining({ id: model.id }), thinkingLevel: "high" },
		]);
		expect(result.diagnostics).toEqual([]);
	});
});
