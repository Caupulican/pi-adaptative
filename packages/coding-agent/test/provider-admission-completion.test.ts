import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProviderAdmissionPolicy, withProviderAdmission } from "../src/core/provider-admission/gate.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import { observeProviderResult, ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const policy: ProviderAdmissionPolicy = { enabled: true, limits: {}, maxWaitMs: 10_000, foregroundLimitWaitMs: 10_000 };

function harness() {
	const dir = mkdtempSync(join(tmpdir(), "pi-admission-races-"));
	let now = 1_000;
	const ledger = new ProviderAdmissionLedger(dir, { now: () => now, heartbeatMs: 60_000 });
	const limits = new ProviderLimitStore(dir, { now: () => now });
	cleanups.push(
		() => rmSync(dir, { recursive: true, force: true }),
		() => ledger.releaseAll(),
	);
	return {
		ledger,
		limits,
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		getPolicy: () => policy,
	};
}

describe("provider admission completion boundaries", () => {
	it("does not erase a newer sibling limit when an older request succeeds", async () => {
		const h = harness();
		const inner = createAssistantMessageEventStream();
		const model = { api: "faux", provider: "anthropic", id: "fixture" } as Model<Api>;
		const wrapped = withProviderAdmission(() => inner, h);
		await wrapped(model, { messages: [] }, {});
		h.advance(1);
		h.limits.record("anthropic", { limitedUntil: 5_000, reason: "rate_limit" });
		inner.end({ ...fauxAssistantMessage("ok"), provider: "anthropic" });
		await inner.result();
		await Promise.resolve();
		expect(h.limits.read("anthropic")?.limitedUntil).toBe(5_000);
		expect(h.ledger.countInflight("anthropic").total).toBe(0);
	});

	it("attributes a settled result to the admitted account after credentials switch", async () => {
		const h = harness();
		let account = "anthropic#first";
		const inner = createAssistantMessageEventStream();
		const model = { api: "faux", provider: "anthropic", id: "fixture" } as Model<Api>;
		const wrapped = withProviderAdmission(() => inner, { ...h, getAccountKey: () => account });
		await wrapped(model, { messages: [] }, {});
		account = "anthropic#second";
		inner.end({
			...fauxAssistantMessage(""),
			provider: "anthropic",
			stopReason: "error",
			errorMessage: "429 rate limit; retry after 4 seconds",
		});
		await inner.result();
		await Promise.resolve();
		expect(h.limits.read("anthropic#first")?.limitedUntil).toBe(5_000);
		expect(h.limits.read("anthropic#second")).toBeUndefined();
	});

	it("releases admission when cancellation races asynchronous stream creation", async () => {
		const h = harness();
		const controller = new AbortController();
		const inner = createAssistantMessageEventStream();
		const model = { api: "faux", provider: "anthropic", id: "fixture" } as Model<Api>;
		const wrapped = withProviderAdmission(async () => {
			controller.abort();
			await Promise.resolve();
			return inner;
		}, h);
		await wrapped(model, { messages: [] }, { signal: controller.signal });
		expect(h.ledger.countInflight("anthropic").total).toBe(0);
		inner.end({ ...fauxAssistantMessage(""), stopReason: "aborted" });
	});

	it("detaches its abort listener after a normal terminal result", async () => {
		const h = harness();
		const controller = new AbortController();
		const removed = vi.spyOn(controller.signal, "removeEventListener");
		const inner = createAssistantMessageEventStream();
		const model = { api: "faux", provider: "anthropic", id: "fixture" } as Model<Api>;
		const wrapped = withProviderAdmission(() => inner, h);
		await wrapped(model, { messages: [] }, { signal: controller.signal });
		inner.end(fauxAssistantMessage("ok"));
		await inner.result();
		await Promise.resolve();
		expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("does not start transport if admission acquisition races cancellation", async () => {
		const h = harness();
		const controller = new AbortController();
		const acquire = h.ledger.acquire.bind(h.ledger);
		vi.spyOn(h.ledger, "acquire").mockImplementation((...args) => {
			const hold = acquire(...args);
			controller.abort(new Error("cancelled at admission"));
			return hold;
		});
		const inner = createAssistantMessageEventStream();
		inner.end(fauxAssistantMessage("unused"));
		const transport = vi.fn(() => inner);
		const model = { api: "faux", provider: "anthropic", id: "fixture" } as Model<Api>;
		const wrapped = withProviderAdmission(transport, { ...h, getLane: () => "foreground" });
		await expect(wrapped(model, { messages: [] }, { signal: controller.signal })).rejects.toThrow(
			"cancelled at admission",
		);
		expect(transport).not.toHaveBeenCalled();
		expect(h.ledger.countInflight("anthropic").total).toBe(0);
	});

	it.each([
		{ startedAt: undefined, cleared: false },
		{ startedAt: 1_000, cleared: false },
		{ startedAt: 1_001, cleared: true },
	])("success clears only a provably older limit (request start=$startedAt)", ({ startedAt, cleared }) => {
		const h = harness();
		h.limits.record("anthropic", { limitedUntil: 5_000, reason: "rate_limit" });
		observeProviderResult(
			h.limits,
			{ ...fauxAssistantMessage("ok"), provider: "anthropic" },
			2_000,
			"anthropic",
			startedAt,
		);
		expect(h.limits.read("anthropic") === undefined).toBe(cleared);
	});

	it("releases the slot on cancellation while the transport factory remains pending", async () => {
		const h = harness();
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const transportResult = Promise.withResolvers<ReturnType<typeof createAssistantMessageEventStream>>();
		const inner = createAssistantMessageEventStream();
		const wrapped = withProviderAdmission(() => {
			entered.resolve();
			return transportResult.promise;
		}, h);
		const request = wrapped(
			{ api: "faux", provider: "anthropic", id: "fixture" } as Model<Api>,
			{ messages: [] },
			{ signal: controller.signal },
		);
		try {
			await entered.promise;
			expect(h.ledger.countInflight("anthropic").total).toBe(1);
			controller.abort();
			expect(h.ledger.countInflight("anthropic").total).toBe(0);
		} finally {
			inner.end({ ...fauxAssistantMessage(""), stopReason: "aborted" });
			transportResult.resolve(inner);
			await request;
		}
	});

	it("releases the slot and listener when transport creation rejects without cancellation", async () => {
		const h = harness();
		const controller = new AbortController();
		const removed = vi.spyOn(controller.signal, "removeEventListener");
		const failure = new Error("transport unavailable");
		const wrapped = withProviderAdmission(async () => {
			throw failure;
		}, h);
		await expect(
			wrapped(
				{ api: "faux", provider: "anthropic", id: "fixture" } as Model<Api>,
				{ messages: [] },
				{ signal: controller.signal },
			),
		).rejects.toBe(failure);
		expect(h.ledger.countInflight("anthropic").total).toBe(0);
		expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
	});
});
