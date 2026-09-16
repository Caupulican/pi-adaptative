/**
 * Managed lane lifetime: which generation a closure is allowed to retire.
 *
 * batch6 added a durable `managed.lifecycle` event fenced on `logicalLaneId` + `dispatchSequence`.
 * `WorkerLifecycle.retireManaged` still substitutes the CURRENT attempt's sequence when the event
 * omits one, so an unversioned closure -- the shape a producer emits for a turn that never reached
 * dispatch -- lands on whatever turn happens to be current. Inferring ownership is exactly what the
 * generation fence exists to prevent.
 *
 * Driven through the real `ManagedLaneController` -> `WorkerLifecycle` -> durable runtime seam with
 * an owned scratch ledger. No Herdr CLI, no external process, and no invented current ownership.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerClaim } from "../src/core/autonomy/contracts.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { ManagedLaneController } from "../src/core/delegation/managed-lane-controller.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import type { ManagedLaneEvent } from "../src/core/extensions/types.ts";
import { isRetainedWorkerLane } from "../src/modes/interactive/components/agents-overlay.ts";

const LANE_ID = "collaboration:team:reviewer";
const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const directory = roots.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

/** The lifetime statement, including the unversioned shape a turn-0 closure produces. */
type LifetimeEvent = {
	laneId: string;
	phase: "lifecycle";
	dispatchSequence?: number;
	agentLifecycle: "retained" | "retired";
};

function sessionManagerFixture() {
	const entries: unknown[] = [];
	return {
		appendCustomEntry: (customType: string, data: unknown) => {
			const id = `entry-${entries.length + 1}`;
			entries.push({ type: "custom", customType, data, id });
			return id;
		},
		getBranch: () => entries,
	};
}

interface Harness {
	lifecycle: WorkerLifecycle;
	controller: ManagedLaneController;
	claims: WorkerClaim[];
	parentTerminals: LaneRecord[];
	deliver(event: LifetimeEvent | ManagedLaneEvent): LaneRecord | undefined;
	records(): LaneRecord[];
}

function harness(sessionId: string): Harness {
	const root = mkdtempSync(join(tmpdir(), "pi-managed-generation-"));
	roots.push(root);
	const lifecycle = new WorkerLifecycle({ agentDir: root, sessionId });
	const claims: WorkerClaim[] = [];
	const parentTerminals: LaneRecord[] = [];
	const session = sessionManagerFixture();
	// `record()` uses exactly these deps; one documented cast avoids stubbing a whole SessionManager.
	const controller = new ManagedLaneController(
		{
			isDisposed: () => false,
			getAgentDir: () => root,
			getCwd: () => root,
			getSessionManager: () => session,
			getGoalStateSnapshot: () => undefined,
			getCapabilityEnvelope: () => ({}),
			saveWorkerClaimSnapshot: (claim: WorkerClaim) => {
				claims.push(claim);
				return `claim-${claims.length}`;
			},
		} as unknown as ConstructorParameters<typeof ManagedLaneController>[0],
		lifecycle,
		(record) => {
			parentTerminals.push(record);
		},
	);
	return {
		lifecycle,
		controller,
		claims,
		parentTerminals,
		deliver: (event) => controller.record(event as ManagedLaneEvent),
		records: () => lifecycle.getManagedRecords(),
	};
}

function dispatchEvent(sequence: number): ManagedLaneEvent {
	return {
		laneId: LANE_ID,
		phase: "dispatch",
		dispatch: {
			sequence,
			instructions: `managed turn ${sequence}`,
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

function terminalEvent(sequence: number): ManagedLaneEvent {
	return {
		laneId: LANE_ID,
		phase: "terminal",
		dispatchSequence: sequence,
		status: "done",
		summary: `managed turn ${sequence} finished`,
		reasonCode: "collaboration_terminal",
	};
}

describe("managed lane generation boundary", () => {
	it("does not retire an admitted newer turn from a closure that names no generation", () => {
		const h = harness("managed-missing-sequence");
		h.deliver(dispatchEvent(1));
		h.deliver(terminalEvent(1));
		h.deliver(dispatchEvent(2));
		const current = h.lifecycle.getManagedAttempt(LANE_ID);
		expect(current?.dispatch.dispatchSequence).toBe(2);

		try {
			h.deliver({ laneId: LANE_ID, phase: "lifecycle", agentLifecycle: "retired" });
		} catch {
			// Rejecting an unversioned closure is an acceptable outcome; retiring turn 2 is not.
		}

		// The closure never named turn 2, so it cannot be ownership evidence about it.
		expect(h.records().filter(isRetainedWorkerLane)).toHaveLength(1);
		expect(h.records()[0]?.agentStatus).not.toBe("retired");
		expect(h.lifecycle.getManagedAttempt(LANE_ID)?.dispatch.dispatchSequence).toBe(2);
	});

	it("negative control: a closure that names the current generation retires it", () => {
		const h = harness("managed-explicit-sequence");
		h.deliver(dispatchEvent(1));
		h.deliver(terminalEvent(1));

		h.deliver({ laneId: LANE_ID, phase: "lifecycle", dispatchSequence: 1, agentLifecycle: "retired" });

		expect(h.records()[0]?.agentStatus).toBe("retired");
		expect(h.records().filter(isRetainedWorkerLane)).toHaveLength(0);
		// The retirement is about the process; the turn keeps its result and accounting.
		expect(h.records()[0]?.status).toBe("succeeded");
		expect(h.parentTerminals).toHaveLength(1);
	});

	it("negative control: a turn-0 closure for a lane with no admitted turn settles without durable effect", () => {
		const h = harness("managed-no-turn");

		// The exact producer shape for a lane that closed before any turn was dispatched: no sequence,
		// because there is no generation to name. It must settle, not retry and not invent one.
		const outcome = h.deliver({ laneId: LANE_ID, phase: "lifecycle", agentLifecycle: "retired" });

		expect(outcome).toBeUndefined();
		expect(h.records()).toHaveLength(0);
		expect(h.claims).toHaveLength(0);
	});

	it("negative control: a retired generation cannot be declared retained again", () => {
		const h = harness("managed-revive");
		h.deliver(dispatchEvent(1));
		h.deliver(terminalEvent(1));
		h.deliver({ laneId: LANE_ID, phase: "lifecycle", dispatchSequence: 1, agentLifecycle: "retired" });
		const attemptId = h.lifecycle.getManagedAttempt(LANE_ID)?.attemptId ?? "";

		expect(() =>
			h.lifecycle.ledger.runtime.recordManagedLifetime(attemptId, {
				logicalLaneId: LANE_ID,
				dispatchSequence: 1,
				lifetime: "retained",
			}),
		).toThrow(/retired/);
		expect(h.records()[0]?.agentStatus).toBe("retired");
	});

	it("negative control: the durable runtime rejects a malformed generation statement", () => {
		const h = harness("managed-malformed");
		h.deliver(dispatchEvent(1));
		const attemptId = h.lifecycle.getManagedAttempt(LANE_ID)?.attemptId ?? "";

		expect(() =>
			h.lifecycle.ledger.runtime.recordManagedLifetime(attemptId, {
				logicalLaneId: LANE_ID,
				dispatchSequence: 2,
				lifetime: "retired",
			}),
		).toThrow(/sequence/);
		expect(() =>
			h.lifecycle.ledger.runtime.recordManagedLifetime(attemptId, {
				logicalLaneId: "collaboration:team:other",
				dispatchSequence: 1,
				lifetime: "retired",
			}),
		).toThrow(/managed lane/i);
		expect(h.records()[0]?.agentStatus).not.toBe("retired");
	});
});
