/**
 * GC eligibility of task_steps_context: the per-turn
 * task_steps_context injection (agent-session.ts, built from tasks/task-state.ts#formatTaskStepsContext)
 * used to grow the transcript linearly for any session with an open checklist -- one full copy of the
 * checklist page every turn, forever. This mirrors the fix already applied to <memory_context> recall
 * pages: wrap the injected page in a marker context-gc recognizes as a deterministic, re-derivable
 * semantic-memory-style page, so stale turn-copies get packed down to the most recent one.
 */
import { type AgentMessage, createCustomMessage } from "@caupulican/pi-agent-core";
import { describe, expect, it } from "vitest";
import { applyContextGc } from "../src/core/context-gc.ts";
import {
	addTaskStep,
	createTaskStepsState,
	formatTaskStepsContext,
	updateTaskStep,
} from "../src/core/tasks/task-state.ts";
import { createHarness } from "./test-harness.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function textOf(message: AgentMessage): string {
	if (message.role !== "custom" && message.role !== "user") return "";
	const content = (message as { content: string | { type: string; text?: string }[] }).content;
	if (typeof content === "string") return content;
	const first = content[0];
	return first && typeof first !== "string" && first.type === "text" && first.text ? first.text : "";
}

function taskStepsTurnMessage(context: string, revision: number): AgentMessage {
	return createCustomMessage("task_steps_context", context, false, { revision }, new Date().toISOString());
}

