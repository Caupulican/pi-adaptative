import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { expect, it, vi } from "vitest";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { createLocalWorkerProcessOwnerId, isLocalProcessAlive } from "../src/core/delegation/worker-process-owner.ts";
import { createHarness } from "./suite/harness.ts";

it.each(
	["ensure-before", "claim-after", "binding-before"].flatMap((fault) =>
		["dead", "live", "unknown"].map((ownerState) => ({ fault, ownerState })),
	),
)("interrupted $fault setup recovers only a proven $ownerState owner", async ({ fault, ownerState }) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-project-restart-"));
	const provider = registerFauxProvider();
	let requests = 0;
	let providerContext = "";
	let enrolledSessionId: string | undefined;
	provider.setResponses(
		Array.from({ length: 12 }, () => (context: Context, options?: SimpleStreamOptions) => {
			if (options?.sessionId?.startsWith("lane:worker:")) {
				requests++;
				providerContext = JSON.stringify(context.messages);
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
	const exitedPid = Number(exited.stdout.trim());
	expect(Number.isSafeInteger(exitedPid)).toBe(true);
	expect(isLocalProcessAlive(exitedPid)).toBe(false);
	const incarnation =
		ownerState === "unknown"
			? "unclassified-owner"
			: createLocalWorkerProcessOwnerId(ownerState === "dead" ? exitedPid : process.pid, randomUUID());
	const owner = vi.spyOn(WorkerAgentControlCoordinator.prototype, "getProcessOwnerId").mockReturnValue(incarnation);
	// Preserve the durable state at abrupt interruption: the dying parent never runs its catch's
	// cancellation. The real setup writes and the successor's complete admission path still execute.
	const cancel = vi.spyOn(WorkerLifecycle.prototype, "cancel").mockReturnValue(undefined);
	const ensure = WorkerConversationStore.prototype.ensure;
	const claim = WorkerConversationStore.prototype.claimProjectContext;
	const bind = WorkerLifecycle.prototype.ensureAgent;
	let injected = false;
	const ensureSpy = vi.spyOn(WorkerConversationStore.prototype, "ensure").mockImplementation(function (
		this: WorkerConversationStore,
		input,
	) {
		if (fault === "ensure-before") {
			injected = true;
			throw new Error("Interrupted before transcript creation");
		}
		return ensure.call(this, input);
	});
	const claimSpy = vi.spyOn(WorkerConversationStore.prototype, "claimProjectContext").mockImplementation(function (
		this: WorkerConversationStore,
		input,
	) {
		const conversation = claim.call(this, input);
		enrolledSessionId = conversation.getResumeContext().sessionId;
		if (fault === "claim-after") {
			injected = true;
			throw new Error("Interrupted after enrollment");
		}
		return conversation;
	});
	const bindSpy = vi.spyOn(WorkerLifecycle.prototype, "ensureAgent").mockImplementation(function (
		this: WorkerLifecycle,
		input,
	) {
		if (fault === "binding-before") {
			injected = true;
			throw new Error("Interrupted before registration");
		}
		return bind.call(this, input);
	});
	const restore = () => {
		ensureSpy.mockRestore();
		claimSpy.mockRestore();
		bindSpy.mockRestore();
		owner.mockRestore();
		cancel.mockRestore();
	};
	try {
		await first.session.runWorkerDelegationOnce({ instructions: "Interrupted project task" });
		expect(injected).toBe(true);
		expect(requests).toBe(0);
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: first.sessionManager.getSessionId() });
		const attempts = Object.values(lifecycle.getTaskRuntimeSnapshot().attempts);
		expect(attempts).toHaveLength(1);
		expect(attempts[0].status).toBe("queued");
		expect(attempts[0].lease).toBeUndefined();
		restore();
		const next = await second.session.runWorkerDelegationOnce({ instructions: "Next project task" });
		if (ownerState === "dead") {
			expect(next.record?.status).toBe("succeeded");
			expect(requests).toBe(1);
			expect(providerContext).toContain("Next project task");
			expect(providerContext).not.toContain("Interrupted project task");
			expect(lifecycle.getTaskRuntimeSnapshot().attempts[attempts[0].attemptId].status).toBe("cancelled");
			expect(lifecycle.getPendingTerminalNotifications()).toHaveLength(1);
			if (enrolledSessionId) {
				const imported = new WorkerLifecycle({ agentDir, sessionId: second.sessionManager.getSessionId() });
				expect(imported.getAgent(next.record!.agentId!)?.resumeContext.sessionId).toBe(enrolledSessionId);
			}
		} else {
			expect(next.started).toBe(false);
			expect(requests).toBe(0);
			expect(lifecycle.getTaskRuntimeSnapshot().attempts[attempts[0].attemptId]).toEqual(attempts[0]);
		}
	} finally {
		restore();
		await second.cleanup();
		await first.cleanup();
		provider.unregister();
		rmSync(agentDir, { recursive: true, force: true });
	}
});
