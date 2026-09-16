import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { createLocalWorkerProcessOwnerId, isLocalProcessAlive } from "../src/core/delegation/worker-process-owner.ts";
import { WorkerProjectDirectory } from "../src/core/delegation/worker-project-directory.ts";

it.each(["dead", "live", "unknown"])("unbound project allocation recovery requires a proven %s owner", (ownerState) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-project-unbound-"));
	try {
		const exited = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" });
		expect(exited.status).toBe(0);
		const pid = Number(exited.stdout.trim());
		expect(isLocalProcessAlive(pid)).toBe(false);
		const incarnation =
			ownerState === "unknown"
				? "unknown-owner"
				: createLocalWorkerProcessOwnerId(ownerState === "dead" ? pid : process.pid, randomUUID());
		const directory = new WorkerProjectDirectory(agentDir, new WorkerConversationStore());
		const request = { specializationKey: "b".repeat(64), independent: false, isCompatible: () => true };
		const birth = directory.admit({ ...request, owner: { parentSessionId: "birth", incarnation } });
		expect(birth.kind).toBe("allocated");
		const successor = new WorkerProjectDirectory(agentDir, new WorkerConversationStore()).admit({
			...request,
			owner: { parentSessionId: "next", incarnation: createLocalWorkerProcessOwnerId(process.pid, randomUUID()) },
		});
		expect(successor.kind).toBe(ownerState === "dead" ? "allocated" : "unavailable");
		if (ownerState === "dead" && birth.kind === "allocated")
			expect(() => directory.cancelUnboundAllocation(birth.allocation)).toThrow(/stale/i);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
