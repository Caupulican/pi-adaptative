import { afterEach, expect, it } from "vitest";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	const start = (key: string, overrides: Record<string, unknown> = {}) =>
		f.tool().execute(
			key,
			{
				action: "fire_task",
				placement: "managed-workspace",
				launchKey: key,
				task: `Assignment ${key}`,
				agents: [{ provider: "pi", name: "builder" }],
				...overrides,
			},
			undefined,
			undefined,
			f.context,
		);
	const finish = async (id: string) => {
		for (const agent of f.store.load(id).agents)
			f.store.finishTurn(id, agent.id, agent.turnId, "done", `Evidence ${id}/${agent.id}`);
		await f.execute({ action: "list_jobs" });
	};
	return { ...f, start, finish };
}

it("ordinary managed starts reuse the exact idle CLI and report the new goal", async () => {
	const f = await fixture();
	await f.start("first", { goalId: "goal-a" });
	const first = f.store.load("first").agents[0];
	await f.finish("first");
	const result = await f.start("second", { goalId: "goal-b" });
	expect(result.details).toMatchObject({
		job: { id: "first", agents: [{ turn: 2, paneId: first.paneId, terminalId: first.terminalId }] },
	});
	expect(f.store.list()).toHaveLength(1);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	expect(f.launchTurn).toHaveBeenCalledTimes(2);
	expect(
		f.report.mock.calls
			.map(([event]) => event)
			.filter((event) => event.phase === "dispatch")
			.map((event) => event.goalId),
	).toEqual(["goal-a", "goal-b"]);
	expect(f.backend.readAgent).not.toHaveBeenCalled();
});

it("matching survives a parent controller reload without restarting the native CLI", async () => {
	const f = await fixture();
	await f.start("first");
	await f.finish("first");
	await f.shutdown();
	const result = await f.start("second");
	expect(result.details).toMatchObject({ job: { id: "first", agents: [{ turn: 2 }] } });
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
});

it("a busy compatible specialist refuses automatic duplication without interrupting it", async () => {
	const f = await fixture();
	await f.start("first");
	await expect(f.start("second")).rejects.toThrow(/specialist.*busy|pending/i);
	expect(f.store.list()).toHaveLength(1);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
});

it("a pending question is unavailable for a new assignment", async () => {
	const f = await fixture();
	await f.start("first");
	const first = f.store.load("first").agents[0];
	f.store.finishTurn("first", first.id, first.turnId, "blocked", "Which branch?");
	await expect(f.start("second")).rejects.toThrow(/specialist|question/i);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	expect(f.store.load("first").agents[0].status).toBe("blocked");
});

it("a replaced native occupant cannot receive reused work or trigger a duplicate launch", async () => {
	const f = await fixture();
	await f.start("first");
	await f.finish("first");
	const first = f.store.load("first").agents[0];
	f.states.get(first.backendName!)!.terminalId = "replacement-terminal";
	await expect(f.start("second")).rejects.toThrow(/identity|occupant|unavailable/i);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
	expect(f.backend.closePane).not.toHaveBeenCalled();
});

it("negative control: a different effective model admits a distinct specialist", async () => {
	const f = await fixture();
	await f.start("first", { agents: [{ provider: "pi", name: "builder", model: "one" }] });
	await f.finish("first");
	await f.start("second", { agents: [{ provider: "pi", name: "builder", model: "two" }] });
	expect(f.store.list()).toHaveLength(2);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(2);
});

it("negative control: justified independent work may allocate a second compatible specialist", async () => {
	const f = await fixture();
	await f.start("first");
	await f.start("second", {
		parallelWork: { independent: true, justification: "Independent experiment on separate inputs" },
	});
	expect(f.store.list()).toHaveLength(2);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(2);
});

it("ambiguous compatible contexts require an explicit job selection", async () => {
	const f = await fixture();
	await f.start("first");
	await f.start("second", { parallelWork: { independent: true, justification: "Independent experiment" } });
	await f.finish("first");
	await f.finish("second");
	await expect(f.start("third")).rejects.toThrow(/choice|ambiguous/i);
	const selected = await f.start("fourth", { jobId: "second" });
	expect(selected.details).toMatchObject({ job: { id: "second", agents: [{ turn: 2 }] } });
	expect(f.backend.startAgent).toHaveBeenCalledTimes(2);
});

it("same-key same-intent retries do not submit the reused turn twice", async () => {
	const f = await fixture();
	await f.start("first");
	await f.finish("first");
	await f.start("second");
	const replay = await f.start("second");
	expect(replay.details).toMatchObject({ job: { id: "first", agents: [{ turn: 2 }] } });
	expect(f.launchTurn).toHaveBeenCalledTimes(2);
	await expect(f.start("second", { task: "Changed intent" })).rejects.toThrow(/intent/i);
	expect(f.launchTurn).toHaveBeenCalledTimes(2);
});

it("concurrent compatible starts admit one native specialist", async () => {
	const f = await fixture();
	const results = await Promise.allSettled([f.start("first"), f.start("second")]);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(f.store.list()).toHaveLength(1);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
});

it("an equivalent two-member team reuses its original peer graph as a unit", async () => {
	const f = await fixture();
	const agents = [
		{ provider: "pi", name: "builder", task: "Implement changes" },
		{ provider: "pi", name: "reviewer", task: "Review changes" },
	];
	await f.start("first", { agents });
	const birth = f.store.load("first");
	await f.finish("first");
	const result = await f.start("second", { agents });
	expect(result.details).toMatchObject({ job: { id: "first", agents: [{ turn: 2 }, { turn: 2 }] } });
	expect(f.store.load("first").peerCommand).toBe(birth.peerCommand);
	expect(f.store.load("first").agents.map((agent) => agent.peerTokenHash)).toEqual(
		birth.agents.map((agent) => agent.peerTokenHash),
	);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(2);
	expect(f.launchTurn).toHaveBeenCalledTimes(4);
});

it("one unavailable team member prevents every member's new dispatch", async () => {
	const f = await fixture();
	const agents = [
		{ provider: "pi", name: "builder", task: "Implement changes" },
		{ provider: "pi", name: "reviewer", task: "Review changes" },
	];
	await f.start("first", { agents });
	const first = f.store.load("first").agents[0];
	f.store.finishTurn("first", first.id, first.turnId, "done", "Builder done");
	await expect(f.start("second", { agents })).rejects.toThrow(/specialist.*busy|pending/i);
	expect(f.store.load("first").agents.map((agent) => agent.turn)).toEqual([1, 1]);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(2);
	expect(f.launchTurn).toHaveBeenCalledTimes(2);
});

it("equivalent environment maps match independently of their property order", async () => {
	const f = await fixture();
	await f.start("first", { agents: [{ provider: "pi", name: "builder", env: { FIRST: "one", SECOND: "two" } }] });
	await f.finish("first");
	await f.start("second", { agents: [{ provider: "pi", name: "builder", env: { SECOND: "two", FIRST: "one" } }] });
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	expect(f.launchTurn).toHaveBeenCalledTimes(2);
});
