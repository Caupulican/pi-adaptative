import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	createEmptyUsage,
	dispatchGuardedProviderRequest,
	type Model,
	type ProviderResponseObserver,
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
