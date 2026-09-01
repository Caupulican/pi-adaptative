import { EventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, AssistantMessageEvent, Context, Message, Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { Agent } from "../src/index.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

/**
 * Regression gate for the turn-economics remediation (see
 * packages/coding-agent/docs/turn-economics-remediation-2026-08-31.md, "A1 - Provider input must be
 * strictly append-only" and its A2/A4 sub-defects). The property under test:
 *
 *   For consecutive provider requests R(n) and R(n+1) in one run, R(n)'s messages are a
 *   byte-identical PREFIX of R(n+1)'s messages, except for a trailing region (the verification
 *   obligation instruction and/or the tool-failure ledger). No message already sent to the
 *   provider is ever rewritten or removed by a later request.
 *
 * The scenario below deliberately exercises every path that can violate this:
 *   - a failing tool call, which arms the tool-failure ledger (tool-failure-memory.ts);
 *   - the SAME tool called again with identical arguments two turns later, which is exactly what
 *     `sanitizeToolFailureContext`'s superseded-success dedup targets - if the "already sent" mark
 *     is lost, the first (already-sent) call is wrongly erased when the second is seen;
 *   - a verification obligation appearing (the failing call also reports a failed verification)
 *     and later resolving (a passing call for the same obligation id);
 *   - a model/reasoning change on every turn via `prepareNextTurn`, which is precisely the path
 *     that replaces `config` with a new object each turn (agent-loop.ts).
 *
 * This test must fail if any fix it guards is reverted:
 *   - Task 1 (the "already sent" mark keyed by run identity, not config object identity): reverting
 *     it makes the mark reset to 0 every turn, so the repeated `read` call's first occurrence gets
 *     erased once the second occurrence is seen - breaking the prefix invariant.
 *   - Task 2 (verification-obligation text delivered at the trailing position, not in
 *     `systemPrompt`): reverting it makes `systemPrompt` change when the obligation appears and
 *     again when it resolves, which this test also asserts against directly.
 *   - Task 4 (the ledger message built with a fixed timestamp, not `Date.now()`): reverting it makes
 *     the ledger MESSAGE differ between consecutive requests even when the ledger TEXT is unchanged.
 *   - Task 5 (`sentPrefixCount` exposed on `AgentContextPlanRequest` for a host's context-GC packer):
 *     reverting it, or wiring it to the wrong value, breaks the bounds/monotonicity/non-vacuousness
 *     checks against `planContext`'s captured calls.
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
const MODEL_B = createModel("model-b");

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

function messageText(message: Message): string {
	if (message.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** True for the two request-local transient messages this run can project: the ledger and the
 * verification-obligation instruction. Both always ride at the very tail (see
 * provider-request-planner.ts); this run configures no host-owned `planContext`/`transformContext`,
 * so nothing else can appear after the compactable core. */
function isSyntheticTrailingMessage(message: Message): boolean {
	const text = messageText(message);
	return text.startsWith("ACTIVE VERIFICATION FAILURES") || text.startsWith("MANDATORY TOOL FAILURE RECOVERY");
}

/** The compactable core of a request: everything except the trailing ledger/obligation messages. */
function coreMessages(context: Context): Message[] {
	const messages = context.messages.slice();
	while (messages.length > 0 && isSyntheticTrailingMessage(messages[messages.length - 1])) {
		messages.pop();
	}
	return messages;
}

function findTrailingMessage(context: Context, marker: string): Message | undefined {
	return context.messages.find((message) => messageText(message).startsWith(marker));
}

function obligationMessage(context: Context): Message | undefined {
	return findTrailingMessage(context, "ACTIVE VERIFICATION FAILURES");
}

function ledgerMessage(context: Context): Message | undefined {
	return findTrailingMessage(context, "MANDATORY TOOL FAILURE RECOVERY");
}

function obligationInstructionOf(context: Context): string {
	const message = obligationMessage(context);
	return message ? messageText(message) : "";
}

function ledgerOf(context: Context): string {
	const message = ledgerMessage(context);
	return message ? messageText(message) : "";
}

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

/**
 * Six scripted assistant turns: fail verification (arms ledger + obligation) -> read a.ts -> read
 * a.ts again (identical args; the erasure hazard) -> pass verification (resolves the obligation) ->
 * read b.ts (ordinary continued growth) -> tool-free close.
 */
const SCRIPT: ReadonlyArray<(model: Model<"openai-responses">) => AssistantMessage> = [
	(model) =>
		createAssistantMessage(
			[{ type: "toolCall", id: "verify-1", name: "verify", arguments: { status: "failed" } }],
			model,
			"toolUse",
		),
	(model) =>
		createAssistantMessage(
			[{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }],
			model,
			"toolUse",
		),
	(model) =>
		createAssistantMessage(
			[{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "a.ts" } }],
			model,
			"toolUse",
		),
	(model) =>
		createAssistantMessage(
			[{ type: "toolCall", id: "verify-2", name: "verify", arguments: { status: "passed" } }],
			model,
			"toolUse",
		),
	(model) =>
		createAssistantMessage(
			[{ type: "toolCall", id: "read-3", name: "read", arguments: { path: "b.ts" } }],
			model,
			"toolUse",
		),
	(model) => createAssistantMessage([{ type: "text", text: "All checks pass; work complete." }], model, "stop"),
];

