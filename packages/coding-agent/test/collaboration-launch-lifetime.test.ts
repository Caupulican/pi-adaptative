/**
 * CollaborationCoordinator.launch cancellation lifetime.
 *
 * The per-agent loop calls `this.assertActive(signal)` before `strategy.createNextPane(...)`
 * (coordinator.ts:241-244) and again only at the top of the next iteration. Pane creation is a real
 * round trip to the terminal backend, so a cancellation that lands while it is in flight is not seen
 * until after `backend.startAgent(...)` has already put a worker into the freshly created pane
 * (coordinator.ts:252). The cancellation is honoured one statement too late: the process is started
 * and then torn down, instead of never being started.
 *
 * Existing launch coverage (collaboration-coordinator.test.ts, collaboration-herdr-panel.test.ts)
 * exercises rollback after a *failed* startAgent and stale caller-identity rejection. Neither holds a
 * pane-creation round trip open, so the window between "owned pane exists" and "worker started" is
 * never observed.
 *
 * The durable store is real (a scratch directory under tmpdir()); only the terminal backend is a
 * stub, injected at the existing `deps.backend` port. No pane, process or workspace is real.
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

function readyAgent(pane: CollaborationPane, name: string): BackendAgent {
	return {
		...pane,
		name,
		kind: "pi",
		status: "idle",
		interactiveReady: true,
		launchPending: false,
		stateChangeSequence: 1,
		revision: 1,
	};
}

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
	store: CollaborationJobStore;
	coordinator: CollaborationCoordinator;
	input: NewCollaborationJob;
	splitPane: ReturnType<typeof vi.fn>;
	createWorkspace: ReturnType<typeof vi.fn>;
	startAgent: ReturnType<typeof vi.fn>;
	closePane: ReturnType<typeof vi.fn>;
	closeWorkspace: ReturnType<typeof vi.fn>;
	launchTurn: ReturnType<typeof vi.fn>;
	startedNames: string[];
}

async function harness(options: {
	placement: "current-pane" | "managed-workspace";
	agentCount: number;
	heldSplit?: Deferred<CollaborationPane>;
	heldWorkspace?: Deferred<CollaborationWorkspace>;
}): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-launch-lifetime-"));
	roots.push(root);
	const store = new CollaborationJobStore(root, "parent");
	const panes: CollaborationPane[] = options.placement === "current-pane" ? [CREATED_PANE] : [SECOND_PANE];
	let splitIndex = 0;
	const startedNames: string[] = [];

	const splitPane = vi.fn(async () => {
		const next = panes[Math.min(splitIndex++, panes.length - 1)];
		if (options.heldSplit) return options.heldSplit.promise;
		return next;
	});
	const createWorkspace = vi.fn(async () => {
		if (options.heldWorkspace) return options.heldWorkspace.promise;
		return { workspaceId: ROOT_PANE.workspaceId, tabId: ROOT_PANE.tabId, rootPane: ROOT_PANE };
	});
	const registered = new Map<string, CollaborationPane>();
	const startAgent = vi.fn(async (input: CollaborationStart) => {
		startedNames.push(input.name);
		const pane = [CALLER_PANE, CREATED_PANE, ROOT_PANE, SECOND_PANE].find(
			(candidate) => candidate.paneId === input.paneId,
		);
		if (!pane) throw new Error(`Unexpected startAgent pane ${input.paneId}`);
		registered.set(input.name, pane);
		return readyAgent(pane, input.name);
	});
	const getPane = vi.fn(async (paneId: string) => {
		const pane = [CALLER_PANE, CREATED_PANE, ROOT_PANE, SECOND_PANE].find((candidate) => candidate.paneId === paneId);
		if (!pane) throw new Error(`Unknown pane ${paneId}`);
		return { ...pane };
	});
	// Only a name that actually reached startAgent is resolvable, exactly like the real backend:
	// launch cleanup must fall back to getPane for a pane created but never started.
	const getAgent = vi.fn(async (target: string) => {
		const pane = registered.get(target);
		if (!pane) throw new Error(`Agent ${target} is not registered`);
		return readyAgent(pane, target);
	});
	const closePane = vi.fn(async () => {});
	const closeWorkspace = vi.fn(async () => {});

	// launch() uses exactly these ports; one documented cast avoids stubbing unrelated backend methods.
	const backend = {
		id: "stub",
		session: "stub",
		createWorkspace,
		splitPane,
		getPane,
		startAgent,
		getAgent,
		closePane,
		closeWorkspace,
	} as unknown as CollaborationBackend;

	const launchTurn = vi.fn(async () => {});
	const coordinator = new CollaborationCoordinator({
		store,
		backend: async () => backend,
		launchTurn,
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
		placement: options.placement,
		...(options.placement === "current-pane"
			? {
					callerPaneId: CALLER_PANE.paneId,
					callerTerminalId: CALLER_PANE.terminalId,
					callerWorkspaceId: CALLER_PANE.workspaceId,
					callerTabId: CALLER_PANE.tabId,
				}
			: {}),
		agents: Array.from({ length: options.agentCount }, (_unused, index) => ({
			id: `agent${index}`,
			name: `agent${index}`,
			provider: "pi",
			cwd: root,
			args: [],
			env: {},
			profile: { identity: `agent${index}`, allowedTools: ["read", "bash", "python"], writePaths: [] },
		})),
	};

	return {
		store,
		coordinator,
		input,
		splitPane,
		createWorkspace,
		startAgent,
		closePane,
		closeWorkspace,
		launchTurn,
		startedNames,
	};
}

describe("collaboration launch cancellation lifetime", () => {
	it("does not start a worker in a pane created while the launch was being aborted", async () => {
		const held = deferred<CollaborationPane>();
		const h = await harness({ placement: "current-pane", agentCount: 1, heldSplit: held });
		const controller = new AbortController();

		const launching = h.coordinator.launch(h.input, undefined, controller.signal);
		const observed = launching.then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();
		expect(h.splitPane).toHaveBeenCalledTimes(1);
		expect(h.startAgent).not.toHaveBeenCalled();

		controller.abort(new Error("Launch cancelled while the pane was being created."));
		await flushTasks();
		held.resolve(CREATED_PANE);
		await observed;

		expect(h.startAgent).not.toHaveBeenCalled();
		expect(h.launchTurn).not.toHaveBeenCalled();
		// The owned pane must still be tracked and cleaned up, and the caller's pane left alone.
		expect(h.closePane).toHaveBeenCalledWith(CREATED_PANE.paneId);
		expect(h.closePane).not.toHaveBeenCalledWith(CALLER_PANE.paneId);
	});

	it("does not start a worker in a pane created while the coordinator was being disposed", async () => {
		const held = deferred<CollaborationPane>();
		const h = await harness({ placement: "current-pane", agentCount: 1, heldSplit: held });

		const launching = h.coordinator.launch(h.input);
		const observed = launching.then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();
		expect(h.splitPane).toHaveBeenCalledTimes(1);

		h.coordinator.dispose();
		await flushTasks();
		held.resolve(CREATED_PANE);
		await observed;

		expect(h.startAgent).not.toHaveBeenCalled();
		expect(h.launchTurn).not.toHaveBeenCalled();
		expect(h.closePane).not.toHaveBeenCalledWith(CALLER_PANE.paneId);
	});

	it("does not start a second worker in a managed pane created while the launch was being aborted", async () => {
		const held = deferred<CollaborationPane>();
		const h = await harness({ placement: "managed-workspace", agentCount: 2, heldSplit: held });
		const controller = new AbortController();

		const launching = h.coordinator.launch(h.input, undefined, controller.signal);
		const observed = launching.then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();
		// The root pane is reused for agent 0; agent 1 is the one whose split is held open.
		expect(h.startAgent).toHaveBeenCalledTimes(1);
		expect(h.splitPane).toHaveBeenCalledTimes(1);

		controller.abort(new Error("Launch cancelled while the second pane was being created."));
		await flushTasks();
		held.resolve(SECOND_PANE);
		await observed;

		expect(h.startedNames).toHaveLength(1);
		expect(h.launchTurn).not.toHaveBeenCalled();
		expect(h.closeWorkspace).toHaveBeenCalledWith(ROOT_PANE.workspaceId);
	});

	it("negative control: an abort during managed workspace creation is caught before any pane is used", async () => {
		const held = deferred<CollaborationWorkspace>();
		const h = await harness({ placement: "managed-workspace", agentCount: 1, heldWorkspace: held });
		const controller = new AbortController();

		const launching = h.coordinator.launch(h.input, undefined, controller.signal);
		const observed = launching.then(
			() => "resolved",
			(error: unknown) => error,
		);
		await flushTasks();
		controller.abort(new Error("Launch cancelled during workspace creation."));
		await flushTasks();
		held.resolve({ workspaceId: ROOT_PANE.workspaceId, tabId: ROOT_PANE.tabId, rootPane: ROOT_PANE });
		const outcome = await observed;

		expect(String(outcome)).toContain("Launch cancelled during workspace creation.");
		expect(h.startAgent).not.toHaveBeenCalled();
		expect(h.closeWorkspace).toHaveBeenCalledWith(ROOT_PANE.workspaceId);
	});

	it("negative control: an uncancelled launch starts every worker and dispatches its turns", async () => {
		const h = await harness({ placement: "current-pane", agentCount: 1 });

		const job = await h.coordinator.launch(h.input, "build the thing");

		expect(h.startedNames).toHaveLength(1);
		expect(h.startAgent).toHaveBeenCalledWith(expect.objectContaining({ paneId: CREATED_PANE.paneId }));
		expect(h.launchTurn).toHaveBeenCalledTimes(1);
		expect(h.closePane).not.toHaveBeenCalled();
		expect(job.agents[0].paneId).toBe(CREATED_PANE.paneId);
		expect(job.agents[0].terminalId).toBe(CREATED_PANE.terminalId);
	});

	it("negative control: a cleanup failure leaves the agent marked uncertain, never cleanly closed", async () => {
		const h = await harness({ placement: "current-pane", agentCount: 1 });
		h.startAgent.mockImplementationOnce(async () => {
			throw new Error("startAgent refused");
		});
		h.closePane.mockImplementation(async () => {
			throw new Error("closePane failed");
		});

		await expect(h.coordinator.launch(h.input)).rejects.toThrow("startAgent refused");

		const agent = h.store.load("job").agents[0];
		expect(agent.status).toBe("failed");
		// `closed` is the clean-stop proof; an uncertain cleanup must never set it.
		expect(agent.closed).not.toBe(true);
		expect(agent.evidence).toContain("Launch cleanup uncertain");
	});
});
