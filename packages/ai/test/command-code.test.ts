/**
 * Regression suite for the Command Code provider (`command-code.ts`, `command-code-request.ts`, and
 * `command-code-account.ts`): output token cap with/without reasoning, session UUID + `pause_turn` thread/header
 * stability, per-session UTC date pinning and cold-moment advancement, streamed `tool-input-*` assembly and `length`
 * truncation recovery without spurious unread-event diagnostics, and account usage window/credit separation.
 */

import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamCommandCode, streamSimpleCommandCode } from "../src/providers/command-code.ts";
import { fetchCommandCodeAccountUsage } from "../src/providers/command-code-account.ts";
import {
	buildCommandCodeRequest,
	type CommandCodeRequestBody,
	resolveCommandCodeSessionId,
} from "../src/providers/command-code-request.ts";
import type { Context, Model, ToolCall } from "../src/types.ts";
import { createToolNameMap } from "../src/utils/tool-names.ts";

const RFC_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRUNCATED_TOOL_INPUT_MESSAGE =
	"Tool call arguments were truncated before complete JSON was received. Retry the tool call with complete JSON arguments.";

function makeModel(overrides: Partial<Model<"command-code-generate">> = {}): Model<"command-code-generate"> {
	return {
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "command-code-generate",
		provider: "command-code",
		baseUrl: "https://api.commandcode.ai",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...overrides,
	};
}

function makeContext(): Context {
	return {
		systemPrompt: "Follow workspace instructions.",
		messages: [{ role: "user", content: "Inspect src/index.ts", timestamp: 1_700_000_000_000 }],
		tools: [
			{
				name: "read",
				description: "Read a file",
				parameters: Type.Object({
					path: Type.String(),
					offset: Type.Optional(Type.Number()),
				}),
			},
		],
	};
}

