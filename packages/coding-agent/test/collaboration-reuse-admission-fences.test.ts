import { afterEach, expect, it } from "vitest";
import type { CollaborationJob } from "../src/core/collaboration/job-store.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	const start = async (call: string, input: Record<string, unknown> = {}) => {
		const response = await f.tool().execute(
			call,
			{
				action: "fire_task",
				placement: "managed-workspace",
				task: "Assignment",
				agents: [{ provider: "pi" }],
				...input,
			},
			undefined,
			undefined,
			f.context,
		);
		return (response.details as { job: CollaborationJob }).job;
	};
	const finish = async (job: CollaborationJob) => {
		for (const agent of job.agents) f.store.finishTurn(job.id, agent.id, agent.turnId, "done", "Evidence");
		await f.execute({ action: "list_jobs" });
	};
	return { ...f, start, finish };
}

it("the durable tool call is an implicit start identity when launchKey is omitted", async () => {
	const f = await fixture();
	const first = await f.start("call-one");
	await f.finish(first);
	const replay = await f.start("call-one");
	expect(replay.agents[0].turnId).toBe(first.agents[0].turnId);
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
	const second = await f.start("call-two", { task: "Another assignment" });
	expect(second.id).toBe(first.id);
	expect(second.agents[0].turn).toBe(2);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
});

it("a replayed implicit tool identity rejects changed task intent", async () => {
	const f = await fixture();
	const first = await f.start("call-one");
	await f.finish(first);
	await expect(f.start("call-one", { task: "Different assignment" })).rejects.toThrow(/intent/i);
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
});

it("an accepted receipt cannot be erased through the durable update boundary", async () => {
	const f = await fixture();
	const first = await f.start("call-one", { launchKey: "first" });
	const before = f.store.load(first.id);
	expect(() =>
		f.store.update(first.id, (job) => {
			job.startReceipts = [];
		}),
	).toThrow(/receipt|immutable/i);
	expect(f.store.load(first.id)).toEqual(before);
});

it("task correlation is immutable within one admitted turn", async () => {
	const f = await fixture();
	const first = await f.start("call-one", { launchKey: "first", goalId: "goal-a" });
	const before = f.store.load(first.id);
	expect(() =>
		f.store.update(first.id, (job) => {
			job.agents[0].taskCorrelation = { goalId: "goal-b" };
		}),
	).toThrow(/correlation|immutable/i);
	expect(f.store.load(first.id)).toEqual(before);
});

it("a disposed controller cannot publish a late reuse preflight callback", async () => {
	const f = await fixture();
	const first = await f.start("call-one", { launchKey: "first" });
	await f.finish(first);
	let announce!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		announce = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = f.backend.getAgent.getMockImplementation()!;
	f.backend.getAgent.mockImplementationOnce(async (target) => {
		announce();
		await gate;
		return original(target);
	});
	const pending = f.start("call-two", { launchKey: "second" });
	await entered;
	const published = f.report.mock.calls.length;
	await f.shutdown();
	release();
	await expect(pending).rejects.toThrow(/disposed/i);
	expect(f.report.mock.calls).toHaveLength(published);
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
	expect(f.backend.closePane).not.toHaveBeenCalled();
});

it("negative control: stopped owned contexts refuse reuse without silently relaunching", async () => {
	const f = await fixture();
	const first = await f.start("call-one", { launchKey: "first" });
	await f.finish(first);
	await f.execute({ action: "stop_job", jobId: first.id });
	await expect(f.start("call-two", { launchKey: "second" })).rejects.toThrow(/unavailable|busy/i);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
});

it("negative control: changed caller environment has a distinct admitted specialization", async () => {
	const f = await fixture();
	const first = await f.start("call-one", { launchKey: "first", agents: [{ provider: "pi", env: { MODE: "read" } }] });
	await f.finish(first);
	const second = await f.start("call-two", {
		launchKey: "second",
		agents: [{ provider: "pi", env: { MODE: "write" } }],
	});
	expect(second.id).not.toBe(first.id);
	expect(f.backend.startAgent).toHaveBeenCalledTimes(2);
});

it("negative control: an old accepted key remains inert after a newer task starts", async () => {
	const f = await fixture();
	const first = await f.start("call-one", { launchKey: "first" });
	await f.finish(first);
	await f.start("call-two", { launchKey: "second" });
	await expect(f.start("call-one", { launchKey: "first" })).rejects.toThrow(/already accepted|historical/i);
	expect(f.launchTurn).toHaveBeenCalledTimes(2);
});
