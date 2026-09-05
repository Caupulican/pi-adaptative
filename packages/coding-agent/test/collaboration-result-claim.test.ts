import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { runCollaborationPeer } from "../src/cli/collaboration-peer.ts";
import { CollaborationJobStore } from "../src/core/collaboration/job-store.ts";
import { createCollaborationPeerContext } from "../src/core/collaboration/peer-context.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function runningReport() {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({
		action: "fire_task",
		launchKey: "claims",
		task: "Verify the result",
		agents: [{ provider: "pi" }],
	});
	const agent = f.store.load("claims").agents[0];
	const env = f.backend.createWorkspace.mock.calls[0][0].env!;
	expect(f.store.claimTurn("claims", agent.id, agent.turnId, 12345)).toBe(true);
	f.report.mockClear();
	const args = ["report", agent.turnId, "done", "Verified bounded result"];
	return { ...f, agent, env, args };
}

it("authenticates and persists an immutable exact-turn report without announcing native completion", async () => {
	const f = await runningReport();
	expect(runCollaborationPeer(["current"], f.env)).toEqual({ turnId: f.agent.turnId });
	expect(() => runCollaborationPeer(f.args, { ...f.env, PI_COLLABORATION_PEER_TOKEN: "0".repeat(64) })).toThrow(
		/credential/,
	);
	expect(() => runCollaborationPeer(f.args, { ...f.env, PI_COLLABORATION_AGENT_ID: "foreign" })).toThrow(/credential/);
	expect(() => runCollaborationPeer(f.args, { ...f.env, PI_COLLABORATION_PARENT_ID: "foreign" })).toThrow(/parent/);
	const claim = runCollaborationPeer(f.args, f.env);
	const before = await readFile(f.store.path("claims"), "utf8");
	expect(runCollaborationPeer(f.args, f.env)).toEqual(claim);
	expect(await readFile(f.store.path("claims"), "utf8")).toBe(before);
	expect(() => runCollaborationPeer([...f.args.slice(0, 3), "Different report"], f.env)).toThrow(/immutable/);
	expect(() =>
		f.store.update("claims", (job) => {
			job.agents[0].resultClaim!.evidence = "Replaced through generic update";
		}),
	).toThrow(/immutable/);
	await f.execute({ action: "list_jobs" });
	expect(f.store.load("claims").agents[0]).toMatchObject({ status: "running", resultClaim: claim, notifiedTurn: 0 });
	expect(f.report).not.toHaveBeenCalled();
	expect(before).not.toContain(f.env.PI_COLLABORATION_PEER_TOKEN);
	expect(new CollaborationJobStore(f.root, "parent").load("claims").agents[0].resultClaim).toEqual(claim);
});

it("rejects stale reports after an answer and discovers the new exact identity without replay", async () => {
	const f = await runningReport();
	runCollaborationPeer(["report", f.agent.turnId, "blocked", "Which branch?"], f.env);
	f.store.finishTurn("claims", f.agent.id, f.agent.turnId, "blocked", "Which branch?");
	const answered = f.store.reserveTurn("claims", f.agent.id, "Use feature", true);
	expect(answered.resultClaim).toBeUndefined();
	expect(() => runCollaborationPeer(["current"], f.env)).toThrow(/active/);
	f.store.claimTurn("claims", f.agent.id, answered.turnId, 12346);
	expect(runCollaborationPeer(["current"], f.env)).toEqual({ turnId: answered.turnId });
	expect(() => runCollaborationPeer(f.args, f.env)).toThrow(/stale/);
	const fresh = ["report", answered.turnId, "done", "Verified answer", '{"input":12,"output":3}'];
	expect(runCollaborationPeer(fresh, f.env)).toMatchObject({
		turnId: answered.turnId,
		usage: { input: 12, output: 3 },
	});
	f.store.finishTurn("claims", f.agent.id, answered.turnId, "done", "Verified answer");
	expect(runCollaborationPeer(fresh, f.env)).toMatchObject({ turnId: answered.turnId });
	expect(f.store.load("claims").agents[0].status).toBe("done");
});

it("rejects malformed, oversized, post-terminal and stopped claims without durable mutation", async () => {
	const f = await runningReport();
	const before = await readFile(f.store.path("claims"), "utf8");
	for (const args of [
		["report", f.agent.turnId, "running", "not terminal"],
		["report", f.agent.turnId, "done", " "],
		["report", f.agent.turnId, "done", "界".repeat(2731)],
		["report", f.agent.turnId, "done", "NUL\0evidence"],
		["report", f.agent.turnId, "done", "evidence", "not json"],
	])
		expect(() => runCollaborationPeer(args, f.env)).toThrow();
	expect(await readFile(f.store.path("claims"), "utf8")).toBe(before);
	f.store.finishTurn("claims", f.agent.id, f.agent.turnId, "blocked", "No report");
	expect(() => runCollaborationPeer(f.args, f.env)).toThrow(/active/);
	f.store.beginStop("claims", f.agent.id, f.agent.turnId);
	expect(() => runCollaborationPeer(f.args, f.env)).toThrow(/inactive/);
});

