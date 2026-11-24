import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { anthropicOAuthProvider, registerOAuthProvider, unregisterOAuthProviders } from "@caupulican/pi-ai/oauth";
import { type Component, Container, type TUI } from "@caupulican/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	AuthStorage,
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
	type ProviderRefreshLease,
} from "../src/core/auth-storage.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { AuthDialogsController } from "../src/modes/interactive/auth-dialogs-controller.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { EditorOverlayHost } from "../src/modes/interactive/editor-overlay-host.ts";
import { initTheme } from "../src/presentation/theme/theme.ts";

const source = "offline-auth-command-persistence";
const oauthId = "fixture-persistence-oauth";
const keyId = "fixture-persistence-key";
const credentials = { access: "synthetic-access-only", refresh: "synthetic-refresh-only", expires: 9999999999999 };
const key = "synthetic-api-key-only";
type LockResult<T> = { result: T; next?: string };

class FailingBackend implements AuthStorageBackend {
	private readonly bytes = new InMemoryAuthStorageBackend();
	failWrites = false;
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		return this.bytes.withLock((current) => this.check(fn(current)));
	}
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		return this.bytes.withLockAsync(async (current) => this.check(await fn(current)));
	}
	withProviderRefreshLock<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
		return this.bytes.withProviderRefreshLock(providerId, fn);
	}
	withProviderRefreshLease<T>(providerId: string, fn: (lease: ProviderRefreshLease) => Promise<T>): Promise<T> {
		return this.bytes.withProviderRefreshLease(providerId, fn);
	}
	preflightRefreshPersistence(providerId: string): Promise<void> {
		if (this.failWrites) throw new Error("Synthetic credential write refused");
		return this.bytes.preflightRefreshPersistence(providerId);
	}
	private check<T>(change: LockResult<T>): LockResult<T> {
		if (change.next !== undefined && this.failWrites) throw new Error("Synthetic credential write refused");
		return change;
	}
}

class CompromisingRefreshBackend implements AuthStorageBackend {
	private readonly bytes = new InMemoryAuthStorageBackend();
	private activeRefresh: AbortController | undefined;
	private refreshLockReads = 0;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		return this.bytes.withLock(fn);
	}
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		if (this.activeRefresh && ++this.refreshLockReads === 2) {
			this.activeRefresh.abort(new Error("Synthetic provider refresh lease lost after response"));
		}
		return this.bytes.withLockAsync(fn);
	}
	withProviderRefreshLock<T>(_providerId: string, fn: () => Promise<T>): Promise<T> {
		return fn();
	}
	async withProviderRefreshLease<T>(_providerId: string, fn: (lease: ProviderRefreshLease) => Promise<T>): Promise<T> {
		this.refreshLockReads = 0;
		const activeRefresh = new AbortController();
		this.activeRefresh = activeRefresh;
		try {
			return await fn({
				signal: activeRefresh.signal,
				assertHeld: () => activeRefresh.signal.throwIfAborted(),
			});
		} finally {
			this.activeRefresh = undefined;
		}
	}
	async preflightRefreshPersistence(_providerId: string): Promise<void> {}
}

class CallbackThenThrowBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncCalls = 0;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const change = fn(this.value);
		if (change.next !== undefined) this.value = change.next;
		return change.result;
	}
	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const change = await fn(this.value);
		this.asyncCalls += 1;
		if (this.asyncCalls === 2) throw new Error("Synthetic failure after locked credential inspection");
		if (change.next !== undefined) this.value = change.next;
		return change.result;
	}
	withProviderRefreshLock<T>(_providerId: string, fn: () => Promise<T>): Promise<T> {
		return fn();
	}
	withProviderRefreshLease<T>(_providerId: string, fn: (lease: ProviderRefreshLease) => Promise<T>): Promise<T> {
		const signal = new AbortController().signal;
		return fn({ signal, assertHeld: () => signal.throwIfAborted() });
	}
	async preflightRefreshPersistence(_providerId: string): Promise<void> {}
	replace(providerId: string, credential: Record<string, unknown> | undefined): void {
		const current = this.value ? (JSON.parse(this.value) as Record<string, unknown>) : {};
		if (credential) current[providerId] = credential;
		else delete current[providerId];
		this.value = JSON.stringify(current);
	}
}

