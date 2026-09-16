import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { expect, it } from "vitest";
import type { BackgroundLaneController } from "../src/core/background-lane-controller.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { createHarness } from "./suite/harness.ts";

it.each(["cancel", "dispose", "retained"])(
	"queued specialist ownership follows %s before execution",
	async (action) => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-project-queued-cancel-"));
		const provider = registerFauxProvider();
		let requests = 0;
		provider.setResponses(
			Array.from({ length: 16 }, () => (_context: Context, options?: SimpleStreamOptions) => {
				if (!options?.sessionId?.startsWith("lane:worker:")) return fauxAssistantMessage("Acknowledged.");
				requests++;
				return fauxAssistantMessage(
					JSON.stringify({ status: "completed", summary: "Completed the admitted task" }),
				);
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
		try {
			const controller = (first.session as unknown as { _backgroundLanes: BackgroundLaneController })
				._backgroundLanes;
			const queued = await controller.startWorkerDelegation({ instructions: "Task waiting for foreground idle" });
			if (!queued.started) throw new Error(`Initial task was refused: ${queued.skipReason}`);
			expect(queued.record?.status).toBe("queued");
			expect(requests).toBe(0);
			const original = new WorkerLifecycle({ agentDir, sessionId: first.sessionManager.getSessionId() }).getAgent(
				queued.record!.agentId!,
			)!;
			if (action === "cancel") expect(controller.cancelWorkerAgent(original.agentId)?.status).toBe("canceled");
			if (action === "dispose") await first.cleanup();
			const next = await second.session.runWorkerDelegationOnce({ instructions: "Run the replacement task" });
			expect(next.started).toBe(action !== "retained");
			expect(requests).toBe(action === "retained" ? 0 : 1);
			if (next.started) {
				expect(next.record?.status).toBe("succeeded");
				const imported = new WorkerLifecycle({
					agentDir,
					sessionId: second.sessionManager.getSessionId(),
				}).getAgent(next.record!.agentId!)!;
				expect(imported.resumeContext).toMatchObject(original.resumeContext);
			}
		} finally {
			await second.cleanup();
			await first.cleanup();
			provider.unregister();
			rmSync(agentDir, { recursive: true, force: true });
		}
	},
);
