/**
 * Scheduler-owned lane observation.
 *
 * `WorkerDispatchScheduler` is the single owner of queue/promise transitions, and `observeLane` is
 * the port a caller (today `WorkerDelegationController.runOnce` for a reused turn) awaits instead of
 * running queued work itself. These cases drive the real scheduler through its own constructor
 * options -- its documented seam -- plus the real controller entrance where the behaviour is
 * reachable there, and assert what an observer is TOLD versus what actually happened.
 *
 * Current behaviour these pin (draft baseline):
 * - a preflight rejection settles observers with `cancelled` even when the durable cancellation
 *   failed and the lane is still queued and executable;
 * - disposal does the same when the durable cancellation throws;
 * - the start callback fires before `options.run`, so it announces a start that a synchronously
 *   failing run never made, and it carries the pre-start queued record;
 * - an observer that registers while the lane is already running never receives the start callback.
 *
 * Every wait is an event or an explicit transition; there are no readiness sleeps.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerDelegationRunOutcome } from "../src/core/agent-session-contracts.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import {
	type WorkerDispatchAdmission,
	WorkerDispatchScheduler,
	type WorkerDispatchSchedulerOptions,
} from "../src/core/delegation/worker-dispatch-scheduler.ts";
import { createReuseHarness } from "./fixtures/specialist-reuse-harness.ts";

const roots: string[] = [];
/** Schedulers built by this suite; each one is released before its scratch directory is removed. */
const liveSchedulers: Array<{ dispose(): void }> = [];