function fixture() {
	const backend = new FailingBackend();
	const storage = AuthStorage.fromStorage(backend);
	const editor: Component = { render: () => [], invalidate: () => {} };
	let mounted = editor;
	const overlayHost = new EditorOverlayHost(new Container(), {
		setFocus: (component) => {
			if (component) mounted = component;
		},
		restoreFocus: (component) => {
			if (component) mounted = component;
		},
		requestRender: () => {},
	});
	const refresh = vi.fn(async (_provider: string) => {});
	const count = vi.fn(async () => {});
	const statuses: string[] = [];
	const errors: string[] = [];
	const controller = new AuthDialogsController({
		getSession: () => ({ model: undefined, refreshModelsAfterAuthChange: refresh }) as unknown as AgentSession,
		getSettingsManager: () => ({}) as SettingsManager,
		getModelRegistry: () =>
			({
				authStorage: storage,
				getAll: () => [{ provider: keyId }],
				getProviderDisplayName: (id: string) => id,
			}) as unknown as ModelRegistry,
		ui: {
			showSelector: () => {
				throw new Error("Unexpected provider selector");
			},
			showStatus: (message) => statuses.push(message),
			showError: (message) => errors.push(message),
			requestRender: () => {},
			tui: { requestRender: () => {} } as unknown as TUI,
			overlayHost,
			getEditor: () => editor,
			updateAvailableProviderCount: count,
			invalidateFooter: () => {},
			updateEditorBorderColor: () => {},
			maybeWarnAboutAnthropicSubscriptionAuth: () => {},
			checkDaxnutsEasterEgg: () => {},
		},
	});
	return {
		backend,
		storage,
		controller,
		refresh,
		count,
		statuses,
		errors,
		reader: () => AuthStorage.fromStorage(backend),
		isEditor: () => mounted === editor,
		async login(id = oauthId) {
			const pending = controller.showOAuthSelector("login", id);
			if (id === keyId) {
				expect(mounted).toBeInstanceOf(LoginDialogComponent);
				(mounted as LoginDialogComponent).pasteText(key);
				(mounted as LoginDialogComponent).handleInput("\r");
			}
			await pending;
		},
	};
}

beforeEach(() => {
	initTheme("dark");
	registerOAuthProvider(
		{
			id: oauthId,
			name: oauthId,
			login: async () => credentials,
			refreshToken: async (value) => value,
			getApiKey: (value) => value.access,
		},
		source,
	);
});
afterEach(() => unregisterOAuthProviders(source));

function expectSafeFeedback(errors: string[]) {
	for (const secret of [key, credentials.access, credentials.refresh]) expect(errors.join("\n")).not.toContain(secret);
}

