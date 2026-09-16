import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { withFileLock } from "../src/core/util/atomic-file.ts";

function claimant(inputFile: string) {
	const child = fork(
		fileURLToPath(new URL("./fixtures/worker-project-claim-process.ts", import.meta.url)),
		[inputFile],
		{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
	);
	const ready = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const completed = Promise.withResolvers<boolean>();
	let claimed: boolean | undefined;
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString()}`.slice(-4096);
	});
	const fail = (error: Error) => {
		ready.reject(error);
		entered.reject(error);
		completed.reject(error);
	};
	for (const promise of [ready.promise, entered.promise, completed.promise]) void promise.catch(() => {});
	child.on("message", (message: unknown) => {
		if (!message || typeof message !== "object" || !("phase" in message))
			return fail(new Error("Invalid claim IPC."));
		if (message.phase === "ready") ready.resolve();
		else if (message.phase === "entered") entered.resolve();
		else if (message.phase === "result" && "claimed" in message && typeof message.claimed === "boolean")
			claimed = message.claimed;
		else fail(new Error("Unexpected claim IPC."));
	});
	child.once("error", fail);
	child.once("exit", (code) => {
		if (code === 0 && claimed !== undefined) completed.resolve(claimed);
		else fail(new Error(`Claim child exited ${code}: ${stderr}`));
	});
	return { child, ready: ready.promise, entered: entered.promise, completed: completed.promise };
}

it("two native processes racing for one released transcript admit exactly one writer", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-project-claim-race-"));
	const children: ChildProcess[] = [];
	try {
		const store = new WorkerConversationStore();
		const conversation = store.create({
			agentDir: root,
			parentSessionId: "birth",
			logicalAgentId: "worker-1",
			cwd: root,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const open = {
			agentDir: root,
			resumeContext: conversation.getResumeContext(),
			expectedLogicalAgentId: "worker-1",
			specializationKey: "a".repeat(64),
		};
		const owned = store.claimProjectContext({ ...open, owner: { parentSessionId: "birth", incarnation: "first" } });
		store.releaseProjectContext(owned);
		const processes = ["left", "right"].map((parentSessionId) => {
			const inputFile = join(root, `${parentSessionId}.json`);
			writeFileSync(
				inputFile,
				JSON.stringify({ ...open, owner: { parentSessionId, incarnation: parentSessionId } }),
			);
			const process = claimant(inputFile);
			children.push(process.child);
			return process;
		});
		await Promise.all(processes.map((process) => process.ready));
		await withFileLock(open.resumeContext.sessionFile!, async () => {
			for (const process of processes) process.child.send("start");
			await Promise.all(processes.map((process) => process.entered));
		});
		const claimed = await Promise.all(processes.map((process) => process.completed));
		expect(claimed.filter(Boolean)).toHaveLength(1);
		const messages = new WorkerConversationStore().open(open).getRawTranscript();
		expect(messages).toHaveLength(1);
		expect(messages[0].content).toBe(claimed[0] ? "left" : "right");
		expect(() =>
			store.claimProjectContext({ ...open, owner: { parentSessionId: "third", incarnation: "third" } }),
		).toThrow(/busy/i);
	} finally {
		await Promise.all(
			children.map(
				(child) =>
					new Promise<void>((resolve) => {
						if (child.exitCode !== null || child.signalCode !== null) return resolve();
						child.once("exit", () => resolve());
						child.kill();
					}),
			),
		);
		rmSync(root, { recursive: true, force: true });
	}
});
