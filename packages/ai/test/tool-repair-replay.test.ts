import { describe, expect, it } from "vitest";
import { replayToolRepairCorpus } from "../src/utils/tool-repair/replay.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

describe("tool repair corpus replay", () => {
	it("deterministically classifies sanitized corpus records and emits bounce fixtures", () => {
		const records = [
			{
				kind: "tool_validation" as const,
				ts: "2026-07-07T00:00:00.000Z",
				provider: "test-provider",
				modelId: "test-model",
				tool: "count",
				failureModes: ["other"],
				shape: [{ path: "count", expectedType: "number", receivedType: "object" }],
			},
		];

		const first = replayToolRepairCorpus(records);
		const second = replayToolRepairCorpus(records);
		expect(second).toEqual(first);
		expect(first).toMatchObject([
			{
				record: 1,
				tool: "count",
				classifiedModes: ["other"],
				outcome: "would-bounce",
				fixture: {
					tool: "count",
					arguments: { count: {} },
				},
			},
		]);

		const fixture = first[0]!.fixture;
		expect(() =>
			validateToolArguments(
				{
					name: fixture.tool,
					description: "replayed fixture",
					parameters: fixture.parameters,
				},
				{ type: "toolCall", id: "fixture", name: fixture.tool, arguments: fixture.arguments },
			),
		).toThrow(/Validation failed/);
	});
});
