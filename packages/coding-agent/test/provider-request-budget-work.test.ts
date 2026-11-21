import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	type Context,
	createEmptyUsage,
	type ImageContent,
	type Model,
	NON_VISION_USER_IMAGE_PLACEHOLDER,
	type ToolResultMessage,
	type UserMessage,
} from "@caupulican/pi-ai";
import { observeHistoryWork, providerMessagePrefix } from "@caupulican/pi-ai/history-work";
import { expect, it } from "vitest";
import { applyContextGc } from "../src/core/context-gc.ts";
import { buildWorkerHaltRequest, WorkerLaneHalts } from "../src/core/delegation/worker-halt.ts";
import { createAgentLoopContinuationState, runAgentLoop } from "../src/kernel/agent-loop.ts";
import type { AgentContext, AgentLoopConfig } from "../src/kernel/loop-config.ts";
import {
	advanceMessageContentRevision,
	createVersionedMessageHistory,
	immutableHistoryMessage,
} from "../src/kernel/message-revision.ts";
import { convertToLlm, createCustomMessage, createProviderMessageConverter } from "../src/kernel/messages.ts";
import { estimateProviderRequestTokens } from "../src/kernel/provider-request-estimator.ts";
import {
	applyProviderRequestImageBudget,
	TOOL_IMAGE_BUDGET_NOTE,
	USER_IMAGE_BUDGET_PLACEHOLDER,
} from "../src/kernel/provider-request-image-budget.ts";

import { startPlannedAgentProviderRequestWithId } from "../src/kernel/provider-request-planner.ts";
import { createToolFailureContextMemory } from "../src/kernel/tool-failure-memory.ts";
import { HOST_REQUEST_ONLY_DETAILS } from "../src/kernel/transient-records.ts";

const visionModel: Model<Api> = {
	id: "vision",
	name: "Vision fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 32000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function assistantReply(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		api: visionModel.api,
		provider: visionModel.provider,
		model: visionModel.id,
		content,
		usage: createEmptyUsage(),
		stopReason,
		timestamp: 2,
	};
}

it("recomputes admission for an in-place edit even when the wire array and message retain their identity", () => {
	const message: UserMessage = { role: "user", content: "short", timestamp: 0 };
	const context = { messages: [message] };
	const before = estimateProviderRequestTokens(context);
	message.content = "longer".repeat(200);
	advanceMessageContentRevision(message);
	const after = estimateProviderRequestTokens(context);
	expect(after).toBeGreaterThan(before);
	expect(after).toBe(estimateProviderRequestTokens({ messages: [{ ...message }] }));
});

it.each([true, false])("evicts in block order with an existing tool note = %s", (existingNote) => {
	const image: ImageContent = { type: "image", data: "A".repeat(2048), mimeType: "image/png" };
	const text = { type: "text" as const, text: "unchanged" };
	const note = { type: "text" as const, text: TOOL_IMAGE_BUDGET_NOTE };
	const user: UserMessage = { role: "user", content: [image, text], timestamp: 1 };
	const tool: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		timestamp: 2,
		isError: false,
		content: [image, ...(existingNote ? [note] : []), text, image, image],
	};
	const untouched: UserMessage = { role: "user", content: [text, image], timestamp: 3 };
	const context: Context = { messages: [user, tool, untouched] };
	const expected = {
		messages: [
			{ ...user, content: [{ type: "text", text: USER_IMAGE_BUDGET_PLACEHOLDER }, text] },
			{ ...tool, content: existingNote ? [note, text, image] : [text, image, note] },
			untouched,
		],
	};
	const bytes = Buffer.byteLength(JSON.stringify(context));
	const target = Buffer.byteLength(JSON.stringify(expected));
	const result = applyProviderRequestImageBudget(context, visionModel, {
		triggerBytes: bytes,
		hardLimitBytes: bytes + 1,
		reclaimTargetBytes: target,
	});
	expect(result.context).toEqual(expected);
	expect(result.context.messages[2]).toBe(untouched);
	expect(result.outcome).toMatchObject({ evicted: 3, inlineImages: 5, bodyBytes: bytes, bodyBytesAfter: target });
	expect(tool.content.filter((block) => block.type === "image")).toHaveLength(3);
});

