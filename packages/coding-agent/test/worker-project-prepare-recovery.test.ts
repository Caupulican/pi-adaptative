import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { expect, it, vi } from "vitest";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { createLocalWorkerProcessOwnerId, isLocalProcessAlive } from "../src/core/delegation/worker-process-owner.ts";
import { WorkerProjectDirectory } from "../src/core/delegation/worker-project-directory.ts";
import { createHarness } from "./suite/harness.ts";

it.each(["before", "after"].flatMap((phase) => ["crash", "live", "lost-receipt"].map((mode) => ({ phase, mode }))))(
	"project preparation $phase durable acceptance preserves recovery proof for $mode",
	async ({ phase, mode }) => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-prepare-recovery-"));
		const provider = registerFauxProvider();
		let requests = 0;
		let messages = "";
		provider.setResponses(
			Array.from({ length: 12 }, () => (context: Context, options?: SimpleStreamOptions) => {
				if (options?.sessionId?.startsWith("lane:worker:")) {
					requests++;
					messages = JSON.stringify(context.messages);
				}
				return fauxAssistantMessage(JSON.stringify({ status: "completed", summary: "Finished" }));
			}),
		);
		const options = {
			agentDir,
			cwd: agentDir,
			sharedFauxProvider: provider,
			settings: { workerDelegation: { enabled: true } },
		};
		const first = await createHarness(options);
		const second = await createHarness(options);
		const exited = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" });
		expect(exited.status).toBe(0);
		const pid = Number(exited.stdout.trim());
		expect(isLocalProcessAlive(pid)).toBe(false);
		const owner = vi
			.spyOn(WorkerAgentControlCoordinator.prototype, "getProcessOwnerId")
			.mockReturnValue(createLocalWorkerProcessOwnerId(mode === "crash" ? pid : process.pid, randomUUID()));
		const cancel =
			mode === "lost-receipt"
				? undefined
				: vi.spyOn(WorkerProjectDirectory.prototype, "cancelUnboundAllocation").mockImplementation(() => {});
		const prepare = WorkerLifecycle.prototype.prepare;
		let injected = false;
		const spy = vi.spyOn(WorkerLifecycle.prototype, "prepare").mockImplementation(function (
			this: WorkerLifecycle,
			...args
		) {
			if (phase === "after") prepare.apply(this, args);
			injected = true;
			throw new Error("Interrupted preparation receipt");
		});
		try {
			await first.session.runWorkerDelegationOnce({ instructions: "Abandoned preparation" }).catch(() => {});
			expect(injected).toBe(true);
			expect(requests).toBe(0);
			spy.mockRestore();
			owner.mockRestore();
			cancel?.mockRestore();
			const lifecycle = new WorkerLifecycle({ agentDir, sessionId: first.sessionManager.getSessionId() });
			const attempts = Object.values(lifecycle.getTaskRuntimeSnapshot().attempts);
			expect(attempts).toHaveLength(phase === "after" ? 1 : 0);
			const next = await second.session.runWorkerDelegationOnce({ instructions: "Next task" });
			if (mode === "live") {
				expect(next.started).toBe(false);
				expect(requests).toBe(0);
				if (phase === "after")
					expect(lifecycle.getTaskRuntimeSnapshot().attempts[attempts[0].attemptId].status).toBe("queued");
			} else {
				expect(next.record?.status).toBe("succeeded");
				expect(requests).toBe(1);
				expect(messages).not.toContain("Abandoned preparation");
				if (phase === "after") {
					expect(lifecycle.getTaskRuntimeSnapshot().attempts[attempts[0].attemptId].status).toBe("cancelled");
					expect(lifecycle.getPendingTerminalNotifications()).toHaveLength(1);
				}
			}
		} finally {
			spy.mockRestore();
			owner.mockRestore();
			cancel?.mockRestore();
			await second.cleanup();
			await first.cleanup();
			provider.unregister();
			rmSync(agentDir, { recursive: true, force: true });
		}
	},
);
