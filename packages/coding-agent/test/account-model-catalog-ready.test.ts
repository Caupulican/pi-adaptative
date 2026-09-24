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
});
