import { EventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, AssistantMessageEvent, Context, Message, Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

/**
 * DIAGNOSTIC PROBE for turn-economics Task 10 - NOT a permanent regression gate (though it may be
 * promoted to one once the real fix lands). Question under test: does `packages/agent`'s own
 * request-construction pipeline preserve message OBJECT REFERENCES, turn over turn, for the portion
 * of `Context.messages` a previous request already sent?
 *
 * This directly mirrors what `messagesPreserveCachedPrefix` in
 * packages/ai/src/providers/openai-codex-responses.ts checks (read-only reference, not edited here):
 *
 *   for (let index = 0; index < continuation.sourceMessageCount; index++) {
 *     if (context.messages[index] !== continuation.sourceMessages[index]) return false;
 *   }
 *
 * where `continuation.sourceMessageCount`/`sourceMessages` are `context.messages.length`/
 * `context.messages` captured verbatim (by reference) at the moment the PREVIOUS request was sent
 * (openai-codex-responses.ts line ~1744-1745: `sourceMessages: context.messages`). The probe below
 * reproduces that exact comparison against the actual `context` argument `streamFn` receives on two
 * consecutive turns of a real `agentLoop` run - i.e. it asks the same question with `===` instead of
 * `toEqual`, which `provider-request-prefix-stability.test.ts` never checks (that gate is deliberately
 * about BYTE content, not object identity - see its own docstring).
 *
 * Two scenarios:
 *   - "clean": no tool failure, no verification obligation - the simplest possible multi-turn growth.
 *   - "with ledger/obligation": reuses the fixture shape from provider-request-prefix-stability - a
 *     failing tool call arms the ledger and an obligation, both rebuilt fresh every request by design
 *     (see provider-request-planner.ts's trailing-region comment and Task 2/Task 4 in the remediation
 *     doc). Hypothesis: this is exactly the region that breaks reference identity, because it always
 *     rides at the tail of `context.messages`, but new durable content is inserted BEFORE it on the
 *     next turn - so its rebuilt-fresh object no longer occupies the same array index, and everything
 *     from that index forward mismatches by reference even when unchanged by content.
 */

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function pushDone(stream: MockAssistantStream, message: AssistantMessage): void {
	const { stopReason } = message;
	if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "toolUse") {
		throw new Error(`Invalid provider done reason: ${stopReason}`);
	}
	stream.push({ type: "done", reason: stopReason, message });
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(id: string): Model<"openai-responses"> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 2_048,
	};
}

const MODEL_A = createModel("model-a");

function createAssistantMessage(
	content: AssistantMessage["content"],
	model: Model<"openai-responses">,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(),
		stopReason,
		timestamp: 0,
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** Exactly what `messagesPreserveCachedPrefix` checks - reference equality of every message the
 * PREVIOUS request sent, against the SAME positions in the CURRENT request. */
function referenceStablePrefixLength(previous: readonly Message[], current: readonly Message[]): number {
	const limit = Math.min(previous.length, current.length);
	for (let index = 0; index < limit; index++) {
		if (previous[index] !== current[index]) return index;
	}
	return limit;
}

const readSchema = Type.Object({ path: Type.String() });
const readTool: AgentTool<typeof readSchema, { path: string }> = {
	name: "read",
	label: "Read",
	description: "Read a file",
	parameters: readSchema,
	async execute(_toolCallId, params) {
		return { content: [{ type: "text", text: `contents of ${params.path}` }], details: { path: params.path } };
	},
};

const verifySchema = Type.Object({ status: Type.Union([Type.Literal("failed"), Type.Literal("passed")]) });
type VerifyDetails = { piVerification: { version: 1; id: string; status: "failed" | "passed" } };
const verifyTool: AgentTool<typeof verifySchema, VerifyDetails> = {
	name: "verify",
	label: "Verify",
	description: "Run the verification suite",
	parameters: verifySchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `suite ${params.status}` }],
			details: { piVerification: { version: 1, id: "suite", status: params.status } },
			isError: params.status === "failed",
		};
	},
};

async function runScript(
	tools: AgentTool<any, any>[],
	script: ReadonlyArray<(model: Model<"openai-responses">) => AssistantMessage>,
): Promise<Context[]> {
	const requests: Context[] = [];
	let scriptIndex = 0;
	const streamFn = (model: Model<any>, context: Context) => {
		requests.push(context);
		const stream = new MockAssistantStream();
		const turn = scriptIndex;
		scriptIndex++;
		queueMicrotask(() => {
			pushDone(stream, script[turn](model as Model<"openai-responses">));
		});
		return stream;
	};
	const context: AgentContext = { systemPrompt: "You are a careful engineer.", messages: [], tools };
	const config: AgentLoopConfig = { model: MODEL_A, convertToLlm: identityConverter };
	const stream = agentLoop([createUserMessage("Do the work.")], context, config, undefined, streamFn);
	for await (const _event of stream) {
		// drain
	}
	return requests;
}

