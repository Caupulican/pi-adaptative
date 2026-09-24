import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ModelThinkingLevel } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * The cache custody contract: across a corpus of ordinary work, every provider request is an append
 * to the lane's previous one, or a break the gate sanctioned. The guard records every other break in
 * the decision ledger, so the corpus asserts that ledger holds no unsanctioned break, and that the
 * lane kept one reasoning level.
 */
describe("cache custody contract", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps every request of a tool loop, a parallel batch, a bookkeeping turn and an extension prompt change an append", async () => {
		let executions = 0;
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo a value",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_id, params) => {
				executions++;
				return { content: [{ type: "text", text: `echo ${(params as { value: string }).value}` }], details: {} };
			},
		};
		let turns = 0;
		const harness = await createHarness({
			models: [{ id: "reasoner", reasoning: true }],
			settings: { autoLearn: { reflectionReview: false } },
			baseToolsOverride: [echo],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						turns++;
						return turns < 2 ? undefined : { systemPrompt: `${event.systemPrompt}\n\nEXTENSION-MARKER` };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["echo", "task_steps"]);
		harness.session.setThinkingLevel("high", { persistSettings: false });

		const reasoning: Array<ModelThinkingLevel | undefined> = [];
		const respond =
			(message: ReturnType<typeof fauxAssistantMessage>) =>
			(_context: unknown, options: { reasoning?: ModelThinkingLevel } | undefined) => {
				reasoning.push(options?.reasoning);
				return message;
			};
		const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) =>
			fauxAssistantMessage(calls, { stopReason: "toolUse" });
		harness.setResponses([
			// A tool loop.
			respond(toolUse(fauxToolCall("echo", { value: "one" }))),
			respond(toolUse(fauxToolCall("echo", { value: "two" }))),
			respond(toolUse(fauxToolCall("echo", { value: "three" }))),
			// A 12-call parallel batch.
			respond(
				toolUse(...Array.from({ length: 12 }, (_, index) => fauxToolCall("echo", { value: `batch-${index}` }))),
			),
			// A bookkeeping turn: the continuation after it is where the host would lower reasoning.
			respond(
				toolUse(
					fauxToolCall("task_steps", {
						action: "replace",
						steps: [{ id: "s1", title: "Echo values", status: "done" }],
					}),
				),
			),
			respond(fauxAssistantMessage("first prompt done")),
			// A second owner prompt, on which the extension changes the system prompt.
			respond(toolUse(fauxToolCall("echo", { value: "four" }))),
			respond(fauxAssistantMessage("second prompt done")),
		]);

		await harness.session.prompt("run the corpus");
		await harness.session.prompt("continue");

		expect(executions).toBe(16);
		expect(harness.getPendingResponseCount()).toBe(0);
		const snapshots = harness.sessionManager.getEntries().filter((entry) => entry.type === "request_snapshot");
		expect(snapshots).toHaveLength(8);
		expect(snapshots.slice(1).map((snapshot) => snapshot.prefixIntact)).toEqual(Array(7).fill(true));
		const breaks = (harness.session.getDecisionLedger()?.cacheDecisions(harness.session.sessionId) ?? []).filter(
			(decision) => decision.kind === "cache_break",
		);
		expect(breaks.filter((decision) => !decision.admit)).toEqual([]);
		// One reasoning level for the whole lane: the bookkeeping continuation kept it.
		expect(new Set(reasoning)).toEqual(new Set(["high"]));
	});
});
