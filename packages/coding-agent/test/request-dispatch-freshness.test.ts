import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	createEmptyUsage,
	dispatchGuardedProviderRequest,
	getProviderResponseAccount,
	type Model,
	ProviderResponseAccountScope,
	type ProviderResponseObserver,
	providerResponseAccountFor,
	registerBuiltInApiProviders,
	sameProviderResponseRoute,
	streamSimple,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { appendWorkerKnowledgeContext } from "../src/core/delegation/worker-knowledge-context.ts";
import type { AgentContext, AgentContextPlan, AgentLoopConfig, StreamFn } from "../src/kernel/loop-config.ts";
import { convertToLlm } from "../src/kernel/messages.ts";
import { startPlannedAgentProviderRequestWithId } from "../src/kernel/provider-request-planner.ts";

const model: Model<Api> = {
	id: "dispatch-freshness-fixture",
	name: "Dispatch freshness fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function context(textProtocol: boolean): AgentContext {
	return {
		systemPrompt: "Follow the owner.",
		messages: [{ role: "user", content: "Read the task.", timestamp: 1 }],
		tools: textProtocol
			? [
					{
						name: "lookup",
						label: "Lookup",
						description: "Look up a file.",
						parameters: Type.Object({ path: Type.String() }),
						execute: async () => ({ content: [], details: undefined }),
					},
				]
			: [],
	};
}
function success(): AssistantMessageEventStream {
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "Done." }],
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: 1,
	};
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}
function setup(textProtocol: boolean) {
	let current = true,
		committed = false,
		commits = 0,
		snapshotId: string | undefined;
	const originalGuard = vi.fn(() => undefined);
	const begin = vi.fn(() => ({ complete: () => {}, failed: () => {} }));
	const observer: ProviderResponseObserver = { begin };
	const plan = (messages: AgentContextPlan["messages"]): AgentContextPlan => ({
		messages,
		isCurrent: () => !committed,
		isDispatchCurrent: () => current,
		commit: () => {
			committed = true;
			commits++;
		},
	});
	const config: AgentLoopConfig = {
		model,
		convertToLlm,
		textToolCallProtocol: textProtocol,
		requestGuard: originalGuard,
		providerResponseObserver: observer,
		planContext: async ({ messages }) => plan(messages),
		onProviderRequestSnapshot: async (snapshot) => {
			snapshotId = snapshot.requestId;
			await Promise.resolve();
		},
	};
	return {
		config,
		plan,
		observer,
		begin,
		originalGuard,
		invalidate: () => {
			current = false;
		},
		commits: () => commits,
		snapshotId: () => snapshotId,
		committed: () => committed,
	};
}
async function collect(stream: AssistantMessageEventStream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}

it("keeps the dispatched account on its matching terminal error and drops it at persistence and local refusal boundaries", async () => {
	const message: AssistantMessage = {
		...(await success().result()),
		stopReason: "error",
		errorMessage: "model_not_supported",
	};
	const physical = new AssistantMessageEventStream();
	const complete = vi.fn();
	const begin = vi.fn(() => ({ complete, failed: vi.fn() }));
	const options = {
		apiKey: "synthetic-credential",
		providerAccountKey: "fixture#account-a",
		providerResponseObserver: { begin },
	};
	const scope = new ProviderResponseAccountScope();
	const bound = scope.bind(options);
	const request = dispatchGuardedProviderRequest(model, bound, (providerOptions) => {
		expect(Object.getOwnPropertySymbols(providerOptions!)).toHaveLength(0);
		return physical;
	});
	options.providerAccountKey = "fixture#account-b";
	bound.providerAccountKey = options.providerAccountKey;
	physical.push({ type: "error", reason: "error", error: message });
	expect(await request.result()).toBe(message);
	const account = { provider: model.provider, model: model.id, accountKey: "fixture#account-a" };
	expect(getProviderResponseAccount(message)).toBeUndefined();
	expect(begin).toHaveBeenCalledTimes(1);
	expect(complete).toHaveBeenCalledExactlyOnceWith(message);
	const final = scope.project(message, { ...message, streamEndAt: Date.now() });
	expect(getProviderResponseAccount(final)).toEqual(account);
	const serialized = JSON.stringify(final);
	expect(serialized).not.toContain("account-a");
	expect(serialized).not.toContain(options.apiKey);
	expect(getProviderResponseAccount(JSON.parse(serialized))).toBeUndefined();
	const transformed = { ...final, errorMessage: "Different local diagnostic" };
	expect(getProviderResponseAccount(scope.project(message, transformed))).toBeUndefined();
	const replayScope = new ProviderResponseAccountScope();
	expect(getProviderResponseAccount(replayScope.project(final))).toBeUndefined();
	expect(getProviderResponseAccount(final)).toEqual(account);
	final.errorMessage = "Edited after delivery";
	expect(getProviderResponseAccount(final)).toBeUndefined();

	const dispatch = vi.fn(() => physical);
	const refused = dispatchGuardedProviderRequest(
		model,
		{
			...options,
			requestGuard: () => {
				throw new Error("model_not_supported");
			},
		},
		dispatch,
	);
	expect(getProviderResponseAccount(await refused.result())).toBeUndefined();
	expect(dispatch).not.toHaveBeenCalled();
	expect(begin).toHaveBeenCalledTimes(1);
});

