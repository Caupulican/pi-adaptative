import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnthropicMessagesCompat } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { tempDir } from "./temp-dir.ts";

it("retains an explicitly verified Anthropic tool-search override from models.json", () => {
	const directory = tempDir("pi-model-registry-tool-search-");
	const modelsPath = join(directory, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				verified_proxy: {
					baseUrl: "https://proxy.example.test",
					apiKey: "test-key",
					api: "anthropic-messages",
					compat: { supportsToolSearch: true },
					models: [
						{
							id: "verified-claude",
							reasoning: true,
							input: ["text"],
						},
					],
				},
			},
		}),
	);

	const registry = ModelRegistry.create(AuthStorage.create(join(directory, "auth.json")), modelsPath);
	const compat = registry.find("verified_proxy", "verified-claude")?.compat as AnthropicMessagesCompat | undefined;

	expect(registry.getError()).toBeUndefined();
	expect(compat?.supportsToolSearch).toBe(true);
});
