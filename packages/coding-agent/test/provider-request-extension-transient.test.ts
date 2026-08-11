import type { ProviderRequestAdmissionContext } from "@caupulican/pi-agent-core/types";
import { afterEach, describe, expect, it } from "vitest";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

describe("provider request extension transients", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("budgets provider-only extension context as non-compactable without persisting it", async () => {
		const marker = `EXTENSION-TRANSIENT-${"x".repeat(2_000)}`;
		harness = await createHarnessWithExtensions({
			responses: ["delivered"],
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => ({
						messages: event.messages,
						transientMessages: [
							{
								role: "user",
								content: [{ type: "text", text: marker }],
								timestamp: 2,
							},
						],
					}));
				},
			],
		});
		const admission = harness.agent.admitProviderRequest?.bind(harness.agent);
		if (!admission) throw new Error("Expected session provider request admission");
		const requests: ProviderRequestAdmissionContext[] = [];
		harness.agent.admitProviderRequest = async (request, signal) => {
			requests.push(request);
			return await admission(request, signal);
		};

		await harness.agent.prompt("durable history");

		expect(requests).toHaveLength(1);
		expect(JSON.stringify(requests[0].context.messages)).toContain(marker);
		expect(JSON.stringify(requests[0].nonCompactableContext.messages)).toContain(marker);
		expect(JSON.stringify(requests[0].sourceContext.messages)).not.toContain(marker);
		expect(JSON.stringify(harness.faux.contexts[0].messages)).toContain(marker);
		expect(JSON.stringify(harness.agent.state.messages)).not.toContain(marker);
	});

	it("rejects late payload expansion so extensions cannot bypass request admission", async () => {
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_request", (event) => ({
						...(event.payload as Record<string, unknown>),
						latePromptInjection: "unbudgeted",
					}));
				},
			],
		});

		await expect(harness.session.extensionRunner.emitBeforeProviderRequest({ messages: [] })).rejects.toThrow(
			"cannot expand provider payload",
		);
	});
});
