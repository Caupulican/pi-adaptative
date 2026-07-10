import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryProvider } from "../../src/core/memory/memory-provider.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession legacy memory prefetch policy", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("does not bypass the contextPolicy.memory hard off-switch", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: false } } },
		});
		harnesses.push(harness);
		const prefetch = vi.fn(async () => "<memory_context>must not be injected</memory_context>");
		const provider: MemoryProvider = {
			name: "local-test-memory",
			egress: "local",
			isAvailable: () => true,
			getCapabilities: () => ({ surfaces: ["context"] }),
			initialize: async () => {},
			shutdown: async () => {},
			prefetch,
		};
		harness.session.registerMemoryProvider(provider);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("ok")]);

		await harness.session.prompt("where is the deployment plan stored");

		expect(prefetch).not.toHaveBeenCalled();
	});
});
