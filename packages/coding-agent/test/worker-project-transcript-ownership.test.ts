import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicCompaction } from "@caupulican/pi-agent-core/compaction/compaction";
import { afterEach, expect, it } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-ownership-"));
	roots.push(agentDir);
	const store = new WorkerConversationStore();
	const options = {
		agentDir,
		parentSessionId: "birth-parent",
		logicalAgentId: "worker-1",
		cwd: agentDir,
		resourceProfileNames: [],
		contextPointers: [],
	};
	const legacy = store.create(options);
	legacy.appendMessage({ role: "user", content: "Original history", timestamp: 1 });
	const resumeContext = legacy.getResumeContext();
	const open = { agentDir, resumeContext, expectedLogicalAgentId: "worker-1" };
	const specializationKey = "a".repeat(64);
	const owner = { parentSessionId: "birth-parent", incarnation: "process-a" };
	return { store, legacy, options, open, specializationKey, owner };
}

it("fences cached and freshly reopened writers while the current claim retains the exact transcript", () => {
	const f = fixture();
	const claimed = f.store.claimProjectContext({ ...f.open, owner: f.owner, specializationKey: f.specializationKey });
	claimed.appendMessage({ role: "user", content: "First owned task", timestamp: 2 });
	f.store.releaseProjectContext(claimed);
	expect(() => claimed.appendMessage({ role: "user", content: "Late callback", timestamp: 3 })).toThrow();
	const successor = f.store.claimProjectContext({
		...f.open,
		owner: { parentSessionId: "parent-b", incarnation: "process-b" },
		specializationKey: f.specializationKey,
	});
	const reopened = f.store.open(f.open);
	for (const stale of [f.legacy, claimed, reopened])
		expect(() => stale.appendMessage({ role: "user", content: "Stale write", timestamp: 4 })).toThrow();
	successor.appendMessage({ role: "user", content: "Second owned task", timestamp: 5 });
	expect(successor.getResumeContext()).toEqual(f.open.resumeContext);
	expect(successor.getRawTranscript().map((message) => message.content)).toEqual([
		"Original history",
		"First owned task",
		"Second owned task",
	]);
	expect(() => f.store.releaseProjectContext(claimed)).toThrow();
});

it("does not let ensure recover or update an enrolled transcript without a current claim", () => {
	const f = fixture();
	const claimed = f.store.claimProjectContext({ ...f.open, owner: f.owner, specializationKey: f.specializationKey });
	const before = readFileSync(f.open.resumeContext.sessionFile!, "utf8");
	expect(() => f.store.ensure(f.options)).toThrow();
	expect(() =>
		f.store.claimProjectContext({
			...f.open,
			owner: { parentSessionId: "other", incarnation: "b" },
			specializationKey: f.specializationKey,
		}),
	).toThrow();
	expect(readFileSync(f.open.resumeContext.sessionFile!, "utf8")).toBe(before);
	claimed.appendMessage({ role: "user", content: "Still owned", timestamp: 2 });
});

it("rejects registration of a foreign unindexed history and an incompatible project key", () => {
	const f = fixture();
	expect(() =>
		f.store.claimProjectContext({
			...f.open,
			owner: { parentSessionId: "other", incarnation: "b" },
			specializationKey: f.specializationKey,
		}),
	).toThrow();
	f.legacy.appendMessage({
		role: "user",
		content: "Negative control: original legacy owner remains usable",
		timestamp: 2,
	});
	const claimed = f.store.claimProjectContext({ ...f.open, owner: f.owner, specializationKey: f.specializationKey });
	f.store.releaseProjectContext(claimed);
	expect(() =>
		f.store.claimProjectContext({ ...f.open, owner: f.owner, specializationKey: "b".repeat(64) }),
	).toThrow();
});