describe("task_steps_context GC eligibility", () => {
	it("wraps the injected context in a <task_steps_context revision=N> marker", () => {
		const state = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Investigate root cause", status: "in_progress" },
			"T1",
		);
		const context = formatTaskStepsContext(state);
		expect(context).toBeDefined();
		expect(context!.startsWith(`<task_steps_context revision=${state.revision}>\n`)).toBe(true);
		expect(context!.endsWith("\n</task_steps_context>")).toBe(true);
		// Single-turn content is identical to pre-wrap output aside from the marker wrapper.
		expect(context).toContain("Current native task_steps context for this session");
		expect(context).toContain("[in_progress] Investigate root cause");
		expect(context).toContain("Continue the in_progress step");
	});

	it("packs stale task_steps_context pages from earlier turns while preserving the most recent one", () => {
		let state = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Investigate root cause", status: "in_progress" },
			"T1",
		);
		const turn1 = taskStepsTurnMessage(formatTaskStepsContext(state)!, state.revision);

		state = updateTaskStep(state, "step-1", { note: "narrowed down the cause" }, "T2");
		const turn2 = taskStepsTurnMessage(formatTaskStepsContext(state)!, state.revision);

		// Keep at least one open step at every captured turn (a checklist with zero open steps stops
		// injecting context entirely -- formatTaskStepsContext returns undefined -- which is a
		// different, already-covered case; this test exercises the steady "open checklist" path).
		state = addTaskStep(state, { content: "Write regression test" }, "T3");
		const turn3 = taskStepsTurnMessage(formatTaskStepsContext(state)!, state.revision);

		state = updateTaskStep(state, "step-1", { status: "completed", evidence: ["fix verified"] }, "T4");
		state = updateTaskStep(state, "step-2", { status: "in_progress" }, "T4");
		const turn4 = taskStepsTurnMessage(formatTaskStepsContext(state)!, state.revision);

		const messages: AgentMessage[] = [
			turn1,
			user("turn 1 prompt"),
			...Array.from({ length: 4 }, (_, index) => user(`noise ${index}`)),
			turn2,
			user("turn 2 prompt"),
			...Array.from({ length: 4 }, (_, index) => user(`more noise ${index}`)),
			turn3,
			user("turn 3 prompt"),
			...Array.from({ length: 4 }, (_, index) => user(`even more noise ${index}`)),
			turn4,
			user("turn 4 prompt"),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			semanticMemory: { preserveRecentPages: 1, minChars: 20 },
			writePayloads: false,
		});

		// Only the 3 stale pages (turn1..turn3) are packed; the most recent page (turn4) survives.
		expect(result.report.records.map((record) => record.reason)).toEqual([
			"stale-semantic-memory",
			"stale-semantic-memory",
			"stale-semantic-memory",
		]);

		const turn1Index = messages.indexOf(turn1);
		const turn2Index = messages.indexOf(turn2);
		const turn3Index = messages.indexOf(turn3);
		const turn4Index = messages.indexOf(turn4);

		expect(textOf(result.messages[turn1Index])).toContain("Semantic GC packed stale Automata/Mind context page");
		expect(textOf(result.messages[turn1Index])).not.toContain("Investigate root cause");
		expect(textOf(result.messages[turn2Index])).toContain("Semantic GC packed stale Automata/Mind context page");
		expect(textOf(result.messages[turn2Index])).not.toContain("narrowed down the cause");
		expect(textOf(result.messages[turn3Index])).toContain("Semantic GC packed stale Automata/Mind context page");
		expect(textOf(result.messages[turn3Index])).not.toContain("Write regression test");

		// The most recent task_steps_context page is untouched by GC (block still renders each turn).
		expect(result.messages[turn4Index]).toBe(turn4);
		expect(textOf(result.messages[turn4Index])).toContain("<task_steps_context");
		expect(textOf(result.messages[turn4Index])).toContain("Write regression test");
		expect(textOf(result.messages[turn4Index])).not.toContain("Semantic GC packed");

		// Unrelated user turns are untouched.
		expect(textOf(result.messages[messages.indexOf(messages.find((m) => m.role === "user")!)])).toBe("turn 1 prompt");
	});

	it("does not pack a task_steps_context page that is the sole/most-recent page (nothing stale yet)", () => {
		const state = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Single open step", status: "in_progress" },
			"T1",
		);
		const turn1 = taskStepsTurnMessage(formatTaskStepsContext(state)!, state.revision);
		const messages: AgentMessage[] = [turn1, user("only turn")];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			semanticMemory: { preserveRecentPages: 1, minChars: 20 },
			writePayloads: false,
		});

		expect(result.report.packedCount).toBe(0);
		expect(textOf(result.messages[0])).toContain("<task_steps_context");
		expect(textOf(result.messages[0])).toContain("Single open step");
	});

	// End-to-end proof through the REAL settings path: SettingsManager.getContextGcSettings() (no
	// contextGc override configured) -> ContextPipeline.applyContextGc -> context-gc.ts. Regression
	// guard for the settings-manager.ts fallback that used to hand-copy its own markers array instead
	// of deriving from context-gc.ts's DEFAULT_CONTEXT_GC_SETTINGS -- that hand-copy predated (and
	// therefore never carried) the "<task_steps_context" marker, so a real session on default settings
	// would never have packed these pages even after the context-gc.ts-only fix above.
	it("session GC packs stale task_steps_context pages under DEFAULT settings (no contextGc override)", () => {
		const harness = createHarness();
		try {
			const page = (label: string, revision: number): AgentMessage =>
				createCustomMessage(
					"task_steps_context",
					`<task_steps_context revision=${revision}>\n${label} open task_steps: ${"checklist item ".repeat(80)}\n</task_steps_context>`,
					false,
					{ revision },
					new Date().toISOString(),
				);
			const messages: AgentMessage[] = [
				page("old", 1),
				...Array.from({ length: 12 }, (_, index) => user(`noise ${index}`)),
				page("recent", 2),
			];
			const session = harness.session as unknown as {
				_applyContextGc(
					messages: AgentMessage[],
					writePayloads: boolean,
				): { report: { records: { reason: string }[] } };
			};
			const result = session._applyContextGc(messages, false);
			expect(result.report.records.map((record) => record.reason)).toEqual(["stale-semantic-memory"]);
		} finally {
			harness.cleanup();
		}
	});
});