it("withholds evidence for a middleware error, an account-free request and an ambiguous result reused by two accounts", async () => {
	const source = await success().result();
	const error = { ...source, stopReason: "error" as const, errorMessage: "model_not_supported" };
	const port = () => {
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "error", reason: "error", error });
		return stream;
	};
	for (const scope of ["fixture", "foreign#account", "fixture#synthetic-token"]) {
		const response = dispatchGuardedProviderRequest(
			model,
			{ apiKey: "synthetic-token", providerAccountKey: scope },
			port,
		);
		expect(getProviderResponseAccount(await response.result())).toBeUndefined();
	}
	const accountA = { providerAccountKey: "fixture#account-a" };
	const middleware = dispatchGuardedProviderRequest(model, accountA, port, "middleware");
	expect(getProviderResponseAccount(await middleware.result())).toBeUndefined();
	await dispatchGuardedProviderRequest(model, accountA, port).result();
	expect(getProviderResponseAccount(error)?.accountKey).toBe(accountA.providerAccountKey);
	await dispatchGuardedProviderRequest(model, { providerAccountKey: "fixture#account-b" }, port).result();
	expect(getProviderResponseAccount(error)).toBeUndefined();
});

it("compares only genuine routes and discards an error reused on a different endpoint", async () => {
	const options = { apiKey: "fixture-credential", providerAccountKey: "fixture#account-a" };
	const source = { ...model, baseUrl: "https://fixture.invalid/one/private?token=fixture-secret" };
	const original = providerResponseAccountFor(source, options)!;
	const same = providerResponseAccountFor({ ...source }, options)!;
	const otherApi = providerResponseAccountFor({ ...source, api: "openai-responses" }, options)!;
	expect(sameProviderResponseRoute(original, same)).toBe(true);
	expect(sameProviderResponseRoute(original, otherApi)).toBe(false);
	expect(sameProviderResponseRoute({ ...original }, original)).toBe(false);
	expect(providerResponseAccountFor({ ...source, baseUrl: " " }, options)).toBeUndefined();
	expect(Object.keys(original).sort()).toEqual(["accountKey", "model", "provider"]);
	expect(JSON.stringify(original)).not.toContain(source.baseUrl);

	const error = { ...(await success().result()), stopReason: "error" as const, errorMessage: "model_not_supported" };
	const transport = () => {
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "error", reason: "error", error });
		return stream;
	};
	await dispatchGuardedProviderRequest(source, options, transport).result();
	expect(sameProviderResponseRoute(getProviderResponseAccount(error)!, original)).toBe(true);
	source.baseUrl = "https://fixture.invalid/two/private?token=fixture-secret";
	expect(sameProviderResponseRoute(providerResponseAccountFor(source, options)!, original)).toBe(false);
	await dispatchGuardedProviderRequest(source, options, transport).result();
	expect(getProviderResponseAccount(error)).toBeUndefined();
	await dispatchGuardedProviderRequest(source, options, transport).result();
	expect(getProviderResponseAccount(error)).toBeUndefined();
	expect(JSON.stringify(error)).not.toContain("fixture-secret");
});

