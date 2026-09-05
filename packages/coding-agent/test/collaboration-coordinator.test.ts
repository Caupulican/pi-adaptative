import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CollaborationBackend } from "../src/core/collaboration/backend.ts";
import { CollaborationCoordinator, stopCollaborationAgent } from "../src/core/collaboration/coordinator.ts";
import { CollaborationJobStore } from "../src/core/collaboration/job-store.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("a stopped peer's question wakes its parent while another peer keeps working, never on progress", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-cycle-"));
	roots.push(root);
	const store = new CollaborationJobStore(root, "parent");
	store.create({
		id: "team",
		parentSessionId: "parent",
		sessionName: "pi-team",
		cwd: root,
		title: "team",
		createdAt: 0,
		deadlineSeconds: 30,
		agents: ["one", "two"].map((id) => ({
			id,
			name: id,
			provider: "pi",
			cwd: root,
			args: [],
			env: {},
			backendName: id,
			terminalId: id,
			profile: { identity: id, allowedTools: ["read", "bash"], writePaths: [] },
		})),
	});
	const one = store.reserveTurn("team", "one", "first");
	const two = store.reserveTurn("team", "two", "second");
	store.claimTurn("team", "one", one.turnId, 10);
	store.claimTurn("team", "two", two.turnId, 11);
	const report = vi.fn();
	const launchTurn = vi.fn(async () => {});
	const backend = {} as CollaborationBackend;
	const coordinator = new CollaborationCoordinator({ store, report, launchTurn, backend: async () => backend });
	coordinator.refresh();
	expect(report).not.toHaveBeenCalled();
	store.finishTurn("team", "one", one.turnId, "blocked", "Which branch should I use?");
	coordinator.refresh();
	coordinator.refresh();
	expect(report).toHaveBeenCalledTimes(1);
	expect(report).toHaveBeenCalledWith(
		expect.objectContaining({
			laneId: "collaboration:team:one",
			phase: "terminal",
			status: "blocked",
			dispatchSequence: one.turn,
			summary: "Which branch should I use?",
		}),
	);
	const answered = await coordinator.followup("team", "one", "Use the feature branch", {
		text: "Use the feature branch",
	});
	expect(answered.backendName).toBe(one.backendName);
	expect(answered.terminalId).toBe(one.terminalId);
	expect(answered.turnId).not.toBe(one.turnId);
	expect(store.load("team").agents[1].turnId).toBe(two.turnId);
	expect(launchTurn).toHaveBeenCalledTimes(1);
	store.finishTurn("team", "one", answered.turnId, "done", "verified");
	coordinator.refresh();
	expect(report.mock.calls.filter(([event]) => event.phase === "terminal")).toHaveLength(2);
});

async function controlledTeam() {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-stop-"));
	roots.push(root);
	const store = new CollaborationJobStore(root, "parent");
	const input = {
		id: "team",
		parentSessionId: "parent",
		sessionName: "pi-team",
		cwd: root,
		title: "team",
		createdAt: 0,
		deadlineSeconds: 30,
		agents: ["one", "two"].map((id) => ({
			id,
			name: id,
			provider: "pi",
			cwd: root,
			args: [],
			env: {},
			backendName: id,
			paneId: `pane-${id}`,
			terminalId: id,
			profile: { identity: id, allowedTools: ["read", "bash"], writePaths: [] },
		})),
	};
	store.create({ ...input, workspaceId: "owned" });
	const getAgent = vi.fn(async (name: string) => ({ paneId: `pane-${name}`, terminalId: name, status: "working" }));
	const closePane = vi.fn(async () => {});
	const closeWorkspace = vi.fn(async () => {});
	const backend = { getAgent, closePane, closeWorkspace } as unknown as CollaborationBackend;
	const report = vi.fn();
	const launchTurn = vi.fn(async () => {});
	const backendFactory = vi.fn(async (_session: string, _create?: boolean) => backend);
	const coordinator = new CollaborationCoordinator({ store, backend: backendFactory, report, launchTurn });
	const one = store.reserveTurn("team", "one", "first");
	const two = store.reserveTurn("team", "two", "second");
	return {
		store,
		coordinator,
		report,
		one,
		two,
		backend,
		backendFactory,
		getAgent,
		closePane,
		closeWorkspace,
		launchTurn,
		input,
	};
}

it("a deadline stop is fenced to one exact turn and leaves other peers running", async () => {
	const f = await controlledTeam();
	expect(await f.coordinator.stopAgent("team", "one", "stale")).toBe(false);
	expect(f.closePane).not.toHaveBeenCalled();
	expect(await f.coordinator.stopAgent("team", "one", f.one.turnId)).toBe(true);
	expect(f.closePane).toHaveBeenCalledExactlyOnceWith("pane-one");
	expect(f.backendFactory).toHaveBeenCalledExactlyOnceWith("pi-team", false);
	expect(f.closeWorkspace).not.toHaveBeenCalled();
	expect(f.store.load("team").agents[1].status).toBe("reserved");
	expect(f.report).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ laneId: "collaboration:team:one", status: "stopped" }),
	);
});

it("failed cleanup never publishes a stopped worker and blocks new prompts until recovery", async () => {
	const f = await controlledTeam();
	f.closePane.mockRejectedValueOnce(new Error("close failed"));
	await expect(f.coordinator.stopAgent("team", "one", f.one.turnId)).rejects.toThrow("close failed");
	f.coordinator.refresh();
	expect(f.report).not.toHaveBeenCalled();
	expect(() => f.store.reserveTurn("team", "one", "must not race cleanup")).toThrow(/pending|stopping/);
	await f.coordinator.stopAgent("team", "one", f.one.turnId);
	expect(f.report).toHaveBeenCalledTimes(1);
});

