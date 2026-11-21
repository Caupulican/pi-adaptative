import { setImmediate as nextTurn } from "node:timers/promises";
import { type Api, type AssistantMessage, createEmptyUsage, type Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interfaceText } from "../src/core/language/interface-text.ts";
import { UsageResetResume, type UsageResetResumeDeps } from "../src/core/usage-reset-resume.ts";
import type { ClassifiedError } from "../src/kernel/reliability/index.ts";

const model: Model<Api> = {
	id: "credit-rotation-fixture",
	name: "Synthetic reset-credit rotation",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "http://127.0.0.1:45101/catalog/backend-api/codex/responses",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 128,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const quota: ClassifiedError = {
	reason: "billing_or_quota",
	retryable: false,
	shouldCompact: false,
	shouldRotateCredential: false,
	shouldFallback: false,
	message: "Synthetic account usage limit reached.",
};
const disposers: Array<() => void> = [];
const credits = (count: number) => Response.json({ credits: [], available_count: count });
const notice = (count: number) => interfaceText().notices.usageReset.codexResetsAvailable(count);
const accountOf = (request: Request) => request.headers.get("chatgpt-account-id");

function fixture(transport: (request: Request) => Response | Promise<Response>) {
	let account = "A";
	let revision = 0;
	let disposed = false;
	const requests: Request[] = [];
	const warn = vi.fn();
	const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, options) => {
		const request = new Request(input, options);
		expect(new URL(request.url).hostname).toBe("127.0.0.1");
		expect(request.method).toBe("GET");
		expect(request.headers.get("X-OpenAI-Fedramp")).toBe("true");
		requests.push(request);
		return transport(request);
	});
	vi.stubGlobal("fetch", fetch);
	const getApiKeyAndHeaders = vi.fn<UsageResetResumeDeps["modelRegistry"]["getApiKeyAndHeaders"]>(async () => {
		const capturedAccount = account;
		const capturedRevision = revision;
		const payload = {
			"https://api.openai.com/auth": { chatgpt_account_id: `synthetic-credit-${capturedAccount}` },
			synthetic_revision: capturedRevision,
		};
		return {
			ok: true,
			model: {
				...model,
				baseUrl: `http://127.0.0.1:45102/account-${capturedAccount}/backend-api/codex/responses`,
			},
			apiKey: `synthetic.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`,
			credentialHeaders: { "X-OpenAI-Fedramp": "true" },
			providerAccountKey: `openai-codex#synthetic-credit-${capturedAccount}`,
			requestGuard: (_model, signal) => {
				signal?.throwIfAborted();
				if (account !== capturedAccount || revision !== capturedRevision)
					throw new Error("Synthetic account authorization changed");
				return undefined;
			},
		};
	});
	const message: AssistantMessage = {
		role: "assistant",
		provider: model.provider,
		model: model.id,
		api: model.api,
		content: [],
		usage: createEmptyUsage(),
		stopReason: "error",
		errorMessage: quota.message,
		timestamp: Date.now(),
	};
	const resume = new UsageResetResume({
		enabled: true,
		clock: {
			now: () => Date.now(),
			setTimeout: (callback, wait) => setTimeout(callback, wait),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		},
		modelRegistry: {
			find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
			isUsingSubscription: () => true,
			getApiKeyAndHeaders,
		},
		inRunRetryMaxMs: () => 0,
		modelExhaustion: () => undefined,
		transcript: {
			agent: { state: { model, messages: [message] } },
			sessionManager: {
				getLatestCustomEntryOnBranch: vi.fn(() => undefined),
				appendCustomEntry: vi.fn(() => "synthetic-entry"),
			},
		},
		waitForIdle: async () => {},
		isDisposed: () => disposed,
		goals: () => ({ getState: () => undefined, resumeUsageLimitedGoal: () => false }),
		continueTurn: async () => true,
		warn,
	});
	const dispose = () => {
		disposed = true;
		resume.dispose();
	};
	disposers.push(dispose);
	return {
		requests,
		warn,
		dispose,
		stop: () => resume.runStopped(message, quota),
		redeem: () => resume.noteUsageReset("openai-codex"),
		useAccount: (next: string) => {
			account = next;
			revision += 1;
		},
		renew: () => {
			revision += 1;
		},
	};
}

async function settle() {
	await nextTurn();
	await nextTurn();
}

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.unstubAllGlobals();
});

