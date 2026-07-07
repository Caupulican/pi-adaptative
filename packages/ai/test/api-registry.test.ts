import { afterEach, describe, expect, it } from "vitest";
import type { ApiProvider } from "../src/api-registry.ts";
import { clearApiProviders, getApiProvider, registerApiProvider, unregisterApiProviders } from "../src/api-registry.ts";

const api = "anthropic-messages";

function provider(): ApiProvider<typeof api> {
	return {
		api,
		stream: () => {
			throw new Error("not called");
		},
		streamSimple: () => {
			throw new Error("not called");
		},
	};
}

afterEach(() => {
	clearApiProviders();
});

describe("api provider registry", () => {
	it("restores an overridden provider when the override is unregistered", () => {
		registerApiProvider(provider());
		const builtIn = getApiProvider(api);

		registerApiProvider(provider(), "extension");
		expect(getApiProvider(api)).not.toBe(builtIn);

		unregisterApiProviders("extension");
		expect(getApiProvider(api)).toBe(builtIn);
	});

	it("restores chained overrides in LIFO order", () => {
		registerApiProvider(provider());
		const builtIn = getApiProvider(api);
		registerApiProvider(provider(), "extension-1");
		const firstOverride = getApiProvider(api);
		registerApiProvider(provider(), "extension-2");
		expect(getApiProvider(api)).not.toBe(firstOverride);

		unregisterApiProviders("extension-2");
		expect(getApiProvider(api)).toBe(firstOverride);

		unregisterApiProviders("extension-1");
		expect(getApiProvider(api)).toBe(builtIn);
	});
});
