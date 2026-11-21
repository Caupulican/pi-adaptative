import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Api, Model } from "@caupulican/pi-ai";
import { providerResponseAccountFor } from "@caupulican/pi-ai/stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { clearApiKeyCache, ModelRegistry } from "../src/core/model-registry.ts";
import { AccountModelCatalog, accountModelCatalogOf } from "../src/core/model-router/account-models.ts";
import type { RequestAuth } from "../src/core/request-auth.ts";

const router: Model<Api> = {
	id: "readiness-router",
	name: "Offline readiness fixture",
	provider: "openrouter",
	api: "openai-completions",
	baseUrl: "https://readiness.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const codex: Model<Api> = { ...router, id: "readiness-codex", provider: "openai-codex", api: "openai-codex-responses" };
const auth = (account: string): RequestAuth => ({ apiKey: `synthetic-${account}` });
let forbiddenFetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
beforeEach(() => {
	forbiddenFetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("No real network in readiness tests"));
	vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(() => {
	try {
		expect(forbiddenFetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});

function rotating() {
	const gates = [Promise.withResolvers<RequestAuth | undefined>(), Promise.withResolvers<RequestAuth | undefined>()];
	let account = 0;
	const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => {
		const key = new Headers(options?.headers).get("Authorization");
		return new Response("{}", { status: key === "Bearer synthetic-B" ? 403 : 200 });
	});
	const catalog = new AccountModelCatalog({
		getModels: () => [router],
		hasConfiguredAuth: () => true,
		getRequestAuth: () => gates[account]!.promise,
		fetch,
	});
	return { catalog, gates, fetch, useB: () => (account = 1) };
}

function twoProviders() {
	let heldCodex: Promise<RequestAuth | undefined> | undefined;
	let routerConfigured = true;
	let routerAuth: RequestAuth | undefined = auth("A");
	const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "offline-readiness" } };
	const codexAuth = { apiKey: `synthetic.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic` };
	const getRequestAuth = vi.fn(async (model: Model<Api>) =>
		model.provider === router.provider ? routerAuth : heldCodex ? await heldCodex : codexAuth,
	);
	const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, options) => {
		expect(new URL(String(url)).hostname).toBe("readiness.invalid");
		if (String(url).endsWith("/key")) {
			return new Response("{}", {
				status: new Headers(options?.headers).get("Authorization") === "Bearer synthetic-B" ? 403 : 200,
			});
		}
		return Response.json({ models: [{ slug: codex.id, visibility: "list", supported_in_api: true, priority: 1 }] });
	});
	const catalog = new AccountModelCatalog({
		getModels: () => [router, { ...router, id: "same-provider-second-model" }, codex],
		hasConfiguredAuth: (model) => model.provider !== router.provider || routerConfigured,
		getRequestAuth,
		fetch,
	});
	return {
		catalog,
		getRequestAuth,
		fetch,
		codexAuth,
		holdCodex: (promise: Promise<RequestAuth | undefined>) => (heldCodex = promise),
		setRouter: (configured: boolean, value: RequestAuth | undefined) => {
			routerConfigured = configured;
			routerAuth = value;
		},
	};
}

