import type { AgentContext, BackgroundToolCallCompletion, BackgroundToolCallContext } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	BackgroundToolTaskController,
	type BackgroundToolTaskRecord,
} from "../src/core/background-tool-task-controller.ts";
import { withExclusiveMutationBarrier } from "../src/core/tools/file-mutation-queue.ts";

function assistantMessage(toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "sleep 600" } }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

/** A handed-off call whose completion never settles: exactly the long job the barrier must not hold. */
function neverSettlingContext(toolCallId: string, trigger: BackgroundToolCallContext["trigger"]) {
	const toolCall = { type: "toolCall" as const, id: toolCallId, name: "bash", arguments: { command: "sleep 600" } };
	return {
		assistantMessage: assistantMessage(toolCallId),
		toolCall,
		args: toolCall.arguments,
		context: { systemPrompt: "", messages: [], tools: [] } satisfies AgentContext,
		trigger,
		elapsedMs: 15_000,
		completion: new Promise<BackgroundToolCallCompletion>(() => {}),
		cancel: vi.fn(),
	} satisfies BackgroundToolCallContext;
}

function createController(sessionId: string) {
	const persisted: BackgroundToolTaskRecord[] = [];
	const controller = new BackgroundToolTaskController({
		getSessionId: () => sessionId,
		getArtifactStore: () => undefined,
		persist: (record) => persisted.push(record),
		notifyTerminal: () => {},
	});
	return { controller, persisted };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("background handoff and the exclusive mutation barrier", () => {
	it.each(["clock", "manual"] as const)(
		"a %s handoff stops holding the barrier while the command keeps running",
		async (trigger) => {
			const { controller, persisted } = createController(`session-${trigger}`);
			const started = deferred();
			const commandGate = deferred();
			let commandSettled = false;
			const held = withExclusiveMutationBarrier(
				async () => {
					started.resolve();
					await commandGate.promise;
				},
				{ holdId: "call-held" },
			).then(() => {
				commandSettled = true;
			});
			await started.promise;

			const handoff = controller.handoff(neverSettlingContext("call-held", trigger));
			expect(handoff).toBeDefined();
			expect(persisted).toHaveLength(1);

			// The handed-off command is a detached session task now: the next exclusive run must not
			// wait for it, and its own work is still running.
			let successorRan = false;
			await withExclusiveMutationBarrier(
				async () => {
					successorRan = true;
				},
				{ holdId: "call-successor" },
			);
			expect(successorRan).toBe(true);
			expect(commandSettled).toBe(false);

			commandGate.resolve();
			await held;
			await controller.shutdown();
		},
	);
});
