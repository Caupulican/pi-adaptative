import { registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import type { Api, Model } from "@caupulican/pi-ai/types";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

/** The session's model-auth resolution, which every provider request goes through. */
type SessionAuthResolution = { _getRequiredRequestAuth(model: Model<Api>): Promise<unknown> };

const PROVIDER_ID = "session-expired-oauth-test";
/** Four days stale, the state the owner's Windows host was actually in. */
const EXPIRES_AT = Date.UTC(2026, 8, 7, 12, 0, 0);

/**
 * A stored OAuth credential that expired and cannot be refreshed used to reach the user as
 * "No API key for provider: <id>" — false, and it points at the wrong fix. The session must say
 * which credential died, when, why the refresh failed, and how to reauthorize.
 */
describe("expired OAuth credential at the session boundary", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		unregisterOAuthProvider(PROVIDER_ID);
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("names the expired credential and the reauthorization command instead of claiming no API key", async () => {
		registerOAuthProvider({
			id: PROVIDER_ID,
			name: "Session Test Provider",
			login: async () => {
				throw new Error("unused");
			},
			refreshToken: async () => {
				throw new Error("offline");
			},
			getApiKey: (credentials) => credentials.access,
		});
		const harness = await createHarness({
			withConfiguredAuth: false,
			fauxProvider: { provider: PROVIDER_ID },
		});
		harnesses.push(harness);
		harness.authStorage.set(PROVIDER_ID, {
			type: "oauth",
			access: "expired-access-token",
			refresh: "refresh-token",
			expires: EXPIRES_AT,
		});

		const session = harness.session as unknown as SessionAuthResolution;
		const failure = await session._getRequiredRequestAuth(harness.getModel()).then(
			() => undefined,
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		const expected =
			`OAuth credential for ${PROVIDER_ID} expired on ${new Date(EXPIRES_AT).toISOString()} ` +
			`and could not be refreshed (Failed to refresh OAuth token for ${PROVIDER_ID}). ` +
			`Run pi login ${PROVIDER_ID} to reauthorize.`;
		expect(failure).toBe(expected);
		expect(failure).not.toContain("No API key");

		// The same text the SDK stream fn throws when it resolves the provider-facing key.
		const auth = await harness.session.modelRegistry.getApiKeyAndHeaders(harness.getModel());
		expect(auth.ok).toBe(false);
		expect(auth.ok ? undefined : auth.error).toBe(expected);
	});

	it("still reports a missing credential as no API key", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.prompt("hi")).rejects.toThrow(
			`No API key found for ${harness.getModel().provider}.`,
		);
	});
});