describe("account catalog readiness follows current checks", () => {
	it.each([false, true])("keeps waiting for B when obsolete A finishes first (signal=%s)", async (withSignal) => {
		const f = rotating();
		const cancel = new AbortController();
		const old = f.catalog.refresh();
		let settled = false;
		const ready = f.catalog.ready(withSignal ? cancel.signal : undefined).then(() => (settled = true));
		f.useB();
		const current = f.catalog.refreshAfterAuthChange(router.provider);
		try {
			f.gates[0]!.resolve(auth("A"));
			await old;
			await nextTurn();
			expect(settled).toBe(false);
			expect(f.fetch).not.toHaveBeenCalled();
			f.gates[1]!.resolve(auth("B"));
			await current;
			await ready;
			expect(f.catalog.availability(router)).toBe("unavailable");
		} finally {
			cancel.abort();
			f.gates[0]!.resolve(auth("A"));
			f.gates[1]!.resolve(auth("B"));
			await Promise.all([old, current]);
		}
	});

	it.each([false, true])("becomes ready when B finishes even if A never finishes (signal=%s)", async (withSignal) => {
		const f = rotating();
		const cancel = new AbortController();
		void f.catalog.refresh();
		let settled = false;
		void f.catalog.ready(withSignal ? cancel.signal : undefined).then(() => (settled = true));
		f.useB();
		const current = f.catalog.refreshAfterAuthChange(router.provider);
		try {
			f.gates[1]!.resolve(auth("B"));
			await current;
			await nextTurn();
			expect(settled).toBe(true);
			expect(f.catalog.availability(router)).toBe("unavailable");
			expect(f.fetch).toHaveBeenCalledOnce();
		} finally {
			cancel.abort();
		}
	});

	it("cancels an existing wait without cancelling shared checks or letting late A overwrite B", async () => {
		const f = rotating();
		const cancel = new AbortController();
		const old = f.catalog.refresh();
		const ready = f.catalog.ready(cancel.signal);
		f.useB();
		const current = f.catalog.refreshAfterAuthChange(router.provider);
		cancel.abort();
		await ready;
		expect(f.fetch).not.toHaveBeenCalled();
		f.gates[1]!.resolve(auth("B"));
		await current;
		f.gates[0]!.resolve(auth("A"));
		await old;
		expect(f.catalog.availability(router)).toBe("unavailable");
		expect(f.fetch).toHaveBeenCalledOnce();
	});

	it("returns immediately for an already aborted caller while the shared check can finish", async () => {
		const f = rotating();
		const current = f.catalog.refresh();
		const cancel = new AbortController();
		cancel.abort();
		await f.catalog.ready(cancel.signal);
		expect(f.fetch).not.toHaveBeenCalled();
		f.gates[0]!.resolve(auth("A"));
		await current;
		expect(f.catalog.availability(router)).toBe("available");
	});

	it("is immediately ready before any checks start", async () => {
		const f = rotating();
		await f.catalog.ready();
		expect(f.fetch).not.toHaveBeenCalled();
	});
});

