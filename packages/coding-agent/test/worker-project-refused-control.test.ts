import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { expect, it } from "vitest";
import type { BackgroundLaneController } from "../src/core/background-lane-controller.ts";
import { MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH } from "../src/core/orchestration/contracts.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

it.each(["empty", "oversized", "none"])(
	"a %s refused control leaves the original context available to the next parent",
	async (kind) => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-project-refused-control-"));
		const provider = registerFauxProvider();
		const requests: string[] = [];
		provider.setResponses(
			Array.from({ length: 16 }, () => (context: Context, options?: SimpleStreamOptions) => {
				if (!options?.sessionId?.startsWith("lane:worker:")) return fauxAssistantMessage("Acknowledged.");
				requests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage(JSON.stringify({ status: "completed", summary: "Retained project finding" }));
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
			const initial = await first.session.runWorkerDelegationOnce({ instructions: "Inspect project ownership" });
			expect(initial.record?.status).toBe("succeeded");
			if (kind !== "none") {
				const controller = (first.session as unknown as { _backgroundLanes: BackgroundLaneController })
					._backgroundLanes;
				const message = kind === "empty" ? " " : "x".repeat(MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH + 1);
				expect(() => controller.startWorkerAgentTask(initial.record!.agentId!, message)).toThrow();
			}
			const next = await second.session.runWorkerDelegationOnce({ instructions: "Continue project ownership work" });
			expect(next.record?.status, JSON.stringify(next)).toBe("succeeded");
			expect(requests).toHaveLength(2);
			expect(requests[1]).toContain("Retained project finding");
		} finally {
			await second.cleanup();
			await first.cleanup();
			provider.unregister();
			rmSync(agentDir, { recursive: true, force: true });
		}
	},
);
