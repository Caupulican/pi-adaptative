import type { AgentTool } from "@caupulican/pi-agent-core/types";
import { type FauxRequestEvent, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { COMPACTION_PREPARED_CUSTOM_TYPE } from "../../src/core/compaction-controller.ts";
import { cacheLaneKey } from "../../src/core/context/cache-observation-recorder.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * While the session lane idles past the moment its learned cache curve says a summary still reads the
 * prefix warm, a compaction is prepared on the warm lane and recorded unapplied. When the lane is woken
 * after the cache has expired (the owner returns, or a long tool's results come back), the admission gate
 * finds continuing from the prepared summary cheaper than resuming cold, applies it, and the request goes
 * out on the compacted history. The faux provider's cache expires after `CACHE_TTL_MS`; the learned
 * evidence (warm below it, cold beyond, return gaps past it, one compaction's outcome) is recorded in the
 * decision ledger the way live sessions record it.
 */

const CACHE_TTL_MS = 2_000;
const RETURN_GAP_MS = 6_000;

const SUMMARY = [
	"## Active Task",
	"User: hello",
	"",
	"### Mandatory Rules",
	"(none)",
	"",
	"## Working Set",
	"(none)",
	"",
	"## Files",
	"(none)",
	"",
	"## Open Problems",
	"(none)",
	"",
	"## Done",
	"(none)",
	"",
	"## Key Decisions",
	"(none)",
	"",
	"## Constraints & Preferences",
	"(none)",
	"",
	"## Critical Context",
	"prepared while idle",
].join("\n");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function preparedHarness(options: { tools?: AgentTool[]; requests: FauxRequestEvent[] }): Promise<Harness> {
	const harness = await createHarness({
		models: [
			{
				id: "priced",
				cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 200_000,
			},
		],
		fauxProvider: { cacheTtlMs: CACHE_TTL_MS, onRequest: (event) => options.requests.push(event) },
		...(options.tools ? { baseToolsOverride: options.tools } : {}),
	});
	const ledger = harness.session.getDecisionLedger();
	if (!ledger) throw new Error("decision ledger unavailable");
	const model = harness.getModel();
	const lane = cacheLaneKey(model.api, model.provider, model.id);
	const observed = (gapMs: number, retained: number, holder: "owner" | "tool") =>
		ledger.recordCacheObservation({
			sessionId: "history",
			cwd: "/repo",
			lane,
			observedAt: Date.now() - 60_000,
			gapMs,
			promptTokens: 1_000,
			cacheReadTokens: retained * 1_000,
			retained,
			prefixIntact: "true",
			holder,
		});
	for (let index = 0; index < 10; index++) {
		observed(500, 1, "tool");
		observed(1_500, 1, "tool");
		observed(RETURN_GAP_MS, 0, "owner");
		observed(RETURN_GAP_MS, 0, "tool");
	}
	ledger.recordCompactionOutcome({
		sessionId: "history",
		lane,
		observedAt: Date.now() - 60_000,
		tokensBefore: 10_000,
		tokensAfter: 2_000,
		outputTokens: 100,
	});
	return harness;
}

describe("idle preparation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("prepares a summary on the warm lane while idle and continues from it when the owner returns cold", async () => {
		const requests: FauxRequestEvent[] = [];
		const harness = await preparedHarness({ requests });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage(SUMMARY),
			fauxAssistantMessage("after"),
		]);

		await harness.session.prompt("hello");
		// The operator sees when the lane will prepare and what that is expected to save.
		expect(harness.session.getIdlePreparationView()).toMatchObject({ state: "armed" });
		await sleep(RETURN_GAP_MS);
		expect(harness.session.getIdlePreparationView()).toMatchObject({ state: "prepared" });
		// The preparation ran on the warm lane, before the cache expired, and was recorded unapplied.
		expect(requests).toHaveLength(2);
		expect(requests[1]?.cachedChars).toBeGreaterThan(0);
		const prepared = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === COMPACTION_PREPARED_CUSTOM_TYPE);
		expect(prepared).toHaveLength(1);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);

		await harness.session.prompt("again");
		expect(harness.session.getIdlePreparationView()).toMatchObject({ state: "resumed", fresh: true });
		const compaction = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
		expect(compaction).toMatchObject({ summary: SUMMARY });
		const decisions = harness.session.getDecisionLedger()?.cacheDecisions(harness.session.sessionId) ?? [];
		expect(decisions.map((decision) => [decision.kind, decision.admit])).toEqual(
			expect.arrayContaining([
				["idle_preparation", true],
				["prepared_resume", true],
			]),
		);
		expect(requests).toHaveLength(3);
	}, 20_000);

	it("lets a prepared summary go when the owner returns while the cache is still warm", async () => {
		const requests: FauxRequestEvent[] = [];
		const harness = await preparedHarness({ requests });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage(SUMMARY),
			fauxAssistantMessage("after"),
			fauxAssistantMessage("later"),
		]);

		await harness.session.prompt("hello");
		// Past the planned moment, inside the cache lifetime.
		await sleep(1_500);
		await harness.session.prompt("again");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		const decisions = harness.session.getDecisionLedger()?.cacheDecisions(harness.session.sessionId) ?? [];
		expect(
			decisions.filter((decision) => decision.kind === "prepared_resume").map((decision) => decision.admit),
		).toEqual([false]);
		// A request went out on the full history: the preparation no longer describes it, and is never offered again.
		await harness.session.prompt("later");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(
			(harness.session.getDecisionLedger()?.cacheDecisions(harness.session.sessionId) ?? []).filter(
				(decision) => decision.kind === "prepared_resume",
			),
		).toHaveLength(1);
	}, 20_000);

	it("holds a long tool's results until the prepared summary is applied, keeping the call and its result", async () => {
		const requests: FauxRequestEvent[] = [];
		const wait: AgentTool = {
			name: "wait",
			label: "wait",
			description: "Waits",
			parameters: Type.Object({}),
			execute: async () => {
				await sleep(RETURN_GAP_MS);
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		};
		const harness = await preparedHarness({ tools: [wait], requests });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {}, { id: "call-wait" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(SUMMARY),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hello");

		// The preparation ran while the tool did; its results then went out on the compacted history.
		expect(requests).toHaveLength(3);
		expect(requests[1]?.cachedChars).toBeGreaterThan(0);
		const compaction = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
		// The summary is the prepared one; verification added the tool action it had to record as done.
		expect(compaction?.type === "compaction" ? compaction.summary : "").toContain("prepared while idle");
		const context = harness.sessionManager.buildSessionContext().messages;
		expect(context[0]?.role).toBe("compactionSummary");
		const call = context.findIndex(
			(message) =>
				message.role === "assistant" &&
				message.content.some((part) => part.type === "toolCall" && part.id === "call-wait"),
		);
		const result = context.findIndex(
			(message) => message.role === "toolResult" && message.toolCallId === "call-wait",
		);
		expect(call).toBeGreaterThan(0);
		expect(result).toBeGreaterThan(call);
	}, 20_000);
});
