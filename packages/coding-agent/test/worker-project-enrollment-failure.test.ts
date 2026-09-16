import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { expect, it, vi } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { createHarness } from "./suite/harness.ts";

it.each(["claim-before", "claim-after", "binding-before", "binding-after"])(
	"project admission recovers after %s fails without replaying cancelled work",
	async (fault) => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-project-enrollment-failure-"));
		const provider = registerFauxProvider();
		let requests = 0;
		let providerContext = "";
		let enrolledSessionId: string | undefined;
		provider.setResponses(
			Array.from({ length: 12 }, () => (_context: Context, options?: SimpleStreamOptions) => {
				if (options?.sessionId?.startsWith("lane:worker:")) {
					requests++;
					providerContext = JSON.stringify(_context.messages);
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
		const claim = WorkerConversationStore.prototype.claimProjectContext;
		const bind = WorkerLifecycle.prototype.ensureAgent;
		let injected = false;
		const claimSpy = vi.spyOn(WorkerConversationStore.prototype, "claimProjectContext").mockImplementation(function (
			this: WorkerConversationStore,
			input,
		) {
			if (fault === "claim-before") {
				injected = true;
				throw new Error("Claim rejected");
			}
			const conversation = claim.call(this, input);
			enrolledSessionId ??= conversation.getResumeContext().sessionId;
			if (fault === "claim-after") {
				injected = true;
				throw new Error("Claim receipt lost");
			}
			return conversation;
		});
		const bindSpy = vi.spyOn(WorkerLifecycle.prototype, "ensureAgent").mockImplementation(function (
			this: WorkerLifecycle,
			input,
		) {
			if (fault === "binding-before") {
				injected = true;
				throw new Error("Binding rejected");
			}
			const agent = bind.call(this, input);
			if (fault === "binding-after") {
				injected = true;
				throw new Error("Binding receipt lost");
			}
			return agent;
		});
		try {
			const initial = await first.session.runWorkerDelegationOnce({ instructions: "Cancelled project task" });
			expect(injected).toBe(true);
			expect(initial.started).toBe(false);
			expect(requests).toBe(0);
			const lifecycle = new WorkerLifecycle({ agentDir, sessionId: first.sessionManager.getSessionId() });
			const cancelled = Object.values(lifecycle.getTaskRuntimeSnapshot().attempts);
			expect(cancelled).toHaveLength(1);
			expect(cancelled[0].status).toBe("cancelled");
			claimSpy.mockRestore();
			bindSpy.mockRestore();
			const next = await second.session.runWorkerDelegationOnce({ instructions: "Next project task" });
			expect(next.record?.status).toBe("succeeded");
			expect(requests).toBe(1);
			expect(providerContext).toContain("Next project task");
			expect(providerContext).not.toContain("Cancelled project task");
			expect(lifecycle.getTaskRuntimeSnapshot().attempts[cancelled[0].attemptId].status).toBe("cancelled");
			if (enrolledSessionId) {
				const imported = new WorkerLifecycle({
					agentDir,
					sessionId: second.sessionManager.getSessionId(),
				}).getAgent(next.record!.agentId!);
				expect(imported?.resumeContext.sessionId).toBe(enrolledSessionId);
			}
		} finally {
			claimSpy.mockRestore();
			bindSpy.mockRestore();
			await second.cleanup();
			await first.cleanup();
			provider.unregister();
			rmSync(agentDir, { recursive: true, force: true });
		}
	},
);