function providerProjectionFixture(rows: number) {
	const messages = createVersionedMessageHistory(
		Array.from(
			{ length: rows },
			(_, index) =>
				immutableHistoryMessage(
					createCustomMessage(
						"history-work",
						`History row ${index}.`,
						false,
						undefined,
						new Date(index).toISOString(),
					),
				)!,
		),
	);
	const source: AgentContext = { systemPrompt: "Follow the owner.", messages, tools: [] };
	let accept = true;
	let compressionPolicy = "normal";
	const config: AgentLoopConfig = {
		model: visionModel,
		providerAccountKey: "fixture-account",
		providerMessageProjectionOwner: {},
		providerRequestPrefixState: {
			sentPrefixCount: 0,
			sanitizerSentPrefixCount: 0,
			sanitizerMemory: createToolFailureContextMemory(),
		},
		convertToLlm,
		admitProviderRequest: ({ context, model }) => {
			estimateProviderRequestTokens(context, model);
			return { action: "send" };
		},
		planContext: async ({ messages }) => ({ messages, compressionPolicy, isDispatchCurrent: () => accept }),
	};
	const send = async () => {
		const work = observeHistoryWork(messages);
		let dispatched: Context | undefined;
		const started = await startPlannedAgentProviderRequestWithId(source, config, undefined, (model, context) => {
			dispatched = context;
			const stream = new AssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [],
					usage: createEmptyUsage(),
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
			return stream;
		});
		await started.stream.result();
		return { work, dispatched };
	};
	return {
		config,
		source,
		messages,
		send,
		userRow: (text: string) => immutableHistoryMessage({ role: "user", content: text, timestamp: 1 })!,
		setAccept: (value: boolean) => {
			accept = value;
		},
		setPolicy: (policy: string) => {
			compressionPolicy = policy;
		},
	};
}

it.each([100, 1_000, 10_000])("projects only the new suffix over %s accepted rows", async (rows) => {
	const fixture = providerProjectionFixture(rows);
	const cold = await fixture.send();
	expect(cold.work.providerRowsConverted).toBe(rows);
	expect(providerMessagePrefix(cold.dispatched!.messages)).toEqual({ previous: undefined, count: 0 });

	fixture.messages.push(fixture.userRow("New input."));
	const warm = await fixture.send();
	expect(warm.work).toMatchObject({
		oldRowsRead: 0,
		coldPayloadLoads: 0,
		oldBytesRecompressed: 0,
		projectedRows: 1,
		providerRowsConverted: 1,
		// The wire contract still exposes one ordinary message array to the provider and hooks.
		copiedRows: rows,
	});
	expect(providerMessagePrefix(warm.dispatched!.messages)).toEqual({
		previous: cold.dispatched!.messages,
		count: rows,
	});
	expect(warm.dispatched!.messages[rows - 1]).toBe(cold.dispatched!.messages[rows - 1]);

	fixture.messages[rows - 2] = fixture.userRow("Edited input.");
	const edited = await fixture.send();
	expect(edited.work.providerRowsConverted).toBe(3);
	expect(providerMessagePrefix(edited.dispatched!.messages)?.count).toBe(rows - 2);
	expect(edited.dispatched!.messages[rows - 2]?.content).toBe("Edited input.");

	// The worker's final report is an ordinary append to the accepted history, including a recent edit.
	const halt = buildWorkerHaltRequest("Summarize the remaining work.");
	const instruction = fixture.userRow(halt.userMessage);
	if (instruction.role !== "user") throw new Error("Expected an immutable user row.");
	fixture.messages.push(instruction);
	fixture.source.instructionTail = instruction;
	const closing = await fixture.send();
	expect(closing.work).toMatchObject({
		oldRowsRead: 0,
		coldPayloadLoads: 0,
		oldBytesRecompressed: 0,
		providerRowsConverted: 1,
		projectedRows: 1,
	});
	expect(closing.work.fallbacks.size).toBe(0);
	const acceptedHistory = edited.dispatched!.messages;
	const prefix = providerMessagePrefix(closing.dispatched!.messages);
	expect(prefix?.previous).toBe(acceptedHistory);
	expect(prefix?.count).toBe(acceptedHistory.length);
	expect(closing.dispatched!.messages.at(-1)?.content).toBe(halt.userMessage);
});