describe("account refresh scope and recovery", () => {
	it("refreshes only the changed provider without waiting on an unrelated credential lookup", async () => {
		const f = twoProviders();
		await f.catalog.refresh();
		expect(f.catalog.hasListing(codex.provider)).toBe(true);
		f.getRequestAuth.mockClear();
		f.fetch.mockClear();
		const unrelated = Promise.withResolvers<RequestAuth | undefined>();
		f.holdCodex(unrelated.promise);
		f.setRouter(true, auth("B"));
		let settled = false;
		const changed = f.catalog.refreshAfterAuthChange(router.provider).then(() => (settled = true));
		try {
			await nextTurn();
			expect(f.getRequestAuth.mock.calls.map(([model]) => model.provider)).toEqual([router.provider]);
			expect(settled).toBe(true);
			await changed;
			await f.catalog.ready();
			expect(f.catalog.availability(router)).toBe("unavailable");
			expect(f.catalog.hasListing(codex.provider)).toBe(true);
		} finally {
			unrelated.resolve(f.codexAuth);
			await changed;
		}
	});

	it("lets a provider-scoped tier waiter proceed while an unrelated current check remains pending", async () => {
		const f = twoProviders();
		await f.catalog.refresh();
		const pending = Promise.withResolvers<RequestAuth | undefined>();
		f.holdCodex(pending.promise);
		const changed = f.catalog.refreshAfterAuthChange(codex.provider);
		let globalSettled = false;
		const globalReady = f.catalog.ready().then(() => {
			globalSettled = true;
		});
		try {
			await f.catalog.ready(undefined, router.provider);
			await nextTurn();
			expect(globalSettled).toBe(false);
			expect(f.catalog.availability(router)).toBe("available");
		} finally {
			pending.resolve(f.codexAuth);
			await changed;
			await globalReady;
		}
	});

	it("still checks each configured provider once in an explicit full refresh", async () => {
		const f = twoProviders();
		await f.catalog.refresh();
		expect(f.getRequestAuth.mock.calls.map(([model]) => model.provider).sort()).toEqual(
			[codex.provider, router.provider].sort(),
		);
		expect(f.fetch).toHaveBeenCalledTimes(2);
		expect(f.catalog.availability(router)).toBe("available");
		expect(f.catalog.hasListing(codex.provider)).toBe(true);
		f.getRequestAuth.mockClear();
		await f.catalog.refreshAfterAuthChange("unsupported-provider");
		expect(f.getRequestAuth).not.toHaveBeenCalled();
	});

	it("shares one rejected key check across matching routes without resolving every model or a caller's alternate endpoint", async () => {
		const registry = ModelRegistry.inMemory(
			AuthStorage.inMemory({ openrouter: { type: "api_key", key: "synthetic-shared-key" } }),
		);
		const siblings = Array.from({ length: 1000 }, (_, index) => ({
			...router,
			id: `scoped-${index}`,
			name: `Scoped ${index}`,
		}));
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 403 }));
		vi.stubGlobal("fetch", fetch);
		try {
			registry.registerProvider("openrouter", {
				apiKey: "synthetic-shared-key",
				baseUrl: router.baseUrl,
				api: router.api,
				models: [
					...siblings,
					{ ...router, id: "other-account", headers: { Authorization: "Bearer synthetic-other-key" } },
				],
			});
			const resolve = vi.spyOn(registry, "getApiKeyAndHeaders");
			const catalog = accountModelCatalogOf(registry);
			await catalog.refreshAfterAuthChange("openrouter");
			const matching = registry
				.getAll()
				.filter((model) => model.provider === "openrouter" && model.id.startsWith("scoped-"));
			expect(matching).toHaveLength(siblings.length);
			for (const model of matching) expect(catalog.unavailableCause(model)).toBe("model_account_rejected");
			expect(catalog.availability(registry.find("openrouter", "other-account")!)).toBe("unknown");
			const selected = registry.find("openrouter", siblings[0]!.id)!;
			expect(catalog.availability({ ...selected, baseUrl: `${selected.baseUrl}/another-api` })).toBe("unknown");
			expect(resolve).toHaveBeenCalledOnce();
			expect(fetch).toHaveBeenCalledOnce();
		} finally {
			registry.unregisterProvider("openrouter");
		}
	});

	it.each([false, true])(
		"clears old key rejection without fetching when credentials disappear (configured=%s)",
		async (configured) => {
			const f = twoProviders();
			f.setRouter(true, auth("B"));
			await f.catalog.refresh();
			expect(f.catalog.availability(router)).toBe("unavailable");
			f.setRouter(configured, undefined);
			f.getRequestAuth.mockClear();
			f.fetch.mockClear();
			await f.catalog.refreshAfterAuthChange(router.provider);
			await f.catalog.ready();
			expect(f.catalog.availability(router)).toBe("unknown");
			expect(f.catalog.hasListing(codex.provider)).toBe(true);
			expect(f.fetch).not.toHaveBeenCalled();
			expect(f.getRequestAuth).toHaveBeenCalledTimes(configured ? 1 : 0);
		},
	);

	it.each(["getModels", "hasConfiguredAuth"] as const)(
		"invalidates obsolete checks before a throwing %s discovery and recovers on retry",
		async (failure) => {
			let broken = false;
			const pending = Promise.withResolvers<RequestAuth | undefined>();
			const getRequestAuth = vi
				.fn()
				.mockImplementationOnce(() => pending.promise)
				.mockResolvedValue(auth("A"));
			const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}"));
			const catalog = new AccountModelCatalog({
				getModels: () => {
					if (broken && failure === "getModels") throw new Error("Synthetic model discovery failure");
					return [router];
				},
				hasConfiguredAuth: () => {
					if (broken && failure === "hasConfiguredAuth") throw new Error("Synthetic auth discovery failure");
					return true;
				},
				getRequestAuth,
				fetch,
			});
			const old = catalog.refresh();
			broken = true;
			await catalog.refreshAfterAuthChange(router.provider);
			await catalog.ready();
			expect(catalog.availability(router)).toBe("unknown");
			pending.resolve(auth("A"));
			await old;
			await nextTurn();
			expect(fetch).not.toHaveBeenCalled();
			expect(catalog.availability(router)).toBe("unknown");
			broken = false;
			await catalog.refreshAfterAuthChange(router.provider);
			await catalog.ready();
			expect(catalog.availability(router)).toBe("available");
			expect(fetch).toHaveBeenCalledOnce();
		},
	);

	it("bounds a credential lookup and refuses to send its late credentials after timeout", async () => {
		const deadline = new AbortController();
		vi.spyOn(AbortSignal, "timeout")
			.mockReturnValueOnce(deadline.signal)
			.mockReturnValue(new AbortController().signal);
		const pending = Promise.withResolvers<RequestAuth | undefined>();
		const getRequestAuth = vi
			.fn()
			.mockImplementationOnce(() => pending.promise)
			.mockResolvedValue(auth("A"));
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}"));
		const catalog = new AccountModelCatalog({
			getModels: () => [router],
			hasConfiguredAuth: () => true,
			getRequestAuth,
			fetch,
		});
		const current = catalog.refresh();
		deadline.abort(new DOMException("Synthetic credential deadline", "TimeoutError"));
		await current;
		await catalog.ready();
		expect(catalog.availability(router)).toBe("unknown");
		pending.resolve(auth("A"));
		await nextTurn();
		expect(fetch).not.toHaveBeenCalled();
		await catalog.refreshAfterAuthChange(router.provider);
		await catalog.ready();
		expect(catalog.availability(router)).toBe("available");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("settles an aborted transport as unknown and permits a later successful refresh", async () => {
		const deadline = new AbortController();
		vi.spyOn(AbortSignal, "timeout")
			.mockReturnValueOnce(deadline.signal)
			.mockReturnValue(new AbortController().signal);
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementationOnce((_url, options) => {
				const signal = options?.signal;
				expect(signal).toBeInstanceOf(AbortSignal);
				expect(signal!.aborted).toBe(false);
				return new Promise<Response>((_resolve, reject) => {
					signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
				});
			})
			.mockResolvedValue(new Response("{}"));
		const catalog = new AccountModelCatalog({
			getModels: () => [router],
			hasConfiguredAuth: () => true,
			getRequestAuth: async () => auth("A"),
			fetch,
		});
		const current = catalog.refresh();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		const reason = new DOMException("Synthetic transport deadline", "TimeoutError");
		deadline.abort(reason);
		const sentSignal = fetch.mock.calls[0]![1]!.signal!;
		expect(sentSignal.aborted).toBe(true);
		expect(sentSignal.reason).toBe(reason);
		await current;
		await catalog.ready();
		expect(catalog.availability(router)).toBe("unknown");
		await catalog.refreshAfterAuthChange(router.provider);
		await catalog.ready();
		expect(catalog.availability(router)).toBe("available");
	});
});

