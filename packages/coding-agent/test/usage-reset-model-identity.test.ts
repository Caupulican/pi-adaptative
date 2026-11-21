import { type Api, type AssistantMessage, createEmptyUsage, type Model } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { interfaceText } from "../src/core/language/interface-text.ts";
import type { RequestAuth } from "../src/core/request-auth.ts";
import { restoredUsageStop, UsageResetResume, type UsageResetResumeDeps } from "../src/core/usage-reset-resume.ts";
import type { ClassifiedError } from "../src/kernel/reliability/index.ts";

const now = Date.parse("2026-11-21T07:45:00Z");
const delay = 120_000;
const error = "Usage limit reached. Try again in 2 minutes.";
const quota: ClassifiedError = {
	reason: "billing_or_quota",
	retryable: false,
	shouldCompact: false,
	shouldRotateCredential: false,
	shouldFallback: false,
	message: error,
};
const effectiveToken = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
const unscopedToken = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-unscoped-account" } })).toString("base64url")}.signature`;
const model: Model<Api> = {
	id: "original-model",
	name: "Usage reset identity fixture",
	provider: "fixture-subscription",
	api: "openai-completions",
	baseUrl: "https://catalog-endpoint.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function refusal(selected: Model<Api> = model): AssistantMessage {
	return {
		role: "assistant",
		provider: selected.provider,
		model: selected.id,
		api: selected.api,
		content: [],
		usage: createEmptyUsage(),
		stopReason: "error",
		errorMessage: error,
		timestamp: now,
	};
}

function stoppedGoal(): GoalState {
	const reason = `billing_or_quota: ${error}`;
	return {
		...createGoalState({
			goalId: "reset-goal",
			userGoal: "Finish the assigned work",
			now: new Date(now).toISOString(),
		}),
		status: "usage_limited",
		blockedReason: reason,
		events: [
			{
				type: "system_stop_goal",
				status: "usage_limited",
				reason,
				refusedBy: { provider: model.provider, id: model.id },
				now: new Date(now).toISOString(),
			},
		],
	};
}

function fixture(selected: Model<Api> = model) {
	const messages: AssistantMessage[] = [refusal(selected)];
	const state = { messages, model: selected };
	const requestGuard = vi.fn<NonNullable<RequestAuth["requestGuard"]>>().mockReturnValue(undefined);
	const resolved: RequestAuth & { model: Model<Api>; providerAccountKey: string } = {
		model: { ...selected, baseUrl: "https://effective-endpoint.invalid/backend-api/codex/responses" },
		apiKey: effectiveToken,
		credentialHeaders: { "X-OpenAI-Fedramp": "true" },
		providerAccountKey: `${selected.provider}#synthetic-account`,
		requestGuard,
	};
	const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, ...resolved }));
	const find = vi.fn(() => selected);
	const warn = vi.fn();
	const goals = {
		getState: vi.fn<() => GoalState | undefined>(() => undefined),
		resumeUsageLimitedGoal: vi.fn(() => false),
	};
	const legacyGoals = { resumeUsageLimitedGoal: goals.resumeUsageLimitedGoal };
	const modelRegistry = {
		find,
		isUsingSubscription: () => true,
		getApiKeyAndHeaders,
		getApiKeyForProvider: vi.fn(async () => unscopedToken),
		authStorage: { getOAuthRequestHeaders: vi.fn(() => ({ "chatgpt-account-id": "synthetic-unscoped-account" })) },
	};
	const deps: UsageResetResumeDeps = {
		enabled: true,
		clock: {
			now: () => Date.now(),
			setTimeout: (callback, wait) => setTimeout(callback, wait),
			clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		},
		modelRegistry,
		inRunRetryMaxMs: () => 0,
		modelExhaustion: () => undefined,
		transcript: {
			agent: { state },
			sessionManager: { getLatestCustomEntryOnBranch: vi.fn(() => undefined), appendCustomEntry: vi.fn() },
		},
		waitForIdle: async () => {},
		isDisposed: () => false,
		...legacyGoals,
		goals: () => goals,
		continueTurn: vi.fn(async () => true),
		warn,
	};
	const resume = new UsageResetResume(deps);
	return { deps, resume, messages, state, find, resolved, requestGuard, getApiKeyAndHeaders, goals, warn };
}

