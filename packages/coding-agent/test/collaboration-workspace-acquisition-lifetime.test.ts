/**
 * Managed-workspace acquisition: the window before a root pane exists.
 *
 * green2 made a pane acquisition durable (`acquiring`) and taught the launch cleanup that only
 * `delivery: "not-submitted"` proves nothing was created. Both of those live INSIDE the per-agent
 * loop (coordinator.ts:247-259). `strategy.init()` runs before that loop, so a managed workspace
 * request is outstanding while no member is marked `acquiring` and no member has a paneId:
 *
 * - A `createWorkspace` rejection with `delivery: "unknown"` leaves `workspaceId` undefined, so the
 *   catch falls to its last branch (coordinator.ts:356-360). Every member has no paneId and no
 *   `acquiring` flag, so every member is added to `cleanedAgentIds` and finished as cleanly closed -
 *   a cleanup proof for a workspace that may well exist.
 * - An explicit stop in that same window reaches `stopCollaborationAgent` with no `acquiring` flag,
 *   no paneId, and a non-running status, so it falls through to `finishStop` and claims closure.
 *
 * The store-level tests at the end pin the same invariant at its authoritative owner: `finishStop`
 * currently deletes `acquiring` unconditionally (job-store.ts), so any caller can convert an
 * unobserved outstanding acquisition into durable proof of closure. A cleanup that positively closed
 * the owned resource is a different thing and must stay clean.
 *
 * Only the terminal backend is stubbed, at the existing `deps.backend` port. The store is real, and
 * every scratch directory is removed even when an assertion fails.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	CollaborationAgent as BackendAgent,
	CollaborationBackend,
	CollaborationPane,
	CollaborationStart,
	CollaborationWorkspace,
} from "../src/core/collaboration/backend.ts";
import { CollaborationBackendError } from "../src/core/collaboration/backend.ts";
import { CollaborationCoordinator } from "../src/core/collaboration/coordinator.ts";
import { CollaborationJobStore, type NewCollaborationJob } from "../src/core/collaboration/job-store.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushTasks(rounds = 25): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

const ROOT_PANE: CollaborationPane = {
	paneId: "root-pane",
	terminalId: "root-terminal",
	workspaceId: "owned-workspace",
	tabId: "owned-tab",
};

const SECOND_PANE: CollaborationPane = {
	paneId: "second-pane",
	terminalId: "second-terminal",
	workspaceId: "owned-workspace",
	tabId: "owned-tab",
};

const WORKSPACE: CollaborationWorkspace = {
	workspaceId: ROOT_PANE.workspaceId,
	tabId: ROOT_PANE.tabId,
	rootPane: ROOT_PANE,
};

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
	store: CollaborationJobStore;
	coordinator: CollaborationCoordinator;
	input: NewCollaborationJob;
	createWorkspace: ReturnType<typeof vi.fn>;
	splitPane: ReturnType<typeof vi.fn>;
	startAgent: ReturnType<typeof vi.fn>;
	closeWorkspace: ReturnType<typeof vi.fn>;
}

async function harness(heldWorkspace?: Deferred<CollaborationWorkspace>): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-workspace-acquisition-"));
	roots.push(root);
	const store = new CollaborationJobStore(root, "parent");

	const createWorkspace = vi.fn(async () => (heldWorkspace ? heldWorkspace.promise : WORKSPACE));
	const splitPane = vi.fn(async () => SECOND_PANE);
	const startAgent = vi.fn(async (input: CollaborationStart): Promise<BackendAgent> => {
		const pane = [ROOT_PANE, SECOND_PANE].find((candidate) => candidate.paneId === input.paneId);
		if (!pane) throw new Error(`Unexpected startAgent pane ${input.paneId}`);
		return {
			...pane,
			name: input.name,
			kind: "pi",
			status: "idle",
			interactiveReady: true,
			launchPending: false,
			stateChangeSequence: 1,
			revision: 1,
		};
	});
	const closeWorkspace = vi.fn(async () => {});

	// launch()/stopCollaborationAgent() use exactly these ports; one documented cast avoids stubbing
	// unrelated backend methods.
	const backend = {
		id: "stub",
		session: "stub",
		createWorkspace,
		splitPane,
		startAgent,
		closeWorkspace,
		getPane: vi.fn(async () => ({ ...ROOT_PANE })),
		getAgent: vi.fn(async () => {
			throw new Error("Agent is not registered");
		}),
		closePane: vi.fn(async () => {}),
	} as unknown as CollaborationBackend;

	const coordinator = new CollaborationCoordinator({
		store,
		backend: async () => backend,
		launchTurn: vi.fn(async () => {}),
		report: vi.fn(),
	});

	const input: NewCollaborationJob = {
		id: "job",
		parentSessionId: "parent",
		sessionName: "pi-team",
		cwd: root,
		title: "team",
		createdAt: 0,
		deadlineSeconds: 30,
		placement: "managed-workspace",
		agents: ["agent0", "agent1"].map((id) => ({
			id,
			name: id,
			provider: "pi",
			cwd: root,
			args: [],
			env: {},
			profile: { identity: id, allowedTools: ["read", "bash", "python"], writePaths: [] },
		})),
	};

	return { store, coordinator, input, createWorkspace, splitPane, startAgent, closeWorkspace };
}

/** A job with one member, used for the store-owner transitions below. */
async function storeOnlyJob(): Promise<{ store: CollaborationJobStore; agentId: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-workspace-store-"));
	roots.push(root);
	const store = new CollaborationJobStore(root, "parent");
	store.create({
		id: "job",
		parentSessionId: "parent",
		sessionName: "pi-team",
		cwd: root,
		title: "team",
		createdAt: 0,
		deadlineSeconds: 30,
		agents: [
			{
				id: "agent0",
				name: "agent0",
				provider: "pi",
				cwd: root,
				args: [],
				env: {},
				profile: { identity: "agent0", allowedTools: ["read", "bash", "python"], writePaths: [] },
			},
		],
	});
	return { store, agentId: "agent0" };
}