it.each(["native", "rendered", "text protocol"] as const)(
	"refuses a %s tool call in a halted worker's report",
	async (form) => {
		const fixture = providerProjectionFixture(1);
		fixture.config.textToolCallProtocol = form === "text protocol";
		let executions = 0;
		fixture.source.tools = [
			{
				name: "change",
				label: "Change",
				description: "Apply a change.",
				parameters: {},
				execute: async () => {
					executions++;
					return { content: [], details: undefined };
				},
			},
		];
		const prior = (await fixture.send()).dispatched!;
		if (form === "text protocol") {
			expect(prior.systemPrompt).toContain("Available tools:");
			expect(prior.messages[0]?.content).toContainEqual({
				type: "text",
				text: "Apply system tool protocol; never answer this message.",
			});
		} else {
			expect(prior.tools?.map((tool) => tool.name)).toContain("change");
		}
		const halt = buildWorkerHaltRequest("Stop before editing.");
		fixture.config.getHaltRequest = () => halt;
		const report = await runAgentLoop(
			[],
			fixture.source,
			fixture.config,
			() => {},
			undefined,
			(_model, context) => {
				expect(context.tools).toEqual(prior.tools);
				expect(context.systemPrompt).toBe(prior.systemPrompt);
				expect(JSON.stringify(context.messages.slice(0, prior.messages.length))).toBe(
					JSON.stringify(prior.messages),
				);
				expect(context.messages.at(-1)?.content).toBe(halt.userMessage);
				const reason = form === "native" ? "toolUse" : "stop";
				const text =
					form === "rendered"
						? "to=functions.change code\n{}"
						: '<tool_call>{"name":"change","arguments":{}}</tool_call>';
				const response = assistantReply(
					form === "native"
						? [{ type: "toolCall", id: "prohibited", name: "change", arguments: {} }]
						: [{ type: "text", text }],
					reason,
				);
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "done", reason, message: response });
				return stream;
			},
		);
		expect(executions).toBe(0);
		expect(report.some((message) => message.role === "toolResult")).toBe(false);
		expect(report.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("no operation was executed"),
			content: [{ type: "text", text: "" }],
		});
	},
);