describe("provider request prefix stability (turn-economics A1/A2/A4 regression gate)", () => {
	it("never rewrites an already-sent message across a failing tool call, a resolved obligation, and a model change", async () => {
		const requests: { model: string; context: Context }[] = [];
		let scriptIndex = 0;
		let prepareNextTurnCalls = 0;
		const streamFn = (model: Model<any>, context: Context) => {
			requests.push({ model: model.id, context });
			const stream = new MockAssistantStream();
			const turn = scriptIndex;
			scriptIndex++;
			queueMicrotask(() => {
				pushDone(stream, SCRIPT[turn](model as Model<"openai-responses">));
			});
			return stream;
		};

		const planRequests: { sentPrefixCount: number; messagesLength: number }[] = [];
		const context: AgentContext = {
			systemPrompt: "You are a careful engineer.",
			messages: [],
			tools: [verifyTool, readTool],
		};
		const config: AgentLoopConfig = {
			model: MODEL_A,
			convertToLlm: identityConverter,
			// Pass-through planner whose only job here is to record the `sentPrefixCount` the loop
			// hands it (see AgentContextPlanRequest) - the seam the host's context-GC packer will read
			// to know where "already sent" ends. Behaves exactly like the default (no `planContext`
			// configured) otherwise.
			planContext: async ({ messages, sentPrefixCount }) => {
				planRequests.push({ sentPrefixCount, messagesLength: messages.length });
				return { messages };
			},
			// Mirrors the host behavior the remediation doc measured: `prepareNextTurn` returns a
			// snapshot unconditionally, every turn, alternating the model/reasoning actually used.
			// Each snapshot forces agent-loop.ts to replace `config` with a new object.
			prepareNextTurn: async () => {
				prepareNextTurnCalls++;
				return prepareNextTurnCalls % 2 === 0
					? { model: MODEL_B, thinkingLevel: "high" as const }
					: { model: MODEL_A, thinkingLevel: "low" as const };
			},
		};

		const stream = agentLoop(
			[createUserMessage("Fix the regression and verify it.")],
			context,
			config,
			undefined,
			streamFn,
		);
		for await (const _event of stream) {
			// drain
		}

		expect(requests).toHaveLength(SCRIPT.length);
		// The model/reasoning change actually happened - otherwise this test would not exercise the
		// config-cloning path at all.
		expect(new Set(requests.map((r) => r.model))).toEqual(new Set([MODEL_A.id, MODEL_B.id]));

		// Task 5: `planContext` receives the same `sentPrefixCount` the planner clamps for
		// `sanitizeToolFailureContext` - the seam a host context-GC packer reads to know where
		// "already sent" ends (see AgentContextPlanRequest.sentPrefixCount). Called once per turn
		// here (this script never replans or hits a stale-plan retry).
		expect(planRequests).toHaveLength(SCRIPT.length);
		// Nothing has gone out before the very first request.
		expect(planRequests[0].sentPrefixCount).toBe(0);
		for (const entry of planRequests) {
			// Always a valid index into the history it was computed against - never past the end.
			expect(entry.sentPrefixCount).toBeLessThanOrEqual(entry.messagesLength);
			expect(entry.sentPrefixCount).toBeGreaterThanOrEqual(0);
		}
		for (let i = 0; i < planRequests.length - 1; i++) {
			expect(planRequests[i + 1].sentPrefixCount).toBeGreaterThanOrEqual(planRequests[i].sentPrefixCount);
		}
		// Confirm the value genuinely tracks what has been sent rather than sitting at a constant
		// (e.g. a regression that always passed 0, or the admission-attempt counter instead of the
		// real mark, would satisfy every check above while still being wrong).
		expect(planRequests.some((entry) => entry.sentPrefixCount > 0)).toBe(true);

		// Task 2: systemPrompt sits at byte zero of the request and must stay byte-identical for the
		// whole run, including across the turn where the obligation appears and the turn where it
		// resolves. Reverting Task 2 reintroduces `verificationObligations.appendSystemPrompt(...)`,
		// which changes this value at requests[1] (obligation appears) and again once it clears.
		for (const request of requests) {
			expect(request.context.systemPrompt).toBe(requests[0].context.systemPrompt);
		}

		// Sanity: the obligation and ledger appear/resolve exactly where the script expects.
		expect(obligationInstructionOf(requests[0].context)).toBe("");
		expect(ledgerOf(requests[0].context)).toBe("");
		expect(obligationInstructionOf(requests[1].context)).toContain("suite");
		expect(ledgerOf(requests[1].context)).not.toBe("");
		// Still active through the duplicate-read turns (not resolved until the passing verify call).
		expect(obligationInstructionOf(requests[3].context)).toContain("suite");
		// Resolved as of the request built after the passing verify call (requests[4] = turn 5).
		expect(obligationInstructionOf(requests[4].context)).toBe("");
		// The ledger for the ORIGINAL failure is never explicitly cleared in this script (the passing
		// call uses different arguments, a different operation identity) - it stays active, which
		// keeps exercising prefix stability for a long-lived bounded failure record.
		expect(ledgerOf(requests[4].context)).not.toBe("");
		expect(ledgerOf(requests[5].context)).not.toBe("");

		// Task 1 (the core invariant): every request's compactable core is a byte-identical prefix of
		// the next request's compactable core. Reverting Task 1 makes the mark reset to 0 every turn
		// (since `prepareNextTurn` above clones `config` every turn), so requests[3] (built after the
		// SECOND `read(a.ts)` at turn 3) wrongly erases the FIRST `read(a.ts)` call/result that
		// requests[2] already sent - violating this exact check.
		for (let i = 0; i < requests.length - 1; i++) {
			const previousCore = coreMessages(requests[i].context);
			const nextCore = coreMessages(requests[i + 1].context);
			expect(nextCore.length).toBeGreaterThanOrEqual(previousCore.length);
			expect(nextCore.slice(0, previousCore.length)).toEqual(previousCore);
		}

		// Task 4 (closes the hole the check above leaves open): `coreMessages` deliberately excludes
		// the trailing region, so a nondeterministic trailing message - e.g. a ledger built with
		// `timestamp: Date.now()` instead of a fixed constant - would slip past every assertion so
		// far even though it rewrites an already-sent message on every single request. Whenever the
		// ledger TEXT is unchanged between two consecutive requests, the ledger MESSAGE itself must be
		// byte-identical too. Same check for the obligation message, for the same reason.
		let comparedStableLedgerPairs = 0;
		let comparedStableObligationPairs = 0;
		for (let i = 0; i < requests.length - 1; i++) {
			const previousLedger = ledgerMessage(requests[i].context);
			const nextLedger = ledgerMessage(requests[i + 1].context);
			if (previousLedger && nextLedger && messageText(previousLedger) === messageText(nextLedger)) {
				expect(nextLedger).toEqual(previousLedger);
				comparedStableLedgerPairs++;
			}
			const previousObligation = obligationMessage(requests[i].context);
			const nextObligation = obligationMessage(requests[i + 1].context);
			if (previousObligation && nextObligation && messageText(previousObligation) === messageText(nextObligation)) {
				expect(nextObligation).toEqual(previousObligation);
				comparedStableObligationPairs++;
			}
		}
		// Confirm the script actually exercised both comparisons above at least once - otherwise they
		// would vacuously pass regardless of whether the timestamp were fixed.
		expect(comparedStableLedgerPairs).toBeGreaterThan(0);
		expect(comparedStableObligationPairs).toBeGreaterThan(0);

		// Confirm the erasure hazard was genuinely present in the transcript for this check to mean
		// anything: both `read(a.ts)` calls actually appear (uncollapsed) somewhere across the run.
		const readCallCount = requests
			.at(-1)
			?.context.messages.filter(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "toolCall" && block.id === "read-1"),
			).length;
		expect(readCallCount).toBe(1);
	});
});