async function settleMicrotasks() {
	for (let index = 0; index < 12; index++) await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("Unexpected transport in offline usage-reset test"))),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("usage-reset refusal identity", () => {
	it.each([false, true])("rejects an alias during %s goal restoration", (goal) => {
		const { deps, find, messages } = fixture();
		find.mockReturnValue({ ...model, id: "replacement-alias" });
		expect(restoredUsageStop(messages[0], goal ? stoppedGoal() : undefined, undefined, deps)).toBeUndefined();
	});

	it.each([false, true])("retains the exact model during %s goal restoration", (goal) => {
		const { deps, messages } = fixture();
		expect(restoredUsageStop(messages[0], goal ? stoppedGoal() : undefined, undefined, deps)).toMatchObject({
			at: now + delay,
			resume: { ref: `${model.provider}/${model.id}` },
		});
	});

	it("does not arm a live refusal using an alias subscription", async () => {
		const { resume, find, messages, warn } = fixture();
		find.mockReturnValue({ ...model, id: "replacement-alias" });
		resume.runStopped(messages[0]!, { ...quota, retryAfterMs: delay });
		await settleMicrotasks();
		expect(warn).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		resume.dispose();
	});

	it.each([{ provider: "another-provider" }, { model: "another-model" }])(
		"does not arm for a cloned refusal with another identity %o",
		async (identity) => {
			const { resume, messages, warn } = fixture();
			const stopped = messages[0]!;
			messages[0] = { ...stopped, ...identity };
			resume.runStopped(stopped, { ...quota, retryAfterMs: delay });
			await settleMicrotasks();
			expect(warn).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			resume.dispose();
		},
	);

	it.each([{ provider: "another-provider" }, { model: "another-model" }])(
		"does not wake a cloned refusal with another identity %o",
		async (identity) => {
			const { resume, messages, deps } = fixture();
			resume.runStopped(messages[0]!, { ...quota, retryAfterMs: delay });
			await settleMicrotasks();
			messages[0] = { ...messages[0]!, ...identity };
			await vi.advanceTimersByTimeAsync(delay);
			expect(deps.continueTurn).not.toHaveBeenCalled();
			resume.dispose();
		},
	);

	it("wakes an exact cloned refusal once", async () => {
		const { resume, messages, deps } = fixture();
		resume.runStopped(messages[0]!, { ...quota, retryAfterMs: delay });
		await settleMicrotasks();
		messages[0] = structuredClone(messages[0]!);
		await vi.advanceTimersByTimeAsync(delay);
		expect(deps.continueTurn).toHaveBeenCalledOnce();
		resume.dispose();
	});

	it.each([false, true])("does not invoke model B from model A's %s restored reset alarm", async (restored) => {
		const { resume, messages, state, deps } = fixture();
		if (restored) resume.restoreWait(undefined);
		else resume.runStopped(messages[0]!, { ...quota, retryAfterMs: delay });
		await settleMicrotasks();
		state.model = { ...model, id: "owner-selected-model-b" };
		await vi.advanceTimersByTimeAsync(delay);
		expect(deps.continueTurn).not.toHaveBeenCalled();
		resume.dispose();
	});

	it("does not arm a reset on model B while model A's error settles", async () => {
		const { resume, messages, state, deps, warn } = fixture();
		let release!: () => void;
		deps.waitForIdle = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		resume.runStopped(messages[0]!, { ...quota, retryAfterMs: delay });
		state.model = { ...model, id: "owner-selected-model-b" };
		release();
		await settleMicrotasks();
		expect(warn).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		resume.dispose();
	});

	it("retains the recorded goal's reset wake after an owner model change", async () => {
		const { resume, state, goals, deps } = fixture();
		const goal = stoppedGoal();
		goals.getState.mockReturnValue(goal);
		goals.resumeUsageLimitedGoal.mockReturnValue(true);
		state.model = { ...model, id: "owner-selected-model-b" };
		expect(resume.restoreWait(goal)).toMatchObject({ until: now + delay, goal: true });
		await vi.advanceTimersByTimeAsync(delay);
		expect(goals.resumeUsageLimitedGoal).toHaveBeenCalledOnce();
		expect(deps.continueTurn).not.toHaveBeenCalled();
		resume.dispose();
	});
});

describe("automatic read-only Codex reset-credit offers", () => {
	const codex = { ...model, provider: "openai-codex", api: "openai-codex-responses" as const };
	const notice = () => interfaceText().notices.usageReset.codexResetsAvailable(2);

	it("uses the effective request endpoint, token and account headers", async () => {
		const { resume, messages, getApiKeyAndHeaders, requestGuard, warn } = fixture(codex);
		const requests: Request[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(new Request(input, init));
				return Response.json({ credits: [], available_count: 2 });
			}),
		);
		resume.runStopped(messages[0]!, quota);
		await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(notice()));
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe("https://effective-endpoint.invalid/backend-api/wham/rate-limit-reset-credits");
		expect(requests[0]!.method).toBe("GET");
		expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${effectiveToken}`);
		expect(requests[0]!.headers.get("chatgpt-account-id")).toBe("synthetic-account");
		expect(requests[0]!.headers.get("X-OpenAI-Fedramp")).toBe("true");
		expect(getApiKeyAndHeaders).toHaveBeenCalledWith(codex);
		expect(requestGuard.mock.calls.length).toBeGreaterThanOrEqual(2);
		resume.dispose();
	});

	it("sends no credit request when resolved authorization is already stale", async () => {
		const { resume, messages, requestGuard, warn, getApiKeyAndHeaders } = fixture(codex);
		requestGuard.mockImplementation(() => {
			throw new Error("Synthetic credential replaced");
		});
		const fetch = vi.fn(async () => Response.json({ credits: [], available_count: 2 }));
		vi.stubGlobal("fetch", fetch);
		resume.runStopped(messages[0]!, quota);
		await settleMicrotasks();
		expect(fetch).not.toHaveBeenCalled();
		expect(getApiKeyAndHeaders).toHaveBeenCalledOnce();
		expect(warn.mock.calls.some(([text]) => text === notice())).toBe(false);
		resume.dispose();
	});

	it("does not publish credits after authorization changes while the GET is pending", async () => {
		const { resume, messages, requestGuard, warn } = fixture(codex);
		let release!: (response: Response) => void;
		let current = true;
		requestGuard.mockImplementation(() => {
			if (!current) throw new Error("Synthetic account replaced");
		});
		const fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetch);
		resume.runStopped(messages[0]!, quota);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		current = false;
		release(Response.json({ credits: [], available_count: 2 }));
		await settleMicrotasks();
		expect(warn.mock.calls.some(([text]) => text === notice())).toBe(false);
		resume.dispose();
	});
});