it.each(["aborted", "error"] as const)(
	"retries a worker report after a provider %s with one durable halt",
	async (failure) => {
		const fixture = providerProjectionFixture(1);
		const halts = new WorkerLaneHalts();
		const reason = "Report the pending edit.";
		const instruction = buildWorkerHaltRequest(reason).userMessage;
		halts.request("worker", reason, 30_000, () => {});
		fixture.config.getHaltRequest = () => halts.take("worker");
		const requests: Context[] = [];
		const sendAttempt = () =>
			runAgentLoop(
				[],
				fixture.source,
				fixture.config,
				() => {},
				undefined,
				(_model, context) => {
					requests.push(context);
					const stream = new AssistantMessageEventStream();
					if (requests.length === 1) {
						stream.push({
							type: "error",
							reason: failure,
							error: { ...assistantReply([], failure), errorMessage: "Transport interrupted." },
						});
					} else {
						stream.push({
							type: "done",
							reason: "stop",
							message: assistantReply([{ type: "text", text: "The edit is pending." }], "stop"),
						});
					}
					return stream;
				},
			);
		try {
			const failed = await sendAttempt();
			expect(failed.at(-1)).toMatchObject({ role: "assistant", stopReason: failure });
			fixture.messages.push(...failed);
			const clarification = "Include the filename in the report.";
			fixture.config.getSteeringMessages = async () => [fixture.userRow(clarification)];
			const resumed = await sendAttempt();
			expect(resumed.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(requests.at(-1)?.messages.at(-2)).toMatchObject({ content: clarification });
			expect(
				[...fixture.messages, ...resumed].filter((row) => row.role === "user" && row.content === instruction),
			).toHaveLength(1);
			expect(requests).toHaveLength(2);
			for (const request of requests) {
				expect(request.messages.filter((row) => row.role === "user" && row.content === instruction)).toHaveLength(
					1,
				);
				expect(request.messages.at(-1)).toMatchObject({ role: "user", content: instruction });
			}
		} finally {
			halts.clear("worker");
		}
	},
);

it.each(["aborted", "exhausted turn budget"] as const)("skips a worker report request when %s", async (stop) => {
	const fixture = providerProjectionFixture(1);
	fixture.config.getHaltRequest = () => buildWorkerHaltRequest("Stop before editing.");
	fixture.config.maxProviderTurns = 1;
	const state = createAgentLoopContinuationState();
	if (stop === "exhausted turn budget") state.providerTurns = 1;
	const turnsBefore = state.providerTurns;
	let dispatches = 0;
	const report = await runAgentLoop(
		[],
		fixture.source,
		fixture.config,
		() => {},
		stop === "aborted" ? AbortSignal.abort() : undefined,
		() => {
			dispatches++;
			throw new Error("Unexpected closing request");
		},
		state,
	);
	expect(dispatches).toBe(0);
	expect(state.providerTurns).toBe(turnsBefore);
	expect(report.some((row) => row.role === "assistant")).toBe(false);
});

it("keeps the durable halt instruction last when admission replans around a failed report", async () => {
	const fixture = providerProjectionFixture(3);
	const request = buildWorkerHaltRequest("Stop and report the remaining work.");
	const halt: UserMessage = { role: "user", content: request.userMessage, timestamp: 1 };
	const failedReport = assistantReply([], "error");
	const retained = fixture.messages[2]!;
	fixture.messages.push(halt, failedReport);
	fixture.source.instructionTail = halt;
	fixture.config.planContext = async ({ messages }) => ({
		messages,
		transientMessages: [
			createCustomMessage("closing-test-note", "Fresh context note.", false, undefined, new Date(0).toISOString()),
		],
	});
	const attempts: number[] = [];
	fixture.config.admitProviderRequest = ({ attempt, context, nonCompactableContext, sourceContext }) => {
		attempts.push(attempt);
		expect(context.messages.at(-1)?.content).toBe(request.userMessage);
		expect(nonCompactableContext.messages.at(-1)?.content).toBe(request.userMessage);
		expect(context.messages.at(-2)?.content).toEqual([
			{ type: "text", text: expect.stringContaining("Fresh context note.") },
		]);
		if (attempt === 0) {
			return {
				action: "replan",
				context: {
					systemPrompt: sourceContext.systemPrompt,
					tools: sourceContext.tools,
					messages: [retained, halt, failedReport],
				},
			};
		}
		return { action: "send" };
	};

	const closing = await fixture.send();
	expect(attempts).toEqual([0, 1]);
	expect(closing.dispatched?.messages.at(-1)?.content).toBe(request.userMessage);
	expect(closing.dispatched?.messages).toHaveLength(4);
	expect(fixture.messages).toEqual([retained, halt, failedReport]);
});

it("does not retain the suffix of a refused dispatch and invalidates on projection policy changes", async () => {
	const fixture = providerProjectionFixture(100);
	const cold = await fixture.send();
	fixture.messages.push(fixture.userRow("Undispatched."));
	fixture.setAccept(false);
	const rejected = await fixture.send();
	expect(rejected.dispatched).toBeUndefined();

	fixture.messages.push(fixture.userRow("Next input."));
	fixture.setAccept(true);
	const retry = await fixture.send();
	expect(retry.work.providerRowsConverted).toBe(2);
	expect(providerMessagePrefix(retry.dispatched!.messages)?.previous).toBe(cold.dispatched!.messages);

	fixture.setPolicy("new compression policy");
	const changed = await fixture.send();
	expect(changed.work.providerRowsConverted).toBe(102);
	expect(providerMessagePrefix(changed.dispatched!.messages)?.count).toBe(0);
});

it.each(["account", "model", "prompt", "tools"] as const)(
	"starts a new provider projection on a %s change",
	async (scope) => {
		const fixture = providerProjectionFixture(100);
		await fixture.send();
		if (scope === "account") fixture.config.providerAccountKey = "another-account";
		if (scope === "model") fixture.config.model = { ...visionModel, id: "another-model" };
		if (scope === "prompt") fixture.source.systemPrompt = "A different system prompt.";
		if (scope === "tools")
			fixture.source.tools = [
				{
					name: "lookup",
					label: "Lookup",
					description: "Look up a fixture.",
					parameters: {},
					execute: async () => ({ content: [], details: undefined }),
				},
			];
		const changed = await fixture.send();
		expect(changed.work.providerRowsConverted).toBe(100);
		expect(providerMessagePrefix(changed.dispatched!.messages)?.count).toBe(0);
	},
);

it("does not retain evidence from mutable caller rows", async () => {
	const fixture = providerProjectionFixture(100);
	const mutable: UserMessage = { role: "user", content: "Before.", timestamp: 0 };
	fixture.messages[0] = mutable;
	const first = await fixture.send();
	expect(providerMessagePrefix(first.dispatched!.messages)).toBeUndefined();

	mutable.content = "After.";
	const second = await fixture.send();
	expect(second.work.providerRowsConverted).toBe(100);
	expect(second.dispatched!.messages[0]?.content).toBe("After.");
	expect(providerMessagePrefix(second.dispatched!.messages)).toBeUndefined();
});

it("does not certify the pre-image-budget array when the provider receives a projection", async () => {
	const fixture = providerProjectionFixture(100);
	fixture.config.model = { ...visionModel, input: ["text"] };
	fixture.messages.push(
		immutableHistoryMessage({
			role: "user",
			timestamp: 1,
			content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
		})!,
	);
	const first = await fixture.send();
	expect(first.dispatched!.messages[100]?.content).toEqual([
		{ type: "text", text: "(image omitted: model does not support images)" },
	]);
	expect(providerMessagePrefix(first.dispatched!.messages)).toBeUndefined();

	fixture.messages.push(fixture.userRow("Follow-up."));
	const next = await fixture.send();
	expect(next.dispatched!.messages[100]?.content).toEqual(first.dispatched!.messages[100]?.content);
	expect(providerMessagePrefix(next.dispatched!.messages)).toBeUndefined();
});

it("extends an accepted packed tool result without replaying the old tool body", async () => {
	const rows = 1_000;
	const fixture = providerProjectionFixture(rows);
	const original = "original tool output line\n".repeat(2_048);
	fixture.messages[1] = immutableHistoryMessage({
		role: "toolResult",
		toolCallId: "large-bash-result",
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text: original }],
		timestamp: 1,
	})!;
	fixture.config.planContext = async ({ messages, sentPrefixCount }) => {
		const gc = applyContextGc(messages, {
			enabled: true,
			preserveRecentMessages: 1,
			packStrideMessages: 1,
			minToolResultChars: 100,
			tools: ["bash"],
			writePayloads: false,
			deferProviderAcceptance: true,
			frozenBelow: sentPrefixCount,
		});
		return {
			messages: gc.messages,
			compressionPolicy: gc.compressionPolicy,
			prepareCommit: gc.isCurrent,
			commit: gc.commit,
			acceptProviderHistory: gc.acceptProviderHistory,
		};
	};
	const cold = await fixture.send();
	const packed = cold.dispatched!.messages[1]!;
	expect(packed.role).toBe("toolResult");
	expect(JSON.stringify(packed.content)).toContain("Never treat summary as original.");
	expect(JSON.stringify(packed.content).length).toBeLessThan(original.length / 10);

	fixture.messages.push(fixture.userRow("Follow-up."));
	const warm = await fixture.send();
	expect(warm.dispatched!.messages[1]).toBe(packed);
	expect(providerMessagePrefix(warm.dispatched!.messages)).toEqual({
		previous: cold.dispatched!.messages,
		count: rows,
	});
	expect(warm.work).toMatchObject({
		oldRowsRead: 0,
		oldBytesRecompressed: 0,
		coldPayloadLoads: 0,
		providerRowsConverted: 1,
	});
});

