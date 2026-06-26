/**
 * Test fixture extension that registers a provider.
 */

import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";

export const testProviderExtensionFactory: ExtensionFactory = (pi) => {
	pi.registerProvider("test-provider", {
		name: "Test Provider",
		baseUrl: "https://test.example.com",
		api: "custom-api",
		models: [
			{
				id: "test-model-1",
				name: "Test Model 1",
				api: "custom-api",
				input: ["text"],
				reasoning: false,
				cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 2048,
			},
		],
	});
};
