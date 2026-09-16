/**
 * A managed CLI closure that could not be persisted must not be reported as published.
 *
 * `ManagedLaneController.record({ phase: "lifecycle" })` calls `WorkerLifecycle.retireManaged`,
 * which crosses the durable runtime and its event store. The coordinator that publishes the closure
 * marks it notified once the controller returns, so a swallowed persistence failure loses the
 * closure permanently: the lane stays retained on disk and nothing will ever say so again.
 *
 * The failure is injected at the existing durable boundary -- the `OrchestrationEventStore` the
 * lifecycle already accepts -- so the controller, the lifecycle and the runtime under test are the
 * real ones. Rejecting an unattributable REPORT (no generation named) is a different outcome and
 * keeps its own control here; the frozen managed-lane suite owns the missing-generation semantics
 * and is not duplicated.
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
import type { AppendOrchestrationEventInput, OrchestrationEvent } from "../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { isRetainedWorkerLane } from "../src/modes/interactive/components/agents-overlay.ts";

const LANE_ID = "collaboration:team:reviewer";
const roots: string[] = [];
/** Controllers built by this suite; each releases its in-flight lane registrations before cleanup. */
const liveControllers: ManagedLaneController[] = [];

afterEach(() => {
	while (liveControllers.length > 0) {
		try {
			liveControllers.pop()?.release();
		} catch {
			// Teardown must reach every scratch directory even when a release throws.
		}
	}
	while (roots.length > 0) {
		const directory = roots.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

/** The lifetime statement a producer publishes when a managed CLI closes. */
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

/**
 * The real durable store, with one injected failure at its append boundary. `failWhen` decides which
 * append fails; everything else is persisted exactly as production would.
 */
class FaultInjectingEventStore extends OrchestrationEventStore {
	failWhen: (input: AppendOrchestrationEventInput) => Error | undefined = () => undefined;
	readonly attempted: string[] = [];

	override append(
		input: AppendOrchestrationEventInput,
		options?: Parameters<OrchestrationEventStore["append"]>[1],
	): OrchestrationEvent {
		this.attempted.push(input.type);
		const failure = this.failWhen(input);
		if (failure) throw failure;
		return super.append(input, options);
	}
}

interface Harness {
	lifecycle: WorkerLifecycle;
	controller: ManagedLaneController;
	store: FaultInjectingEventStore;
	claims: WorkerClaim[];
	warnings: string[];
	deliver(event: LifetimeEvent | ManagedLaneEvent): LaneRecord | undefined;
	records(): LaneRecord[];
}

function harness(sessionId: string): Harness {
	const root = mkdtempSync(join(tmpdir(), "pi-managed-closure-failure-"));
	roots.push(root);
	const store = new FaultInjectingEventStore({ agentDir: root, sessionId });
	const lifecycle = new WorkerLifecycle({ agentDir: root, sessionId, store });
	const claims: WorkerClaim[] = [];
	const warnings: string[] = [];
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
		() => {},
		(message) => {
			warnings.push(message);
		},
	);
	liveControllers.push(controller);
	return {
		lifecycle,
		controller,
		store,
		claims,
		warnings,
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

describe("managed lane closure failure", () => {
	it("propagates a durable persistence failure instead of acknowledging the closure", () => {
		const h = harness("managed-closure-persistence");
		h.deliver(dispatchEvent(1));
		h.deliver(terminalEvent(1));
		h.store.failWhen = (input) =>
			input.type === "managed.lifecycle" ? new Error("durable event store is unavailable") : undefined;

		// The producer marks its closure published once this call returns; a swallowed store failure
		// therefore loses the closure forever.
		expect(() =>
			h.deliver({ laneId: LANE_ID, phase: "lifecycle", dispatchSequence: 1, agentLifecycle: "retired" }),
		).toThrow(/unavailable/);
		expect(h.store.attempted).toContain("managed.lifecycle");
		expect(h.records()[0]?.agentStatus).not.toBe("retired");
		expect(h.records().filter(isRetainedWorkerLane)).toHaveLength(1);
	});

	it("negative control: the same closure succeeds once the durable boundary recovers", () => {
		const h = harness("managed-closure-recovers");
		h.deliver(dispatchEvent(1));
		h.deliver(terminalEvent(1));
		h.store.failWhen = (input) =>
			input.type === "managed.lifecycle" ? new Error("durable event store is unavailable") : undefined;
		try {
			// However this attempt reports itself, nothing was persisted by it.
			h.deliver({ laneId: LANE_ID, phase: "lifecycle", dispatchSequence: 1, agentLifecycle: "retired" });
		} catch {
			// The durable failure is the subject of the case above; here it is only the precondition.
		}
		expect(h.records()[0]?.agentStatus).not.toBe("retired");

		h.store.failWhen = () => undefined;
		h.deliver({ laneId: LANE_ID, phase: "lifecycle", dispatchSequence: 1, agentLifecycle: "retired" });

		// The retry is the same statement about the same generation, and it is now durable.
		expect(h.records()[0]?.agentStatus).toBe("retired");
		expect(h.records()[0]?.status).toBe("succeeded");
		expect(h.records().filter(isRetainedWorkerLane)).toHaveLength(0);
	});

	it("negative control: an unattributable report is refused without touching the durable store", () => {
		const h = harness("managed-closure-unattributable");
		h.deliver(dispatchEvent(1));
		h.deliver(terminalEvent(1));
		h.deliver(dispatchEvent(2));
		const attemptedBefore = [...h.store.attempted];

		// No generation named while turn 2 is admitted: a report, not a durable failure.
		const outcome = h.deliver({ laneId: LANE_ID, phase: "lifecycle", agentLifecycle: "retired" });

		expect(outcome).toBeUndefined();
		expect(h.store.attempted).toEqual(attemptedBefore);
		expect(h.warnings.join("\n")).toMatch(/managed worker/i);
		expect(h.records()[0]?.agentStatus).not.toBe("retired");
	});

	it("negative control: a lifetime report for an unknown lane writes nothing and claims nothing", () => {
		const h = harness("managed-closure-unknown-lane");
		const attemptedBefore = [...h.store.attempted];

		const outcome = h.deliver({
			laneId: "collaboration:team:absent",
			phase: "lifecycle",
			dispatchSequence: 1,
			agentLifecycle: "retired",
		});

		expect(outcome).toBeUndefined();
		expect(h.store.attempted).toEqual(attemptedBefore);
		expect(h.claims).toHaveLength(0);
	});
});