it.each(["native", "custom", "filtered image"] as const)(
	"keeps framed packed %s history pristine across replan and warm acceptance",
	async (form) => {
		const fixture = providerProjectionFixture(3);
		fixture.messages.splice(0, 3, ...[0, 1, 2].map((index) => fixture.userRow(`Native row ${index}.`)));
		if (form === "custom")
			fixture.messages[0] = immutableHistoryMessage(
				createCustomMessage("converted-row", "Converted custom row.", false, undefined, new Date(0).toISOString()),
			)!;
		if (form === "filtered image") {
			fixture.config.convertToLlm = createProviderMessageConverter(() => true);
			fixture.messages[0] = immutableHistoryMessage({
				role: "user",
				timestamp: 0,
				content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
			})!;
		}
		fixture.messages[1] = immutableHistoryMessage({
			role: "toolResult",
			toolCallId: "packed-frame",
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "Tool result line.\n".repeat(2048) }],
			timestamp: 1,
		})!;
		let note = "Cold request note.";
		const frames: { rows: AgentContext["messages"]; snapshot: string }[] = [];
		fixture.config.planContext = async ({ messages, sentPrefixCount }) => {
			const gc = applyContextGc(messages, {
				enabled: true,
				preserveRecentMessages: 1,
				packStrideMessages: 1,
				minToolResultChars: 100,
				tools: ["bash"],
				writePayloads: false,
				deferProviderAcceptance: true,
				frozenBelow: sentPrefixCount,
			});
			frames.push({ rows: gc.messages, snapshot: JSON.stringify(gc.messages) });
			return {
				messages: gc.messages,
				compressionPolicy: gc.compressionPolicy,
				prepareCommit: gc.isCurrent,
				commit: gc.commit,
				acceptProviderHistory: gc.acceptProviderHistory,
				nonCompactableHead: 0,
				transientMessages: [
					createCustomMessage("request-note", note, false, HOST_REQUEST_ONLY_DETAILS, new Date(0).toISOString()),
				],
			};
		};
		const cold = await fixture.send();
		const coldSnapshot = JSON.stringify(cold.dispatched);
		expect(cold.dispatched!.messages).toHaveLength(4);
		const packed = cold.dispatched!.messages[2];
		expect(JSON.stringify(packed)).toContain("Never treat summary as original.");
		if (form === "custom") expect(JSON.stringify(cold.dispatched!.messages[1])).toContain("Converted custom row.");
		if (form === "filtered image") expect(JSON.stringify(cold.dispatched!.messages[1])).not.toContain("AA==");
		fixture.messages.push(fixture.userRow("Warm owner request."));
		note = "Rejected request note.";
		const attempts: number[] = [];
		fixture.config.admitProviderRequest = ({ attempt, sourceContext }) => {
			attempts.push(attempt);
			if (attempt === 0) {
				note = "Accepted request note.";
				return { action: "replan", context: { ...sourceContext } };
			}
			return { action: "send" };
		};
		const warm = await fixture.send();
		expect(attempts).toEqual([0, 1]);
		expect(warm.dispatched!.messages).toHaveLength(5);
		expect(warm.dispatched!.messages[2]).toBe(packed);
		expect(JSON.stringify(warm.dispatched)).toContain("Accepted request note.");
		expect(JSON.stringify(warm.dispatched)).not.toMatch(/Cold request note|Rejected request note/);
		fixture.config.admitProviderRequest = () => ({ action: "send" });
		fixture.messages.push(fixture.userRow("Next owner request."));
		note = "Final request note.";
		const next = await fixture.send();
		expect(next.dispatched!.messages).toHaveLength(6);
		expect(next.dispatched!.messages.every(Boolean)).toBe(true);
		expect(next.dispatched!.messages[2]).toBe(packed);
		expect(JSON.stringify(next.dispatched)).not.toMatch(
			/Cold request note|Rejected request note|Accepted request note/,
		);
		expect(next.work.providerRowsConverted).toBe(1);
		expect(JSON.stringify(cold.dispatched)).toBe(coldSnapshot);
		for (const frame of frames) {
			expect(Object.isFrozen(frame.rows)).toBe(true);
			expect(JSON.stringify(frame.rows)).toBe(frame.snapshot);
		}
	},
);

