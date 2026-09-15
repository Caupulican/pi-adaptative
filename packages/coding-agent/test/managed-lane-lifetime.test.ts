/**
 * A managed (Herdr) persistent CLI's lifetime never reaches the lane projection.
 *
 * Two independent gaps, both on the path the original user scope cares about - Pi delegating into
 * Herdr panes - driven here through the real seam:
 * `CollaborationCoordinator.report` -> `ManagedLaneController.record` -> `WorkerLifecycle` projection.
 *
 * 1. `CollaborationCoordinator.refresh` de-duplicates by TURN: once a terminal has been published for
 *    turn N it sets `notifiedTurn = N`, and every later pass skips the member while
 *    `notifiedTurn >= turn`. Stopping the persistent CLI AFTER its task completed does not advance
 *    `turn`, so the closure is never published at all. A lifetime field on the first terminal event
 *    cannot fix this: at that moment the CLI is still retained.
 *
 * 2. `prepareManaged` binds no `agentId`, so a managed attempt has none and
 *    `projectWorkerLaneRecord` leaves `agentStatus` undefined. `isRetainedWorkerLane` is
 *    `(worker|tmux-worker) && agentStatus !== "retired"`, unconditionally TRUE for every managed lane
 *    that ever existed.
 *
 * A closed pane and a completed turn are different facts: a steering-stopped turn does not retire the
 * CLI behind it, and cancelling a durable task is not evidence that any CLI closed. The closure is
 * therefore published as a distinct LIFECYCLE event rather than by re-finishing a terminal task, so
 * completion, usage and the parent terminal handoff are each published exactly once.
 *
 * No Herdr CLI is launched, no agent binding is faked, and no closure is inferred from cancellation.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerClaim } from "../src/core/autonomy/contracts.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { CollaborationBackend } from "../src/core/collaboration/backend.ts";
import { CollaborationCoordinator } from "../src/core/collaboration/coordinator.ts";
import { CollaborationJobStore, collaborationLaneId } from "../src/core/collaboration/job-store.ts";
import { ManagedLaneController } from "../src/core/delegation/managed-lane-controller.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import type { ManagedLaneEvent } from "../src/core/extensions/types.ts";
import { isRetainedWorkerLane } from "../src/modes/interactive/components/agents-overlay.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * The lifetime fact a managed event cannot currently carry. Proposed as an optional discriminated
 * phase on the existing `ManagedLaneEvent`, so the fix publishes a CLI closure without re-finishing a
 * task that already reached terminal. The cast documents a proposed input, not an implementation.
 */
type ProposedManagedLaneEvent =
	| ManagedLaneEvent
	| {
			laneId: string;
			phase: "lifecycle";
			/** Durable dispatch turn this lifetime statement was observed against. */
			dispatchSequence?: number;
			agentLifecycle: "retained" | "retired";
	  };

function isLifecycleEvent(
	event: ProposedManagedLaneEvent,
): event is Extract<ProposedManagedLaneEvent, { phase: "lifecycle" }> {
	return (event as { phase: string }).phase === "lifecycle";
}

/** In-memory SessionManager surface the managed controller actually uses. */
function sessionManagerFixture() {
	const entries: unknown[] = [];
	return {
		manager: {
			appendCustomEntry: (customType: string, data: unknown) => {
				const id = `entry-${entries.length + 1}`;
				entries.push({ type: "custom", customType, data, id });
				return id;
			},
			getBranch: () => entries,
		},
		entries,
	};
}

interface Harness {
	store: CollaborationJobStore;
	coordinator: CollaborationCoordinator;
	lifecycle: WorkerLifecycle;
	controller: ManagedLaneController;
	jobId: string;
	agentId: string;
	laneId: string;
	published: ProposedManagedLaneEvent[];
	claims: WorkerClaim[];
	parentTerminals: LaneRecord[];
	usageReports: Array<{ usage: Usage; reportId: string }>;
	/** Reopen the durable ledger from disk; an in-memory controller map cannot satisfy this. */
	reopenLifecycle(): WorkerLifecycle;
	/** Feed one published event through the real managed controller. */
	deliver(event: ProposedManagedLaneEvent): void;
	managedRecords(): LaneRecord[];
}

