import { afterEach, expect, it } from "vitest";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function completedJob() {
	const fixture = await collaborationFixture();
	cleanups.push(fixture.cleanup);
	await fixture.execute({
		action: "fire_task",
		launchKey: "goals",
		goalId: "goal-a",
		task: "First assignment",
		agents: [{ provider: "pi" }],
	});
	const first = fixture.store.load("goals").agents[0];
	fixture.store.finishTurn("goals", first.id, first.turnId, "done", "First assignment finished");
	return { ...fixture, first };
}

it("a new follow-up dispatch uses its current goal while preserving the job and CLI birth identity", async () => {
	const f = await completedJob();
	await f.execute({ action: "send_followup", jobId: "goals", goalId: "goal-b", task: "Second assignment" });
	const job = f.store.load("goals");
	const dispatches = f.report.mock.calls.map(([event]) => event).filter((event) => event.phase === "dispatch");
	expect(dispatches.map((event) => event.goalId)).toEqual(["goal-a", "goal-b"]);
	expect(job.goalId).toBe("goal-a");
	expect(job.agents[0]).toMatchObject({
		paneId: f.first.paneId,
		terminalId: f.first.terminalId,
		profile: f.first.profile,
		turn: 2,
	});
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	expect(f.store.finishTurn("goals", f.first.id, f.first.turnId, "done", "Late first terminal")).toBe(false);
	expect(
		f.report.mock.calls.map(([event]) => `${event.phase}:${event.dispatchSequence ?? event.dispatch?.sequence}`),
	).toEqual(["dispatch:1", "terminal:1", "dispatch:2"]);
});

it("a new task without a goal does not silently inherit the original goal", async () => {
	const f = await completedJob();
	await f.execute({ action: "send_followup", jobId: "goals", task: "Unscoped new assignment" });
	const dispatch = f.report.mock.calls
		.map(([event]) => event)
		.filter((event) => event.phase === "dispatch")
		.at(-1);
	expect(dispatch.goalId).toBeUndefined();
	expect(f.store.load("goals").goalId).toBe("goal-a");
});

it("an answer retains the question's task correlation across controller reload", async () => {
	const f = await completedJob();
	await f.execute({ action: "send_followup", jobId: "goals", goalId: "goal-b", task: "Second assignment" });
	const second = f.store.load("goals").agents[0];
	f.store.finishTurn("goals", second.id, second.turnId, "blocked", "Which branch?");
	await f.shutdown();
	await f.execute({
		action: "answer_question",
		jobId: "goals",
		goalId: "unrelated-goal",
		answer: { text: "feature" },
	});
	const dispatches = f.report.mock.calls.map(([event]) => event).filter((event) => event.phase === "dispatch");
	expect(dispatches.map((event) => event.goalId)).toEqual(["goal-a", "goal-b", "goal-b"]);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
});

it("negative control: an original goal's question keeps that goal", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({
		action: "fire_task",
		launchKey: "question",
		goalId: "goal-a",
		task: "First",
		agents: [{ provider: "pi" }],
	});
	const first = f.store.load("question").agents[0];
	f.store.finishTurn("question", first.id, first.turnId, "blocked", "Which branch?");
	await f.execute({
		action: "answer_question",
		jobId: "question",
		goalId: "unrelated-goal",
		answer: { text: "feature" },
	});
	expect(
		f.report.mock.calls
			.map(([event]) => event)
			.filter((event) => event.phase === "dispatch")
			.map((event) => event.goalId),
	).toEqual(["goal-a", "goal-a"]);
});

it("a direct successor reservation cannot erase a terminal before its parent handoff is published", async () => {
	const f = await completedJob();
	const before = f.store.load("goals");
	expect(() => f.store.reserveTurn("goals", f.first.id, "Too soon")).toThrow(/handoff|publish/i);
	expect(f.store.load("goals")).toEqual(before);
});

it("negative control: a published terminal permits a direct continuation", async () => {
	const f = await completedJob();
	await f.execute({ action: "list_jobs" });
	const second = f.store.reserveTurn("goals", f.first.id, "Continue the original task");
	expect(second.turn).toBe(2);
	expect(second.paneId).toBe(f.first.paneId);
});

it("failed handoff publication leaves the original result intact and submits no successor", async () => {
	const f = await completedJob();
	f.report.mockImplementation((event) => {
		if (event.phase === "terminal") throw new Error("host handoff unavailable");
	});
	await expect(
		f.execute({ action: "send_followup", jobId: "goals", goalId: "goal-b", task: "Second" }),
	).rejects.toThrow("host handoff unavailable");
	expect(f.store.load("goals").agents[0]).toMatchObject({
		turn: 1,
		turnId: f.first.turnId,
		status: "done",
		notifiedTurn: 0,
	});
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
});
