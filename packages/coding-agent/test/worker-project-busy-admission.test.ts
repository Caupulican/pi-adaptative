import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

it.each([false, true])(
	"a busy specialist in another parent requires explicit independent work (parallel: %s)",
	async (parallel) => {
		const root = mkdtempSync(join(tmpdir(), "pi-project-busy-"));
		const provider = registerFauxProvider();
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let workerRequests = 0;
		provider.setResponses(
			Array.from({ length: 16 }, () => async (_context: Context, options?: SimpleStreamOptions) => {
				if (!options?.sessionId?.startsWith("lane:worker:")) return fauxAssistantMessage("Acknowledged.");
				workerRequests++;
				if (workerRequests === 1) {
					entered.resolve();
					await gate.promise;
				}
				return fauxAssistantMessage(JSON.stringify({ status: "completed", summary: "Worker finished" }));
			}),
		);
		const options = {
			agentDir: root,
			cwd: root,
			sharedFauxProvider: provider,
			settings: { workerDelegation: { enabled: true } },
		};
		const first = await createHarness(options);
		const second = await createHarness(options);
		const running = first.session.runWorkerDelegationOnce({ instructions: "Hold the existing project specialist" });
		void running.catch(() => {});
		try {
			await entered.promise;
			const outcome = await second.session.runWorkerDelegationOnce({
				instructions: "Inspect the same project",
				...(parallel
					? {
							parallelWork: {
								independentOf: [`${first.sessionManager.getSessionId()}:worker-1`],
								justification: "Independent second review requested explicitly",
							},
						}
					: {}),
			});
			expect(outcome.started).toBe(parallel);
			expect(workerRequests).toBe(parallel ? 2 : 1);
			if (!parallel) expect(outcome.skipReason).toMatch(/specialist.*busy/);
		} finally {
			gate.resolve();
			await running;
			await first.cleanup();
			await second.cleanup();
			provider.unregister();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
