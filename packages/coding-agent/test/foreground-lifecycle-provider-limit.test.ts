import { describe, expect, it, vi } from "vitest";
import { ForegroundLifecycleAdapter } from "../src/core/foreground-lifecycle-adapter.ts";
import type { ModelRouterController } from "../src/core/model-router-controller.ts";
import { ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";
import { createHarness } from "./test-harness.ts";

describe("foreground retry provider limits", () => {
	it("publishes retry cooldown under the same credential-scoped key admission reads", async () => {
		const harness = createHarness();
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
		try {
			let activeAccount = "account-a";
			const limits = new ProviderLimitStore(harness.tempDir, { now: () => 1_000 });
			const lifecycle = new ForegroundLifecycleAdapter(
				harness.agent,
				harness.sessionManager,
				{ commitSessionBufferPrefix: () => new Map() } as ModelRouterController,
				undefined,
				undefined,
				limits,
				(provider) => `${provider}#${activeAccount}`,
			);
			lifecycle.install();
			await harness.agent.onProviderRequestSnapshot?.(
				{
					requestId: "credential-scoped-retry",
					model: { api: "faux", provider: "faux", id: "faux-1" },
					reasoning: "off",
					maxTokens: 128,
					attempt: 0,
					context: { systemPrompt: "", tools: [], messages: [] },
				} as never,
				undefined,
			);
			activeAccount = "account-b";

			lifecycle.recordRetryEvent({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 2_000,
				errorMessage: "429 rate limit",
			});

			expect(limits.read("faux#account-a")).toMatchObject({
				provider: "faux#account-a",
				limitedUntil: 3_000,
				reason: "rate_limit",
			});
			expect(limits.read("faux")).toBeUndefined();
			expect(limits.read("faux#account-b")).toBeUndefined();
		} finally {
			clock.mockRestore();
			await harness.cleanup();
		}
	});
});
