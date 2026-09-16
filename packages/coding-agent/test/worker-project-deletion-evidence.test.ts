import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { deleteForegroundSessionBundle } from "../src/core/session-artifact-bundle.ts";

it.each(["missing", "downgraded", "intact"])("preserves enrolled history with %s ownership metadata", async (mode) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-delete-evidence-"));
	try {
		const store = new WorkerConversationStore();
		const parentSessionId = "birth";
		const original = store.create({
			agentDir,
			parentSessionId,
			logicalAgentId: "worker-1",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const context = original.getResumeContext();
		store.claimProjectContext({
			agentDir,
			resumeContext: context,
			expectedLogicalAgentId: "worker-1",
			owner: { parentSessionId, incarnation: "one" },
			specializationKey: "a".repeat(64),
		});
		const metadata = `${context.sessionFile!}.worker.json`;
		if (mode === "missing") rmSync(metadata);
		if (mode === "downgraded")
			writeFileSync(metadata, JSON.stringify(JSON.parse(readFileSync(metadata, "utf8")).metadata));
		const sessionPath = join(agentDir, "foreground.jsonl");
		writeFileSync(sessionPath, "foreground\n");
		const result = await deleteForegroundSessionBundle({
			agentDir,
			parentSessionId,
			sessionPath,
			removePath: async (path) => {
				rmSync(path, { recursive: true, force: true });
				return { ok: true, method: "unlink" };
			},
		});
		expect(result.complete).toBe(false);
		expect(result.workerArtifacts).toMatchObject({ ok: false, method: "preserved" });
		expect(existsSync(context.sessionFile!)).toBe(true);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
