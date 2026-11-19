import { expect, it, vi } from "vitest";
import { ANTIGRAVITY_CLIENT_CONFIG } from "../../ai/src/providers/antigravity-client-config.generated.ts";
import { ANTIGRAVITY_CATALOG_VERSION } from "../../ai/src/utils/antigravity.ts";
import { checkProviderAuth, refreshStaleModelCatalogs } from "../src/cli/auth-check.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

it("refreshes stale catalog metadata on explicit auth check even while the token is valid", async () => {
	const id = "google-antigravity";
	const credential = {
		type: "oauth" as const,
		refresh: "fixture",
		access: "active-fixture",
		expires: Date.now() + 3600000,
	};
	const storage = AuthStorage.inMemory({ [id]: credential });
	const resolve = vi.spyOn(storage, "getOAuthApiKey").mockResolvedValue(credential.access);
	expect(await checkProviderAuth(id, storage, { noRefresh: true })).toMatchObject({
		status: "valid",
		tokenRefreshed: false,
	});
	expect(resolve).not.toHaveBeenCalled();
	expect(await checkProviderAuth(id, storage, {})).toMatchObject({ status: "error", tokenRefreshed: false });
	expect(resolve).toHaveBeenCalledOnce();
	resolve.mockImplementationOnce(async () => {
		storage.set(id, {
			...credential,
			catalogVersion: ANTIGRAVITY_CATALOG_VERSION,
			clientVersion: ANTIGRAVITY_CLIENT_CONFIG.version,
		});
		return credential.access;
	});
	expect(await checkProviderAuth(id, storage, {})).toMatchObject({ status: "valid", tokenRefreshed: false });
});

it("makes a newly advertised model selectable on upgrade without refreshing a current cache again", async () => {
	const id = "google-antigravity";
	const model = "gemini-4-neon-high";
	const old = {
		type: "oauth" as const,
		refresh: "fixture",
		access: "fixture",
		expires: Date.now() + 3600000,
		catalogVersion: 5,
		modelCatalog: {},
	};
	const storage = AuthStorage.inMemory({ [id]: old });
	const resolve = vi.spyOn(storage, "getOAuthApiKey").mockImplementationOnce(async () => {
		storage.set(id, {
			...old,
			catalogVersion: ANTIGRAVITY_CATALOG_VERSION,
			clientVersion: ANTIGRAVITY_CLIENT_CONFIG.version,
			modelCatalog: {
				[model]: { maxTokens: 1048576, maxOutputTokens: 262144, supportsThinking: true, thinkingLevel: 3 },
			},
		});
		return old.access;
	});
	await refreshStaleModelCatalogs(storage);
	expect(ModelRegistry.inMemory(storage).find(id, model)?.defaultThinkingLevel).toBe("high");
	await refreshStaleModelCatalogs(storage);
	expect(resolve).toHaveBeenCalledOnce();
});