async function harness(): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "pi-managed-lane-lifetime-"));
	roots.push(root);
	const store = new CollaborationJobStore(root, "parent");
	const jobId = "team";
	const agentId = "reviewer";
	store.create({
		id: jobId,
		parentSessionId: "parent",
		sessionName: "pi-team",
		cwd: root,
		title: "team",
		createdAt: 0,
		deadlineSeconds: 30,
		agents: [
			{
				id: agentId,
				name: agentId,
				provider: "pi",
				cwd: root,
				args: [],
				env: {},
				backendName: agentId,
				paneId: `pane-${agentId}`,
				terminalId: `terminal-${agentId}`,
				profile: { identity: agentId, allowedTools: ["read", "bash", "python"], writePaths: [] },
			},
		],
	});

	const published: ProposedManagedLaneEvent[] = [];
	const claims: WorkerClaim[] = [];
	const parentTerminals: LaneRecord[] = [];
	const usageReports: Array<{ usage: Usage; reportId: string }> = [];
	const sessionId = "managed-session";
	const lifecycle = new WorkerLifecycle({ agentDir: root, sessionId });
	const session = sessionManagerFixture();

	// `record()` uses exactly these deps; one documented cast avoids stubbing an entire SessionManager.
	const controller = new ManagedLaneController(
		{
			isDisposed: () => false,
			getAgentDir: () => root,
			getCwd: () => root,
			getSessionManager: () => session.manager,
			getGoalStateSnapshot: () => undefined,
			getCapabilityEnvelope: () => ({}),
			saveWorkerClaimSnapshot: (claim: WorkerClaim) => {
				claims.push(claim);
				return `claim-${claims.length}`;
			},
			addSpawnedUsage: (usage: Usage, options: { reportId: string }) => {
				usageReports.push({ usage, reportId: options.reportId });
				return options.reportId;
			},
		} as unknown as ConstructorParameters<typeof ManagedLaneController>[0],
		lifecycle,
		(record) => {
			parentTerminals.push(record);
		},
	);

	const backend = {
		id: "stub",
		session: "stub",
		getAgent: vi.fn(async (name: string) => ({
			paneId: `pane-${name}`,
			terminalId: `terminal-${name}`,
			workspaceId: "w1",
			tabId: "t1",
			status: "idle" as const,
			interactiveReady: true,
			launchPending: false,
			stateChangeSequence: 1,
			revision: 1,
		})),
		closePane: vi.fn(async () => {}),
	} as unknown as CollaborationBackend;

	const coordinator = new CollaborationCoordinator({
		store,
		backend: async () => backend,
		launchTurn: vi.fn(async () => {}),
		report: (event) => {
			published.push(event as ProposedManagedLaneEvent);
		},
	});

	return {
		store,
		coordinator,
		lifecycle,
		controller,
		jobId,
		agentId,
		laneId: collaborationLaneId(jobId, agentId),
		published,
		claims,
		parentTerminals,
		usageReports,
		reopenLifecycle: () => new WorkerLifecycle({ agentDir: root, sessionId }),
		deliver: (event) => {
			controller.record(event as ManagedLaneEvent);
		},
		managedRecords: () => lifecycle.getManagedRecords(),
	};
}

/** A valid provider usage claim, in the exact field set `validateProviderUsage` accepts. */
const TURN_USAGE: Usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

/** Reserve, dispatch, complete and publish one managed turn through the real seam. */
function runManagedTurn(h: Harness, status: "done" | "stopped", evidence: string): void {
	const before = h.published.length;
	const turn = h.store.reserveTurn(h.jobId, h.agentId, "do the work");
	// `reserveTurn` does not report; the coordinator's own dispatch does, via launchReservedTurn.
	h.coordinator.refresh();
	h.store.claimTurn(h.jobId, h.agentId, turn.turnId, 4242);
	h.store.finishTurn(h.jobId, h.agentId, turn.turnId, status, evidence, TURN_USAGE);
	h.coordinator.refresh();
	for (const event of h.published.slice(before)) h.deliver(event);
}