/**
 * Task 9 regression gate: the sanitizer horizon must be SESSION-scoped (persist across every
 * top-level prompt for the life of one `Agent`), not RUN-scoped (reset every prompt like the
 * pack-freeze horizon does). See `ProviderRequestPrefixState` in types.ts for why the two marks
 * must have different lifetimes, and `Agent.runPromptMessages`/`syncSanitizerPrefixHorizon` for
 * where the session-scoped one is threaded through.
 *
 * This exercises `Agent` directly (not `agentLoop`), because the defect is specifically in
 * `Agent.runPromptMessages` minting a fresh continuation state - and hence a fresh mark - on every
 * new top-level prompt. Nothing about `agentLoop` alone can reproduce a bug that only exists at the
 * multi-prompt, `Agent`-owns-the-session layer.
 */
const failSchema = Type.Object({});
const failTool: AgentTool<typeof failSchema, undefined> = {
	name: "fail_tool",
	label: "Fail Tool",
	description: "A tool that always fails",
	parameters: failSchema,
	async execute() {
		return { content: [{ type: "text", text: "boom" }], details: undefined, isError: true };
	},
};

describe("sanitizer horizon persists across prompts on one Agent (turn-economics regression)", () => {
	it("does not rewrite first-prompt history at the start of a second prompt, even with a failing tool call in the first", async () => {
		const requests: Context[] = [];
		let turn = 0;
		const streamFn = (model: Model<any>) => {
			const stream = new MockAssistantStream();
			const thisTurn = turn;
			turn++;
			queueMicrotask(() => {
				const activeModel = model as Model<"openai-responses">;
				const message =
					thisTurn === 0
						? createAssistantMessage(
								[{ type: "toolCall", id: "fail-1", name: "fail_tool", arguments: {} }],
								activeModel,
								"toolUse",
							)
						: thisTurn === 1
							? createAssistantMessage(
									[{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }],
									activeModel,
									"toolUse",
								)
							: thisTurn === 2
								? createAssistantMessage(
										// Duplicate of turn 1's call, still WITHIN prompt 1 - already correctly
										// protected today, since the mark never resets mid-prompt. Establishes
										// that read-1 legitimately gets SENT (as part of this turn's request)
										// before prompt 1 ends.
										[{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "a.ts" } }],
										activeModel,
										"toolUse",
									)
								: createAssistantMessage([{ type: "text", text: "Prompt done." }], activeModel, "stop");
				pushDone(stream, message);
			});
			return stream;
		};

		const agent = new Agent({
			initialState: { systemPrompt: "You are a careful engineer.", tools: [failTool, readTool], model: MODEL_A },
			convertToLlm: identityConverter,
			streamFn,
		});

		await agent.prompt("Fix the regression and verify it.");
		expect(agent.state.errorMessage).toBeUndefined();

		// Capture prompt 2's own request separately so a request-order mistake in this test can't be
		// mistaken for the defect under test.
		const priorRequestCount = requests.length;
		const originalStreamFn = agent.streamFn;
		agent.streamFn = (model, context, options) => {
			requests.push(context);
			return originalStreamFn(model, context, options);
		};
		await agent.prompt("Now double-check your work.");
		expect(agent.state.errorMessage).toBeUndefined();
		expect(requests.length).toBeGreaterThan(priorRequestCount);

		// prompt 2's very first request - built the instant prompt 2 starts, before ANY of prompt 2's
		// own turns have been accepted - is exactly where the bug fires: the mark resetting to 0 here
		// would license erasing read-1, even though it was already sent during prompt 1.
		const secondPromptFirstRequest = requests[priorRequestCount];
		const toolCallIds = secondPromptFirstRequest.messages
			.filter((message): message is Extract<Message, { role: "assistant" }> => message.role === "assistant")
			.flatMap((message) => message.content.filter((block) => block.type === "toolCall").map((block) => block.id));
		expect(toolCallIds).toContain("read-1");
		expect(toolCallIds).toContain("read-2");
	});
});
