import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { expect, it, vi } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { createHarness } from "./suite/harness.ts";

it.each(["before", "after", "none"])(
	"project admission recovers after a %s transcript creation failure",
	async (phase) => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-project-setup-failure-"));
		const provider = registerFauxProvider();
		let requests = 0;
		provider.setResponses(
			Array.from({ length: 16 }, () => (_context: Context, options?: SimpleStreamOptions) => {
				if (!options?.sessionId?.startsWith("lane:worker:")) return fauxAssistantMessage("Acknowledged.");
				requests++;
				return fauxAssistantMessage(JSON.stringify({ status: "completed", summary: "Finished project task" }));
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
		const ensure = WorkerConversationStore.prototype.ensure;
		let injected = false;
		const spy = vi.spyOn(WorkerConversationStore.prototype, "ensure").mockImplementation(function (
			this: WorkerConversationStore,
			input,
		) {
			if (phase === "before") {
				injected = true;
				throw new Error("Injected failure before transcript creation");
			}
			const conversation = ensure.call(this, input);
			if (phase === "after") {
				injected = true;
				throw new Error("Injected failure after transcript creation");
			}
			return conversation;
		});
		try {
			const initial = await first.session.runWorkerDelegationOnce({ instructions: "First project task" });
			expect(injected).toBe(phase !== "none");
			expect(initial.started).toBe(phase === "none");
			expect(requests).toBe(phase === "none" ? 1 : 0);
			spy.mockRestore();
			const next = await second.session.runWorkerDelegationOnce({ instructions: "Next project task" });
			expect(next.record?.status).toBe("succeeded");
			expect(requests).toBe(phase === "none" ? 2 : 1);
		} finally {
			spy.mockRestore();
			await second.cleanup();
			await first.cleanup();
			provider.unregister();
			rmSync(agentDir, { recursive: true, force: true });
		}
	},
);
