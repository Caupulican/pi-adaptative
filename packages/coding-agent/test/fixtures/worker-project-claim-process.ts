import { readFileSync } from "node:fs";
import { WorkerConversationStore } from "../../src/core/delegation/worker-conversation-store.ts";

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Parameters<
	WorkerConversationStore["claimProjectContext"]
>[0];
function send(value: object): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send) return reject(new Error("IPC is required."));
		process.send(value, (error) => (error ? reject(error) : resolve()));
	});
}
process.once("message", () => {
	void (async () => {
		await send({ phase: "entered" });
		try {
			const conversation = new WorkerConversationStore().claimProjectContext(input);
			conversation.appendMessage({ role: "user", content: input.owner.parentSessionId, timestamp: 2 });
			await send({ phase: "result", claimed: true });
		} catch (error) {
			await send({ phase: "result", claimed: false, error: String(error) });
		}
		process.disconnect();
	})().catch((error: unknown) => {
		process.stderr.write(String(error));
		process.exitCode = 1;
		if (process.connected) process.disconnect();
	});
});
await send({ phase: "ready" });
