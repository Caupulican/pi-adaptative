import { afterEach, expect, it, vi } from "vitest";
import { CollaborationControlHandoffs } from "../src/core/collaboration/control-handoffs.ts";
import { reserveCollaborationCleanupAttempt } from "../src/core/collaboration/deadlines.ts";
import { CollaborationJobStore } from "../src/core/collaboration/job-store.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({ action: "launch_workspace", launchKey: "control", agents: [{ provider: "codex" }] });
	return f;
}

it("durably surfaces cleanup failure without claiming the native worker stopped", async () => {
	const f = await fixture();
	const notify = vi.fn();
	const owner = new CollaborationControlHandoffs(f.store, notify);
	owner.record("control", "agent-1", "turn", "backend offline");
	owner.flush();
	owner.flush();
	expect(notify).toHaveBeenCalledTimes(1);
	expect(notify.mock.calls[0][0]).toMatchObject({
		jobId: "control",
		source: "agent-1",
		turnId: "turn",
		error: "backend offline",
	});
	expect(f.store.load("control").agents[0]).toMatchObject({ status: "idle" });
	expect(f.report.mock.calls.some(([event]) => event.phase === "terminal")).toBe(false);
});

it("retries an unacknowledged control notice after restart but not an acknowledged one", async () => {
	const f = await fixture();
	const fail = vi.fn(() => {
		throw new Error("outbox unavailable");
	});
	const owner = new CollaborationControlHandoffs(f.store, fail);
	owner.record("control", "server", "generation", "server exited");
	expect(() => owner.flush()).toThrow(/outbox unavailable/);
	const notify = vi.fn();
	const recovered = new CollaborationControlHandoffs(f.store, notify);
	recovered.flush();
	new CollaborationControlHandoffs(f.store, notify).flush();
	expect(notify).toHaveBeenCalledTimes(1);
	owner.record("control", "server", "generation", "another rendering of same failure");
	recovered.flush();
	expect(notify).toHaveBeenCalledTimes(1);
});

it("retains exact-turn cleanup admission across store reopen and fences stale turns", async () => {
	const f = await fixture();
	const agent = f.store.reserveTurn("control", "agent-1", "work");
	const turn = { jobId: "control", agentId: agent.id, turnId: agent.turnId, deadlineAt: agent.deadlineAt! };
	const results: Array<number | undefined> = [];
	for (let reopen = 0; reopen < 4; reopen++)
		results.push(reserveCollaborationCleanupAttempt(new CollaborationJobStore(f.root, "parent"), turn));
	expect(results).toEqual([1, 2, 3, 0]);
	f.store.finishTurn("control", agent.id, agent.turnId, "done", "verified");
	const next = f.store.reserveTurn("control", agent.id, "next task");
	expect(reserveCollaborationCleanupAttempt(f.store, turn)).toBeUndefined();
	expect(reserveCollaborationCleanupAttempt(f.store, { ...turn, turnId: next.turnId })).toBe(1);
});