function deferredHaltFixture(text: boolean) {
	const fixture = providerProjectionFixture(3);
	fixture.config.textToolCallProtocol = text;
	fixture.source.tools = ["tool_search", ...Array.from({ length: 12 }, (_, i) => `command_${i}`)].map((name) => ({
		name,
		label: name,
		description: name === "tool_search" ? "Load schemas by name." : name.repeat(500),
		parameters: {},
		execute: async () => {
			throw new Error("The report may not execute a tool.");
		},
	}));
	const search = (name: string) =>
		immutableHistoryMessage({
			role: "toolResult",
			toolCallId: name,
			toolName: "tool_search",
			isError: false,
			timestamp: 2,
			content: [{ type: "text", text: "Search finished." }],
			details: { kind: "deferred_tool_schema_search", query: `select:${name}`, maxResults: 1 },
		})!;
	const halt = fixture.userRow(buildWorkerHaltRequest("Report the pending discovery.").userMessage);
	if (halt.role !== "user") throw new Error("Expected an immutable halt instruction.");
	const sendReport = () => {
		fixture.messages.push(halt);
		fixture.source.instructionTail = halt;
		return fixture.send();
	};
	return { ...fixture, search, halt, sendReport };
}

it.each([false, true])(
	"keeps accepted deferred declarations when a search completes just before halt (text=%s)",
	async (text) => {
		const fixture = deferredHaltFixture(text);
		let noteStart = 0;
		let noteTexts = ["First worker note."];
		fixture.config.planContext = async ({ messages }) => ({
			messages,
			nonCompactableHead: noteStart,
			transientMessages: noteTexts.map((note) =>
				createCustomMessage("worker-note", note, false, HOST_REQUEST_ONLY_DETAILS, new Date(0).toISOString()),
			),
		});
		fixture.messages.push(fixture.search("command_10"));
		const accepted = (await fixture.send()).dispatched!;
		if (!text) {
			expect(accepted.tools?.map((tool) => tool.name)).toContain("command_10");
			expect(accepted.tools?.map((tool) => tool.name)).not.toContain("command_11");
		}
		// Move the live note across the accepted search, and change its length and content.
		noteStart = fixture.messages.length;
		noteTexts = ["Updated worker note.", "Second worker note."];
		fixture.messages.push(fixture.search("command_11"));
		const report = (await fixture.sendReport()).dispatched!;
		expect(report.tools).toEqual(accepted.tools);
		expect(report.systemPrompt).toBe(accepted.systemPrompt);
		if (text) expect(report.messages[0]).toBe(accepted.messages[0]);
		const guardCount = Number(text);
		expect(report.messages.slice(guardCount, guardCount + noteStart)).toEqual(
			accepted.messages.slice(guardCount + 1),
		);
		expect(
			report.messages
				.slice(guardCount + noteStart, guardCount + noteStart + noteTexts.length)
				.map((row) => row.content),
		).toEqual(noteTexts.map((note) => [{ type: "text", text: note }]));
		expect(report.messages.at(-2)).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: expect.stringContaining('"name":"command_11"') }],
		});
		expect(report.messages.at(-1)?.content).toBe(fixture.halt.content);
	},
);

