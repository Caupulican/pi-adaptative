import { expect, it, vi } from "vitest";
import { WorkerDirectoryAdmission } from "../src/core/delegation/worker-directory-admission.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

it.each([false, true])("a replay preflight cannot shadow a durable job's stop (dryRun: %s)", async (dryRun) => {
	const f = await collaborationFixture();
	let release!: () => void;
	let announce!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		announce = resolve;
	});
	try {
		const request = { action: "fire_task", launchKey: "existing", task: "Work", agents: [{ provider: "pi" }] };
		await f.execute(request);
		const agent = f.store.load("existing").agents[0];
		const original = WorkerDirectoryAdmission.prototype.namespaceKey;
		const spy = vi.spyOn(WorkerDirectoryAdmission.prototype, "namespaceKey").mockImplementation(async function (
			this: WorkerDirectoryAdmission,
			cwd,
			signal,
		) {
			announce();
			await gate;
			return original.call(this, cwd, signal);
		});
		const replay = f.execute(request).catch((error: unknown) => error);
		await entered;
		await f.execute({ action: "stop_job", jobId: "existing", dryRun });
		release();
		await replay;
		spy.mockRestore();
		expect(f.store.load("existing").agents[0].closed === true).toBe(!dryRun);
		if (dryRun) expect(f.backend.closePane).not.toHaveBeenCalled();
		else expect(f.backend.closePane).toHaveBeenCalledExactlyOnceWith(agent.paneId);
		expect(f.launchTurn).toHaveBeenCalledTimes(1);
	} finally {
		release();
		vi.restoreAllMocks();
		await f.cleanup();
	}
});
