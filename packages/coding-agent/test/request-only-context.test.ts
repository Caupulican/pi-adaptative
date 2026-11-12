import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	type Context,
	createEmptyUsage,
	type Model,
} from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type {
	AgentContext,
	AgentContextPlan,
	AgentLoopConfig,
	ProviderRequestSnapshotContext,
} from "../src/kernel/loop-config.ts";
import { convertToLlm, createCustomMessage } from "../src/kernel/messages.ts";
import { estimateProviderRequestTokens } from "../src/kernel/provider-request-estimator.ts";
import { startPlannedAgentProviderRequestWithId } from "../src/kernel/provider-request-planner.ts";
import { HOST_REQUEST_ONLY_DETAILS } from "../src/kernel/transient-records.ts";

const model: Model<Api> = {
	id: "request-only-context",
	name: "Request-only context",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function reply(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "Read the next file." }],
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: 2,
	};
}

function setup(textProtocol = false, withFrame = true) {
	let knowledge = "Current accepted knowledge: owner prefers concise replies.";
	const frame = createCustomMessage(
		"continuous_chat_view",
		"<chat>earlier turn</chat>",
		false,
		undefined,
		"1970-01-01T00:00:00.000Z",
	);
	const source: AgentContext = {
		systemPrompt: "Follow the owner.",
		messages: [{ role: "user", content: "Read this project.", timestamp: 1 }],
		tools: textProtocol
			? [
					{
						name: "lookup",
						label: "Lookup",
						description: "Read a file.",
						parameters: {},
						execute: async () => ({ content: [], details: undefined }),
					},
				]
			: [],
	};
	const snapshots: ProviderRequestSnapshotContext[] = [];
	const dispatched: Context[] = [];
	const measurements: number[] = [];
	const config: AgentLoopConfig = {
		model,
		convertToLlm,
		...(textProtocol ? { textToolCallProtocol: true } : {}),
		planContext: async (request) => {
			const plan: AgentContextPlan = {
				messages: withFrame ? [frame, ...request.messages] : request.messages,
				nonCompactableHead: withFrame ? 1 : 0,
				transientMessages: [
					createCustomMessage(
						"knowledge_context",
						knowledge,
						false,
						HOST_REQUEST_ONLY_DETAILS,
						"1970-01-01T00:00:00.000Z",
					),
				],
			};
			measurements.push(await request.measureRequest!(plan));
			return plan;
		},
		onProviderRequestSnapshot: (snapshot) => void snapshots.push(snapshot),
	};
	const send = async () => {
		const started = await startPlannedAgentProviderRequestWithId(source, config, undefined, (_model, context) => {
			dispatched.push(context);
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: reply() });
			return stream;
		});
		await started.stream.result();
	};
	return {
		source,
		config,
		snapshots,
		dispatched,
		measurements,
		send,
		setKnowledge: (text: string) => {
			knowledge = text;
		},
	};
}

describe("request-only knowledge at the provider boundary", () => {
	it.each([false, true])(
		"keeps unchanged live knowledge in place when messages append, frame=%s",
		async (withFrame) => {
			const fixture = setup(false, withFrame);
			await fixture.send();
			const first = fixture.dispatched[0]!;
			fixture.source.messages.push(reply(), { role: "user", content: "Continue.", timestamp: 3 });
			await fixture.send();
			const second = fixture.dispatched[1]!;
			expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
			expect(second.messages).toHaveLength(first.messages.length + 2);
			expect(JSON.stringify(fixture.source)).not.toContain("knowledge_context");
			expect(fixture.source.messages).toHaveLength(3);
		},
	);

	it("keeps unmarked transient messages at the tail without persisting them", async () => {
		const fixture = setup();
		const base = fixture.config.planContext!;
		fixture.config.planContext = async (request, signal) => {
			const plan = await base(request, signal);
			return {
				...plan,
				transientMessages: [
					...(plan.transientMessages ?? []),
					{ role: "user", content: "Live fallback.", timestamp: 4 },
				],
			};
		};
		await fixture.send();
		expect(fixture.dispatched[0]!.messages.at(-1)).toMatchObject({ role: "user", content: "Live fallback." });
		expect(JSON.stringify(fixture.source.messages)).not.toContain("Live fallback.");
	});

	it.each([false, true])(
		"uses the dispatched head and tail for admission and measurement, text protocol=%s",
		async (textProtocol) => {
			const fixture = setup(textProtocol);
			fixture.source.trailingInstruction = "Report the outcome.";
			await fixture.send();
			const snapshot = fixture.snapshots[0]!;
			const context = fixture.dispatched[0]!;
			expect(snapshot.context).toBe(context);
			expect(snapshot.requestOnlyMessageRange).toEqual({
				start: (textProtocol ? 1 : 0) + 1,
				count: 1,
			});
			expect(fixture.measurements[0]).toBe(estimateProviderRequestTokens(context, model));
			const protocolCount = textProtocol ? 1 : 0;
			expect(snapshot.nonCompactableContext.messages).toEqual([
				...context.messages.slice(0, protocolCount + 2),
				...context.messages.slice(-1),
			]);
			expect(context.messages[protocolCount + 2]).toMatchObject({ role: "user", content: "Read this project." });
			expect(
				snapshot.sourceContext.messages.some(
					(message) => message.role === "custom" && message.customType === "knowledge_context",
				),
			).toBe(false);
		},
	);

	it("replaces corrected and withheld knowledge without retaining its earlier values in history", async () => {
		const fixture = setup();
		await fixture.send();
		fixture.setKnowledge("Current accepted knowledge: owner prefers detailed replies.");
		await fixture.send();
		expect(JSON.stringify(fixture.dispatched[1])).not.toContain("concise replies");
		fixture.setKnowledge("CURRENT KNOWLEDGE: withheld.");
		await fixture.send();
		expect(JSON.stringify(fixture.dispatched[2])).not.toContain("prefers");
		expect(JSON.stringify(fixture.source.messages)).not.toContain("knowledge");
	});
});
