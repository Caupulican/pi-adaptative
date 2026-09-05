import { afterEach, expect, it } from "vitest";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("reserves a fresh durable follow-up and accepts only that turn's terminal", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({ action: "fire_task", launchKey: "followup", task: "first", agents: [{ provider: "pi" }] });
	const first = f.store.load("followup").agents[0];
	f.store.finishTurn("followup", first.id, first.turnId, "done", "first verified");
	await f.execute({ action: "send_followup", jobId: "followup", task: "second" });
	const second = f.store.load("followup").agents[0];
	expect(second.turn).toBe(2);
	expect(second.backendName).toBe(first.backendName);
	expect(f.store.finishTurn("followup", first.id, first.turnId, "done", "stale")).toBe(false);
	expect(f.store.load("followup").agents[0].status).toBe("reserved");
	f.store.finishTurn("followup", second.id, second.turnId, "done", "second verified");
	await f.execute({ action: "list_jobs" });
	await f.execute({ action: "list_jobs" });
	expect(f.report.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(2);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	expect(f.sendMessage).not.toHaveBeenCalled();
});

it("does not deliver a follow-up if its host reservation fails, and never launches a replacement", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({ action: "fire_task", launchKey: "refusal", task: "first", agents: [{ provider: "pi" }] });
	const first = f.store.load("refusal").agents[0];
	f.store.finishTurn("refusal", first.id, first.turnId, "done", "done");
	f.report.mockImplementation((event) => {
		if (event.phase === "dispatch") throw new Error("reservation unavailable");
	});
	await expect(f.execute({ action: "send_followup", jobId: "refusal", task: "no" })).rejects.toThrow(
		"reservation unavailable",
	);
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	expect(f.store.load("refusal").agents[0]).toMatchObject({ status: "failed", closed: true });
});

it("dismiss refuses active work, then stops idle tracking without terminating the persistent CLI", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({ action: "fire_task", launchKey: "dismiss", task: "work", agents: [{ provider: "pi" }] });
	await expect(f.execute({ action: "dismiss", jobId: "dismiss" })).rejects.toThrow(/active/);
	const turn = f.store.load("dismiss").agents[0];
	f.store.finishTurn("dismiss", turn.id, turn.turnId, "done", "verified before tracking ends");
	await f.execute({ action: "dismiss", jobId: "dismiss" });
	await f.execute({ action: "dismiss", jobId: "dismiss" });
	expect(f.store.load("dismiss")).toMatchObject({ dismissed: true, agents: [{ status: "done" }] });
	expect(f.report.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(1);
	expect(f.backend.closePane).not.toHaveBeenCalled();
	expect(f.backend.closeWorkspace).not.toHaveBeenCalled();
	expect(f.backend.stopSession).not.toHaveBeenCalled();
	await expect(f.execute({ action: "send_followup", jobId: "dismiss", task: "no" })).rejects.toThrow(/dismissed/);
});

it("answers on the same native conversation with a fresh dispatch identity, never an unrelated task", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({ action: "fire_task", launchKey: "question", task: "work", agents: [{ provider: "pi" }] });
	const first = f.store.load("question").agents[0];
	f.store.finishTurn("question", first.id, first.turnId, "blocked", "Which branch?");
	await expect(f.execute({ action: "send_followup", jobId: "question", task: "unrelated" })).rejects.toThrow(/Answer/);
	await f.execute({ action: "answer_question", jobId: "question", answer: { text: "feature" } });
	expect(f.store.load("question").agents[0]).toMatchObject({
		backendName: first.backendName,
		terminalId: first.terminalId,
		profile: first.profile,
		turn: 2,
	});
	expect(f.store.load("question").agents[0].turnId).not.toBe(first.turnId);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	expect(f.confirm).not.toHaveBeenCalled();
});
