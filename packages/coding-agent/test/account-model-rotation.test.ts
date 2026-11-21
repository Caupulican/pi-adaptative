import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Model, providerResponseAccountFor } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { AccountModelCatalog, describeAccessProblem } from "../src/core/model-router/account-models.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const model: Model<Api> = {
	id: "fixture-model",
	name: "Account rotation fixture",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://account-rotation.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function codexAccessToken(account: string): string {
	const payload = { "https://api.openai.com/auth": { chatgpt_account_id: account } };
	return `fixture.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
}

function receipt(dispatched: Model<Api>, account: string) {
	const apiKey =
		dispatched.api === "openai-codex-responses" ? codexAccessToken(account) : `synthetic-token-${account}`;
	const response = providerResponseAccountFor(dispatched, {
		apiKey,
		providerAccountKey: `${dispatched.provider}#${account}`,
	});
	if (!response) throw new Error("Expected a dispatch receipt for the selected fixture route");
	return response;
}

function fixture() {
	let identity = { account: "account-a", token: "synthetic-token-a" };
	const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response("{}"));
	const catalog = new AccountModelCatalog({
		getModels: () => [model],
		hasConfiguredAuth: () => true,
		getRequestAuth: async () => ({
			apiKey: identity.token,
			providerAccountKey: `openrouter#${identity.account}`,
		}),
		fetch,
	});
	return {
		catalog,
		fetch,
		use(account: string, token: string) {
			identity = { account, token };
		},
	};
}

