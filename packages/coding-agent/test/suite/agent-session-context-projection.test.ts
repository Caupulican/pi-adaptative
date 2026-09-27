import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession accepted context projection", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("exposes the accepted provider snapshot without publishing read-only previews", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.session.getContextProjection().entries).toEqual([]);

		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("inspect the repository");

		const accepted = harness.session.getContextProjection();
		expect(accepted.entries.some((entry) => entry.role === "user")).toBe(true);
		expect(accepted.entries.every((entry) => entry.freshness.observedAtTurn === accepted.observedAtTurn)).toBe(true);

		const transcriptPreview = harness.session.getContextProjection(harness.session.messages);
		expect(transcriptPreview.entries.some((entry) => entry.role === "assistant")).toBe(true);
		expect(harness.session.getContextProjection()).toBe(accepted);
	});
});
