import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { AccountModelCatalog } from "../src/core/model-router/account-models.ts";

/**
 * An account check waits on the account's credential, which can stall (a token refresh). The
 * submission that waits for the checks settles when the owner interrupts it, instead of hanging.
 */
describe("account model catalog readiness", () => {
	it("settles on the submission's abort while a credential lookup never returns", async () => {
		const model = { provider: "openrouter", id: "deepseek/x", baseUrl: "https://openrouter.ai/api/v1" } as Model<Api>;
		const catalog = new AccountModelCatalog({
			getModels: () => [model],
			hasConfiguredAuth: () => true,
			getRequestAuth: () => new Promise<undefined>(() => undefined),
		});
		void catalog.refresh();
		const controller = new AbortController();
		let settled = false;
		const ready = catalog.ready(controller.signal).then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(settled).toBe(false);
		controller.abort("user interrupt");
		await ready;
		expect(settled).toBe(true);
		expect(catalog.availability(model)).toBe("unknown");
	});

	it("keeps the latest refresh when an older credential check settles last", async () => {
		const model = { provider: "openrouter", id: "deepseek/x", baseUrl: "https://openrouter.ai/api/v1" } as Model<Api>;
		let resolveOld: ((auth: { apiKey: string }) => void) | undefined;
		let resolveNew: ((auth: { apiKey: string }) => void) | undefined;
		let authCall = 0;
		const catalog = new AccountModelCatalog({
			getModels: () => [model],
			hasConfiguredAuth: () => true,
			getRequestAuth: () =>
				new Promise((resolve) => {
					authCall += 1;
					if (authCall === 1) resolveOld = resolve;
					else resolveNew = resolve;
				}),
			fetch: async (_input, init) =>
				new Response("{}", {
					status: new Headers(init?.headers).get("Authorization") === "Bearer new-key" ? 200 : 401,
				}),
		});
		const oldRefresh = catalog.refresh();
		const newRefresh = catalog.refresh();
		resolveNew?.({ apiKey: "new-key" });
		await newRefresh;
		expect(catalog.availability(model)).toBe("available");
		resolveOld?.({ apiKey: "old-key" });
		await oldRefresh;
		expect(catalog.availability(model)).toBe("available");
	});

	it("publishes a later sequential refresh", async () => {
		const model = { provider: "openrouter", id: "deepseek/x", baseUrl: "https://openrouter.ai/api/v1" } as Model<Api>;
		let apiKey = "old-key";
		const catalog = new AccountModelCatalog({
			getModels: () => [model],
			hasConfiguredAuth: () => true,
			getRequestAuth: async () => ({ apiKey }),
			fetch: async (_input, init) =>
				new Response("{}", {
					status: new Headers(init?.headers).get("Authorization") === "Bearer new-key" ? 200 : 401,
				}),
		});
		await catalog.refresh();
		expect(catalog.availability(model)).toBe("unavailable");
		apiKey = "new-key";
		await catalog.refresh();
		expect(catalog.availability(model)).toBe("available");
	});

	it("removes provider state when the latest refresh no longer has configured auth", async () => {
		const model = { provider: "openrouter", id: "deepseek/x", baseUrl: "https://openrouter.ai/api/v1" } as Model<Api>;
		let configured = true;
		const catalog = new AccountModelCatalog({
			getModels: () => [model],
			hasConfiguredAuth: () => configured,
			getRequestAuth: async () => ({ apiKey: "rejected-key" }),
			fetch: async () => new Response("{}", { status: 401 }),
		});
		await catalog.refresh();
		expect(catalog.availability(model)).toBe("unavailable");
		configured = false;
		await catalog.refresh();
		expect(catalog.availability(model)).toBe("unknown");
		expect(catalog.describe()).toEqual([]);
	});
});