describe("account checks keep the resolved request model and authority", () => {
	it.each(["stored key", "configured model header", "provider environment key", "provider environment header"])(
		"refuses the captured request after its %s changes",
		async (source) => {
			const provider = source === "provider environment header" ? "anthropic" : "openrouter";
			const envName =
				source === "provider environment header"
					? "ANTHROPIC_AUTH_TOKEN"
					: source === "provider environment key"
						? "OPENROUTER_API_KEY"
						: "PI_TEST_ACCOUNT_AUTH_INPUT";
			vi.stubEnv(envName, "fixture-A");
			const storage = AuthStorage.inMemory();
			if (source === "stored key") storage.set(provider, { type: "api_key", key: `$${envName}` });
			if (source.endsWith("header")) storage.set(provider, { type: "api_key", key: "fixture-static" });
			const registry = ModelRegistry.inMemory(storage);
			try {
				registry.registerProvider(provider, {
					api: router.api,
					baseUrl: router.baseUrl,
					apiKey: "fixture-static",
					models: [
						{
							...router,
							headers:
								source === "configured model header" ? { Authorization: `Bearer $${envName}` } : undefined,
						},
					],
				});
				const model = registry.find(provider, router.id)!;
				const auth = await registry.getApiKeyAndHeaders(model);
				if (!auth.ok) throw new Error(auth.error);
				const usesHeader = source.endsWith("header");
				expect(usesHeader ? new Headers(auth.headers).get("authorization") : auth.apiKey).toBe(
					usesHeader ? "Bearer fixture-A" : "fixture-A",
				);
				expect(auth.requestGuard?.(model, undefined)).toBeUndefined();
				vi.stubEnv(envName, "fixture-B");
				expect(() => auth.requestGuard?.(model, undefined)).toThrow("changed before sending");
				const next = await registry.getApiKeyAndHeaders(model);
				if (!next.ok) throw new Error(next.error);
				expect(usesHeader ? new Headers(next.headers).get("authorization") : next.apiKey).toBe(
					usesHeader ? "Bearer fixture-B" : "fixture-B",
				);
				expect(next.requestGuard?.(model, undefined)).toBeUndefined();
			} finally {
				registry.unregisterProvider(provider);
				vi.unstubAllEnvs();
			}
		},
	);

	it.each(["stored key", "configured key", "configured model header"])(
		"keeps the command-backed %s out of cached account identity without rerunning it on a read",
		async (source) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-account-command-"));
			const counter = join(directory, "calls");
			vi.stubEnv("PI_TEST_ACCOUNT_COMMAND_COUNTER", counter);
			const command = `!node -e "require('node:fs').appendFileSync(process.env.PI_TEST_ACCOUNT_COMMAND_COUNTER,'x');process.stdout.write('fixture-command')"`;
			const provider = "fixture-command-provider";
			const storage = AuthStorage.inMemory();
			if (source === "stored key") storage.set(provider, { type: "api_key", key: command });
			const registry = ModelRegistry.inMemory(storage);
			try {
				registry.registerProvider(provider, {
					api: router.api,
					baseUrl: router.baseUrl,
					apiKey: source === "configured key" ? command : "fixture-static",
					models: [{ ...router, headers: source.endsWith("header") ? { "X-Test-Account": command } : undefined }],
				});
				const model = registry.find(provider, router.id)!;
				const auth = await registry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.providerAccountKey) throw new Error("Expected configured request account");
				expect(auth.canCacheAccountIdentity).toBe(false);
				const executions = () => readFileSync(counter, "utf8").length;
				const atAdmission = executions();
				expect(atAdmission).toBeGreaterThan(0);
				expect(auth.requestGuard?.(model, undefined)).toBeUndefined();
				expect(executions()).toBe(atAdmission);
				const catalog = accountModelCatalogOf(registry);
				const receipt = providerResponseAccountFor(auth.model, auth);
				if (!receipt) throw new Error("Expected a scoped provider response for the resolved command value");
				expect(await catalog.markRefused(receipt, "model_not_supported")).toBe(false);
				const afterLookup = executions();
				expect(catalog.isCurrentRefusal(receipt)).toBe(false);
				expect(catalog.unavailableCause(model)).toBeUndefined();
				expect(catalog.availability(model)).toBe("unknown");
				expect(executions()).toBe(afterLookup);
			} finally {
				registry.unregisterProvider(provider);
				clearApiKeyCache();
				vi.unstubAllEnvs();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("uses the registry's non-OAuth endpoint and guard for an admitted runtime override", async () => {
		const oauthEndpoint = "http://127.0.0.1:45102/synthetic-oauth";
		const apiEndpoint = "http://127.0.0.1:45101/synthetic-api";
		const storage = AuthStorage.inMemory({
			openrouter: {
				type: "oauth",
				access: "synthetic-oauth-key",
				refresh: "synthetic-unused-refresh",
				expires: Date.now() + 60_000,
			},
		});
		const registry = ModelRegistry.inMemory(storage);
		registry.registerProvider("openrouter", {
			api: router.api,
			baseUrl: apiEndpoint,
			models: [
				{
					id: router.id,
					name: router.name,
					reasoning: false,
					input: ["text"],
					cost: router.cost,
					contextWindow: router.contextWindow,
					maxTokens: router.maxTokens,
				},
			],
			oauth: {
				name: "Synthetic account endpoint",
				login: async () => {
					throw new Error("Offline fixture excludes login");
				},
				refreshToken: async () => {
					throw new Error("Offline fixture excludes refresh");
				},
				getApiKey: (credential) => credential.access,
				modifyModels: (models) =>
					models.map((model) =>
						model.provider === router.provider ? { ...model, baseUrl: oauthEndpoint } : model,
					),
			},
		});
		try {
			const selected = registry.find(router.provider, router.id)!;
			expect(selected.baseUrl).toBe(oauthEndpoint);
			storage.setRuntimeApiKey(router.provider, "synthetic-runtime-key");
			const resolve = registry.getApiKeyAndHeaders.bind(registry);
			const guards: Array<ReturnType<typeof vi.fn>> = [];
			vi.spyOn(registry, "getApiKeyAndHeaders").mockImplementation(async (model) => {
				const resolved = await resolve(model);
				if (!resolved.ok) return resolved;
				expect(resolved.model.baseUrl).toBe(apiEndpoint);
				const guard = vi.fn(resolved.requestGuard!);
				guards.push(guard);
				return { ...resolved, requestGuard: guard };
			});
			const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({}));
			vi.stubGlobal("fetch", fetch);
			const catalog = accountModelCatalogOf(registry);
			await catalog.refresh();
			await catalog.ready();
			expect(fetch).toHaveBeenCalledOnce();
			expect(fetch.mock.calls[0]?.[0]).toBe(`${apiEndpoint}/key`);
			expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
				"Bearer synthetic-runtime-key",
			);
			expect(guards).toHaveLength(1);
			expect(guards[0]).toHaveBeenCalledWith(
				expect.objectContaining({ baseUrl: apiEndpoint }),
				expect.any(AbortSignal),
			);
			expect(catalog.availability(selected)).toBe("available");
		} finally {
			registry.unregisterProvider(router.provider);
		}
	});

	it.each(["provider", "id"] as const)("rejects an auth model with a mismatched %s before fetching", async (field) => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({}));
		const catalog = new AccountModelCatalog({
			getModels: () => [router],
			hasConfiguredAuth: () => true,
			getRequestAuth: async () => ({
				model: { ...router, [field]: field === "provider" ? "synthetic-other-provider" : "synthetic-other-id" },
				apiKey: "synthetic-key",
			}),
			fetch,
		});
		await catalog.refresh();
		await catalog.ready();
		expect(fetch).not.toHaveBeenCalled();
		expect(catalog.availability(router)).toBe("unknown");
		expect(catalog.describe().join("\n")).toContain("different model");
	});

	it.each([
		[router, "dispatch"],
		[router, "publication"],
		[codex, "dispatch"],
		[codex, "publication"],
	] as const)(
		"refuses stale %s account authority before %s and recovers with a current snapshot",
		async (model, boundary) => {
			let current = true;
			let invalidate = true;
			const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-readiness" } };
			const token =
				model.provider === codex.provider
					? `synthetic.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`
					: "synthetic-router-key";
			const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
				if (invalidate && boundary === "publication") current = false;
				return model.provider === codex.provider
					? Response.json({
							models: [{ slug: model.id, visibility: "list", supported_in_api: true, priority: 0 }],
						})
					: Response.json({});
			});
			const guard = vi.fn(() => {
				if (!current) throw new Error("Synthetic account request is stale");
				return undefined;
			});
			const catalog = new AccountModelCatalog({
				getModels: () => [model],
				hasConfiguredAuth: () => true,
				getRequestAuth: async () => {
					if (invalidate && boundary === "dispatch") current = false;
					return { model, apiKey: token, requestGuard: guard };
				},
				fetch,
			});
			await catalog.refresh();
			await catalog.ready();
			expect(fetch).toHaveBeenCalledTimes(boundary === "dispatch" ? 0 : 1);
			expect(guard).toHaveBeenCalled();
			expect(catalog.availability(model)).toBe("unknown");
			expect(catalog.hasListing(model.provider)).toBe(false);
			expect(catalog.describe().join("\n")).toContain("Synthetic account request is stale");

			current = true;
			invalidate = false;
			fetch.mockClear();
			await catalog.refreshAfterAuthChange(model.provider);
			expect(fetch).toHaveBeenCalledOnce();
			expect(catalog.availability(model)).toBe("available");
			expect(catalog.hasListing(model.provider)).toBe(model.provider === codex.provider);
		},
	);
});