/** A dispatch event for the managed lane, as the coordinator emits one. */
function dispatchEvent(h: Harness, sequence: number): ProposedManagedLaneEvent {
	return {
		laneId: h.laneId,
		phase: "dispatch",
		dispatch: {
			sequence,
			instructions: "do the work",
			profileId: "collaboration",
			provider: "pi",
			authorizationId: "collaboration",
			authorizationKind: "profile-derived",
			allowedTools: ["read"],
			writePaths: [],
			leaseTtlMs: 60_000,
		},
	};
}

describe("managed lane lifetime", () => {
	it("publishes the persistent CLI's closure after its last turn already reached terminal", async () => {
		const h = await harness();
		h.deliver(dispatchEvent(h, 1));
		runManagedTurn(h, "done", "work finished");
		const afterTurn = h.published.length;
		expect(h.published.filter((event) => event.phase === "terminal")).toHaveLength(1);

		// The operator stops the persistent CLI itself, after its task already completed.
		expect(await h.coordinator.stopAgent(h.jobId, h.agentId)).toBe(true);
		h.coordinator.refresh();

		expect(h.store.load(h.jobId).agents[0].closed).toBe(true);
		// The closure is a new durable fact about the AGENT, not a new turn, so it must still be
		// published - as its own lifecycle statement, never by re-finishing the completed task.
		const added = h.published.slice(afterTurn);
		expect(added.length).toBeGreaterThan(0);
		expect(added.filter(isLifecycleEvent).map((event) => event.agentLifecycle)).toEqual(["retired"]);
	});

	it("removes a retired managed CLI from the retained roster while its history survives", async () => {
		const h = await harness();
		h.deliver(dispatchEvent(h, 1));
		runManagedTurn(h, "done", "work finished");
		expect(h.managedRecords()).toHaveLength(1);

		h.deliver({ laneId: h.laneId, phase: "lifecycle", dispatchSequence: 1, agentLifecycle: "retired" });

		const records = h.managedRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.agentStatus).toBe("retired");
		expect(records.filter(isRetainedWorkerLane)).toHaveLength(0);
		// History is not deleted to tidy the roster: the durable task and its terminal status remain.
		expect(records[0]?.status).toBe("succeeded");
		expect(h.lifecycle.getManagedAttempt(h.laneId)?.result?.status).toBe("completed");
	});

	it("accounts completion, usage and the parent terminal handoff exactly once across a closure", async () => {
		const h = await harness();
		h.deliver(dispatchEvent(h, 1));
		runManagedTurn(h, "done", "work finished");
		// The turn's own accounting: one claim, one parent terminal, one validated usage report.
		expect(h.claims).toHaveLength(1);
		expect(h.parentTerminals).toHaveLength(1);
		expect(h.usageReports).toHaveLength(1);
		expect(h.usageReports[0]?.usage.cost.total).toBe(TURN_USAGE.cost.total);
		expect(h.managedRecords()[0]?.costUsd).toBe(TURN_USAGE.cost.total);

		await h.coordinator.stopAgent(h.jobId, h.agentId);
		h.coordinator.refresh();
		// The coordinator's OWN emitted closure goes through the full seam, not a hand-built event.
		const closures = h.published.filter(isLifecycleEvent);
		for (const event of closures) h.deliver(event);

		expect(closures.length).toBeGreaterThan(0);
		expect(h.claims).toHaveLength(1);
		expect(h.parentTerminals).toHaveLength(1);
		expect(h.usageReports).toHaveLength(1);
	});

	it("keeps a managed retirement durable across a ledger reopen", async () => {
		const h = await harness();
		h.deliver(dispatchEvent(h, 1));
		runManagedTurn(h, "done", "work finished");

		h.deliver({ laneId: h.laneId, phase: "lifecycle", dispatchSequence: 1, agentLifecycle: "retired" });

		// Replayed from disk: an in-memory controller map cannot satisfy this.
		const reopened = h.reopenLifecycle();
		const records = reopened.getManagedRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.agentStatus).toBe("retired");
		expect(records.filter(isRetainedWorkerLane)).toHaveLength(0);
		// Retirement is not achieved by clearing the completed task's status.
		expect(records[0]?.status).toBe("succeeded");
		expect(reopened.getManagedAttempt(h.laneId)?.result?.status).toBe("completed");
	});

	it("negative control: replaying the same-generation closure is idempotent", async () => {
		const h = await harness();
		h.deliver(dispatchEvent(h, 1));
		runManagedTurn(h, "done", "work finished");
		const closure: ProposedManagedLaneEvent = {
			laneId: h.laneId,
			phase: "lifecycle",
			dispatchSequence: 1,
			agentLifecycle: "retired",
		};
		h.deliver(closure);
		const afterFirst = {
			claims: h.claims.length,
			terminals: h.parentTerminals.length,
			usage: h.usageReports.length,
			records: h.managedRecords().length,
			status: h.managedRecords()[0]?.agentStatus,
		};

		h.deliver(closure);

		expect({
			claims: h.claims.length,
			terminals: h.parentTerminals.length,
			usage: h.usageReports.length,
			records: h.managedRecords().length,
			status: h.managedRecords()[0]?.agentStatus,
		}).toEqual(afterFirst);
	});

	it("negative control: a completed turn on a still-retained CLI stays available", async () => {
		const h = await harness();
		h.deliver(dispatchEvent(h, 1));
		runManagedTurn(h, "done", "work finished");

		const terminals = h.published.filter((event) => event.phase === "terminal");
		expect(terminals).toHaveLength(1);
		expect(h.published.filter(isLifecycleEvent)).toHaveLength(0);
		const agent = h.store.load(h.jobId).agents[0];
		expect(agent.closed).not.toBe(true);
		expect(agent.paneId).toBe(`pane-${h.agentId}`);
		expect(h.managedRecords().filter(isRetainedWorkerLane)).toHaveLength(1);
	});

	it("negative control: a steering-stopped turn does not retire the CLI behind it", async () => {
		const h = await harness();
		h.deliver(dispatchEvent(h, 1));
		runManagedTurn(h, "stopped", "turn ended by steering");

		expect(h.published.filter(isLifecycleEvent)).toHaveLength(0);
		// The turn ended; the persistent CLI did not.
		expect(h.store.load(h.jobId).agents[0].closed).not.toBe(true);
		expect(h.managedRecords().filter(isRetainedWorkerLane)).toHaveLength(1);
	});

	it("negative control: a replayed closure cannot retire a newer dispatch generation", async () => {
		const h = await harness();
		h.deliver(dispatchEvent(h, 1));
		runManagedTurn(h, "done", "first turn finished");
		await h.coordinator.stopAgent(h.jobId, h.agentId);
		h.coordinator.refresh();
		const capturedClosure = h.published.filter(isLifecycleEvent).at(-1) ?? {
			laneId: h.laneId,
			phase: "lifecycle" as const,
			dispatchSequence: 1,
			agentLifecycle: "retired" as const,
		};

		// A newer dispatch generation takes the same logical lane.
		h.deliver(dispatchEvent(h, 2));
		const newer = h.lifecycle.getManagedAttempt(h.laneId);
		expect(newer?.dispatch.dispatchSequence).toBe(2);

		// Replaying the captured closure against the newer generation must be rejected or ignored.
		try {
			h.deliver(capturedClosure);
		} catch {
			// A rejection is an acceptable outcome; a silent mutation is not.
		}

		const current = h.lifecycle.getManagedAttempt(h.laneId);
		expect(current?.dispatch.dispatchSequence).toBe(2);
		expect(current?.status).not.toBe("completed");
		expect(current?.result).toBeUndefined();
		expect(h.managedRecords().filter(isRetainedWorkerLane)).toHaveLength(1);
	});
});