afterEach(() => {
	while (liveSchedulers.length > 0) {
		const scheduler = liveSchedulers.pop();
		try {
			scheduler?.dispose();
		} catch {
			// Teardown must reach every scratch directory even when a release throws.
		}
	}
	while (roots.length > 0) {
		const directory = roots.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

function scratchAgentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-dispatch-observation-"));
	roots.push(directory);
	return directory;
}

function laneRecord(laneId: string, status: LaneRecord["status"] = "queued"): LaneRecord {
	return { laneId, type: "worker", status, agentId: laneId };
}

const REQUEST: WorkerDelegationRequest = { instructions: "observed lane work" };

interface Harness {
	scheduler: WorkerDispatchScheduler;
	records: Map<string, LaneRecord>;
	admissions: Map<string, WorkerDispatchAdmission>;
	cancelled: Array<{ laneId: string; reasonCode: string }>;
	runs: string[];
	warnings: string[];
	/** Resolve a lane's run; the scheduler tracks whatever this returns. */
	settleRun(laneId: string, outcome: WorkerDelegationRunOutcome): void;
	failRun(laneId: string, error: Error): void;
	disposed: { value: boolean };
}

/**
 * The real scheduler over deterministic host callbacks. Runs are promises this harness settles, so
 * every transition is explicit; preflight and cancellation behaviour are injected per lane.
 */
function schedulerHarness(
	overrides: Partial<Pick<WorkerDispatchSchedulerOptions, "preflight" | "cancel" | "run">> = {},
): Harness {
	const records = new Map<string, LaneRecord>();
	const admissions = new Map<string, WorkerDispatchAdmission>();
	const cancelled: Array<{ laneId: string; reasonCode: string }> = [];
	const runs: string[] = [];
	const warnings: string[] = [];
	const pending = new Map<
		string,
		{ resolve(outcome: WorkerDelegationRunOutcome): void; reject(error: Error): void }
	>();
	const disposed = { value: false };
	// Injected cancellation may be failing on purpose; teardown always uses a succeeding one so the
	// queue entries and their reload-gate registrations are released whatever the test asserted.
	let cleanupMode = false;
	const scheduler = new WorkerDispatchScheduler({
		agentDir: scratchAgentDir(),
		isDisposed: () => disposed.value,
		admit: (_request, record) => admissions.get(record.laneId) ?? { action: "start" },
		getRecord: (laneId) => records.get(laneId),
		run:
			overrides.run ??
			((_request, record) => {
				runs.push(record.laneId);
				// The durable lifecycle moves to running as part of starting: a later read of the lane
				// sees the started record, which is what an observer must be told about.
				records.set(record.laneId, laneRecord(record.laneId, "running"));
				return new Promise<WorkerDelegationRunOutcome>((resolve, reject) => {
					pending.set(record.laneId, { resolve, reject });
				});
			}),
		cancel: (laneId, reasonCode) => {
			cancelled.push({ laneId, reasonCode });
			if (cleanupMode || !overrides.cancel) return;
			overrides.cancel(laneId, reasonCode);
		},
		warn: (message) => {
			warnings.push(message);
		},
		...(overrides.preflight ? { preflight: overrides.preflight } : {}),
	});
	liveSchedulers.push({
		dispose: () => {
			cleanupMode = true;
			disposed.value = false;
			scheduler.cancelQueued();
			disposed.value = true;
		},
	});
	return {
		scheduler,
		records,
		admissions,
		cancelled,
		runs,
		warnings,
		disposed,
		settleRun: (laneId, outcome) => {
			const settle = pending.get(laneId);
			if (!settle) throw new Error(`lane ${laneId} is not running`);
			pending.delete(laneId);
			settle.resolve(outcome);
		},
		failRun: (laneId, error) => {
			const settle = pending.get(laneId);
			if (!settle) throw new Error(`lane ${laneId} is not running`);
			pending.delete(laneId);
			settle.reject(error);
		},
	};
}

/** Let queued microtasks settle; every transition under test is event-driven, never timed. */
async function flush(rounds = 8): Promise<void> {
	for (let round = 0; round < rounds; round++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("worker dispatch lane observation", () => {
	it("waits while a failed durable cancellation leaves the lane owned, then settles once it succeeds", async () => {
		let cancellationFails = true;
		const harness = schedulerHarness({
			preflight: async () => ({ action: "cancel", reasonCode: "worker_directory_unavailable" }),
			cancel: () => {
				// The durable cancellation is what actually ends a lane; while it fails the queue entry
				// is deliberately retained so a later drain can retry it.
				if (cancellationFails) throw new Error("durable cancellation failed");
			},
		});
		const record = laneRecord("lane-preflight");
		harness.records.set(record.laneId, record);
		harness.scheduler.enqueue(record, REQUEST);
		const observed = harness.scheduler.observeLane(record.laneId);

		harness.scheduler.drain();
		await flush();

		// Still owned and still executable: "cancelled" would be a false terminal answer right now.
		expect(harness.scheduler.ownsLane(record.laneId)).toBe(true);
		expect(await Promise.race([observed, Promise.resolve("pending" as const)])).toBe("pending");

		// The durable write recovers and the next scheduler signal retries it.
		cancellationFails = false;
		harness.scheduler.drain();
		await flush();

		await expect(observed).resolves.toEqual({
			state: "cancelled",
			reasonCode: "worker_directory_unavailable",
		});
		expect(harness.runs).toEqual([]);
		expect(harness.scheduler.ownsLane(record.laneId)).toBe(false);
	});

	it("settles a truthful failure when disposal's durable cancellation fails", async () => {
		const disposalError = new Error("durable cancellation failed during disposal");
		const harness = schedulerHarness({
			cancel: () => {
				throw disposalError;
			},
		});
		const record = laneRecord("lane-disposed");
		harness.records.set(record.laneId, record);
		harness.scheduler.enqueue(record, REQUEST);
		const observed = harness.scheduler.observeLane(record.laneId);

		harness.disposed.value = true;
		harness.scheduler.cancelQueued();
		await flush();

		// Disposal did not cancel this lane, and this generation will never signal again: the observer
		// must be told the truth -- a failure carrying the durable error -- rather than a false
		// cancellation or an answer that never arrives.
		const settled = await Promise.race([
			observed,
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
		]);
		expect(settled).not.toBe("pending");
		expect(settled).not.toEqual({ state: "cancelled", reasonCode: "session_disposed" });
		expect(settled).toMatchObject({ state: "failed", error: disposalError });
	});

	it("negative control: a dropped queue entry settles as cancelled exactly once", async () => {
		const harness = schedulerHarness();
		const record = laneRecord("lane-dropped");
		harness.records.set(record.laneId, record);
		harness.scheduler.enqueue(record, REQUEST);
		const observed = harness.scheduler.observeLane(record.laneId);

		expect(harness.scheduler.dropQueued(record.laneId)).toBe(true);

		await expect(observed).resolves.toEqual({ state: "cancelled", reasonCode: "worker_dispatch_dropped" });
		expect(harness.runs).toEqual([]);
	});

	it("does not announce a start for a run that never began", async () => {
		const started: LaneRecord[] = [];
		const harness = schedulerHarness({
			run: () => {
				throw new Error("synchronous start admission failed");
			},
		});
		const record = laneRecord("lane-failed-start");
		harness.records.set(record.laneId, record);
		harness.scheduler.enqueue(record, REQUEST);
		const observed = harness.scheduler.observeLane(record.laneId, {
			onStarted: (startedRecord) => {
				started.push(startedRecord);
			},
		});

		harness.scheduler.drain();
		await flush();

		// The run threw before doing anything; nothing started, so nothing may be announced as started.
		expect(started).toEqual([]);
		const settled = await observed;
		expect(settled.state).toBe("failed");
	});

	it("announces the started record to an observer that arrives after the lane is already running", async () => {
		const harness = schedulerHarness();
		const record = laneRecord("lane-late-observer");
		harness.records.set(record.laneId, record);
		harness.scheduler.enqueue(record, REQUEST);

		harness.scheduler.drain();
		await flush();
		expect(harness.runs).toEqual([record.laneId]);
		// The lane is running before this observer exists, exactly like a caller that awaits an
		// acceptance the coordinator already dispatched.
		const started: LaneRecord[] = [];
		const observed = harness.scheduler.observeLane(record.laneId, {
			onStarted: (startedRecord) => {
				started.push(startedRecord);
			},
		});

		harness.settleRun(record.laneId, { started: true, record: laneRecord(record.laneId, "succeeded") });
		await flush();

		// One start callback, carrying the record that actually started -- an observer that arrives
		// late still learns the lane started, and learns it as the started record.
		expect(started).toHaveLength(1);
		expect(started[0]?.laneId).toBe(record.laneId);
		expect(started[0]?.status).toBe("running");
		await expect(observed).resolves.toMatchObject({ state: "ran" });
	});

	it("announces a start exactly once for one dispatched lane", async () => {
		const harness = schedulerHarness();
		const record = laneRecord("lane-once");
		harness.records.set(record.laneId, record);
		harness.scheduler.enqueue(record, REQUEST);
		const started: LaneRecord[] = [];
		const observed = harness.scheduler.observeLane(record.laneId, {
			onStarted: (startedRecord) => {
				started.push(startedRecord);
			},
		});

		harness.scheduler.drain();
		harness.scheduler.drain();
		await flush();
		harness.settleRun(record.laneId, { started: true, record: laneRecord(record.laneId, "succeeded") });
		await flush();

		expect(harness.runs).toEqual([record.laneId]);
		expect(started).toHaveLength(1);
		// The announced record is the one the scheduler actually dispatched, not a stale queue entry.
		expect(started[0]?.status).toBe("running");
		await expect(observed).resolves.toMatchObject({ state: "ran" });
	});

	it("binds an observer registered after deferred acceptance to the resumed run", async () => {
		const harness = schedulerHarness();
		const record = laneRecord("lane-deferred-observer");
		harness.records.set(record.laneId, record);
		harness.scheduler.enqueue(record, { instructions: "first run" });
		harness.scheduler.drain();

		// A reused turn is accepted in the narrow interval where the specialist has released its
		// resources but the prior scheduler promise has not unwound yet.
		harness.scheduler.enqueue(record, { instructions: "resumed run" });
		const started: LaneRecord[] = [];
		const observed = harness.scheduler.observeLane(record.laneId, {
			onStarted: (startedRecord) => started.push(startedRecord),
		});
		expect(started).toEqual([]);
		harness.settleRun(record.laneId, {
			started: true,
			record: { ...laneRecord(record.laneId, "succeeded"), reasonCode: "prior_run" },
		});
		await flush();

		expect(harness.runs).toEqual([record.laneId, record.laneId]);
		expect(started).toHaveLength(1);
		expect(await Promise.race([observed, Promise.resolve("pending" as const)])).toBe("pending");

		harness.settleRun(record.laneId, {
			started: true,
			record: { ...laneRecord(record.laneId, "succeeded"), reasonCode: "resumed_run" },
		});
		await expect(observed).resolves.toMatchObject({
			state: "ran",
			outcome: { record: { reasonCode: "resumed_run" } },
		});
	});

	it("settles only the deferred observer when that resume is explicitly dropped", async () => {
		const harness = schedulerHarness();
		const record = laneRecord("lane-dropped-deferred-observer");
		harness.records.set(record.laneId, record);
		harness.scheduler.enqueue(record, { instructions: "first run" });
		harness.scheduler.drain();
		harness.scheduler.enqueue(record, { instructions: "resumed run" });
		const observed = harness.scheduler.observeLane(record.laneId);

		expect(harness.scheduler.dropQueued(record.laneId)).toBe(true);
		await expect(observed).resolves.toEqual({ state: "cancelled", reasonCode: "worker_dispatch_dropped" });

		// The prior run remains independently owned and can still settle normally.
		harness.settleRun(record.laneId, {
			started: true,
			record: { ...laneRecord(record.laneId, "succeeded"), reasonCode: "prior_run" },
		});
		await flush();
		expect(harness.runs).toEqual([record.laneId]);
	});

	it("negative control: a waiting admission keeps the lane queued and settles nothing", async () => {
		const harness = schedulerHarness();
		const record = laneRecord("lane-waiting");
		harness.records.set(record.laneId, record);
		harness.admissions.set(record.laneId, { action: "wait", reason: "dependencies" });
		harness.scheduler.enqueue(record, REQUEST);
		const observed = harness.scheduler.observeLane(record.laneId);

		harness.scheduler.drain();
		await flush();

		expect(harness.runs).toEqual([]);
		expect(harness.scheduler.getWaitState(record.laneId)?.reason).toBe("dependencies");
		const settled = await Promise.race([observed, Promise.resolve("pending" as const)]);
		expect(settled).toBe("pending");
	});

	it("negative control: capacity and dependency gates release into exactly one dispatch", async () => {
		const harness = schedulerHarness();
		const record = laneRecord("lane-gated");
		harness.records.set(record.laneId, record);
		harness.admissions.set(record.laneId, { action: "wait", reason: "capacity" });
		harness.scheduler.enqueue(record, REQUEST);
		const observed = harness.scheduler.observeLane(record.laneId);
		harness.scheduler.drain();
		await flush();
		expect(harness.runs).toEqual([]);

		harness.admissions.set(record.laneId, { action: "start" });
		harness.scheduler.drain();
		harness.scheduler.drain();
		await flush();
		harness.settleRun(record.laneId, { started: true, record: laneRecord(record.laneId, "succeeded") });

		await expect(observed).resolves.toMatchObject({ state: "ran" });
		expect(harness.runs).toEqual([record.laneId]);
	});

	it("negative control: a rejected run settles truthfully and is not reported as a completion", async () => {
		const harness = schedulerHarness();
		const record = laneRecord("lane-rejected");
		harness.records.set(record.laneId, record);
		harness.scheduler.enqueue(record, REQUEST);
		const observed = harness.scheduler.observeLane(record.laneId);

		harness.scheduler.drain();
		await flush();
		harness.failRun(record.laneId, new Error("worker exploded"));
		await flush();

		const settled = await observed;
		expect(settled.state).toBe("failed");
		expect(harness.cancelled.map((entry) => entry.reasonCode)).toContain("worker_background_error");
	});

	it("negative control: a lane this scheduler never owned settles as unowned, not as completed", async () => {
		const harness = schedulerHarness();

		const settled = await harness.scheduler.observeLane("lane-unknown");

		expect(settled).toEqual({ state: "unowned" });
	});

	it("negative control: an admission cancellation settles once with its own reason", async () => {
		const harness = schedulerHarness();
		const record = laneRecord("lane-admission-cancel");
		harness.records.set(record.laneId, record);
		harness.admissions.set(record.laneId, { action: "cancel", reasonCode: "goal_dependency_unsatisfied" });
		harness.scheduler.enqueue(record, REQUEST);
		const observed = harness.scheduler.observeLane(record.laneId);

		harness.scheduler.drain();
		await flush();

		await expect(observed).resolves.toEqual({
			state: "cancelled",
			reasonCode: "goal_dependency_unsatisfied",
		});
		expect(harness.cancelled).toEqual([{ laneId: record.laneId, reasonCode: "goal_dependency_unsatisfied" }]);
		expect(harness.runs).toEqual([]);
	});

	it("holds a reused runOnce behind a real dependency and preserves its context on release", async () => {
		const context = await createReuseHarness({ settings: { workerDelegation: { maxConcurrent: 2 } } });
		context.appendWorkerReply("mapped the retry ladder");
		const blocker = context.appendWorkerHold("held the dependency lane");
		context.appendWorkerReply("continued on the same specialist");
		try {
			// One specialist with real history, then a DIFFERENT specialization whose lane is genuinely
			// running: that lane is the dependency the reused turn must wait for.
			const first = await context.harness.session.runWorkerDelegationOnce({
				instructions: "Map the retry ladder",
			});
			expect(first.record?.status).toBe("succeeded");
			const dependency = context.harness.session.runWorkerDelegationOnce({
				instructions: "Hold the dependency lane",
				authority: { readOnly: true },
			});
			await blocker.entered;
			const dependencyLaneId = context.laneRecords().find((record) => record.status === "running")?.laneId;
			expect(dependencyLaneId).toBeDefined();
			const requestsBeforeRelease = context.workerRequests().length;

			// The reused turn depends on that still-running task; runOnce must not execute it yet.
			const reused = context.harness.session.runWorkerDelegationOnce({
				instructions: "Continue on the same specialist",
				taskContext: {
					requirementIds: [],
					dependsOnTaskIds: [dependencyLaneId ?? ""],
					acceptanceCriterionIds: [],
					resourcePointerIds: [],
				},
			});
			await flush();

			// Nothing ran while the dependency was unsettled: no provider request, no result.
			expect(context.workerRequests()).toHaveLength(requestsBeforeRelease);

			blocker.release();
			await dependency;
			await context.settleLanes();
			const outcome = await reused;

			// Released through the scheduler's own gate, on the SAME specialist, with its own context.
			expect(outcome.record?.status).toBe("succeeded");
			expect(outcome.record?.agentId).toBe(first.record?.agentId);
			const reusedRequest = context.workerRequests().at(-1);
			expect(reusedRequest?.text).toContain("Map the retry ladder");
			expect(reusedRequest?.text).toContain("Continue on the same specialist");
		} finally {
			blocker.release();
		}
	});

	it("negative control: preflight validation runs once before the lane is dispatched", async () => {
		const preflight = vi.fn(async () => ({ action: "start" }) as const);
		const harness = schedulerHarness({ preflight });
		const record = laneRecord("lane-preflight-ok");
		harness.records.set(record.laneId, record);
		harness.scheduler.enqueue(record, REQUEST);
		const observed = harness.scheduler.observeLane(record.laneId);

		harness.scheduler.drain();
		await flush();
		expect(preflight).toHaveBeenCalledTimes(1);
		expect(harness.runs).toEqual([record.laneId]);
		harness.settleRun(record.laneId, { started: true, record: laneRecord(record.laneId, "succeeded") });

		await expect(observed).resolves.toMatchObject({ state: "ran" });
	});
});
