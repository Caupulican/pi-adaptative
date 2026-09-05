import { afterEach, expect, it, vi } from "vitest";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("publishes one bounded terminal from a durable file event, without output peeking or a second wake owner", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({
		action: "fire_task",
		launchKey: "event-job",
		task: "work",
		agents: [{ provider: "pi", name: "worker's quoted name" }],
	});
	const member = f.store.load("event-job").agents[0];
	f.report.mockClear();
	const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(() => {
		throw new Error("Polling forbidden");
	});
	let resolveTerminal: () => void = () => {};
	const terminal = new Promise<void>((resolve) => {
		resolveTerminal = resolve;
	});
	f.report.mockImplementation((event) => {
		if (event.phase === "terminal") resolveTerminal();
	});
	f.store.finishTurn("event-job", member.id, member.turnId, "done", "bounded evidence ".repeat(1000));
	const guard = setTimeout(resolveTerminal, 3000);
	try {
		await terminal;
	} finally {
		clearTimeout(guard);
	}
	expect(f.report).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			laneId: "collaboration:event-job:agent-1",
			phase: "terminal",
			status: "done",
			dispatchSequence: 1,
			summary: expect.stringContaining("bounded evidence"),
		}),
	);
	expect(Buffer.byteLength(f.report.mock.calls[0][0].summary)).toBeLessThanOrEqual(8192);
	expect(f.backend.readAgent).not.toHaveBeenCalled();
	expect(f.sendMessage).not.toHaveBeenCalled();
	expect(interval).not.toHaveBeenCalled();
	await f.shutdown();
	await f.start();
	expect(f.report).toHaveBeenCalledTimes(1);
});

it("sends one peer's stopped question immediately while another peer is active", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({
		action: "fire_task",
		launchKey: "team",
		task: "work",
		agents: [
			{ provider: "pi", task: "Implement the task" },
			{ provider: "claude", task: "Review the implementation" },
		],
	});
	const [one, two] = f.store.load("team").agents;
	f.store.finishTurn("team", one.id, one.turnId, "blocked", "Which branch?");
	await f.execute({ action: "list_jobs" });
	expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked", summary: "Which branch?" }));
	expect(f.store.load("team").agents[1]).toMatchObject({ turnId: two.turnId, status: "reserved" });
	expect(f.sendMessage).not.toHaveBeenCalled();
});

it("preserves optional measured usage on the host terminal bridge without manufacturing a missing claim", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({
		action: "fire_task",
		launchKey: "usage",
		task: "work",
		agents: [
			{ provider: "pi", task: "Implement the task" },
			{ provider: "claude", task: "Review the implementation" },
		],
	});
	const [one, two] = f.store.load("usage").agents;
	f.store.finishTurn("usage", one.id, one.turnId, "done", "verified", {
		input: 100,
		output: 50,
		cost: { total: 0.003 },
	});
	f.store.finishTurn("usage", two.id, two.turnId, "done", "verified");
	await f.execute({ action: "list_jobs" });
	await f.execute({ action: "list_jobs" });
	const terminals = f.report.mock.calls.map(([event]) => event).filter((event) => event.phase === "terminal");
	expect(terminals).toHaveLength(2);
	expect(terminals[0].usage).toMatchObject({ input: 100, output: 50, cost: { total: 0.003 } });
	expect(terminals[1].usage).toBeUndefined();
});