function ndjsonResponse(events: readonly Record<string, unknown>[]): Response {
	const payload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(payload));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "application/x-ndjson" },
	});
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Command Code provider regressions", () => {
	describe("outputCap with and without reasoning effort", () => {
		it("clamps max_tokens to Math.min(settings.maxTokens ?? model.maxTokens, model.maxTokens) in buildCommandCodeRequest", () => {
			const model = makeModel({ maxTokens: 16_384 });
			const context = makeContext();
			const toolMap = createToolNameMap(context.tools ?? []);

			const defaultNoReasoning = buildCommandCodeRequest(model, context, toolMap, {
				cacheRetention: "short",
			});
			expect(defaultNoReasoning.params.max_tokens).toBe(16_384);
			expect(defaultNoReasoning.params.reasoning_effort).toBeUndefined();

			const narrowedNoReasoning = buildCommandCodeRequest(model, context, toolMap, {
				maxTokens: 4_096,
				cacheRetention: "short",
			});
			expect(narrowedNoReasoning.params.max_tokens).toBe(4_096);
			expect(narrowedNoReasoning.params.reasoning_effort).toBeUndefined();

			const widenedNoReasoning = buildCommandCodeRequest(model, context, toolMap, {
				maxTokens: 65_536,
				cacheRetention: "short",
			});
			expect(widenedNoReasoning.params.max_tokens).toBe(16_384);
			expect(widenedNoReasoning.params.reasoning_effort).toBeUndefined();

			const narrowedWithReasoning = buildCommandCodeRequest(model, context, toolMap, {
				maxTokens: 2_048,
				reasoningEffort: "high",
				cacheRetention: "short",
			});
			expect(narrowedWithReasoning.params.max_tokens).toBe(2_048);
			expect(narrowedWithReasoning.params.reasoning_effort).toBe("high");

			const widenedWithReasoning = buildCommandCodeRequest(model, context, toolMap, {
				maxTokens: 99_999,
				reasoningEffort: "max",
				cacheRetention: "short",
			});
			expect(widenedWithReasoning.params.max_tokens).toBe(16_384);
			expect(widenedWithReasoning.params.reasoning_effort).toBe("max");
		});

		it("preserves outputCap clamping through streamSimpleCommandCode both without and with reasoning effort", async () => {
			const capturedBodies: CommandCodeRequestBody[] = [];
			const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
				capturedBodies.push(JSON.parse(String(init?.body ?? "{}")) as CommandCodeRequestBody);
				return ndjsonResponse([
					{ type: "text-delta", text: "ok" },
					{
						type: "finish",
						finishReason: "stop",
						totalUsage: { inputTokens: 12, outputTokens: 3 },
					},
				]);
			});
			vi.stubGlobal("fetch", fetchMock);

			const model = makeModel({
				maxTokens: 12_000,
				thinkingLevelMap: { xhigh: "max" },
			});
			const context = makeContext();

			// 1. Without reasoning, caller cap above model.maxTokens clamps to model.maxTokens.
			const highCallerNoReasoning = await streamSimpleCommandCode(model, context, {
				apiKey: "cc-test-key",
				maxTokens: 50_000,
			}).result();
			expect(highCallerNoReasoning.stopReason).toBe("stop");

			// 2. Without reasoning, caller cap below model.maxTokens narrows to caller cap.
			await streamSimpleCommandCode(model, context, {
				apiKey: "cc-test-key",
				maxTokens: 3_000,
			}).result();

			// 3. With reasoning (mapped xhigh -> max), omitted maxTokens uses model.maxTokens.
			await streamSimpleCommandCode(model, context, {
				apiKey: "cc-test-key",
				reasoning: "xhigh",
			}).result();

			// 4. With reasoning, caller cap below model.maxTokens narrows and above model.maxTokens clamps.
			await streamSimpleCommandCode(model, context, {
				apiKey: "cc-test-key",
				reasoning: "medium",
				maxTokens: 2_500,
			}).result();
			await streamSimpleCommandCode(model, context, {
				apiKey: "cc-test-key",
				reasoning: "high",
				maxTokens: 48_000,
			}).result();

			expect(
				capturedBodies.map((body) => ({
					maxTokens: body.params.max_tokens,
					reasoningEffort: body.params.reasoning_effort,
				})),
			).toEqual([
				{ maxTokens: 12_000, reasoningEffort: undefined },
				{ maxTokens: 3_000, reasoningEffort: undefined },
				{ maxTokens: 12_000, reasoningEffort: "max" },
				{ maxTokens: 2_500, reasoningEffort: "medium" },
				{ maxTokens: 12_000, reasoningEffort: "high" },
			]);
		});
	});

	describe("resolveCommandCodeSessionId and pause_turn continuation consistency", () => {
		it("preserves RFC UUIDs, hashes non-UUID session ids deterministically, and generates fresh RFC UUIDs when unset", async () => {
			const explicitUuid = "018f4a7c-8d3b-7e10-9a2b-3c4d5e6f7081";
			await expect(resolveCommandCodeSessionId(explicitUuid)).resolves.toBe(explicitUuid);

			const derivedFirst = await resolveCommandCodeSessionId("auto-learn-nightly-42");
			const derivedSecond = await resolveCommandCodeSessionId("  auto-learn-nightly-42  ");
			const derivedOther = await resolveCommandCodeSessionId("auto-learn-nightly-43");
			expect(derivedFirst).toMatch(RFC_UUID_PATTERN);
			expect(derivedSecond).toBe(derivedFirst);
			expect(derivedOther).not.toBe(derivedFirst);

			const generatedA = await resolveCommandCodeSessionId();
			const generatedB = await resolveCommandCodeSessionId("   ");
			expect(generatedA).toMatch(RFC_UUID_PATTERN);
			expect(generatedB).toMatch(RFC_UUID_PATTERN);
			expect(generatedA).not.toBe(generatedB);
		});

		it.each([
			{ label: "explicit RFC UUID", sessionId: "018f4a7c-8d3b-7e10-9a2b-3c4d5e6f7081" },
			{ label: "non-UUID session label", sessionId: "routine-worker-session-9" },
			{ label: "omitted sessionId", sessionId: undefined },
		])(
			"keeps threadId and x-session-id identical across initial post and pause_turn continuation ($label)",
			async ({ sessionId }) => {
				const observedPosts: Array<{ xSessionId: string | null; threadId: string | undefined }> = [];
				let postCount = 0;
				const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
					postCount++;
					const headers = new Headers(init?.headers);
					const body = JSON.parse(String(init?.body ?? "{}")) as CommandCodeRequestBody;
					observedPosts.push({
						xSessionId: headers.get("x-session-id"),
						threadId: body.threadId,
					});
					if (postCount === 1) {
						return ndjsonResponse([
							{ type: "text-delta", text: "First leg. " },
							{
								type: "finish",
								finishReason: "pause_turn",
								rawFinishReason: "pause_turn",
								totalUsage: { inputTokens: 20, outputTokens: 5 },
							},
						]);
					}
					return ndjsonResponse([
						{ type: "text-delta", text: "Second leg." },
						{
							type: "finish",
							finishReason: "stop",
							totalUsage: { inputTokens: 25, outputTokens: 6 },
						},
					]);
				});
				vi.stubGlobal("fetch", fetchMock);

				const message = await streamCommandCode(makeModel(), makeContext(), {
					apiKey: "cc-test-key",
					...(sessionId !== undefined ? { sessionId } : {}),
				}).result();

				expect(observedPosts).toHaveLength(2);
				const [firstPost, secondPost] = observedPosts;
				expect(firstPost?.xSessionId).toMatch(RFC_UUID_PATTERN);
				expect(firstPost?.threadId).toBe(firstPost?.xSessionId);
				expect(secondPost).toEqual(firstPost);
				if (sessionId && RFC_UUID_PATTERN.test(sessionId)) {
					expect(firstPost?.threadId).toBe(sessionId);
				} else if (sessionId) {
					expect(firstPost?.threadId).toBe(await resolveCommandCodeSessionId(sessionId));
				}
				expect(message.stopReason).toBe("stop");
				expect(message.content).toEqual([
					{ type: "text", text: "First leg. " },
					{ type: "text", text: "Second leg." },
				]);
			},
		);
	});

	describe("resolveCommandCodeDate UTC midnight pinning and cold-moment advancement", () => {
		it("pins config.date per sessionId across UTC midnight and advances when sessionDate is supplied", () => {
			vi.useFakeTimers();
			const model = makeModel();
			const context = makeContext();
			const toolMap = createToolNameMap(context.tools ?? []);
			const sessionA = "date-pin-session-alpha";
			const sessionB = "date-pin-session-beta";

			vi.setSystemTime(new Date("2026-11-10T23:59:58.000Z"));
			const turn1A = buildCommandCodeRequest(model, context, toolMap, {
				cacheRetention: "short",
				sessionId: sessionA,
			});
			expect(turn1A.config.date).toBe("2026-11-10");

			// Cross UTC midnight: sessionA stays pinned to 2026-11-10, while a fresh sessionB captures 2026-11-11.
			vi.setSystemTime(new Date("2026-11-11T00:05:12.000Z"));
			const turn2A = buildCommandCodeRequest(model, context, toolMap, {
				cacheRetention: "short",
				sessionId: sessionA,
			});
			const turn1B = buildCommandCodeRequest(model, context, toolMap, {
				cacheRetention: "short",
				sessionId: sessionB,
			});
			expect(turn2A.config.date).toBe("2026-11-10");
			expect(turn1B.config.date).toBe("2026-11-11");

			// Supplying sessionDate on a cold moment advances sessionA's pinned date and persists on subsequent turns.
			const advancedA = buildCommandCodeRequest(model, context, toolMap, {
				cacheRetention: "short",
				sessionId: sessionA,
				sessionDate: "2026-11-11",
			});
			expect(advancedA.config.date).toBe("2026-11-11");

			vi.setSystemTime(new Date("2026-11-12T04:00:00.000Z"));
			const afterAdvanceA = buildCommandCodeRequest(model, context, toolMap, {
				cacheRetention: "short",
				sessionId: sessionA,
			});
			expect(afterAdvanceA.config.date).toBe("2026-11-11");
		});
	});

	describe("streamed tool-input-start / tool-input-delta / tool-input-end assembly", () => {
		it("consumes tool-input-* events without spurious command_code_unread_events when tool-call completes", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>().mockResolvedValue(
					ndjsonResponse([
						{ type: "tool-input-start", id: "call_read_1", toolName: "read" },
						{ type: "tool-input-delta", id: "call_read_1", delta: '{"path":"src/' },
						{ type: "tool-input-delta", id: "call_read_1", inputTextDelta: 'index.ts","offset":null}' },
						{ type: "tool-input-end", id: "call_read_1" },
						{
							type: "tool-call",
							toolCallId: "call_read_1",
							toolName: "read",
							input: { path: "src/index.ts", offset: null },
						},
						{
							type: "finish",
							finishReason: "tool-calls",
							totalUsage: { inputTokens: 30, outputTokens: 14 },
						},
					]),
				),
			);

			const openaiUpstreamModel = makeModel({ id: "gpt-5.4", upstream: "openai" });
			const message = await streamCommandCode(openaiUpstreamModel, makeContext(), {
				apiKey: "cc-test-key",
			}).result();

			expect(message.stopReason).toBe("toolUse");
			expect(message.diagnostics).toBeUndefined();
			expect(message.content).toEqual([
				{
					type: "toolCall",
					id: "call_read_1",
					name: "read",
					arguments: { path: "src/index.ts" },
				},
			]);
		});

		it("materializes TRUNCATED_TOOL_INPUT_MESSAGE on length cutoff without unread-event diagnostics and skips providerExecuted inputs", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>().mockResolvedValue(
					ndjsonResponse([
						{
							type: "tool-input-start",
							id: "call_srv_1",
							toolName: "web_search",
							providerExecuted: true,
						},
						{ type: "tool-input-delta", id: "call_srv_1", delta: '{"query":"unterminated' },
						{ type: "tool-input-start", id: "call_trunc_1", toolName: "read" },
						{ type: "tool-input-delta", id: "call_trunc_1", delta: '{"path":"src/unfinished' },
						{ type: "tool-input-start", id: "call_empty_2", toolName: "read" },
						{ type: "tool-input-end", id: "call_empty_2" },
						{
							type: "finish",
							finishReason: "max_output_tokens",
							rawFinishReason: "length",
							totalUsage: { inputTokens: 40, outputTokens: 128 },
						},
					]),
				),
			);

			const message = await streamCommandCode(makeModel(), makeContext(), {
				apiKey: "cc-test-key",
			}).result();

			expect(message.stopReason).toBe("length");
			expect(message.diagnostics).toBeUndefined();
			const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
			expect(toolCalls).toEqual([
				{
					type: "toolCall",
					id: "call_trunc_1",
					name: "read",
					arguments: {},
					errorMessage: TRUNCATED_TOOL_INPUT_MESSAGE,
				},
				{
					type: "toolCall",
					id: "call_empty_2",
					name: "read",
					arguments: {},
					errorMessage: TRUNCATED_TOOL_INPUT_MESSAGE,
				},
			]);
		});
	});

	describe("fetchCommandCodeAccountUsage window and credit mapping", () => {
		it("maps 5h, weekly, monthlyCredits, planMonthlyCredits, and orgLimits while keeping purchased/free credits distinct", async () => {
			const requestedUrls: string[] = [];
			const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				requestedUrls.push(url);
				const parsed = new URL(url);
				if (parsed.pathname === "/alpha/whoami") {
					return Response.json({
						user: { id: "usr_1", name: "Ada", email: "ada@example.com" },
						org: { id: "org_99", name: "Acme Eng", login: "acme" },
						orgLimits: [
							{
								scope: "org",
								spent: 150,
								limit: 200,
								exceeded: false,
								resetInterval: "monthly",
								resetAt: "2026-12-01T00:00:00.000Z",
							},
							{
								scope: "model",
								model: "claude-opus-4-6",
								modelLabel: "Claude Opus 4.6",
								spent: 50,
								limit: 50,
								exceeded: true,
								resetInterval: "weekly",
								resetAt: "2026-11-16T00:00:00.000Z",
							},
						],
					});
				}
				if (parsed.pathname === "/alpha/billing/credits") {
					return Response.json({
						credits: {
							planId: "individual_pro_v1",
							monthlyCredits: 0,
							purchasedCredits: 120.5,
							freeCredits: 14.5,
						},
						windowLimits: {
							limited: true,
							fiveHour: { used: 100, cap: 100, resetAt: 1_794_400_000_000 },
							weekly: { used: 240, cap: 400, resetAt: 1_794_800_000_000 },
						},
					});
				}
				if (parsed.pathname === "/alpha/billing/subscriptions") {
					return Response.json({
						data: {
							planId: "individual_pro_v1",
							status: "active",
							currentPeriodStart: "2026-11-01T00:00:00.000Z",
							currentPeriodEnd: 1_796_083_200_000,
						},
					});
				}
				if (parsed.pathname === "/alpha/usage/summary") {
					return Response.json({
						data: {
							totalCost: 80,
							totalCount: 142,
							periodBasis: "billing-period",
						},
					});
				}
				return new Response("not found", { status: 404 });
			});

			const usage = await fetchCommandCodeAccountUsage("cc-live-key", {
				baseUrl: "https://api.commandcode.ai/",
				fetch: fetchMock,
			});

			expect(requestedUrls).toEqual([
				"https://api.commandcode.ai/alpha/whoami?limits=1",
				"https://api.commandcode.ai/alpha/billing/credits?orgId=org_99",
				"https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org_99",
				"https://api.commandcode.ai/alpha/usage/summary?orgId=org_99&since=2026-11-01T00%3A00%3A00.000Z",
			]);
			expect(usage).toEqual({
				whoami: {
					user: { id: "usr_1", name: "Ada", email: "ada@example.com" },
					org: { id: "org_99", name: "Acme Eng", login: "acme" },
					orgLimits: [
						{
							scope: "org",
							spent: 150,
							limit: 200,
							exceeded: false,
							resetInterval: "monthly",
							resetAt: "2026-12-01T00:00:00.000Z",
						},
						{
							scope: "model",
							model: "claude-opus-4-6",
							modelLabel: "Claude Opus 4.6",
							spent: 50,
							limit: 50,
							exceeded: true,
							resetInterval: "weekly",
							resetAt: "2026-11-16T00:00:00.000Z",
						},
					],
				},
				billingCredits: {
					credits: {
						planId: "individual_pro_v1",
						monthlyCredits: 0,
						purchasedCredits: 120.5,
						freeCredits: 14.5,
					},
					windowLimits: {
						limited: true,
						fiveHour: { used: 100, cap: 100, resetAt: 1_794_400_000_000 },
						weekly: { used: 240, cap: 400, resetAt: 1_794_800_000_000 },
					},
				},
				subscription: {
					planId: "individual_pro_v1",
					status: "active",
					currentPeriodStart: "2026-11-01T00:00:00.000Z",
					currentPeriodEnd: 1_796_083_200_000,
				},
				usageSummary: {
					totalCost: 80,
					totalCount: 142,
					periodBasis: "billing-period",
				},
				planId: "individual_pro_v1",
				plan: "Pro v1",
				planMonthlyCredits: 80,
			});
		});
	});
});
