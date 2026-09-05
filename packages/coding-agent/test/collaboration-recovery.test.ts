import { afterEach, expect, it } from "vitest";
import { CollaborationCoordinator } from "../src/core/collaboration/coordinator.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("does not misclassify missing backend evidence as proof that an orphaned worker stopped", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({ action: "fire_task", launchKey: "uncertain", task: "work", agents: [{ provider: "pi" }] });
	const member = f.store.load("uncertain").agents[0];
	f.states.clear();
	f.report.mockClear();
	const owner = new CollaborationCoordinator({
		store: f.store,
		backend: async () => f.backend,
		report: f.report,
		launchTurn: async () => {},
	});
	await expect(owner.stopAgent("uncertain", member.id, member.turnId)).rejects.toThrow("unavailable");
	expect(f.store.load("uncertain").agents[0]).toMatchObject({ stopping: true, status: "reserved" });
	owner.refresh();
	expect(f.report).not.toHaveBeenCalled();
	expect(f.backend.closePane).not.toHaveBeenCalled();
});

it("restores active reservations without replaying prompts or disturbing live native sessions", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({ action: "fire_task", launchKey: "live", task: "work", agents: [{ provider: "pi" }] });
	const before = f.store.load("live").agents[0];
	await f.shutdown();
	await f.start();
	expect(f.store.load("live").agents[0]).toEqual(before);
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
	expect(f.backend.closePane).not.toHaveBeenCalled();
	expect(f.backend.readAgent).not.toHaveBeenCalled();
});

it("restores only unpublished terminals and does not reclassify acknowledged terminals as orphans", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({
		action: "fire_task",
		launchKey: "terminal",
		task: "work",
		agents: [
			{ provider: "pi", task: "Implement the task" },
			{ provider: "claude", task: "Review the implementation" },
		],
	});
	const [one, two] = f.store.load("terminal").agents;
	f.store.finishTurn("terminal", one.id, one.turnId, "done", "already published");
	await f.execute({ action: "list_jobs" });
	await f.shutdown();
	f.report.mockClear();
	f.store.finishTurn("terminal", two.id, two.turnId, "failed", "proved stopped");
	await f.start();
	await f.execute({ action: "list_jobs" });
	expect(f.report).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ laneId: "collaboration:terminal:agent-2", status: "failed", dispatchSequence: 1 }),
	);
	expect(f.backend.closePane).not.toHaveBeenCalled();
});
