import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Before a submission's run exists (routing, System One classification, extension hooks) there is no
 * agent run for an interrupt to abort; the submission's own abort cancels it there, so the turn never
 * reaches the provider.
 */
describe("submission preflight abort", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("cancels a submission that is still preparing its turn", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached!: () => void;
		const inPreflight = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						reached();
						await gate;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should not be sent")]);
		const prompt = harness.session.prompt("a question");
		await inPreflight;
		expect(harness.session.isPreparingSubmission).toBe(true);
		await harness.session.abort("user interrupt");
		release();
		await prompt;
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.isPreparingSubmission).toBe(false);
	});
});