it("does not stop a replacement pane occupant", async () => {
	const f = await controlledTeam();
	f.getAgent.mockResolvedValueOnce({ paneId: "pane-one", terminalId: "replacement", status: "working" });
	await expect(f.coordinator.stopAgent("team", "one", f.one.turnId)).rejects.toThrow(/identity|occupant/);
	expect(f.closePane).not.toHaveBeenCalled();
	expect(f.report).not.toHaveBeenCalled();
});

it("terminal publication failure remains retryable without losing or duplicating the evidence", async () => {
	const f = await controlledTeam();
	f.store.finishTurn("team", "one", f.one.turnId, "blocked", "Which branch?");
	f.report.mockImplementationOnce(() => {
		throw new Error("journal unavailable");
	});
	expect(() => f.coordinator.refresh()).toThrow("journal unavailable");
	expect(f.store.load("team").agents[0].notifiedTurn).toBe(0);
	f.coordinator.refresh();
	f.coordinator.refresh();
	expect(f.report).toHaveBeenCalledTimes(2);
	expect(f.report.mock.calls[1][0]).toMatchObject({ summary: "Which branch?", dispatchSequence: f.one.turn });
});

it("preserves an advisory usage claim on the same exact terminal handoff without inventing missing usage", async () => {
	const f = await controlledTeam();
	f.store.finishTurn("team", "one", f.one.turnId, "done", "verified", {
		input: 100,
		output: 50,
		cost: { total: 0.003 },
	});
	f.store.finishTurn("team", "two", f.two.turnId, "done", "verified");
	f.coordinator.refresh();
	f.coordinator.refresh();
	expect(f.report).toHaveBeenCalledTimes(2);
	expect(f.report.mock.calls[0][0]).toMatchObject({ usage: { input: 100, output: 50, cost: { total: 0.003 } } });
	expect(f.report.mock.calls[1][0].usage).toBeUndefined();
});

it("the helper stop owner persists proof without acknowledging or publishing the parent handoff", async () => {
	const f = await controlledTeam();
	expect(
		await stopCollaborationAgent(f.store, async () => f.backend, "team", "one", f.one.turnId, "helper exited"),
	).toBe(true);
	expect(f.report).not.toHaveBeenCalled();
	expect(f.store.load("team").agents[0]).toMatchObject({ status: "failed", notifiedTurn: 0, closed: true });
	f.coordinator.refresh();
	expect(f.report).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ status: "failed", summary: "helper exited", dispatchSequence: f.one.turn }),
	);
});

it("passes the immutable structured executable to native agent startup", async () => {
	const f = await controlledTeam();
	const pane = { paneId: "pane-new", terminalId: "terminal-new", workspaceId: "new-workspace", tabId: "tab" };
	const startAgent = vi.fn(async () => ({
		...pane,
		status: "idle" as const,
		interactiveReady: true,
		launchPending: false,
		stateChangeSequence: 1,
		revision: 1,
	}));
	Object.assign(f.backend, {
		createWorkspace: vi.fn(async () => ({ workspaceId: pane.workspaceId, tabId: pane.tabId, rootPane: pane })),
		startAgent,
	});
	const agents = [{ ...f.input.agents[0], executable: "/opt/provider wrapper" }];
	await f.coordinator.launch({ ...f.input, id: "new-job", agents });
	expect(f.backendFactory).toHaveBeenCalledExactlyOnceWith("pi-team", true);
	expect(startAgent).toHaveBeenCalledWith(expect.objectContaining({ executable: "/opt/provider wrapper", args: [] }));
	expect(() =>
		f.store.update("new-job", (job) => {
			job.agents[0].executable = "/replacement";
		}),
	).toThrow(/immutable/);
	const env = (f.backend.createWorkspace as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
	expect(env).toMatchObject({
		PI_COLLABORATION_AGENT_ID: agents[0].id,
		PI_COLLABORATION_JOB_ID: "new-job",
		PI_COLLABORATION_PEER_TOKEN: expect.any(String),
	});
	expect(JSON.stringify(f.store.load("new-job"))).not.toContain(env.PI_COLLABORATION_PEER_TOKEN);
});

it("rejects indistinguishable team tasks before any backend or durable side effect", async () => {
	const f = await controlledTeam();
	await expect(f.coordinator.launch({ ...f.input, id: "unscoped" }, "work")).rejects.toThrow(/distinct/);
	await expect(
		f.coordinator.launch(
			{ ...f.input, id: "duplicate", agents: f.input.agents.map((agent) => ({ ...agent, task: "same task" })) },
			"work",
		),
	).rejects.toThrow(/distinct/);
	expect(f.store.list().map((job) => job.id)).toEqual(["team"]);
	expect(f.launchTurn).not.toHaveBeenCalled();
});

it("rejects duplicate durable admission before creating any backend process", async () => {
	const f = await controlledTeam();
	await expect(f.coordinator.launch(f.input)).rejects.toThrow(/already exists/);
	expect(f.backendFactory).not.toHaveBeenCalled();
	expect(f.store.load("team").agents.map((agent) => agent.status)).toEqual(["reserved", "reserved"]);
});
