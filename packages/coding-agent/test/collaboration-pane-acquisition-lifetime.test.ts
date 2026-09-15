/**
 * Collaboration pane acquisition: stopping, and failing, while a pane request is outstanding.
 *
 * Two separate claims, both about a record being finished before the resource it describes is known.
 *
 * 1. `stopCollaborationAgent` (coordinator.ts:29-58) branches on `agent.paneId`. During a launch the
 *    pane id is only written after `strategy.createNextPane(...)` returns (coordinator.ts:244-251),
 *    so an agent whose split is still in flight has none. It is not `running` either (a launching
 *    member is `idle`/`reserved`), so the `helperPid || status === "running"` guard does not fire and
 *    the function falls straight through to `store.finishStop(...)`, which sets `closed: true` and
 *    status `stopped` (job-store.ts:636-649). That is a cleanup proof for a resource nobody has
 *    looked at yet. When the split then answers, `launch` writes the pane onto the closed member and
 *    calls `backend.startAgent` anyway - the member guard sits at :243, before the await at :244.
 *
 * 2. A `splitPane` rejection is treated as proof that no pane exists: the cleanup branch adds every
 *    agent without a `paneId` to `cleanedAgentIds` (coordinator.ts:320-322, :325, :335) and finishes
 *    it as cleanly closed. `CollaborationBackendError` distinguishes `delivery: "not-submitted"` from
 *    `delivery: "unknown"` precisely because the second means the request may have been executed
 *    before the reply was lost. An absent pane id is not evidence that no pane was created.
 *
 * batch2's collaboration-launch-lifetime.test.ts cancels the whole launch (abort/dispose) while a
 * split is pending. This file instead stops one agent, and separately loses the split's reply, so
 * the durable record's own claims are what is under test. The store is real; only the terminal
 * backend is stubbed, at the existing `deps.backend` port.
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

const CALLER_PANE: CollaborationPane = {
	paneId: "caller-pane",
	terminalId: "caller-terminal",
	workspaceId: "caller-workspace",
	tabId: "caller-tab",
};

const CREATED_PANE: CollaborationPane = {
	paneId: "created-pane",
	terminalId: "created-terminal",
	workspaceId: "caller-workspace",
	tabId: "caller-tab",
};

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
	store: CollaborationJobStore;
	coordinator: CollaborationCoordinator;
	input: NewCollaborationJob;
	splitPane: ReturnType<typeof vi.fn>;
	startAgent: ReturnType<typeof vi.fn>;
	closePane: ReturnType<typeof vi.fn>;
	getPane: ReturnType<typeof vi.fn>;
}

async function harness(held?: Deferred<CollaborationPane>): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-pane-acquisition-"));
	roots.push(root);
	const store = new CollaborationJobStore(root, "parent");
	const registered = new Map<string, CollaborationPane>();

	const splitPane = vi.fn(async () => (held ? held.promise : CREATED_PANE));
	const startAgent = vi.fn(async (input: CollaborationStart): Promise<BackendAgent> => {
		const pane = [CALLER_PANE, CREATED_PANE].find((candidate) => candidate.paneId === input.paneId);
		if (!pane) throw new Error(`Unexpected startAgent pane ${input.paneId}`);
		registered.set(input.name, pane);
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
	const getPane = vi.fn(async (paneId: string) => {
		const pane = [CALLER_PANE, CREATED_PANE].find((candidate) => candidate.paneId === paneId);
		if (!pane) throw new Error(`Unknown pane ${paneId}`);
		return { ...pane };
	});
	const getAgent = vi.fn(async (target: string) => {
		const pane = registered.get(target);
		if (!pane) throw new Error(`Agent ${target} is not registered`);
		return {
			...pane,
			name: target,
			kind: "pi",
			status: "idle" as const,
			interactiveReady: true,
			launchPending: false,
			stateChangeSequence: 1,
			revision: 1,
		};
	});
	const closePane = vi.fn(async () => {});

	// launch()/stopCollaborationAgent() use exactly these ports; one documented cast avoids stubbing
	// unrelated backend methods.
	const backend = {
		id: "stub",
		session: "stub",
		splitPane,
		getPane,
		startAgent,
		getAgent,
		closePane,
		closeWorkspace: vi.fn(async () => {}),
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
		placement: "current-pane",
		callerPaneId: CALLER_PANE.paneId,
		callerTerminalId: CALLER_PANE.terminalId,
		callerWorkspaceId: CALLER_PANE.workspaceId,
		callerTabId: CALLER_PANE.tabId,
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
	};

	return { store, coordinator, input, splitPane, startAgent, closePane, getPane };
}

describe("collaboration pane acquisition lifetime", () => {
	it("does not record a stopped agent as closed while its pane request is still outstanding", async () => {
		const held = deferred<CollaborationPane>();
		const h = await harness(held);
		const launching = h.coordinator.launch(h.input).then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();
		expect(h.splitPane).toHaveBeenCalledTimes(1);

		await h.coordinator.stopAgent("job", "agent0");

		// No pane has been observed, let alone closed, so nothing here proves the agent stopped.
		const stopped = h.store.load("job").agents[0];
		expect(h.closePane).not.toHaveBeenCalled();
		expect(stopped.closed).not.toBe(true);

		held.resolve(CREATED_PANE);
		await launching;
	});

	it("does not start a worker in a pane that arrives after its agent was stopped", async () => {
		const held = deferred<CollaborationPane>();
		const h = await harness(held);
		const launching = h.coordinator.launch(h.input).then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();

		await h.coordinator.stopAgent("job", "agent0");
		held.resolve(CREATED_PANE);
		await launching;

		expect(h.startAgent).not.toHaveBeenCalled();
		expect(h.closePane).not.toHaveBeenCalledWith(CALLER_PANE.paneId);
	});

	it("keeps a stopped agent uncertain when closing its late-arriving pane fails", async () => {
		const held = deferred<CollaborationPane>();
		const h = await harness(held);
		h.closePane.mockImplementation(async () => {
			throw new Error("closePane failed");
		});
		const launching = h.coordinator.launch(h.input).then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();

		await h.coordinator.stopAgent("job", "agent0");
		held.resolve(CREATED_PANE);
		await launching;

		// A pane exists, cleanup could not close it: the record must say so rather than claim closure.
		const agent = h.store.load("job").agents[0];
		expect(agent.closed).not.toBe(true);
		expect(agent.evidence).toContain("uncertain");
	});

	it("does not claim a clean close when the pane request fails with unknown delivery", async () => {
		const held = deferred<CollaborationPane>();
		const h = await harness(held);
		const launching = h.coordinator.launch(h.input).then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();

		// The daemon may have created the pane and lost the reply; an absent pane id proves nothing.
		held.reject(new CollaborationBackendError("pane_create_failed", "Reply lost after submission.", "unknown"));
		await launching;

		const agent = h.store.load("job").agents[0];
		expect(agent.closed).not.toBe(true);
		expect(agent.evidence).toContain("uncertain");
	});

	it("negative control: a not-submitted pane failure is a proven clean close", async () => {
		const held = deferred<CollaborationPane>();
		const h = await harness(held);
		const launching = h.coordinator.launch(h.input).then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();

		held.reject(new CollaborationBackendError("invalid_cwd", "Rejected before submission.", "not-submitted"));
		await launching;

		const agent = h.store.load("job").agents[0];
		expect(agent.closed).toBe(true);
		expect(agent.status).toBe("failed");
		expect(h.startAgent).not.toHaveBeenCalled();
	});

	it("negative control: an uninterrupted launch starts its worker and records the pane", async () => {
		const h = await harness();

		const job = await h.coordinator.launch(h.input);

		expect(h.startAgent).toHaveBeenCalledTimes(1);
		expect(job.agents[0].paneId).toBe(CREATED_PANE.paneId);
		expect(job.agents[0].closed).not.toBe(true);
		expect(h.closePane).not.toHaveBeenCalled();
	});
});
