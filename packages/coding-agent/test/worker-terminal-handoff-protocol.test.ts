import { describe, expect, it } from "vitest";
import { buildWorkerTerminalHandoffContent } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import { buildForegroundWorkerTerminalHandoffContent } from "../src/core/foreground-terminal-handoff-controller.ts";

describe("worker terminal handoff protocol", () => {
	it("requires complete transcript pagination and distinguishes blockers from lost state", () => {
		const content = buildWorkerTerminalHandoffContent({
			childAgentId: "worker-3",
			record: {
				laneId: "worker-3",
				status: "blocked",
				reasonCode: "worker_blocked",
			},
		});

		expect(content).toContain("MANDATORY: read every transcript page before judging this result.");
		expect(content).toContain('delegate action="transcript" agentId="worker-3" cursor=0');
		expect(content).toContain("While nextCursor exists, call transcript again with cursor=nextCursor.");
		expect(content).toContain("Stop only when nextCursor is absent.");
		expect(content).toContain(
			"worker_blocked means the durable claim has blockers; it does not mean worker state or transcript was lost.",
		);
		expect(content).toContain("CAVEMAN MODE - MANDATORY");
		expect(content).toContain("terminal handoff means worker state was retained");
		expect(content).toContain("continue or replan within the admitted grant");
	});

	it("omits the blocker-specific warning for other terminal outcomes", () => {
		const content = buildWorkerTerminalHandoffContent({
			childAgentId: "worker-2",
			record: {
				laneId: "worker-2",
				status: "succeeded",
			},
		});

		expect(content).not.toContain("worker_blocked means");
	});

	it("makes an exhausted child budget authoritative over earlier transcript errors", () => {
		const content = buildWorkerTerminalHandoffContent({
			childAgentId: "worker-3",
			record: {
				laneId: "worker-3",
				status: "budget_exhausted",
				reasonCode: "token_budget_exhausted",
			},
		});

		expect(content).toContain("CAVEMAN MODE - MANDATORY: budget_exhausted means an admitted limit ended work");
		expect(content).toContain("Terminal reasonCode is authoritative");
		expect(content).toContain("never replace it with earlier transcript errors");
		expect(content).toContain("replan only within remaining authority");
	});

	it("makes foreground delivery authoritative over a provisional missed-completion diagnosis", () => {
		const content = buildForegroundWorkerTerminalHandoffContent([
			{ laneId: "worker-1", status: "succeeded", reasonCode: "worker_completed" },
			{ laneId: "worker-2", status: "blocked", reasonCode: "worker_blocked" },
		]);

		expect(content).toContain("CAVEMAN MODE - MANDATORY");
		expect(content).toContain("this event proves terminal persistence and delivery");
		expect(content).toContain("Do not report missed completion or lost worker state from these records");
		expect(content).toContain("worker_blocked is a task claim with blockers, not harness failure");
		expect(content).toContain("continue or replan the parent task");
	});

	it("makes a foreground budget terminal authoritative over transient transcript errors", () => {
		const content = buildForegroundWorkerTerminalHandoffContent([
			{ laneId: "worker-3", status: "budget_exhausted", reasonCode: "token_budget_exhausted" },
		]);

		expect(content).toContain("CAVEMAN MODE - MANDATORY: budget_exhausted means an admitted limit ended work");
		expect(content).toContain("Terminal reason is authoritative");
		expect(content).toContain("never replace it with earlier transcript errors");
	});

	it("keeps a nested completion error separate from harness health and preserves healthy siblings", () => {
		const content = buildWorkerTerminalHandoffContent({
			childAgentId: "worker-3",
			record: {
				laneId: "worker-3",
				status: "failed",
				reasonCode: "completion_error",
			},
		});

		expect(content).toContain("CAVEMAN MODE - MANDATORY: completion_error means a worker execution failed");
		expect(content).toContain("Tool timeout, provider/model/API/network/WebSocket/fetch/overload");
		expect(content).toContain("NEVER call any of them harness failure");
		expect(content).toContain("NEVER stop, cancel, or interrupt healthy siblings for them");
		expect(content).toContain("A delivered terminal handoff proves persistence and delivery worked");
		expect(content).toContain("continue or replan");
	});

	it("keeps a foreground completion error separate from harness health and preserves healthy siblings", () => {
		const content = buildForegroundWorkerTerminalHandoffContent([
			{ laneId: "worker-1", status: "failed", reasonCode: "completion_error" },
		]);

		expect(content).toContain("CAVEMAN MODE - MANDATORY: completion_error means a worker execution failed");
		expect(content).toContain("Tool timeout, provider/model/API/network/WebSocket/fetch/overload");
		expect(content).toContain("NEVER call any of them harness failure");
		expect(content).toContain("NEVER stop, cancel, or interrupt healthy siblings for them");
		expect(content).toContain("A delivered terminal handoff proves persistence and delivery worked");
		expect(content).toContain("continue or replan");
	});
});
