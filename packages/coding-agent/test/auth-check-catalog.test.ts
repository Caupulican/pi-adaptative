import { expect, it, vi } from "vitest";
import { ANTIGRAVITY_CLIENT_CONFIG } from "../../ai/src/providers/antigravity-client-config.generated.ts";
import { ANTIGRAVITY_CATALOG_VERSION } from "../../ai/src/utils/antigravity.ts";
import { checkProviderAuth } from "../src/cli/auth-check.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";

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