describe("durable interactive authentication feedback", () => {
	it("rejects an OAuth login whose credential is only available in this session", async () => {
		const f = fixture();
		f.backend.failWrites = true;
		await expect(
			f.storage.login(oauthId, {
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			}),
		).rejects.toThrow(/persist|sav|storage/i);
		expect(f.storage.get(oauthId)).toEqual({ type: "oauth", ...credentials });
		expect(f.reader().get(oauthId)).toBeUndefined();
	});

	it("rejects logout when a fresh reader still has the credential", () => {
		const f = fixture();
		f.storage.set(oauthId, { type: "oauth", ...credentials });
		f.backend.failWrites = true;
		expect(() => f.storage.logout(oauthId)).toThrow(/persist|remov|storage/i);
		expect(f.storage.get(oauthId)).toBeUndefined();
		expect(f.reader().get(oauthId)).toEqual({ type: "oauth", ...credentials });
	});

	for (const id of [oauthId, keyId]) {
		it(`reports session-only ${id} login without claiming a durable save`, async () => {
			const f = fixture();
			f.backend.failWrites = true;
			await f.login(id);
			expect(f.isEditor()).toBe(true);
			expect(f.storage.get(id)).toBeDefined();
			expect(f.reader().get(id)).toBeUndefined();
			expect(f.statuses).toEqual([]);
			expect(f.errors.join("\n")).toMatch(/session/i);
			expect(f.refresh).toHaveBeenCalledWith(id);
			expectSafeFeedback(f.errors);
		});

		it(`commits ${id} login before reporting success`, async () => {
			const f = fixture();
			await f.login(id);
			expect(f.isEditor()).toBe(true);
			expect(f.reader().get(id)).toEqual(f.storage.get(id));
			expect(f.errors).toEqual([]);
			expect(f.statuses).toHaveLength(1);
			expect(f.refresh).toHaveBeenCalledOnce();
		});
	}

	it("reports a session-only logout and refreshes without claiming durable removal", async () => {
		const f = fixture();
		f.storage.set(oauthId, { type: "oauth", ...credentials });
		f.backend.failWrites = true;
		await f.controller.showOAuthSelector("logout", oauthId);
		expect(f.storage.get(oauthId)).toBeUndefined();
		expect(f.reader().get(oauthId)).toBeDefined();
		expect(f.statuses).toEqual([]);
		expect(f.errors.join("\n")).toMatch(/session/i);
		expect(f.refresh).toHaveBeenCalledWith(oauthId);
		expectSafeFeedback(f.errors);
	});

	it("durably removes credentials before reporting logout success", async () => {
		const f = fixture();
		f.storage.set(oauthId, { type: "oauth", ...credentials });
		await f.controller.showOAuthSelector("logout", oauthId);
		expect(f.reader().get(oauthId)).toBeUndefined();
		expect(f.storage.get(oauthId)).toBeUndefined();
		expect(f.errors).toEqual([]);
		expect(f.statuses).toHaveLength(1);
	});

	for (const phase of ["refresh", "count"] as const) {
		it(`surfaces post-commit ${phase} failure after restoring the editor`, async () => {
			const f = fixture();
			f[phase].mockImplementation(async () => {
				expect(f.isEditor()).toBe(true);
				throw new Error(`Synthetic ${phase} activation failure`);
			});
			await f.login();
			expect(f.reader().get(oauthId)).toEqual({ type: "oauth", ...credentials });
			expect(f.statuses).toEqual([]);
			expect(f.errors).toHaveLength(1);
			expect(f.errors[0]).toContain(`Synthetic ${phase} activation failure`);
			expect(f.errors[0]).toMatch(/credential.*(finished|saved|persisted)/i);
			expect(f.errors[0]).not.toMatch(/failed to login/i);
			expectSafeFeedback(f.errors);
		});
	}

	for (const outcome of ["failure", "success"] as const) {
		it(`does not publish stale activation ${outcome} after a newer auth command succeeds`, async () => {
			const f = fixture();
			const activation = Promise.withResolvers<void>();
			const started = Promise.withResolvers<void>();
			f.refresh.mockImplementationOnce(() => {
				started.resolve();
				return activation.promise;
			});
			const oldLogin = f.login();
			await started.promise;
			await f.controller.showOAuthSelector("logout", oauthId);
			expect(f.statuses).toHaveLength(1);
			if (outcome === "failure") activation.reject(new Error("Stale activation failure"));
			else activation.resolve();
			await oldLogin;
			expect(f.errors).toEqual([]);
			expect(f.statuses).toHaveLength(1);
			expect(f.reader().get(oauthId)).toBeUndefined();
		});
	}
});