describe("account-derived model availability after authentication changes", () => {
	it.each([false, true])(
		"uses the selected Codex endpoint's listing before sending (separate endpoint: %s)",
		async (separate) => {
			const root = mkdtempSync(join(tmpdir(), "pi-codex-listing-endpoint-"));
			const provider = "openai-codex";
			const api = "openai-codex-responses";
			const accountId = "offline-account";
			const access = codexAccessToken(accountId);
			const authStorage = AuthStorage.inMemory({
				[provider]: {
					type: "oauth",
					accountId,
					access,
					refresh: "synthetic-refresh",
					expires: Date.now() + 86_400_000,
				},
			});
			const registry = ModelRegistry.create(authStorage, join(root, "models.json"));
			const base = "https://catalog-scope.invalid";
			const selectedPath = separate ? "/two" : "/one";
			const tier = { id: "fast", name: "Fast", description: "Fixture tier" };
			const requests: { path: string; model: string; account: string | null; matchesKey: boolean }[] = [];
			const warnings: string[] = [];
			vi.stubEnv("OPENROUTER_API_KEY", "");
			vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				const { origin, pathname } = new URL(request.url);
				if (origin !== base) throw new Error("Unexpected request outside the offline fixture");
				if (pathname.endsWith("/api/codex/models")) {
					const slug = pathname.startsWith("/one/") ? "fallback" : "selected";
					return Response.json({
						models: [{ slug, visibility: "list", supported_in_api: true, priority: 1, service_tiers: [tier] }],
					});
				}
				requests.push({
					path: pathname,
					model: (await request.json()).model,
					account: request.headers.get("chatgpt-account-id"),
					matchesKey: request.headers.get("authorization") === `Bearer ${access}`,
				});
				return Response.json({ error: { message: "Offline request observed" } }, { status: 400 });
			});
			const settingsManager = SettingsManager.inMemory({
				transport: "sse",
				systemOne: { enabled: false },
				modelCapability: { mode: "off" },
				modelRouter: { enabled: false },
				retry: { enabled: false },
				compaction: { enabled: false },
				proactivity: { enabled: false },
			});
			const loader = new DefaultResourceLoader({
				cwd: root,
				agentDir: root,
				settingsManager,
				installMissingPackages: false,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			let opened: Awaited<ReturnType<typeof createAgentSession>> | undefined;
			try {
				registry.registerProvider(provider, {
					api,
					apiKey: "fixture-unused",
					baseUrl: `${base}/one`,
					models: ["fallback", "selected"].map((id) => ({
						id,
						name: id,
						reasoning: false,
						input: ["text"],
						contextWindow: 131072,
						maxTokens: 1024,
						cost: model.cost,
						...(id === "selected" ? { baseUrl: base + selectedPath } : {}),
					})),
				});
				await loader.reload();
				const selected: Model<Api> = { ...registry.find(provider, "selected")!, serviceTiers: [tier] };
				opened = await createAgentSession({
					cwd: root,
					agentDir: root,
					settingsManager,
					resourceLoader: loader,
					authStorage,
					modelRegistry: registry,
					model: selected,
					isExplicitModel: true,
					systemOneEnabled: false,
					noTools: "all",
					tools: [],
				});
				const { session } = opened;
				session.subscribe((event) => {
					if (event.type === "warning") warnings.push(event.message);
				});
				await session.prompt("Reply briefly.");
				await session.waitForForegroundIdle();
				const expectedModel = separate ? "selected" : "fallback";
				expect(requests).toEqual([
					{ path: `${selectedPath}/codex/responses`, model: expectedModel, account: accountId, matchesKey: true },
				]);
				expect(session.model?.id).toBe(expectedModel);
				expect(session.getFastModeCatalog(selected).tiers).toEqual(separate ? [tier] : []);
				expect(warnings.some((message) => message.includes("is not available on this account"))).toBe(!separate);
			} finally {
				await opened?.session.disposeAndWait();
				registry.unregisterProvider(provider);
				vi.unstubAllGlobals();
				vi.unstubAllEnvs();
				rmSync(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it("admits a model on account B after account A refused it", async () => {
		const { catalog, use } = fixture();
		await catalog.refresh();
		await catalog.markRefused(receipt(model, "account-a"), "model unavailable for account A");
		expect(catalog.availability(model)).toBe("unavailable");
		use("account-b", "synthetic-token-b");
		await catalog.refreshAfterAuthChange(model.provider);
		expect(catalog.availability(model)).toBe("available");
	});

	it("restores routing when the new account explicitly lists a previously refused model", async () => {
		const listedModel: Model<Api> = { ...model, provider: "openai-codex", api: "openai-codex-responses" };
		let account = "fixture-a";
		const queried: string[] = [];
		const catalog = new AccountModelCatalog({
			getModels: () => [listedModel],
			hasConfiguredAuth: () => true,
			getRequestAuth: async () => ({
				apiKey: codexAccessToken(account),
				providerAccountKey: `openai-codex#${account}`,
			}),
			fetch: async (_url, request) => {
				queried.push(new Headers(request?.headers).get("chatgpt-account-id") ?? "");
				return Response.json({
					models: [{ slug: listedModel.id, visibility: "list", supported_in_api: true, priority: 1 }],
				});
			},
		});
		await catalog.refresh();
		expect(catalog.accountDefault(listedModel.provider)).toEqual(listedModel);
		await catalog.markRefused(receipt(listedModel, "fixture-a"), "unavailable on fixture-a");
		expect(catalog.accountDefault(listedModel.provider)).toBeUndefined();
		account = "fixture-b";
		await catalog.refreshAfterAuthChange(listedModel.provider);
		expect(queried).toEqual(["fixture-a", "fixture-b"]);
		expect(catalog.hasListing(listedModel.provider)).toBe(true);
		expect(catalog.accountDefault(listedModel.provider)).toEqual(listedModel);
	});

	it("preserves a refusal through same-account token renewal", async () => {
		const { catalog, use } = fixture();
		await catalog.refresh();
		await catalog.markRefused(receipt(model, "account-a"), "model unavailable for account A");
		use("account-a", "synthetic-renewed-token-a");
		await catalog.refreshAfterAuthChange(model.provider);
		expect(catalog.unavailableCause(model)).toBe("model_account_refused");
	});

	it("preserves a refusal through an ordinary listing refresh", async () => {
		const { catalog } = fixture();
		await catalog.refresh();
		await catalog.markRefused(receipt(model, "account-a"), "model unavailable for account A");
		await catalog.refresh();
		expect(catalog.unavailableCause(model)).toBe("model_account_refused");
	});

	it("keeps a late refusal with the dispatched account when the owner switches away and back", async () => {
		const { catalog, use } = fixture();
		await catalog.refresh();
		const dispatched = receipt(model, "account-a");
		use("account-b", "synthetic-token-b");
		await catalog.refreshAfterAuthChange(model.provider);
		expect(await catalog.markRefused(dispatched, "A refuses this model")).toBe(false);
		expect(catalog.availability(model)).toBe("available");
		use("account-a", "renewed-token-a");
		await catalog.refreshAfterAuthChange(model.provider);
		expect(catalog.unavailableCause(model)).toBe("model_account_refused");
	});

	it("rejects a late old-account listing after the new account check settles", async () => {
		const { catalog, fetch, use } = fixture();
		let release!: (response: Response) => void;
		fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
		const old = catalog.refresh();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		use("account-b", "synthetic-token-b");
		await catalog.refreshAfterAuthChange(model.provider);
		release(new Response("{}", { status: 403 }));
		await old;
		expect(catalog.availability(model)).toBe("available");
	});

	it("rechecks the refused model's own authorization and the session's active request hooks", async () => {
		const target = { ...model, id: "second-model" };
		const fallbackKey = "synthetic-token-a";
		let targetKey = fallbackKey;
		let hookActive = false;
		const catalog = new AccountModelCatalog({
			getModels: () => [model, target],
			hasConfiguredAuth: () => true,
			canReuseAccountIdentity: () => !hookActive,
			getRequestAuth: async (selected) => ({
				apiKey: fallbackKey,
				providerAccountKey: "openrouter#account-a",
				headers: { aUtHoRiZaTiOn: `Bearer ${selected.id === target.id ? targetKey : fallbackKey}` },
			}),
			fetch: async () => Response.json({}),
		});
		await catalog.refresh();
		const refused = receipt(target, "account-a");
		const accessProblem = () => describeAccessProblem(target, { hasConfiguredAuth: () => true }, catalog);
		expect(await catalog.markRefused(refused, "unavailable to A")).toBe(true);
		hookActive = true;
		expect(catalog.availability(target)).toBe("unknown");
		expect(accessProblem()).toBeUndefined();
		hookActive = false;
		targetKey = "synthetic-token-b";
		await catalog.refreshAfterAuthChange(model.provider);
		expect(catalog.isCurrentRefusal(refused)).toBe(false);
		expect(catalog.availability(target)).toBe("unknown");
		expect(accessProblem()).toBeUndefined();
		targetKey = fallbackKey;
		await catalog.refreshAfterAuthChange(model.provider);
		expect(catalog.unavailableCause(target)).toBe("model_account_refused");
		expect(catalog.availability(model)).toBe("available");
	});
});
