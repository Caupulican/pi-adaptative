import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { ownerOrchestrationHome, ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

it("weakly indexes worker cores while active views still share and fence the exact core", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-worker-core-cache-"));
	try {
		const agentDir = join(dir, "agent");
		const parent = SessionManager.create(dir, ownerSessionStorageRoots(agentDir));
		const store = new WorkerConversationStore();
		const roots = { agentDir, orchestrationHome: ownerOrchestrationHome(agentDir) };
		const first = store.ensure({
			...roots,
			parentSessionId: parent.getSessionId(),
			logicalAgentId: "cache-retention-worker",
			cwd: dir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const context = first.getResumeContext();
		const sessionFile = context.sessionFile;
		if (!sessionFile) throw new Error("Expected a persisted worker transcript");

		const cache = (
			store as unknown as {
				cachedCores: { references: Map<string, WeakRef<object>> };
			}
		).cachedCores;
		expect(cache.references.get(sessionFile)).toBeInstanceOf(WeakRef);
		const second = store.open({ ...roots, resumeContext: context, expectedLogicalAgentId: "cache-retention-worker" });
		expect((second as unknown as { core: unknown }).core).toBe((first as unknown as { core: unknown }).core);

		const cursor = first.captureTranscriptCommitCursor();
		expect(() => store.clearCache()).toThrow(/active transcript commit/);
		second.abortTranscriptCommit(cursor);
		store.clearCache();
		expect(cache.references.size).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