describe("automatic reset-credit offers follow the current account", () => {
	it("deduplicates repeated refusals after the same account received its offer", async () => {
		const f = fixture(() => credits(2));
		f.stop();
		await vi.waitFor(() => expect(f.warn).toHaveBeenCalledWith(notice(2)));
		f.stop();
		await settle();
		expect(f.requests).toHaveLength(1);
		expect(f.warn.mock.calls).toEqual([[notice(2)]]);
	});

	it("offers the current account B after account A already received an offer", async () => {
		const f = fixture((request) => credits(accountOf(request) === "synthetic-credit-A" ? 2 : 3));
		f.stop();
		await vi.waitFor(() => expect(f.warn).toHaveBeenCalledWith(notice(2)));
		f.useAccount("B");
		f.stop();
		await vi.waitFor(() => expect(f.warn).toHaveBeenCalledWith(notice(3)), { timeout: 1_000 });
		expect(f.requests.map(accountOf)).toEqual(["synthetic-credit-A", "synthetic-credit-B"]);
		expect(f.requests[1]?.url).toContain("/account-B/backend-api/wham/rate-limit-reset-credits");
		expect(f.warn.mock.calls).toEqual([[notice(2)], [notice(3)]]);
	});

	it("deduplicates repeated refusals while the same current account read is pending", async () => {
		const response = Promise.withResolvers<Response>();
		const f = fixture(() => response.promise);
		try {
			f.stop();
			await vi.waitFor(() => expect(f.requests).toHaveLength(1));
			f.stop();
			await settle();
			expect(f.requests).toHaveLength(1);
			response.resolve(credits(2));
			await vi.waitFor(() => expect(f.warn).toHaveBeenCalledWith(notice(2)));
			expect(f.warn.mock.calls).toEqual([[notice(2)]]);
		} finally {
			response.resolve(credits(2));
		}
	});

	it("starts B while obsolete A is pending and prevents A from clearing or publishing over B", async () => {
		const old = Promise.withResolvers<Response>();
		const current = Promise.withResolvers<Response>();
		const f = fixture((request) => (accountOf(request) === "synthetic-credit-A" ? old.promise : current.promise));
		try {
			f.stop();
			await vi.waitFor(() => expect(f.requests).toHaveLength(1));
			f.useAccount("B");
			f.stop();
			await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 1_000 });
			expect(f.requests.map(accountOf)).toEqual(["synthetic-credit-A", "synthetic-credit-B"]);
			old.resolve(credits(2));
			await settle();
			f.stop();
			await settle();
			expect(f.requests).toHaveLength(2);
			expect(f.warn).not.toHaveBeenCalled();
			current.resolve(credits(3));
			await vi.waitFor(() => expect(f.warn).toHaveBeenCalledWith(notice(3)));
			expect(f.warn.mock.calls).toEqual([[notice(3)]]);
		} finally {
			old.resolve(credits(2));
			current.resolve(credits(3));
		}
	});

	it("replaces an obsolete pending read when the same account renews its token", async () => {
		const old = Promise.withResolvers<Response>();
		let reads = 0;
		const f = fixture(() => (++reads === 1 ? old.promise : credits(3)));
		try {
			f.stop();
			await vi.waitFor(() => expect(f.requests).toHaveLength(1));
			f.renew();
			f.stop();
			await vi.waitFor(() => expect(f.warn).toHaveBeenCalledWith(notice(3)), { timeout: 1_000 });
			expect(f.requests.map(accountOf)).toEqual(["synthetic-credit-A", "synthetic-credit-A"]);
			old.resolve(credits(2));
			await settle();
			expect(f.warn.mock.calls).toEqual([[notice(3)]]);
		} finally {
			old.resolve(credits(2));
		}
	});

	it("retires a pending credit read on redemption and offers a fresh notification episode", async () => {
		const old = Promise.withResolvers<Response>();
		let reads = 0;
		const f = fixture(() => (++reads === 1 ? old.promise : credits(3)));
		try {
			f.stop();
			await vi.waitFor(() => expect(f.requests).toHaveLength(1));
			f.redeem();
			expect(f.requests[0]?.signal.aborted).toBe(true);
			old.resolve(credits(2));
			await settle();
			expect(f.warn).not.toHaveBeenCalled();
			f.stop();
			await vi.waitFor(() => expect(f.warn).toHaveBeenCalledWith(notice(3)));
			expect(f.requests.map(accountOf)).toEqual(["synthetic-credit-A", "synthetic-credit-A"]);
			expect(f.warn.mock.calls).toEqual([[notice(3)]]);
		} finally {
			old.resolve(credits(2));
		}
	});

	it("aborts an in-flight read on disposal and suppresses its late credit notice", async () => {
		const response = Promise.withResolvers<Response>();
		const f = fixture(() => response.promise);
		try {
			f.stop();
			await vi.waitFor(() => expect(f.requests).toHaveLength(1));
			expect(f.requests[0]?.signal.aborted).toBe(false);
			f.dispose();
			expect(f.requests[0]?.signal.aborted).toBe(true);
			response.resolve(credits(2));
			await settle();
			expect(f.warn).not.toHaveBeenCalled();
			expect(f.requests).toHaveLength(1);
		} finally {
			response.resolve(credits(2));
		}
	});
});