it.each(["unchanged", "model header", "caller header", "SDK environment header", "payload hook"] as const)(
	"matches account evidence to the intercepted OpenRouter request with %s",
	async (variant) => {
		registerBuiltInApiProviders();
		const apiKey = "fixture-account-A";
		const otherKey = "fixture-account-B";
		for (const name of ["OPENAI_CUSTOM_HEADERS", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"]) vi.stubEnv(name, "");
		if (variant === "SDK environment header")
			vi.stubEnv("OPENAI_CUSTOM_HEADERS", `Authorization: Bearer ${otherKey}`);
		const sent: { key: string | null; model: string }[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			expect(request.url).toBe("https://unused.invalid/chat/completions");
			sent.push({ key: request.headers.get("authorization"), model: (await request.json()).model });
			return Response.json(
				{ error: { message: "model_not_supported", code: "model_not_supported" } },
				{ status: 400 },
			);
		});
		try {
			const target = {
				...model,
				provider: "openrouter",
				...(variant === "model header" ? { headers: { Authorization: `Bearer ${otherKey}` } } : {}),
			};
			const scope = new ProviderResponseAccountScope();
			const stream = streamSimple(
				target,
				{ messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
				scope.bind({
					apiKey,
					providerAccountKey: "openrouter#account-a",
					maxRetries: 0,
					...(variant === "caller header" ? { headers: { authorization: `Bearer ${otherKey}` } } : {}),
					onPayload: (payload: unknown) => {
						if (variant === "payload hook") (payload as { model: string }).model = "other-model";
					},
				}),
			);
			const message = scope.project(await stream.result());
			expect(sent).toEqual([
				{
					key: `Bearer ${variant === "unchanged" || variant === "payload hook" ? apiKey : otherKey}`,
					model: variant === "payload hook" ? "other-model" : model.id,
				},
			]);
			expect(message.errorMessage).toContain("model_not_supported");
			expect(getProviderResponseAccount(message)?.accountKey).toBe(
				variant === "unchanged" ? "openrouter#account-a" : undefined,
			);
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	},
);

it.each(["same account", "changed account", "mismatched stored account", "conflicting caller headers"] as const)(
	"checks the Codex transport after 401 recovery with %s",
	async (variant) => {
		registerBuiltInApiProviders();
		const token = (account: string, generation: number) => {
			const body = { "https://api.openai.com/auth": { chatgpt_account_id: account }, generation };
			return `e30.${Buffer.from(JSON.stringify(body)).toString("base64url")}.fixture`;
		};
		const first = token("account-a", 1);
		const nextAccount = variant === "changed account" ? "account-b" : "account-a";
		const recovered = token(nextAccount, 2);
		const recover = vi.fn(() => recovered);
		const sent: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			expect(url).toBe("https://unused.invalid/codex/responses");
			const headers = new Headers(init.headers);
			expect(headers.get("authorization")).toBe(`Bearer ${sent.length === 0 ? first : recovered}`);
			sent.push(headers.get("chatgpt-account-id")!);
			return Response.json({ error: { message: "model_not_supported" } }, { status: sent.length === 1 ? 401 : 400 });
		});
		try {
			const source: Model<Api> = { ...model, provider: "openai-codex", api: "openai-codex-responses" };
			const scope = new ProviderResponseAccountScope();
			const stream = streamSimple(
				source,
				{ messages: [{ role: "user", content: "fixture", timestamp: 1 }] },
				scope.bind({
					apiKey: first,
					providerAccountKey:
						variant === "mismatched stored account" ? "openai-codex#other" : "openai-codex#account-a",
					transport: "sse",
					maxRetries: 0,
					onAuthRejection: recover,
					...(variant === "conflicting caller headers"
						? { headers: { authorization: "Bearer ignored", "chatgpt-account-id": "ignored" } }
						: {}),
				}),
			);
			const message = scope.project(await stream.result());
			expect(sent).toEqual(["account-a", nextAccount]);
			expect(recover).toHaveBeenCalledExactlyOnceWith({ providerId: source.provider, status: 401, attempt: 1 });
			expect(message.errorMessage).toContain("model_not_supported");
			expect(getProviderResponseAccount(message)?.accountKey).toBe(
				variant === "same account" ? "openai-codex#account-a" : undefined,
			);
		} finally {
			vi.unstubAllGlobals();
		}
	},
);

describe.each([false, true])("dispatch currency with text protocol %s", (textProtocol) => {
	it("accepts an omitted dispatch-currency predicate", async () => {
		const h = setup(textProtocol);
		const base = h.config.planContext!;
		h.config.planContext = async (request, signal) => {
			const { isDispatchCurrent: _omitted, ...plan } = await base(request, signal);
			return plan;
		};
		const transport = vi.fn<StreamFn>(() => success());
		const started = await startPlannedAgentProviderRequestWithId(
			context(textProtocol),
			h.config,
			undefined,
			transport,
		);
		expect((await collect(started.stream)).message.stopReason).toBe("stop");
		expect(h.commits()).toBe(1);
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ name: "undefined", result: undefined },
		{ name: "a promise", result: Promise.resolve(false) },
	])("refuses a present dispatch predicate returning $name", async ({ result }) => {
		const h = setup(textProtocol);
		const base = h.config.planContext!;
		h.config.planContext = async (request, signal) => ({
			...(await base(request, signal)),
			isDispatchCurrent: (() => result) as unknown as () => boolean,
		});
		const transport = vi.fn<StreamFn>(() => success());
		const started = await startPlannedAgentProviderRequestWithId(
			context(textProtocol),
			h.config,
			undefined,
			transport,
		);
		const terminal = await collect(started.stream);
		expect(started.requestId).toBe(h.snapshotId());
		expect(h.commits()).toBe(1);
		expect(terminal.message.stopReason).toBe("error");
		expect(terminal.events.at(-1)?.type).toBe("error");
		expect(transport).not.toHaveBeenCalled();
		expect(h.begin).not.toHaveBeenCalled();
	});

	it("refuses after snapshot invalidation with one committed request and a terminal error", async () => {
		const h = setup(textProtocol);
		const snapshot = h.config.onProviderRequestSnapshot!;
		h.config.onProviderRequestSnapshot = async (value, signal) => {
			await snapshot(value, signal);
			h.invalidate();
		};
		const transport = vi.fn<StreamFn>(() => success());
		const started = await startPlannedAgentProviderRequestWithId(
			context(textProtocol),
			h.config,
			undefined,
			transport,
		);
		const terminal = await collect(started.stream);
		expect(started.requestId).toBe(h.snapshotId());
		expect(h.commits()).toBe(1);
		expect(terminal.message.stopReason).toBe("error");
		expect(terminal.events.at(-1)?.type).toBe("error");
		expect(transport).not.toHaveBeenCalled();
		expect(h.begin).not.toHaveBeenCalled();
	});
	it("uses the nonconsumptive dispatch check after commit and preserves guard and observer", async () => {
		const h = setup(textProtocol);
		let physical = 0,
			guardsAtTransport = 0;
		const transport: StreamFn = (m, _c, options) => {
			expect(options?.providerResponseObserver).toBe(h.observer);
			expect(options?.requestGuard).toBeTypeOf("function");
			guardsAtTransport = h.originalGuard.mock.calls.length;
			return dispatchGuardedProviderRequest(m, options, () => {
				physical++;
				return success();
			});
		};
		const started = await startPlannedAgentProviderRequestWithId(
			context(textProtocol),
			h.config,
			undefined,
			transport,
		);
		expect((await collect(started.stream)).message.stopReason).toBe("stop");
		expect(h.committed()).toBe(true);
		expect(h.commits()).toBe(1);
		expect(started.requestId).toBe(h.snapshotId());
		expect(physical).toBe(1);
		expect(h.begin).toHaveBeenCalledTimes(1);
		expect(h.originalGuard.mock.calls.length).toBeGreaterThan(guardsAtTransport);
	});
	it("refuses at the downstream physical boundary after an asynchronous transport wait", async () => {
		const h = setup(textProtocol);
		let transportCalls = 0,
			physical = 0;
		const transport: StreamFn = async (m, _c, options) => {
			transportCalls++;
			expect(options?.providerResponseObserver).toBe(h.observer);
			await Promise.resolve();
			h.invalidate();
			return dispatchGuardedProviderRequest(m, options, () => {
				physical++;
				return success();
			});
		};
		const started = await startPlannedAgentProviderRequestWithId(
			context(textProtocol),
			h.config,
			undefined,
			transport,
		);
		const terminal = await collect(started.stream);
		expect(started.requestId).toBe(h.snapshotId());
		expect(h.commits()).toBe(1);
		expect(transportCalls).toBe(1);
		expect(physical).toBe(0);
		expect(h.begin).not.toHaveBeenCalled();
		expect(terminal.message.stopReason).toBe("error");
		expect(terminal.events.at(-1)?.type).toBe("error");
	});
});