describe("managed workspace acquisition lifetime", () => {
	it("does not claim a clean close when the workspace request fails with unknown delivery", async () => {
		const held = deferred<CollaborationWorkspace>();
		const h = await harness(held);
		const launching = h.coordinator.launch(h.input).then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();
		expect(h.createWorkspace).toHaveBeenCalledTimes(1);

		// The daemon may have created the workspace and lost the reply. No member has a pane, but that
		// is not evidence that no workspace exists.
		held.reject(new CollaborationBackendError("workspace_create_failed", "Reply lost after submission.", "unknown"));
		await launching;

		const agents = h.store.load("job").agents;
		expect(agents.map((agent) => agent.closed)).not.toContain(true);
		expect(agents.every((agent) => (agent.evidence ?? "").includes("uncertain"))).toBe(true);
		expect(h.startAgent).not.toHaveBeenCalled();
	});

	it("negative control: a not-submitted workspace failure is a proven clean close", async () => {
		const held = deferred<CollaborationWorkspace>();
		const h = await harness(held);
		const launching = h.coordinator.launch(h.input).then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();

		held.reject(new CollaborationBackendError("invalid_cwd", "Rejected before submission.", "not-submitted"));
		await launching;

		const agents = h.store.load("job").agents;
		expect(agents.map((agent) => agent.closed)).toEqual([true, true]);
		expect(agents.map((agent) => agent.status)).toEqual(["failed", "failed"]);
		expect(h.startAgent).not.toHaveBeenCalled();
	});

	it("does not record a stopped member as closed while the workspace request is still outstanding", async () => {
		const held = deferred<CollaborationWorkspace>();
		const h = await harness(held);
		const launching = h.coordinator.launch(h.input).then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();
		expect(h.createWorkspace).toHaveBeenCalledTimes(1);

		await h.coordinator.stopAgent("job", "agent0");

		try {
			// No workspace and no pane have been observed, so nothing here proves the member stopped.
			const stopped = h.store.load("job").agents[0];
			expect(h.closeWorkspace).not.toHaveBeenCalled();
			expect(stopped.closed).not.toBe(true);
		} finally {
			// Release and drain regardless of the assertion outcome: a red must never strand the
			// pending launch, which would skip the coordinator's own failure cleanup.
			held.resolve(WORKSPACE);
			await launching;
		}
		// The stop intent must also survive the late reply: no worker may be started into it.
		expect(h.startAgent).not.toHaveBeenCalled();
	});

	it("negative control: an uninterrupted managed launch starts every member and closes nothing", async () => {
		const h = await harness();

		const job = await h.coordinator.launch(h.input);

		expect(h.startAgent).toHaveBeenCalledTimes(2);
		expect(job.agents.map((agent) => agent.paneId)).toEqual([ROOT_PANE.paneId, SECOND_PANE.paneId]);
		expect(job.agents.map((agent) => agent.closed)).not.toContain(true);
		expect(h.closeWorkspace).not.toHaveBeenCalled();
	});

	it("negative control: closing the owned workspace resolves its members' acquisition cleanly", async () => {
		const h = await harness();
		h.startAgent.mockImplementationOnce(async () => {
			throw new Error("startAgent refused");
		});

		await expect(h.coordinator.launch(h.input)).rejects.toThrow("startAgent refused");

		// The workspace was positively closed, which is real evidence about every pane inside it.
		expect(h.closeWorkspace).toHaveBeenCalledWith(WORKSPACE.workspaceId);
		expect(h.store.load("job").agents.map((agent) => agent.closed)).toEqual([true, true]);
	});

	it("does not let finishStop convert an unobserved outstanding acquisition into proof of closure", async () => {
		const { store, agentId } = await storeOnlyJob();
		store.beginAcquisition("job", agentId);
		const agent = store.beginStop("job", agentId);
		expect(agent).toBeDefined();

		store.finishStop("job", agentId, agent!.turnId, "stopped", "Owned collaboration agent stopped.");

		// Nothing observed the outstanding resource, so `closed` - the durable cleanup proof consumed by
		// archive, dismiss and the UI - must not be set by this call.
		const settled = store.load("job").agents[0];
		expect(settled.closed).not.toBe(true);
		expect(settled.acquiring).toBe(true);
	});

	it("negative control: finishStop closes a member whose acquisition already resolved", async () => {
		const { store, agentId } = await storeOnlyJob();
		store.beginAcquisition("job", agentId);
		store.finishAcquisition("job", agentId, {
			paneId: "pane-1",
			terminalId: "terminal-1",
			backendName: "a-agent0",
		});
		const agent = store.beginStop("job", agentId);
		expect(agent).toBeDefined();

		expect(store.finishStop("job", agentId, agent!.turnId, "stopped", "Owned collaboration agent stopped.")).toBe(
			true,
		);

		const settled = store.load("job").agents[0];
		expect(settled.closed).toBe(true);
		expect(settled.acquiring).toBeUndefined();
	});

	it("does not admit an unobserved outstanding acquisition as executable work", async () => {
		const { store, agentId } = await storeOnlyJob();
		store.beginAcquisition("job", agentId);
		const before = store.load("job").agents[0];

		// `reserve` guards closed/stopping/steering/status, but an outstanding creation leaves the
		// member `idle`, so nothing stops a turn being reserved onto a resource nobody has observed.
		expect(() => store.reserveTurn("job", agentId, "do the work")).toThrow();

		// Rejection must not have mutated the member.
		const after = store.load("job").agents[0];
		expect(after.turn).toBe(before.turn);
		expect(after.turnId).toBe(before.turnId);
		expect(after.status).toBe(before.status);
		expect(after.acquiring).toBe(true);
	});

	it("negative control: a resolved acquisition reserves a turn normally", async () => {
		const { store, agentId } = await storeOnlyJob();
		store.beginAcquisition("job", agentId);
		store.finishAcquisition("job", agentId, {
			paneId: "pane-1",
			terminalId: "terminal-1",
			backendName: "a-agent0",
		});

		const reserved = store.reserveTurn("job", agentId, "do the work");

		expect(reserved.status).toBe("reserved");
		expect(reserved.turn).toBe(1);
		// `claimTurn` requires an already-reserved turn, so it is unreachable while an acquisition is
		// outstanding; a separate claim test would only mirror the reserve guard above.
		expect(store.claimTurn("job", agentId, reserved.turnId, 4242)).toBe(true);
	});

	it("negative control: an outstanding acquisition is never inert for archive or dismiss", async () => {
		const { store, agentId } = await storeOnlyJob();
		store.beginAcquisition("job", agentId);

		expect(() => store.dismiss("job")).toThrow(/active collaboration work/);
		expect(() => store.archive("job")).toThrow(/active collaboration job/);

		store.finishAcquisition("job", agentId);
		expect(store.load("job").agents[0].acquiring).toBeUndefined();
	});
});