it("checks a new image inserted before a halted worker's accepted image-free history", async () => {
	const fixture = deferredHaltFixture(true);
	fixture.config.model = { ...visionModel, input: ["text"] };
	let note: string | ImageContent[] = "Worker knowledge.";
	fixture.config.planContext = async ({ messages }) => ({
		messages,
		transientMessages: [
			createCustomMessage("worker-note", note, false, HOST_REQUEST_ONLY_DETAILS, new Date(0).toISOString()),
		],
	});
	await fixture.send();
	note = [{ type: "image", mimeType: "image/png", data: "AQID" }];
	const report = (await fixture.sendReport()).dispatched!;
	expect(report.messages[1]?.content).toEqual([{ type: "text", text: NON_VISION_USER_IMAGE_PLACEHOLDER }]);
	expect(report.messages.at(-1)?.content).toBe(fixture.halt.content);
});

it("recomputes halt disclosure if a projected-out search changes in durable history", async () => {
	const fixture = deferredHaltFixture(false);
	fixture.config.planContext = async ({ messages }) => ({
		messages: messages.filter((row) => row.role !== "toolResult"),
	});
	const index = fixture.messages.length;
	fixture.messages.push(fixture.search("command_10"));
	const before = (await fixture.send()).dispatched!;
	expect(before.tools?.map((tool) => tool.name)).toContain("command_10");
	fixture.messages[index] = fixture.search("command_11");
	const report = (await fixture.sendReport()).dispatched!;
	const visible = report.tools?.map((tool) => tool.name);
	expect(visible).toContain("command_11");
	expect(visible).not.toContain("command_10");
});
