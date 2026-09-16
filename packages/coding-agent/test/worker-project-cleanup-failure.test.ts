import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { expect, it, vi } from "vitest";
import type * as LaneToolSurfaceModule from "../src/core/autonomy/lane-tool-surface.ts";
import { createHarness } from "./suite/harness.ts";

const failure = { enabled: false };
vi.mock("../src/core/autonomy/lane-tool-surface.ts", async (importOriginal) => {
	const original = (await importOriginal()) as typeof LaneToolSurfaceModule;
	return {
		...original,
		createLaneToolSurface: (options: Parameters<typeof original.createLaneToolSurface>[0]) => {
			const surface = original.createLaneToolSurface(options);
			return {
				...surface,
				dispose: async () => {
					await surface.dispose();
					if (failure.enabled) throw new Error("Injected unresolved cleanup failure");
				},
			};
		},
	};
});

it.each([
	{ fails: true, foreign: false },
	{ fails: true, foreign: true },
	{ fails: false, foreign: false },
	{ fails: false, foreign: true },
])("cleanup result gates specialist reuse ($fails, foreign=$foreign)", async ({ fails, foreign }) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-project-cleanup-"));
	const provider = registerFauxProvider();
	let workerRequests = 0;
	provider.setResponses(
		Array.from({ length: 16 }, () => (_context: Context, options?: SimpleStreamOptions) => {
			if (!options?.sessionId?.startsWith("lane:worker:")) return fauxAssistantMessage("Acknowledged.");
			workerRequests++;
			return fauxAssistantMessage(JSON.stringify({ status: "completed", summary: "Task finished" }));
		}),
	);
	const options = {
		agentDir,
		cwd: agentDir,
		sharedFauxProvider: provider,
		settings: { workerDelegation: { enabled: true } },
	};
	const first = await createHarness(options);
	const second = foreign ? await createHarness(options) : first;
	try {
		failure.enabled = fails;
		expect((await first.session.runWorkerDelegationOnce({ instructions: "Finish the initial task" })).started).toBe(
			true,
		);
		failure.enabled = false;
		const next = await second.session.runWorkerDelegationOnce({ instructions: "Continue project work" });
		expect(next.started).toBe(!fails);
		expect(workerRequests).toBe(fails ? 1 : 2);
	} finally {
		failure.enabled = false;
		if (foreign) await second.cleanup();
		await first.cleanup();
		provider.unregister();
		rmSync(agentDir, { recursive: true, force: true });
	}
});