describe("websocket delta reference-identity probe (Task 10 diagnostic, not a fix)", () => {
	it("clean multi-turn growth (no tool failure, no obligation): does the prefix stay reference-stable?", async () => {
		const script: ReadonlyArray<(model: Model<"openai-responses">) => AssistantMessage> = [
			(m) =>
				createAssistantMessage(
					[{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }],
					m,
					"toolUse",
				),
			(m) =>
				createAssistantMessage(
					[{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "b.ts" } }],
					m,
					"toolUse",
				),
			(m) =>
				createAssistantMessage(
					[{ type: "toolCall", id: "read-3", name: "read", arguments: { path: "c.ts" } }],
					m,
					"toolUse",
				),
			(m) => createAssistantMessage([{ type: "text", text: "Done." }], m, "stop"),
		];
		const requests = await runScript([readTool], script);
		expect(requests).toHaveLength(script.length);

		const report = requests.slice(1).map((request, i) => {
			const previous = requests[i];
			const stableLen = referenceStablePrefixLength(previous.messages, request.messages);
			return {
				turn: i + 1,
				previousLength: previous.messages.length,
				currentLength: request.messages.length,
				referenceStablePrefixLength: stableLen,
				fullyStable: stableLen === previous.messages.length,
			};
		});
		// eslint-disable-next-line no-console
		console.log("CLEAN SCRIPT reference-stability report:", JSON.stringify(report, null, 2));

		// Evidence, not assumption: report whether the clean case (no ledger/obligation machinery at
		// all) preserves reference identity for everything the previous turn sent. If this is true,
		// the break is specifically the trailing ledger/obligation mechanism (see the other test
		// below). If this is ALREADY false here, the break is more fundamental - somewhere in the
		// durable message array construction itself, independent of ledger/obligation.
		for (const entry of report) {
			expect(entry.fullyStable).toBe(true);
		}
	});

	it("with tool-failure ledger + verification obligation active: does the prefix stay reference-stable?", async () => {
		const script: ReadonlyArray<(model: Model<"openai-responses">) => AssistantMessage> = [
			(m) =>
				createAssistantMessage(
					[{ type: "toolCall", id: "verify-1", name: "verify", arguments: { status: "failed" } }],
					m,
					"toolUse",
				),
			(m) =>
				createAssistantMessage(
					[{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }],
					m,
					"toolUse",
				),
			(m) =>
				createAssistantMessage(
					[{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "b.ts" } }],
					m,
					"toolUse",
				),
			// Resolves the obligation armed by verify-1 before the loop is allowed to stop - an
			// unresolved verification obligation forces a closing turn (verification-obligations.ts),
			// so a script that never resolves it needs an extra unscripted entry and hangs instead.
			(m) =>
				createAssistantMessage(
					[{ type: "toolCall", id: "verify-2", name: "verify", arguments: { status: "passed" } }],
					m,
					"toolUse",
				),
			(m) => createAssistantMessage([{ type: "text", text: "Done." }], m, "stop"),
		];
		const requests = await runScript([readTool, verifyTool], script);
		expect(requests).toHaveLength(script.length);

		const report = requests.slice(1).map((request, i) => {
			const previous = requests[i];
			const stableLen = referenceStablePrefixLength(previous.messages, request.messages);
			return {
				turn: i + 1,
				previousLength: previous.messages.length,
				currentLength: request.messages.length,
				referenceStablePrefixLength: stableLen,
				fullyStable: stableLen === previous.messages.length,
				// What sits at the first index that breaks reference equality, if any - to see whether
				// it is specifically the trailing ledger/obligation region or something in the core.
				firstBreakPreviousMessage:
					stableLen < previous.messages.length ? summarize(previous.messages[stableLen]) : undefined,
				firstBreakCurrentMessage:
					stableLen < previous.messages.length ? summarize(request.messages[stableLen]) : undefined,
			};
		});
		// eslint-disable-next-line no-console
		console.log("LEDGER/OBLIGATION SCRIPT reference-stability report:", JSON.stringify(report, null, 2));

		// This assertion is deliberately NOT `expect(fullyStable).toBe(true)` - the whole point of this
		// probe is to observe and report the actual outcome, not assume it. It only fails (loudly, via
		// the console.log above surviving in test output) if there are literally no turns to compare.
		expect(report.length).toBeGreaterThan(0);
	});
});

function summarize(message: Message | undefined): unknown {
	if (!message) return undefined;
	if (message.role === "user") {
		return {
			role: message.role,
			content: typeof message.content === "string" ? message.content.slice(0, 60) : "[blocks]",
		};
	}
	if (message.role === "assistant") {
		return { role: message.role, content: message.content.map((b) => b.type) };
	}
	if (message.role === "toolResult") {
		return { role: message.role, toolCallId: message.toolCallId };
	}
	return { role: (message as Message).role };
}