it("rejects a corrupted persisted claim whose identity disagrees with its turn", async () => {
	const f = await runningReport();
	runCollaborationPeer(f.args, f.env);
	const job = f.store.load("claims");
	job.agents[0].resultClaim!.turnId = "stale-turn";
	await writeFile(f.store.path("claims"), JSON.stringify(job));
	expect(() => f.store.load("claims")).toThrow(/different turn/);
});

it("does not widen a process-restricted Pi profile to deliver reports", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await expect(
		f.execute({
			action: "fire_task",
			launchKey: "restricted",
			task: "Read one file",
			agents: [{ provider: "pi", tools: ["read"] }],
		}),
	).rejects.toThrow(/already-granted/);
	expect(f.store.list()).toEqual([]);
	expect(f.backend.createWorkspace).not.toHaveBeenCalled();
	await f.execute({ action: "launch_workspace", launchKey: "idle", agents: [{ provider: "pi", tools: ["read"] }] });
	await expect(f.execute({ action: "send_followup", jobId: "idle", task: "Read one file" })).rejects.toThrow(
		/already-granted/,
	);
	expect(f.store.load("idle").agents[0]).toMatchObject({
		turn: 0,
		status: "idle",
		profile: { allowedTools: ["read"] },
	});
});

it("persists an authenticated full question without terminating work and fences settlement by request and turn", async () => {
	const f = await runningReport();
	const peer = createCollaborationPeerContext(f.env)!;
	const evidence = JSON.stringify({
		question: "Choose the exact deployment target",
		options: [{ label: "Staging", description: "The isolated validation environment" }],
		multiSelect: false,
	});
	const receipt = peer.waiting("human:request-1", evidence)!;
	expect(receipt).toEqual({ turnId: f.agent.turnId, requestId: "human:request-1" });
	expect(f.store.load("claims").agents[0]).toMatchObject({
		status: "running",
		pendingQuestion: { ...receipt, evidence },
	});
	expect(f.report).not.toHaveBeenCalled();
	f.store.finishTurn("claims", f.agent.id, f.agent.turnId, "blocked", evidence);
	await f.execute({ action: "list_jobs" });
	const before = await readFile(f.store.path("claims"), "utf8");
	expect(peer.waiting(receipt.requestId, evidence)).toEqual(receipt);
	expect(peer.waiting("human:other", evidence)).toBeUndefined();
	expect(() => peer.waiting(receipt.requestId, "Different choices")).toThrow(/immutable/);
	expect(peer.settled({ ...receipt, requestId: "other" })).toBe(false);
	expect(await readFile(f.store.path("claims"), "utf8")).toBe(before);
	const next = f.store.reserveTurn("claims", f.agent.id, "Staging", true);
	expect(next.pendingQuestion).toBeUndefined();
	f.store.claimTurn("claims", f.agent.id, next.turnId, 12346);
	const nextReceipt = peer.waiting("human:request-2", "Confirm staging")!;
	expect(peer.settled(receipt)).toBe(false);
	expect(f.store.load("claims").agents[0].pendingQuestion?.requestId).toBe(nextReceipt.requestId);
	expect(peer.settled(nextReceipt)).toBe(true);
	expect(peer.settled(nextReceipt)).toBe(false);
});

it("rejects invalid question credentials, bounds, and persisted turn corruption without partial state", async () => {
	const f = await runningReport();
	expect(createCollaborationPeerContext({})).toBeUndefined();
	expect(() => createCollaborationPeerContext({ PI_COLLABORATION_JOB_ID: "claims" })).toThrow(/context/);
	const peer = createCollaborationPeerContext(f.env)!;
	const foreign = createCollaborationPeerContext({ ...f.env, PI_COLLABORATION_PEER_TOKEN: "0".repeat(64) })!;
	expect(() => foreign.waiting("request", "Which target?")).toThrow(/credential/);
	const before = await readFile(f.store.path("claims"), "utf8");
	for (const [id, evidence] of [
		["", "Question"],
		["request", " "],
		["request", "界".repeat(2731)],
		["request", "NUL\0question"],
	])
		expect(() => peer.waiting(id, evidence)).toThrow(/question/);
	expect(await readFile(f.store.path("claims"), "utf8")).toBe(before);
	peer.waiting("request", "Which target?");
	expect(() => peer.waiting("other", "Replacement?")).toThrow(/pending/);
	const job = f.store.load("claims");
	job.agents[0].pendingQuestion!.turnId = "stale";
	await writeFile(f.store.path("claims"), JSON.stringify(job));
	expect(() => f.store.load("claims")).toThrow(/different turn/);
});