describe("credential durability across later public reads", () => {
	it("retries failed durable logout through the same public command", async () => {
		const f = fixture();
		f.storage.set(oauthId, { type: "oauth", ...credentials });
		f.backend.failWrites = true;
		await f.controller.showOAuthSelector("logout", oauthId);
		expect(f.reader().get(oauthId)).toBeDefined();
		expect(f.statuses).toEqual([]);
		f.backend.failWrites = false;
		await f.controller.showOAuthSelector("logout", oauthId);
		expect(f.reader().get(oauthId)).toBeUndefined();
		expect(f.statuses).toHaveLength(1);
		expect(f.statuses[0]).toContain(oauthId);
		expect(f.refresh).toHaveBeenCalledTimes(2);
	});

	for (const id of [oauthId, keyId]) {
		it(`keeps ${id} session-only status honest across unrelated provider activity`, async () => {
			const f = fixture();
			f.backend.failWrites = true;
			await f.login(id);
			const readStatus = () => {
				expect(f.storage.getAuthStatus(id).source).not.toBe("stored");
				const selector = new OAuthSelectorComponent(
					"login",
					f.storage,
					[{ id, name: id, authType: id === oauthId ? "oauth" : "api_key" }],
					() => {},
					() => {},
				);
				const text = stripVTControlCharacters(selector.render(120).join("\n"));
				expect(text).toMatch(/session/i);
				expect(text).not.toContain("✓ configured");
			};
			readStatus();
			f.backend.failWrites = false;
			f.storage.set("fixture-unrelated-provider", { type: "api_key", key: "synthetic-unrelated" });
			await expect(f.storage.getApiKey("fixture-unrelated-provider")).resolves.toBe("synthetic-unrelated");
			expect(f.reader().get(id)).toBeUndefined();
			readStatus();
			f.storage.reload();
			expect(f.storage.get(id)).toBeUndefined();
			expect(f.storage.getAuthStatus(id).source).not.toBe("stored");
		});

		it(`keeps persisted ${id} status after a fresh reload`, async () => {
			const f = fixture();
			await f.login(id);
			f.storage.reload();
			expect(f.storage.getAuthStatus(id)).toMatchObject({ configured: true, source: "stored" });
			const selector = new OAuthSelectorComponent(
				"login",
				f.storage,
				[{ id, name: id, authType: id === oauthId ? "oauth" : "api_key" }],
				() => {},
				() => {},
			);
			expect(stripVTControlCharacters(selector.render(120).join("\n"))).toContain("✓ configured");
		});
	}
});

