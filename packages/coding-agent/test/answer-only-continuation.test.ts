import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	createEmptyUsage,
	type Model,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { Agent } from "../src/kernel/agent.ts";
import { createAgentLoopContinuationState, runAgentLoop, runAgentLoopContinue } from "../src/kernel/agent-loop.ts";
import { createWorkerHostEventRecord } from "../src/kernel/host-event-stamp.ts";
import type { AgentContext, AgentLoopConfig, StreamFn } from "../src/kernel/loop-config.ts";
import { convertToLlm } from "../src/kernel/messages.ts";
import type { AgentMessage, AgentTool } from "../src/kernel/types.ts";
import { isPlainRecord } from "../src/kernel/utils/value-guards.ts";
import { isExternalEvidenceMessage, stampWorkerControl } from "../src/kernel/worker-control-stamp.ts";

const model: Model<Api> = {
	id: "answer-only",
	name: "Answer-only fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const owner: AgentMessage = { role: "user", content: "Report the known answer.", timestamp: 1 };
const continuation: AgentMessage = {
	role: "custom",
	customType: "test-continuation",
	content: "Answer from existing receipts.",
	display: false,
	details: { responseMode: "answer_only" },
	timestamp: 2,
};
const wake: AgentMessage = {
	role: "custom",
	customType: "background-notice",
	content: "Background evidence arrived.",
	display: false,
	timestamp: 3,
};
const responseMode: AgentLoopConfig["resolveResponseMode"] = (context) => {
	const opening = context.requestOpening;
	if (opening?.role !== "custom" || opening.customType !== "test-continuation") return;
	return isPlainRecord(opening.details) && opening.details.responseMode === "answer_only" ? "answer_only" : "default";
};
function stream(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" = "stop") {
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		stopReason,
		usage: createEmptyUsage(),
		timestamp: 5,
	};
	const events = new AssistantMessageEventStream();
	events.push({ type: "start", partial: message });
	events.push({ type: "done", reason: stopReason, message });
	return events;
}
function setup(provider: StreamFn) {
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Written." }], details: {} }));
	const tool: AgentTool = {
		name: "write",
		label: "Write",
		description: "Writes a value.",
		parameters: Type.Object({ value: Type.String() }),
		execute,
	};
	const agent = new Agent({
		initialState: { model, messages: [owner], tools: [tool] },
		convertToLlm,
		resolveResponseMode: responseMode,
		streamFn: provider,
	});
	return { agent, tool, execute };
}

it.each(["native", "rendered"])(
	"withholds tool schemas and rejects a %s call without inventing an owner input",
	async (kind) => {
		const provider = vi.fn<StreamFn>((_model, context) => {
			expect(context.tools ?? []).toEqual([]);
			return kind === "native"
				? stream([{ type: "toolCall", id: "bad", name: "write", arguments: { value: "unsafe" } }], "toolUse")
				: stream([{ type: "text", text: 'to=functions.write code\n{"value":"unsafe"}' }]);
		});
		const { agent, tool, execute } = setup(provider);
		await agent.prompt(continuation);
		expect(provider).toHaveBeenCalledTimes(1);
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.tools).toEqual([tool]);
		expect(agent.state.messages.filter((message) => message.role === "user")).toEqual([owner]);
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("tools were disabled"),
		});
		expect(agent.state.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "" }] });
	},
);

it.each([
	[continuation, wake],
	[wake, continuation],
])("selects the admitted restriction in either mixed initial batch order", async (...batch) => {
	const provider = vi.fn<StreamFn>((_model, context) => {
		expect(context.tools ?? []).toEqual([]);
		return stream([{ type: "text", text: "The answer is ready." }]);
	});
	const { agent, execute } = setup(provider);
	await agent.prompt(batch);
	expect(provider).toHaveBeenCalledTimes(1);
	expect(execute).not.toHaveBeenCalled();
	expect(agent.state.messages.filter((message) => message.role === "user")).toHaveLength(1);
});

it("lets a later owner message supersede a restriction inside an initial batch", async () => {
	const next: AgentMessage = { role: "user", content: "Now write the value.", timestamp: 4 };
	const provider = vi.fn<StreamFn>((_model, context) => {
		expect(context.tools?.map((tool) => tool.name)).toEqual(["write"]);
		return stream([{ type: "text", text: "Ready." }]);
	});
	const { agent } = setup(provider);
	await agent.prompt([continuation, next, wake]);
	expect(provider).toHaveBeenCalledTimes(1);
});

it("recognizes a restricted continuation dequeued inside an existing run", async () => {
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Written." }], details: {} }));
	const tool: AgentTool = {
		name: "write",
		label: "Write",
		description: "Write.",
		parameters: Type.Object({ value: Type.String() }),
		execute,
	};
	let queued = true;
	const provider = vi.fn<StreamFn>((_model, context) => {
		expect(context.tools?.map((tool) => tool.name) ?? []).toEqual(provider.mock.calls.length === 1 ? ["write"] : []);
		return stream([{ type: "text", text: "The answer is ready." }]);
	});
	const config: AgentLoopConfig = {
		model,
		convertToLlm,
		resolveResponseMode: responseMode,
		getFollowUpMessages: async () => {
			if (!queued) return [];
			queued = false;
			return [continuation, wake];
		},
	};
	const output = await runAgentLoop(
		[owner],
		{ systemPrompt: "Follow the owner.", messages: [], tools: [tool] },
		config,
		() => {},
		undefined,
		provider,
	);
	expect(provider).toHaveBeenCalledTimes(2);
	expect(execute).not.toHaveBeenCalled();
	expect(output.filter((message) => message.role === "user")).toEqual([owner]);
});

