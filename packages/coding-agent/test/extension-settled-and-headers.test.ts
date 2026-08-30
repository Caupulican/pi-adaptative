import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/factory-runtime.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";

describe("P2s: Extension settled and before_provider_headers", () => {
	it("allows before_provider_headers handlers to mutate headers in-place", async () => {
		const bus = createEventBus();
		const runtime = createExtensionRuntime();

		const ext = await loadExtensionFromFactory(
			(pi) => {
				pi.on("before_provider_headers", (event) => {
					event.headers["X-Custom-Header"] = "custom-val";
					delete event.headers["X-Remove-Header"];
				});
			},
			process.cwd(),
			bus,
			runtime,
			"test-ext",
		);

		const runner = new ExtensionRunner([ext], runtime, process.cwd(), undefined as any, undefined as any);
		const headers: Record<string, string> = {
			Authorization: "Bearer token",
			"X-Remove-Header": "drop-me",
		};

		await runner.emitBeforeProviderHeaders({
			provider: "anthropic",
			model: "claude-sonnet-4",
			headers,
		});

		expect(headers.Authorization).toBe("Bearer token");
		expect(headers["X-Custom-Header"]).toBe("custom-val");
		expect(headers["X-Remove-Header"]).toBeUndefined();
	});
});
