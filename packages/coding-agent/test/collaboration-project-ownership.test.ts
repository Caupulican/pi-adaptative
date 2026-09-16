import { expect, it, vi } from "vitest";
import { CollaborationJobStore } from "../src/core/collaboration/job-store.ts";
import { createCollaborationPeerContext } from "../src/core/collaboration/peer-context.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

async function transferred() {
	const f = await collaborationFixture();
	const parent = vi.spyOn(f.context.sessionManager, "getSessionId");
	const start = (id: string) =>
		f.execute({
			action: "fire_task",
			launchKey: id,
			task: `Task ${id}`,
			agents: [{ provider: "pi", name: "builder" }],
		});
	try {
		await start("birth");
		const birth = f.store.load("birth");
		const agent = birth.agents[0];
		f.store.finishTurn(birth.id, agent.id, agent.turnId, "done", "First result");
		await f.execute({ action: "list_jobs" });
		parent.mockReturnValue("second");
		const result = await start("second-task");
		expect(result.details).toMatchObject({ job: { id: "birth", agents: [{ turn: 2 }] } });
		return { ...f, birth, parent, start, current: new CollaborationJobStore(f.root, "second") };
	} catch (error) {
		await f.cleanup();
		throw error;
	}
}

it("all stale host mutations refuse after a managed context changes parent", async () => {
	const f = await transferred();
	try {
		const agent = f.current.load("birth").agents[0];
		for (const stale of [f.store, new CollaborationJobStore(f.root, "parent")]) {
			const operations = [
				() => stale.setVariable("birth", "stale", "write"),
				() => stale.reserveTurn("birth", agent.id, "Stale task"),
				() => stale.beginStop("birth", agent.id),
				() => stale.finishTurn("birth", agent.id, agent.turnId, "done", "Stale report"),
				() =>
					stale.update("birth", (job) => {
						job.agents[0].closed = true;
					}),
				() => stale.dismiss("birth"),
				() => stale.archive("birth"),
			];
			for (const operation of operations) expect(operation).toThrow(/parent|owner|foreign/i);
		}
		expect(f.current.load("birth").agents[0]).toEqual(agent);
	} finally {
		await f.cleanup();
	}
});

it("a retained CLI reports the new turn through its original authenticated peer context", async () => {
	const f = await transferred();
	try {
		const agent = f.current.load("birth").agents[0];
		expect(f.current.claimTurn("birth", agent.id, agent.turnId, process.pid)).toBe(true);
		const env = f.backend.createWorkspace.mock.calls[0][0].env;
		expect(env).toBeDefined();
		const peer = createCollaborationPeerContext(env);
		expect(peer).toBeDefined();
		expect(peer!.current()).toEqual({ turnId: agent.turnId });
		const claim = { turnId: agent.turnId, status: "done", evidence: "Second task report" };
		expect(peer!.report(claim)).toMatchObject(claim);
		expect(() => peer!.report({ ...claim, turnId: f.birth.agents[0].turnId })).toThrow(/stale|turn/i);
		expect(f.current.load("birth").agents[0].resultClaim).toMatchObject(claim);
	} finally {
		await f.cleanup();
	}
});

it("returning a team to its first parent does not revive that parent's stale store view", async () => {
	const f = await transferred();
	try {
		const second = f.current.load("birth").agents[0];
		f.current.finishTurn("birth", second.id, second.turnId, "done", "Second result");
		await f.execute({ action: "list_jobs" });
		f.parent.mockReturnValue("parent");
		await f.start("third-task");
		const current = new CollaborationJobStore(f.root, "parent").load("birth");
		expect(current.agents[0].turn).toBe(3);
		expect(() => f.store.setVariable("birth", "stale", "write")).toThrow(/owner|generation|stale/i);
		expect(() => f.current.beginStop("birth", second.id)).toThrow(/parent|owner|foreign/i);
		expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	} finally {
		await f.cleanup();
	}
});
