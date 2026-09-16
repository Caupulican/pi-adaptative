import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkerAgentMailbox } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";

it.each(["enqueue", "acknowledge", "discard"])(
	"rejects old-parent mailbox %s after context transfer, including a fresh constructor",
	(operation) => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-project-mailbox-"));
		try {
			const store = new WorkerConversationStore();
			const parentSessionId = "birth-parent";
			const logicalAgentId = "worker-1";
			const original = store.create({
				agentDir,
				parentSessionId,
				logicalAgentId,
				cwd: agentDir,
				resourceProfileNames: [],
				contextPointers: [],
			});
			const mailboxOptions = { agentDir, parentSessionId, agentId: logicalAgentId };
			const cached = new WorkerAgentMailbox(mailboxOptions);
			const queued = cached.enqueue({ kind: "follow_up", content: "Previously accepted message" });
			const claimOptions = {
				agentDir,
				resumeContext: original.getResumeContext(),
				expectedLogicalAgentId: logicalAgentId,
				specializationKey: "a".repeat(64),
			};
			const first = store.claimProjectContext({ ...claimOptions, owner: { parentSessionId, incarnation: "first" } });
			store.releaseProjectContext(first);
			const successor = store.claimProjectContext({
				...claimOptions,
				owner: { parentSessionId: "second-parent", incarnation: "second" },
			});
			for (const mailbox of [cached, new WorkerAgentMailbox(mailboxOptions)]) {
				expect(() => {
					if (operation === "enqueue") mailbox.enqueue({ kind: "follow_up", content: "Stale new task" });
					else if (operation === "acknowledge") mailbox.acknowledgeDelivered(queued.messageId);
					else mailbox.deadLetterPending("stale discard");
				}).toThrow();
				expect(mailbox.pending()).toEqual([queued]);
			}
			successor.appendMessage({ role: "user", content: "Current owner remains usable", timestamp: 1 });
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	},
);

it("negative control: an unindexed mailbox still accepts and acknowledges ordinary work", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-project-mailbox-legacy-"));
	try {
		const mailbox = new WorkerAgentMailbox({ agentDir, parentSessionId: "parent", agentId: "worker-1" });
		const queued = mailbox.enqueue({ kind: "follow_up", content: "Ordinary work" });
		mailbox.acknowledgeDelivered(queued.messageId);
		expect(mailbox.pending()).toEqual([]);
		expect(mailbox.hasDeliveredControlReceipt(queued.messageId)).toBe(true);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