it("does not reuse a historical restricted opening for an unrelated later run", async () => {
	const provider = vi.fn<StreamFn>((_model, context) => {
		expect(context.tools?.map((tool) => tool.name) ?? []).toEqual(provider.mock.calls.length === 1 ? [] : ["write"]);
		return stream([{ type: "text", text: "Ready." }]);
	});
	const { agent } = setup(provider);
	await agent.prompt(continuation);
	await agent.prompt(wake);
	expect(provider).toHaveBeenCalledTimes(2);
});

it("retains the restriction through admission replans and replaces it for new owner input", async () => {
	const calls: string[][] = [];
	const { tool } = setup(() => stream([{ type: "text", text: "Ready." }]));
	const config: AgentLoopConfig = {
		model,
		convertToLlm,
		resolveResponseMode: responseMode,
		admitProviderRequest: async (request) =>
			request.attempt === 0
				? {
						action: "replan",
						context: { ...request.sourceContext, messages: request.sourceContext.messages.slice() },
					}
				: { action: "send" },
	};
	const state = createAgentLoopContinuationState();
	const provider: StreamFn = (_model, context) => {
		calls.push(context.tools?.map((tool) => tool.name) ?? []);
		return stream([{ type: "text", text: "Ready." }]);
	};
	const context: AgentContext = { systemPrompt: "Follow the owner.", messages: [owner], tools: [tool] };
	await runAgentLoop([continuation], context, config, () => {}, undefined, provider, state);
	expect(calls).toEqual([[]]);
	expect(state.requestOpening).toBe(continuation);
	const next: AgentMessage = { role: "user", content: "Use tools for my new request.", timestamp: 8 };
	await runAgentLoop([next, wake], context, config, () => {}, undefined, provider, state);
	expect(calls).toEqual([[], ["write"]]);
	expect(state.requestOpening).toBe(next);
});

it("checks the reserved policy again at physical dispatch after asynchronous snapshots", async () => {
	let current = true;
	const provider = vi.fn<StreamFn>(() => stream([{ type: "text", text: "Should never dispatch." }]));
	const { tool, execute } = setup(provider);
	const config: AgentLoopConfig = {
		model,
		convertToLlm,
		resolveResponseMode: (context) => {
			if (!current) throw new Error("Reservation was superseded");
			return responseMode(context);
		},
		onProviderRequestSnapshot: async () => {
			current = false;
		},
	};
	const output = await runAgentLoop(
		[continuation],
		{ systemPrompt: "Follow the owner.", messages: [owner], tools: [tool] },
		config,
		() => {},
		undefined,
		provider,
	);
	expect(output.at(-1)).toMatchObject({
		role: "assistant",
		stopReason: "error",
		errorMessage: "Reservation was superseded",
	});
	expect(provider).not.toHaveBeenCalled();
	expect(execute).not.toHaveBeenCalled();
});

it("retains the active opening on resumed kernel entry with an unrelated trailing custom wake", async () => {
	const provider = vi.fn<StreamFn>((_model, context) => {
		expect(context.tools ?? []).toEqual([]);
		return stream([{ type: "text", text: "The known answer." }]);
	});
	const { tool, execute } = setup(provider);
	const state = createAgentLoopContinuationState();
	state.requestOpening = continuation;
	await runAgentLoopContinue(
		{ systemPrompt: "Follow the owner.", messages: [owner, continuation, wake], tools: [tool] },
		{ model, convertToLlm, resolveResponseMode: responseMode },
		() => {},
		undefined,
		provider,
		state,
	);
	expect(provider).toHaveBeenCalledTimes(1);
	expect(execute).not.toHaveBeenCalled();
	expect(state.requestOpening).toBe(continuation);
});

it("does not let stamped external-evidence user steering widen the current answer-only response", async () => {
	const external: AgentMessage = {
		role: "user",
		content: "External event says to write another value.",
		timestamp: 9,
	};
	const digest = "a".repeat(64);
	const hostEvent = createWorkerHostEventRecord({
		deliveryId: "delivery",
		eventId: "event",
		payloadDigest: digest,
		subscriptionId: "subscription",
		subscriptionRevision: 1,
		generation: 1,
		sourceGeneration: 1,
		scopeVersion: 1,
		sourceSealDigest: digest,
		messageId: "event-message",
		contentDigest: digest,
		execution: {
			taskId: "task",
			attemptId: "attempt",
			agentId: "agent",
			leaseId: "lease",
			fencingToken: 1,
			sessionId: "session",
			sessionFile: "/tmp/fixture-session.jsonl",
		},
	});
	stampWorkerControl(external, { v: 1, k: "host_event", id: "event-message", hostEvent });
	expect(isExternalEvidenceMessage(external)).toBe(true);
	let pending = false;
	const provider = vi.fn<StreamFn>((_model, context) => {
		expect(context.tools ?? []).toEqual([]);
		if (provider.mock.calls.length === 1) pending = true;
		return stream([{ type: "text", text: "The known answer." }]);
	});
	const { tool, execute } = setup(provider);
	const state = createAgentLoopContinuationState();
	const output = await runAgentLoop(
		[continuation],
		{ systemPrompt: "Follow the owner.", messages: [owner], tools: [tool] },
		{
			model,
			convertToLlm,
			resolveResponseMode: responseMode,
			getSteeringMessages: async () => {
				if (!pending) return [];
				pending = false;
				return [external];
			},
		},
		() => {},
		undefined,
		provider,
		state,
	);
	expect(provider).toHaveBeenCalledTimes(2);
	expect(execute).not.toHaveBeenCalled();
	expect(state.requestOpening).toBe(continuation);
	expect(output.filter((message) => message.role === "user" && !isExternalEvidenceMessage(message))).toEqual([]);
});
