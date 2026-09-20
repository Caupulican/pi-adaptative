import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createSessionForegroundControl } from "../src/core/system-one/foreground-control.ts";
import { createHarness } from "./suite/harness.ts";

const parameters = Type.Object({ command: Type.String() });

describe("System One foreground control", () => {
	it("queues a steer, and a steer delivered now aborts the turn and sends the queue once the foreground is idle", async () => {
		const events: string[] = [];
		let running = true;
		let queued: string[] = [];
		let idle: () => void = () => {};
		const prompts: string[] = [];
		const control = createSessionForegroundControl({
			abortTurn: (reason) => events.push(`abort:${reason}`),
			isTurnRunning: () => running,
			queueSteer: (text) => queued.push(text),
			takeQueuedText: () => {
				const text = queued.join("\n\n");
				queued = [];
				return text;
			},
			waitForForegroundIdle: () => new Promise((resolve) => (idle = resolve)),
			prompt: async (text) => {
				prompts.push(text);
			},
			recordDirective: (directive) => events.push(`event:${directive}`),
			emitWarning: (message) => events.push(`warn:${message}`),
		});
		await control.steer("keep to the step", "queue");
		expect(queued).toEqual(["keep to the step"]);
		expect(events).toEqual(["event:steer (queue): keep to the step"]);
		await control.steer("stop editing tests", "now");
		expect(events.at(-2)).toBe("event:steer (now): stop editing tests");
		expect(events.at(-1)).toBe("abort:system_one:steer now");
		idle();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(prompts).toEqual(["keep to the step\n\nstop editing tests"]);
		running = false;
		control.cancelTurn("nothing running");
		expect(events.at(-1)).toBe("event:cancel turn: nothing running");
	});

	it("cancels the live turn at once from inside a tool call, like the operator's Esc", async () => {
		let session: Awaited<ReturnType<typeof createHarness>>["session"] | undefined;
		const tool = {
			name: "bash",
			label: "Bash",
			description: "Run a shell command",
			parameters,
			execute: async () => {
				session?.systemOneForegroundControl.cancelTurn("replan: off-step tool call");
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		} satisfies AgentTool<typeof parameters>;
		const harness = await createHarness({ tools: [tool] });
		session = harness.session;
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "git status" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("should not be reached"),
			]);
			await harness.session.prompt("Check the tree");
			const assistants = harness.session.agent.state.messages.filter((message) => message.role === "assistant");
			expect(assistants.at(-1)?.stopReason).toBe("aborted");
			const directives = harness.session.operatorProjection
				.getVisibleEvents()
				.filter((event) => event.title === "System One directed root")
				.map((event) => event.detail);
			expect(directives).toEqual(["cancel turn: replan: off-step tool call"]);
		} finally {
			await harness.cleanup();
		}
	});
});