it("worker knowledge revocation after snapshot prevents dispatch through the composed production plan", async () => {
	const h = setup(false);
	let knowledgeCurrent = true;
	h.config.planContext = async ({ messages, measureRequest }) => {
		const result = await appendWorkerKnowledgeContext({
			plan: h.plan(messages),
			model,
			measureRequest: measureRequest!,
			maxOutputTokens: 1000,
			compactionReserveTokens: 0,
			remainingTokenAllowance: () => undefined,
			projectKnowledge: () => ({
				revision: 1,
				text: "Worker knowledge fixture.",
				includedCount: 1,
				omittedCount: 0,
				references: [],
				isCurrent: () => knowledgeCurrent,
			}),
		});
		if (result.kind !== "ready") throw new Error("Worker knowledge did not fit fixture context.");
		return result.plan;
	};
	const snapshot = h.config.onProviderRequestSnapshot!;
	h.config.onProviderRequestSnapshot = async (value, signal) => {
		await snapshot(value, signal);
		knowledgeCurrent = false;
	};
	const transport = vi.fn<StreamFn>(() => success());
	const started = await startPlannedAgentProviderRequestWithId(context(false), h.config, undefined, transport);
	const terminal = await collect(started.stream);
	expect(started.requestId).toBe(h.snapshotId());
	expect(h.commits()).toBe(1);
	expect(terminal.message.stopReason).toBe("error");
	expect(transport).not.toHaveBeenCalled();
	expect(h.begin).not.toHaveBeenCalled();
});
