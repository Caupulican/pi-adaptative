import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { workerAgentMailboxFile } from "../src/core/agent-paths.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { acquireFileLockSync } from "../src/core/util/atomic-file.ts";
import { createReuseHarness } from "./fixtures/specialist-reuse-harness.ts";

it("holds the mailbox admission lock while publishing an executed specialist as idle", async () => {
	const context = await createReuseHarness();
	context.appendWorkerReply("Finished the task");
	const release = WorkerConversationStore.prototype.releaseProjectContext;
	const excluded: boolean[] = [];
	const spy = vi.spyOn(WorkerConversationStore.prototype, "releaseProjectContext").mockImplementation(function (
		this: WorkerConversationStore,
		conversation,
	) {
		const agent = Object.values(context.agents()).find(
			(candidate) => candidate.resumeContext.sessionId === conversation.getResumeContext().sessionId,
		);
		if (!agent) throw new Error("Executed specialist has no durable binding");
		const parent = context.harness.sessionManager.getSessionId();
		const digest = createHash("sha256")
			.update("pi-worker-agent-mailbox-v1\0")
			.update(parent)
			.update("\0")
			.update(agent.agentId)
			.digest("hex");
		const file = workerAgentMailboxFile(context.harness.tempDir, parent, digest);
		try {
			const unlock = acquireFileLockSync(file, { retries: 0 });
			unlock();
			excluded.push(false);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ELOCKED") throw error;
			excluded.push(true);
		}
		return release.call(this, conversation);
	});
	try {
		const outcome = await context.harness.session.runWorkerDelegationOnce({ instructions: "Inspect ownership" });
		expect(outcome.record?.status).toBe("succeeded");
		expect(excluded).toEqual([true]);
	} finally {
		spy.mockRestore();
		await context.harness.cleanup();
	}
});

it("negative control: the probe acquires an unheld mailbox lock", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-mailbox-lock-control-"));
	try {
		const release = acquireFileLockSync(join(directory, "mailbox.json"), { retries: 0 });
		expect(release).toBeTypeOf("function");
		release();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
