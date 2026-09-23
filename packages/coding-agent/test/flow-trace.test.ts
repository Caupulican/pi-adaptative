import { visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session-contracts.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { HumanInputActivity } from "../src/core/human-input-activity.ts";
import { FlowTrace } from "../src/core/operator-projection/flow-trace.ts";
import { flowRows, renderFlowLanes } from "../src/modes/interactive/components/flow-lanes-render.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function event(value: unknown): AgentSessionEvent {
	return value as AgentSessionEvent;
}

function question(requestId: string, phase: "waiting" | "settled"): HumanInputActivity {
	return {
		phase,
		request: { requestId, questions: [{ question: "Keep the old flag?" }] },
	} as unknown as HumanInputActivity;
}

function lane(status: LaneRecord["status"], extra: Partial<LaneRecord> = {}): LaneRecord {
	return { laneId: "lane-1", type: "worker", status, label: "tester", ...extra } as LaneRecord;
}

/** One run the way the session reports it: prompt, turn, tools, a judgment, a worker, a question. */
function recordedRun(): { trace: FlowTrace; clock: { t: number } } {
	const clock = { t: 1_000 };
	const trace = new FlowTrace({ now: () => clock.t });
	trace.observe(event({ type: "message_start", message: { role: "user", content: "fix the flaky test" } }));
	trace.observe(event({ type: "agent_start" }));
	for (const [id, name] of [
		["t1", "read"],
		["t2", "read"],
		["t3", "bash"],
	] as const) {
		trace.observe(event({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} }));
		clock.t += 1_000;
		trace.observe(event({ type: "tool_execution_end", toolCallId: id, toolName: name, isError: false }));
	}
	trace.observeEvaluation({
		evaluationId: "e1",
		programId: "system-one:claim_delivery",
		label: "answer claims",
		startedAt: clock.t,
		endedAt: clock.t + 800,
		durationMs: 800,
		outcome: "ok",
		verdict: "evaluated",
	});
	trace.observeLanes([lane("running", { startedAt: new Date(clock.t).toISOString() })]);
	trace.observeQuestion(question("q1", "waiting"));
	return { trace, clock };
}

describe("flow trace", () => {
	it("records what happened, where it happened, and keeps running actions open", () => {
		const { trace, clock } = recordedRun();
		const kinds = trace.snapshot().map((e) => `${e.actor}:${e.kind}:${e.endedAt === undefined ? "open" : "done"}`);
		expect(kinds).toEqual([
			"owner:prompt:done",
			"root:turn:open",
			"root:tool:done",
			"root:tool:done",
			"root:tool:done",
			"system_one:judgment:done",
			"root:delegate:done",
			"worker:worker:open",
			"root:question:open",
		]);
		// The routine verdict names nothing; the judgment keeps its label only.
		expect(trace.snapshot()[5]).toMatchObject({ label: "answer claims", to: "root" });

		trace.observeQuestion(question("q1", "settled"));
		trace.observeLanes([lane("partial", { completedAt: new Date(clock.t + 5_000).toISOString() })]);
		trace.observe(
			event({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }], willRetry: false }),
		);
		expect(
			trace
				.snapshot()
				.slice(-2)
				.map((e) => `${e.actor}:${e.kind}`),
		).toEqual(["owner:answer", "worker:report"]);
		const worker = trace.snapshot().find((e) => e.kind === "worker");
		expect(worker).toMatchObject({ outcome: "attention" });
		expect(trace.snapshot().find((e) => e.kind === "report")).toMatchObject({ outcome: "attention", to: "root" });
		expect(trace.snapshot().find((e) => e.kind === "turn")).toMatchObject({ outcome: "ok" });
		expect(trace.snapshot().some((e) => e.endedAt === undefined)).toBe(false);
	});

	it("marks a failed tool and a cancelled turn", () => {
		const trace = new FlowTrace({ now: () => 5 });
		trace.observe(event({ type: "agent_start" }));
		trace.observe(event({ type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: {} }));
		trace.observe(event({ type: "tool_execution_end", toolCallId: "x", toolName: "bash", isError: true }));
		trace.observe(
			event({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }], willRetry: false }),
		);
		expect(trace.snapshot().map((e) => e.outcome)).toEqual(["cancelled", "failed"]);
	});
});

describe("Lanes view", () => {
	beforeAll(() => initTheme("dark"));

	it("draws one lane per actor at the exact width, folds finished runs, and arrows each hand-over", () => {
		const { trace, clock } = recordedRun();
		for (const width of [40, 56, 64, 96]) {
			const drawn = renderFlowLanes(trace.snapshot(), width, clock.t + 2_000);
			for (const row of drawn.rows) expect(visibleWidth(row), `width ${width}`).toBe(width);
		}
		const rows = renderFlowLanes(trace.snapshot(), 96, clock.t + 2_000).rows.map(stripAnsi);
		expect(rows[0]).toMatch(/^you\s+│System One\s+│root\s+│workers/);
		// Three finished reads and a bash in the root lane fold into one counted row with the average.
		// A lane never spills into its neighbour: the folded row keeps its count and average, the names truncate.
		expect(rows.join("\n")).toContain("▸ tools ×3 · avg 1.0s");
		expect(flowRows(trace.snapshot()).find((row) => row.count === 3)?.labels).toEqual(["read", "bash"]);
		// The prompt crosses from you to root; the question crosses back.
		const prompt = rows.find((row) => row.includes("fix the flaky"))!;
		expect(prompt).toContain("▶");
		const asked = rows.find((row) => row.includes("Keep the old flag?"))!;
		expect(asked).toContain("◀");
		expect(flowRows(trace.snapshot()).length).toBeLessThan(trace.snapshot().length);
	});

	it("says so when nothing has happened yet", () => {
		const rows = renderFlowLanes([], 56, 0).rows.map(stripAnsi);
		expect(rows.at(-1)).toContain("no activity yet");
	});
});
