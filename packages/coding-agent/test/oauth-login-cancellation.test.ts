import {
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	registerOAuthProvider,
	unregisterOAuthProviders,
} from "@caupulican/pi-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

const source = "offline-fresh-login-cancellation";
const providerId = "fixture-oauth-login";
const credentials: OAuthCredentials = {
	access: "synthetic-access",
	refresh: "synthetic-refresh",
	expires: 9999999999999,
};

function callbacks(signal: AbortSignal): OAuthLoginCallbacks {
	return {
		signal,
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onSelect: async () => undefined,
	};
}

function provider(login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>) {
	registerOAuthProvider(
		{
			id: providerId,
			name: "Offline OAuth fixture",
			login,
			refreshToken: async (value) => value,
			getApiKey: (value) => value.access,
		},
		source,
	);
}

afterEach(() => unregisterOAuthProviders(source));

describe("fresh OAuth credential commit cancellation", () => {
	it("does not invoke a provider for an already-cancelled login", async () => {
		const login = vi.fn(async () => credentials);
		provider(login);
		const storage = AuthStorage.inMemory();
		const cancellation = new AbortController();
		cancellation.abort(new Error("Owner cancelled before login"));
		await expect(storage.login(providerId, callbacks(cancellation.signal))).rejects.toThrow("cancelled");
		expect(login).not.toHaveBeenCalled();
		expect(storage.get(providerId)).toBeUndefined();
	});

	it("keeps the current credential when a cancelled provider returns late", async () => {
		let resolve!: (value: OAuthCredentials) => void;
		provider(
			() =>
				new Promise<OAuthCredentials>((done) => {
					resolve = done;
				}),
		);
		const previous = { type: "api_key" as const, key: "synthetic-existing-key" };
		const storage = AuthStorage.inMemory({ [providerId]: previous });
		const cancellation = new AbortController();
		const outcome = storage.login(providerId, callbacks(cancellation.signal));
		const assertion = expect(outcome).rejects.toThrow("cancelled");
		cancellation.abort(new Error("Owner cancelled while login was pending"));
		resolve(credentials);
		await assertion;
		expect(storage.get(providerId)).toEqual(previous);
	});

	it("commits a successful current login once", async () => {
		const login = vi.fn(async () => credentials);
		provider(login);
		const storage = AuthStorage.inMemory();
		await storage.login(providerId, callbacks(new AbortController().signal));
		expect(login).toHaveBeenCalledOnce();
		expect(storage.get(providerId)).toEqual({ type: "oauth", ...credentials });
	});
});
