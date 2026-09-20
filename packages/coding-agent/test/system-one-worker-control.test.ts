import { describe, expect, it } from "vitest";
import { createSessionWorkerControl } from "../src/core/system-one/worker-control.ts";

function fakeLanes(state: { running: boolean; registered: boolean }) {
	const calls: string[] = [];
	const control = createSessionWorkerControl({
		cancelWorkerAgent: (agentId, reason) => {
			calls.push(`cancel:${agentId}:${reason}`);
		},
		followUpWorkerAgent: (agentId, message) => {
			calls.push(`followUp:${agentId}:${message}`);
			if (state.running) return { started: false, steering: true };
			if (state.registered) return { started: true, steering: false };
			return { started: false, steering: false, skipReason: "agent_suspended" };
		},
		interruptWorkerAgent: (agentId) => {
			calls.push(`interrupt:${agentId}`);
			if (!state.running) return { interrupted: false, reason: "agent_not_running" };
			state.running = false;
			state.registered = false;
			return { interrupted: true };
		},
		queueWorkerAgentMessage: (agentId, message) => {
			calls.push(`queue:${agentId}:${message}`);
		},
		resumeWorkerAgent: (agentId) => {
			calls.push(`resume:${agentId}`);
			state.running = true;
			return { started: true };
		},
		recordDirective: (agentId, directive) => calls.push(`event:${agentId}:${directive}`),
		emitWarning: (message) => calls.push(`warn:${message}`),
	});
	return { control, calls };
}

describe("System One worker control", () => {
	it("steers a running worker for its next turn, and now by interrupting, queueing and resuming it", () => {
		const { control, calls } = fakeLanes({ running: true, registered: true });
		control.steerWorker("w1", "stay on the mission", "queue");
		expect(calls).toEqual(["event:w1:steer (queue): stay on the mission", "followUp:w1:stay on the mission"]);
		calls.length = 0;
		control.steerWorker("w1", "stop now", "now");
		expect(calls).toEqual(["event:w1:steer (now): stop now", "interrupt:w1", "queue:w1:stop now", "resume:w1"]);
	});

	it("wakes an idle worker on a now-steer without interrupting, and cancels at once", () => {
		const { control, calls } = fakeLanes({ running: false, registered: true });
		control.steerWorker("w2", "start over", "now");
		expect(calls).toEqual(["event:w2:steer (now): start over", "interrupt:w2", "followUp:w2:start over"]);
		calls.length = 0;
		control.cancelWorker("w2", "supervisor requested reroute");
		expect(calls).toEqual([
			"event:w2:cancel: supervisor requested reroute",
			"cancel:w2:supervisor requested reroute",
		]);
	});
});
