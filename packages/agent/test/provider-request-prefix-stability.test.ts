import { EventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, AssistantMessageEvent, Context, Message, Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { Agent } from "../src/index.ts";
import { TOOL_FAILURE_LEDGER_CLEARED_TEXT, TOOL_FAILURE_LEDGER_TRANSIENT_KIND } from "../src/tool-failure-memory.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";
import {
	VERIFICATION_OBLIGATION_TRANSIENT_KIND,
	VERIFICATION_OBLIGATIONS_CLEARED_TEXT,
} from "../src/verification-obligations.ts";

/**
 * Regression gate for the turn-economics remediation (see
 * packages/coding-agent/docs/turn-economics-remediation-2026-08-31.md, "A1 - Provider input must be
 * strictly append-only" and its A2/A4 sub-defects, plus the append-on-change extension to A1 -
 * transient-records.ts). The property under test, now the STRONG form the websocket delta cache
 * actually needs (see the Task 10 diagnosis and packages/ai's `messagesPreserveCachedPrefix`):
 *
 *   For consecutive provider requests R(n) and R(n+1) in one run, R(n)'s ENTIRE messages array -
 *   transients (the verification-obligation instruction, the tool-failure ledger) included, no
 *   trailing carve-out - is both a byte-identical AND OBJECT-REFERENCE-identical PREFIX of
 *   R(n+1)'s messages. No message already sent to the provider is ever rewritten, repositioned, or
 *   removed by a later request; a durable transient record, once committed, is the literal same
 *   object on every later request that includes it.
 *
 * The scenario below deliberately exercises every path that can violate this:
 *   - a failing tool call, which arms the tool-failure ledger (tool-failure-memory.ts);
 *   - the SAME tool called again with identical arguments two turns later, which is exactly what
 *     `sanitizeToolFailureContext`'s superseded-success dedup targets - if the "already sent" mark
 *     is lost, the first (already-sent) call is wrongly erased when the second is seen;
 *   - a verification obligation appearing (the failing call also reports a failed verification)
 *     and later resolving (a passing call for the same obligation id) - exercising both the ACTIVE
 *     and CLEARED durable record shapes append-on-change can commit;
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
 *   - Append-on-change (transient-records.ts): reverting it - rebuilding the ledger/obligation fresh
 *     every request instead of committing a durable record only when content changes - fails the
 *     REFERENCE-identity check specifically, even though the older VALUE-identity check on the core
 *     alone could still pass.
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

// Append-on-change transients (see transient-records.ts) ride as durable `role: "custom"` records
// woven into history at the point they changed, not a request-local trailing block rebuilt every
// turn - so, unlike before this mechanism existed, they must survive convertToLlm to ever reach the
// wire at all.
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult" || m.role === "custom",
	) as Message[];
}

function messageText(message: Message): string {
	const custom = message as unknown as { role: string; content: unknown };
	if (custom.role !== "user" && custom.role !== "custom") return "";
	const content = custom.content;
	return typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.map((part: { type: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
					.join("\n")
			: "";
}

/**
 * The last durable record of the given kind, or undefined if none exists - "last" because
 * append-on-change never rewrites or repositions a record, so an earlier instance further back, if
 * any, is superseded and stale by construction (see transient-records.ts). Recognizing `customType`
 * directly rather than a text-prefix marker also means this is not fooled by the fact that CLEARED
 * text for either kind still starts with the same header the ACTIVE text does (both ledger states
 * start "MANDATORY TOOL FAILURE RECOVERY", both obligation states start "ACTIVE VERIFICATION
 * FAILURES" - see tool-failure-memory.ts / verification-obligations.ts).
 */
function lastCustomRecord(context: Context, customType: string): Message | undefined {
	const messages = context.messages as unknown as { role: string; customType?: string }[];
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === "custom" && messages[index].customType === customType) {
			return context.messages[index];
		}
	}
	return undefined;
}

/**
 * Empty string means no obligation/ledger is CURRENTLY active - which now includes the case where
 * the last durable record is an explicit cleared-state record (its content starts with the kind's
 * `clearedText`, see verification-obligations.ts/tool-failure-memory.ts): that record's whole purpose
 * is to stop an earlier active record from reading as current, not to introduce a new active reading
 * of its own. Callers below predate append-on-change and mean "is there an active constraint right
 * now" - deliberately kept the same question here.
 */
function obligationInstructionOf(context: Context): string {
	const message = lastCustomRecord(context, VERIFICATION_OBLIGATION_TRANSIENT_KIND);
	const text = message ? messageText(message) : "";
	return text.startsWith(VERIFICATION_OBLIGATIONS_CLEARED_TEXT) ? "" : text;
}

function ledgerOf(context: Context): string {
	const message = lastCustomRecord(context, TOOL_FAILURE_LEDGER_TRANSIENT_KIND);
	const text = message ? messageText(message) : "";
	return text.startsWith(TOOL_FAILURE_LEDGER_CLEARED_TEXT) ? "" : text;
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

		// Task 1 + Task 4 + append-on-change (turn-economics A1, extended): every request's FULL
		// message array - transients included, no trailing carve-out needed anymore - is both a
		// byte-identical (`toEqual`) AND OBJECT-REFERENCE-identical (`toBe`, index by index) prefix of
		// the next request's array. Before append-on-change, the ledger/obligation were rebuilt fresh
		// every request, so only a VALUE-prefix check of the core (excluding the ever-shifting trailing
		// region) was possible; append-on-change makes the STRONGER claim provable, because a durable
		// transient record, once committed, is the literal same object on every later request that
		// includes it - exactly what `messagesPreserveCachedPrefix` in
		// packages/ai/src/providers/openai-codex-responses.ts checks before letting the websocket delta
		// continuation engage (see the Task 10 diagnosis this fix responds to). Reverting Task 1 makes
		// the sanitizer mark reset to 0 every turn (since `prepareNextTurn` above clones `config` every
		// turn), so requests[3] (built after the SECOND `read(a.ts)` at turn 3) wrongly erases the FIRST
		// `read(a.ts)` call/result that requests[2] already sent - violating this exact check. Reverting
		// append-on-change (rebuilding transients fresh every turn instead of committing them once)
		// would fail the REFERENCE check specifically while the VALUE check could still pass, which is
		// why both are asserted, not just one.
		let comparedTransientBearingPairs = 0;
		for (let i = 0; i < requests.length - 1; i++) {
			const previous = requests[i].context.messages;
			const next = requests[i + 1].context.messages;
			expect(next.length).toBeGreaterThanOrEqual(previous.length);
			expect(next.slice(0, previous.length)).toEqual(previous);
			for (let index = 0; index < previous.length; index++) {
				expect(next[index]).toBe(previous[index]);
			}
			if (previous.some((message) => (message as unknown as { role: string }).role === "custom")) {
				comparedTransientBearingPairs++;
			}
		}
		// Confirm the script actually exercised a transient-bearing comparison at least once -
		// otherwise the reference check above would vacuously pass regardless of whether append-on-
		// change actually committed a durable record anywhere.
		expect(comparedTransientBearingPairs).toBeGreaterThan(0);

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
