import type { UserMessage } from "@caupulican/pi-ai";
import { WorkerConversationStore } from "../../src/core/delegation/worker-conversation-store.ts";
import type { AgentResumeContext } from "../../src/core/orchestration/contracts.ts";

interface InitializeOwnerMessage {
	type: "initialize";
	agentDir: string;
	resumeContext: AgentResumeContext;
	expectation: {
		messageId: string;
		content: string;
	};
}

interface OwnerOperation {
	conversation: ReturnType<WorkerConversationStore["open"]>;
	expectation: InitializeOwnerMessage["expectation"];
}

let operation: OwnerOperation | undefined;

function errorRecord(error: unknown): { name: string; message: string } {
	return error instanceof Error
		? { name: error.name, message: error.message }
		: { name: "Error", message: String(error) };
}

function send(message: object): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send) {
			reject(new Error("Worker conversation process owner requires an IPC channel."));
			return;
		}
		process.send(message, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function fail(error: unknown): Promise<void> {
	process.exitCode = 1;
	await send({ phase: "fatal", error: errorRecord(error) }).catch(() => {});
	if (process.connected) process.disconnect();
}

async function handleCommand(command: unknown): Promise<void> {
	if (!command || typeof command !== "object" || Array.isArray(command)) {
		throw new TypeError("Worker conversation process command is invalid.");
	}
	const type = (command as { type?: unknown }).type;
	if (type === "initialize") {
		if (operation) throw new Error("Worker conversation process owner is already initialized.");
		const initialize = command as InitializeOwnerMessage;
		operation = {
			conversation: new WorkerConversationStore().open({
				agentDir: initialize.agentDir,
				resumeContext: initialize.resumeContext,
			}),
			expectation: initialize.expectation,
		};
		await send({ phase: "ready" });
		return;
	}
	if (type !== "start") throw new TypeError("Worker conversation process command type is invalid.");
	if (!operation) throw new Error("Worker conversation process owner was not initialized.");

	await send({ phase: "entered" });
	const message: UserMessage = {
		role: "user",
		content: operation.expectation.content,
		timestamp: 1,
	};
	try {
		const value = operation.conversation.reconcileWorkerControlMessage(operation.expectation, message, true);
		await send({ phase: "result", ok: true, value });
	} catch (error) {
		await send({ phase: "result", ok: false, error: errorRecord(error) });
	}
	if (process.connected) process.disconnect();
}

process.on("message", (command) => {
	void handleCommand(command).catch((error: unknown) => fail(error));
});