it("keeps enrollment mandatory after metadata downgrade and exposes no legacy top-level identity", () => {
	const f = fixture();
	const claimed = f.store.claimProjectContext({ ...f.open, owner: f.owner, specializationKey: f.specializationKey });
	f.store.releaseProjectContext(claimed);
	const path = `${f.open.resumeContext.sessionFile!}.worker.json`;
	const envelope = JSON.parse(readFileSync(path, "utf8"));
	expect(envelope.logicalAgentId).toBeUndefined();
	expect(envelope.metadata.logicalAgentId).toBe("worker-1");
	writeFileSync(path, JSON.stringify(envelope.metadata));
	const reopened = new WorkerConversationStore().open(f.open);
	expect(() => reopened.appendMessage({ role: "user", content: "Downgrade bypass", timestamp: 3 })).toThrow();
	expect(() => new WorkerConversationStore().ensure(f.options)).toThrow();
});

it("fences a captured transcript commit after release even when another view refreshed the shared core", () => {
	const f = fixture();
	const claimed = f.store.claimProjectContext({ ...f.open, owner: f.owner, specializationKey: f.specializationKey });
	const { cursor } = claimed.beginTranscriptCommit();
	expect(() => f.store.releaseProjectContext(claimed)).toThrow();
	claimed.abortTranscriptCommit(cursor);
	f.store.releaseProjectContext(claimed);
	const next = f.store.claimProjectContext({ ...f.open, owner: f.owner, specializationKey: f.specializationKey });
	const content = "[Worker control worker-message-stale]\nOld callback";
	expect(() =>
		claimed.reconcileWorkerControlMessage(
			{ messageId: "worker-message-stale", content },
			{ role: "user", content, timestamp: 3 },
			true,
		),
	).toThrow();
	next.appendMessage({ role: "user", content: "Current owner", timestamp: 4 });
});

it("allows read-only delivery evidence after ownership transferred without accepting old-parent work", () => {
	const f = fixture();
	const claimed = f.store.claimProjectContext({ ...f.open, owner: f.owner, specializationKey: f.specializationKey });
	const content = "[Worker control worker-message-delivered]\nAlready committed";
	const expectation = { messageId: "worker-message-delivered", content };
	claimed.reconcileWorkerControlMessage(expectation, { role: "user", content, timestamp: 3 }, true);
	f.store.releaseProjectContext(claimed);
	f.store.claimProjectContext({
		...f.open,
		owner: { parentSessionId: "other", incarnation: "other-process" },
		specializationKey: f.specializationKey,
	});
	const readOnly = f.store.open(f.open);
	expect([...readOnly.findDeliveredWorkerControlMessageIds([expectation])]).toEqual([expectation.messageId]);
	expect(readOnly.reconcileWorkerControlMessage(expectation, { role: "user", content, timestamp: 3 }, false)).toEqual({
		delivered: true,
		appended: false,
	});
	expect(() =>
		readOnly.reconcileWorkerControlMessage(expectation, { role: "user", content, timestamp: 3 }, true),
	).toThrow();
});

it.each([false, true])(
	"rejects late compaction publication after transfer (provider failed: %s)",
	async (providerFailed) => {
		const f = fixture();
		const claimed = f.store.claimProjectContext({
			...f.open,
			owner: f.owner,
			specializationKey: f.specializationKey,
		});
		for (let index = 0; index < 24; index++)
			claimed.appendMessage({
				role: "user",
				content: `Turn ${index}: ${"evidence ".repeat(80)}`,
				timestamp: index + 2,
			});
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const pending = claimed
			.compactProviderContext({
				maxContextTokens: 1200,
				keepRecentTokens: 400,
				generateVerifiedCompaction: async (preparation) => {
					entered.resolve();
					await gate.promise;
					if (providerFailed) throw new Error("Delayed provider failure");
					return createDeterministicCompaction(preparation);
				},
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		await entered.promise;
		try {
			f.store.releaseProjectContext(claimed);
			const successor = f.store.claimProjectContext({
				...f.open,
				owner: { parentSessionId: "other", incarnation: "other" },
				specializationKey: f.specializationKey,
			});
			const before = readFileSync(f.open.resumeContext.sessionFile!, "utf8");
			gate.resolve();
			expect(await pending).toBeInstanceOf(Error);
			expect(readFileSync(f.open.resumeContext.sessionFile!, "utf8")).toBe(before);
			successor.appendMessage({ role: "user", content: "Successor still writes", timestamp: 100 });
		} finally {
			gate.resolve();
			await pending;
		}
	},
);