describe("OAuth refresh lock ownership", () => {
	it("releases a provider lock after a nested auth-file transaction", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-auth-refresh-lock-"));
		try {
			const backend = new FileAuthStorageBackend(join(directory, "auth.json"));
			await backend.withProviderRefreshLock(oauthId, async () => {
				await backend.withLockAsync(async (current) => ({ result: undefined, next: current ?? "{}" }));
			});
			expect(readdirSync(directory).filter((name) => name.endsWith(".refresh.lock"))).toEqual([]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("proves durable persistence before a provider rotates its refresh token", async () => {
		const f = fixture();
		const rotated = {
			...credentials,
			access: "synthetic-rotated-access",
			refresh: "synthetic-rotated-refresh",
		};
		const refreshToken = vi.fn(async () => rotated);
		registerOAuthProvider(
			{
				id: oauthId,
				name: oauthId,
				login: async () => credentials,
				refreshToken,
				requiresRefreshPersistencePreflight: true,
				getApiKey: (value) => value.access,
			},
			source,
		);
		f.storage.set(oauthId, { type: "oauth", ...credentials, expires: 0 });
		f.backend.failWrites = true;
		await expect(f.storage.getOAuthApiKey(oauthId)).rejects.toThrow(/persist|write|storage/i);
		expect(refreshToken).not.toHaveBeenCalled();

		f.backend.failWrites = false;
		await expect(f.storage.getOAuthApiKey(oauthId)).resolves.toBe(rotated.access);
		expect(refreshToken).toHaveBeenCalledOnce();
		expect(f.reader().get(oauthId)).toEqual({ type: "oauth", ...rotated });
	});

	it("saves a completed rotation after the provider refresh lease is compromised", async () => {
		const backend = new CompromisingRefreshBackend();
		const storage = AuthStorage.fromStorage(backend);
		const expired = { ...credentials, expires: 0 };
		const rotated = { ...credentials, access: "rotated-access", refresh: "rotated-refresh" };
		const refreshToken = vi.fn(async () => rotated);
		registerOAuthProvider(
			{
				id: oauthId,
				name: oauthId,
				login: async () => credentials,
				refreshToken,
				getApiKey: (value) => value.access,
			},
			source,
		);
		storage.set(oauthId, { type: "oauth", ...expired });

		await expect(storage.getOAuthApiKey(oauthId)).resolves.toBe(rotated.access);
		expect(refreshToken).toHaveBeenCalledOnce();
		expect(AuthStorage.fromStorage(backend).get(oauthId)).toEqual({ type: "oauth", ...rotated });
	});

	it("merges an Anthropic rotation over a sibling metadata-only edit", async () => {
		const f = fixture();
		const expired = { ...credentials, expires: 0, accountId: "account-before", scopes: ["user:inference"] };
		const sibling = { ...expired, accountId: "account-sibling" };
		const rotated = {
			...expired,
			access: "rotated-access",
			refresh: "rotated-refresh",
			expires: credentials.expires,
		};
		const refreshToken = vi.fn(async () => {
			f.storage.set(oauthId, { type: "oauth", ...sibling });
			return rotated;
		});
		registerOAuthProvider(
			{
				...anthropicOAuthProvider,
				id: oauthId,
				name: oauthId,
				refreshToken,
			},
			source,
		);
		f.storage.set(oauthId, { type: "oauth", ...expired });

		await expect(f.storage.getOAuthApiKey(oauthId)).resolves.toBe(rotated.access);
		expect(f.reader().get(oauthId)).toEqual({
			type: "oauth",
			...rotated,
			accountId: sibling.accountId,
		});
	});

	it("preserves Anthropic metadata omitted by an uncontended refresh", async () => {
		const f = fixture();
		const expired = {
			...credentials,
			expires: 0,
			accountId: "account",
			scopes: ["user:inference"],
			accountRegion: "fixture-region",
		};
		const rotated = {
			access: "rotated-access",
			refresh: "rotated-refresh",
			expires: credentials.expires,
			scopes: ["user:inference", "user:profile"],
		};
		registerOAuthProvider(
			{
				...anthropicOAuthProvider,
				id: oauthId,
				name: oauthId,
				refreshToken: async () => rotated,
			},
			source,
		);
		f.storage.set(oauthId, { type: "oauth", ...expired });

		await expect(f.storage.getOAuthApiKey(oauthId)).resolves.toBe(rotated.access);
		expect(f.reader().get(oauthId)).toEqual({ type: "oauth", ...expired, ...rotated });
	});

	it("adopts a sibling Anthropic rotation with a different refresh token", async () => {
		const f = fixture();
		const expired = { ...credentials, expires: 0, accountId: "account" };
		const sibling = {
			...expired,
			access: "sibling-access",
			refresh: "sibling-refresh",
			expires: credentials.expires,
		};
		const postedResult = {
			...expired,
			access: "posted-access",
			refresh: "posted-refresh",
			expires: credentials.expires,
		};
		registerOAuthProvider(
			{
				...anthropicOAuthProvider,
				id: oauthId,
				name: oauthId,
				refreshToken: async () => {
					f.storage.set(oauthId, { type: "oauth", ...sibling });
					return postedResult;
				},
			},
			source,
		);
		f.storage.set(oauthId, { type: "oauth", ...expired });

		await expect(f.storage.getOAuthApiKey(oauthId)).resolves.toBe(sibling.access);
		expect(f.reader().get(oauthId)).toEqual({ type: "oauth", ...sibling });
	});

	it.each(["logout", "sibling"] as const)(
		"does not revive a rotated token after observing durable %s",
		async (newer) => {
			const backend = new CallbackThenThrowBackend();
			const storage = AuthStorage.fromStorage(backend);
			const expired = { ...credentials, expires: 0 };
			const sibling = {
				...expired,
				access: "sibling-access",
				refresh: "sibling-refresh",
				expires: credentials.expires,
			};
			const rotated = {
				...expired,
				access: "rotated-access",
				refresh: "rotated-refresh",
				expires: credentials.expires,
			};
			registerOAuthProvider(
				{
					...anthropicOAuthProvider,
					id: oauthId,
					name: oauthId,
					refreshToken: async () => {
						backend.replace(oauthId, newer === "sibling" ? { type: "oauth", ...sibling } : undefined);
						return rotated;
					},
				},
				source,
			);
			storage.set(oauthId, { type: "oauth", ...expired });

			await expect(storage.getOAuthApiKey(oauthId)).resolves.toBe(newer === "sibling" ? sibling.access : undefined);
			expect(AuthStorage.fromStorage(backend).get(oauthId)).toEqual(
				newer === "sibling" ? { type: "oauth", ...sibling } : undefined,
			);
		},
	);

	it("does not revive a credential after a session-only logout during refresh", async () => {
		const f = fixture();
		const expired = { ...credentials, expires: 0 };
		const rotated = { ...credentials, access: "rotated-access", refresh: "rotated-refresh" };
		registerOAuthProvider(
			{
				...anthropicOAuthProvider,
				id: oauthId,
				name: oauthId,
				refreshToken: async () => {
					f.backend.failWrites = true;
					expect(f.storage.remove(oauthId)).toBe(false);
					f.backend.failWrites = false;
					return rotated;
				},
			},
			source,
		);
		f.storage.set(oauthId, { type: "oauth", ...expired });

		await expect(f.storage.getOAuthApiKey(oauthId)).resolves.toBeUndefined();
		expect(f.storage.get(oauthId)).toBeUndefined();
		expect(f.reader().get(oauthId)).toEqual({ type: "oauth", ...expired });
	});
});

describe("public AuthStorage login supersession", () => {
	it("rejects an older login that returns while its replacement is still pending", async () => {
		const f = fixture();
		const first = Promise.withResolvers<typeof credentials>();
		const second = Promise.withResolvers<typeof credentials>();
		let calls = 0;
		registerOAuthProvider(
			{
				id: oauthId,
				name: oauthId,
				login: async () => (++calls === 1 ? first.promise : second.promise),
				refreshToken: async (value) => value,
				getApiKey: (value) => value.access,
			},
			source,
		);
		const callbacks = {
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		};
		const old = f.storage.login(oauthId, callbacks).then(
			() => undefined,
			(error: unknown) => error,
		);
		const next = f.storage.login(oauthId, callbacks);
		first.resolve(credentials);
		expect(await old).toBeInstanceOf(Error);
		expect(f.storage.get(oauthId)).toBeUndefined();
		expect(f.reader().get(oauthId)).toBeUndefined();
		const replacement = { ...credentials, access: "synthetic-newer-access", refresh: "synthetic-newer-refresh" };
		second.resolve(replacement);
		await next;
		expect(f.storage.get(oauthId)).toEqual({ type: "oauth", ...replacement });
		expect(f.reader().get(oauthId)).toEqual({ type: "oauth", ...replacement });
	});
	for (const newer of ["login", "logout", "set", "unrelated"] as const) {
		it(`holds a late provider callback after newer ${newer} according to provider identity`, async () => {
			const f = fixture();
			const pending = Promise.withResolvers<typeof credentials>();
			const replacement = { ...credentials, access: "synthetic-new-access", refresh: "synthetic-new-refresh" };
			let calls = 0;
			let oldSignal: AbortSignal | undefined;
			registerOAuthProvider(
				{
					id: oauthId,
					name: oauthId,
					login: async (callbacks) => {
						if (++calls !== 1) return replacement;
						oldSignal = callbacks.signal;
						return pending.promise;
					},
					refreshToken: async (value) => value,
					getApiKey: (value) => value.access,
				},
				source,
			);
			const callbacks = {
				onAuth: () => {},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			};
			const old = f.storage.login(oauthId, callbacks).then(
				() => undefined,
				(error: unknown) => error,
			);
			if (newer === "login") await f.storage.login(oauthId, callbacks);
			else if (newer === "logout") f.storage.logout(oauthId);
			else f.storage.set(newer === "set" ? oauthId : keyId, { type: "api_key", key });
			pending.resolve(credentials);
			const oldOutcome = await old;
			if (newer === "unrelated") expect(oldOutcome).toBeUndefined();
			else expect(oldOutcome).toBeInstanceOf(Error);
			if (newer !== "unrelated") expect(oldSignal?.aborted).toBe(true);
			else expect(oldSignal?.aborted ?? false).toBe(false);
			const expected =
				newer === "login"
					? { type: "oauth", ...replacement }
					: newer === "logout"
						? undefined
						: newer === "set"
							? { type: "api_key", key }
							: { type: "oauth", ...credentials };
			expect(f.storage.get(oauthId)).toEqual(expected);
			expect(f.reader().get(oauthId)).toEqual(expected);
			if (newer === "unrelated") expect(f.reader().get(keyId)).toEqual({ type: "api_key", key });
		});
	}
});

describe("session-only credentials across OAuth backend reconciliation", () => {
	for (const localChange of ["sign-in", "logout"] as const) {
		for (const recovery of ["expiry", "rejection"] as const) {
			it(`retains session ${localChange} during unrelated OAuth ${recovery}`, async () => {
				const f = fixture();
				const otherId = "fixture-other-oauth";
				const other = {
					...credentials,
					access: "synthetic-other-access",
					refresh: "synthetic-other-refresh",
					expires: recovery === "expiry" ? 0 : credentials.expires,
				};
				const rotated = { ...other, access: "synthetic-other-rotated", expires: credentials.expires };
				const refresh = vi.fn(async () => rotated);
				registerOAuthProvider(
					{
						id: otherId,
						name: otherId,
						login: async () => other,
						refreshToken: refresh,
						getApiKey: (value) => value.access,
					},
					source,
				);
				f.storage.set(otherId, { type: "oauth", ...other });
				if (localChange === "logout") f.storage.set(oauthId, { type: "oauth", ...credentials });
				f.backend.failWrites = true;
				if (localChange === "sign-in") await f.login();
				else await f.controller.showOAuthSelector("logout", oauthId);
				f.backend.failWrites = false;
				const recovered =
					recovery === "expiry"
						? await f.storage.getOAuthApiKey(otherId)
						: await f.storage.recoverRejectedOAuthApiKey(otherId, other.access);
				expect(recovered).toBe(rotated.access);
				expect(refresh).toHaveBeenCalledOnce();
				expect(f.storage.get(oauthId)).toEqual(
					localChange === "sign-in" ? { type: "oauth", ...credentials } : undefined,
				);
				expect(f.reader().get(oauthId)).toEqual(
					localChange === "logout" ? { type: "oauth", ...credentials } : undefined,
				);
				if (localChange === "sign-in") expect(f.storage.getAuthStatus(oauthId).source).toBe("session");
			});
		}
	}

	it("never recovers an older saved account for an unsaved replacement login", async () => {
		const f = fixture();
		const older = { ...credentials, access: "synthetic-older-access", refresh: "synthetic-older-refresh" };
		const refresh = vi.fn(async () => ({ ...older, access: "synthetic-older-rotated" }));
		registerOAuthProvider(
			{
				id: oauthId,
				name: oauthId,
				login: async () => credentials,
				refreshToken: refresh,
				needsRefresh: () => true,
				getApiKey: (value) => value.access,
			},
			source,
		);
		f.storage.set(oauthId, { type: "oauth", ...older });
		f.backend.failWrites = true;
		await f.login();
		f.backend.failWrites = false;
		await expect(f.storage.getOAuthApiKey(oauthId)).resolves.toBe(credentials.access);
		await expect(f.storage.recoverRejectedOAuthApiKey(oauthId, credentials.access)).resolves.toBeUndefined();
		expect(refresh).not.toHaveBeenCalled();
		expect(f.reader().get(oauthId)).toEqual({ type: "oauth", ...older });
		f.backend.failWrites = true;
		f.storage.set(oauthId, { type: "oauth", ...credentials, expires: 0 });
		f.backend.failWrites = false;
		await expect(f.storage.getOAuthApiKey(oauthId)).rejects.toBeInstanceOf(Error);
		expect(refresh).not.toHaveBeenCalled();
		expect(f.reader().get(oauthId)).toEqual({ type: "oauth", ...older });
	});
});

describe("explicit auth recovery after an initial storage read failure", () => {
	function disposableStore() {
		const directory = mkdtempSync(join(tmpdir(), "pi-auth-initial-read-"));
		return {
			directory,
			path: join(directory, "auth.json"),
			dispose: () => {
				chmodSync(directory, 0o700);
				rmSync(directory, { recursive: true, force: true });
			},
		};
	}
	const callbacks = {
		onAuth: () => {},
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onSelect: async () => undefined,
	};
	const pendingId = "fixture-pending-session-key";
	const pendingKey = { type: "api_key" as const, key: "synthetic-pending-session-key" };

	function expectPendingPreserved(storage: AuthStorage, path: string) {
		expect(storage.get(pendingId)).toEqual(pendingKey);
		expect(storage.getAuthStatus(pendingId).source).toBe("session");
		expect(AuthStorage.create(path).get(pendingId)).toBeUndefined();
	}

	it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
		"retries an explicit login after repairing an unreadable initial store",
		async () => {
			const file = disposableStore();
			try {
				expect(process.geteuid?.()).toBeGreaterThan(0);
				AuthStorage.create(file.path).set(keyId, { type: "api_key", key });
				const saved = readFileSync(file.path, "utf8");
				chmodSync(file.directory, 0o500);
				const storage = AuthStorage.create(file.path);
				expect(storage.drainErrors().some((error) => (error as NodeJS.ErrnoException).code === "EACCES")).toBe(
					true,
				);
				expect(storage.set(pendingId, pendingKey)).toBe(false);
				chmodSync(file.directory, 0o700);
				expect(readFileSync(file.path, "utf8")).toBe(saved);
				await expect(storage.login(oauthId, callbacks)).resolves.toBeUndefined();
				expect(storage.get(keyId)).toEqual({ type: "api_key", key });
				expect(AuthStorage.create(file.path).get(keyId)).toEqual({ type: "api_key", key });
				expect(AuthStorage.create(file.path).get(oauthId)).toEqual({ type: "oauth", ...credentials });
				expectPendingPreserved(storage, file.path);
			} finally {
				file.dispose();
			}
		},
	);

	for (const invalid of ["{malformed", "null", "[]", '"wrong-root"']) {
		it(`preserves malformed store bytes ${invalid} until repair then retries explicitly`, async () => {
			const file = disposableStore();
			try {
				AuthStorage.create(file.path);
				writeFileSync(file.path, invalid);
				const storage = AuthStorage.create(file.path);
				expect(storage.set(pendingId, pendingKey)).toBe(false);
				expect(readFileSync(file.path, "utf8")).toBe(invalid);
				writeFileSync(file.path, JSON.stringify({ [keyId]: { type: "api_key", key } }));
				await expect(storage.login(oauthId, callbacks)).resolves.toBeUndefined();
				expect(storage.get(keyId)).toEqual({ type: "api_key", key });
				const fresh = AuthStorage.create(file.path);
				expect(fresh.get(keyId)).toEqual({ type: "api_key", key });
				expect(fresh.get(oauthId)).toEqual({ type: "oauth", ...credentials });
				expectPendingPreserved(storage, file.path);
				expect(storage.set(pendingId, pendingKey)).toBe(true);
				expect(AuthStorage.create(file.path).get(pendingId)).toEqual(pendingKey);
			} finally {
				file.dispose();
			}
		});
	}
});
