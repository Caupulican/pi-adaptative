import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerMachinePathRoots } from "../src/core/delegation/worker-machine-scope.ts";
import { WorkerWriteReservationStore } from "../src/core/delegation/worker-write-reservation.ts";
import {
	formatWorkerWriteReservationBlock,
	WorkerWriteReservationCoordinator,
} from "../src/core/delegation/worker-write-reservation-coordinator.ts";

describe("WorkerWriteReservationCoordinator", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	function fixture(overrides: { isProcessAlive?: (pid: number) => boolean } = {}) {
		const root = mkdtempSync(join(tmpdir(), "pi-worker-reservation-coordinator-"));
		tempDirs.push(root);
		const workspace = join(root, "workspace");
		const source = join(workspace, "src");
		mkdirSync(source, { recursive: true });
		const agentDir = join(root, "agent");
		const ownerId = "pi-worker:123:11111111-1111-4111-8111-111111111111";
		let drains = 0;
		const warnings: string[] = [];
		const coordinator = new WorkerWriteReservationCoordinator({
			agentDir,
			getCwd: () => workspace,
			getParentSessionId: () => "parent-1",
			ownerId,
			drainQueuedWorkers: () => {
				drains += 1;
			},
			warn: (message) => warnings.push(message),
			...overrides,
		});
		return { agentDir, coordinator, drains: () => drains, ownerId, source, warnings, workspace };
	}

	it("releases only the matching fence and wakes queued admission from the reservation owner", async () => {
		const state = fixture();
		const first = { attemptId: "attempt-1" };
		const second = { attemptId: "attempt-2" };
		const plan = { writeEnabled: true, writePaths: [state.source] };
		expect(state.coordinator.acquire("task-1", first, plan)).toEqual({ kind: "granted" });

		const competing = new WorkerWriteReservationStore({ agentDir: state.agentDir });
		expect(
			competing.acquire({
				parentSessionId: "parent-2",
				ownerId: "pi-worker:124:22222222-2222-4222-8222-222222222222",
				taskId: "task-2",
				attemptId: "attempt-2",
				fencingToken: 1,
				access: "write",
				workspace: { repositoryRoot: state.workspace, executionRoot: state.workspace },
				writeScopes: [state.source],
			}),
		).toMatchObject({ kind: "blocked" });
		expect(state.coordinator.acquire("task-3", second, plan)).toMatchObject({ kind: "blocked" });

		state.coordinator.release("task-1", second.attemptId, 1);
		expect(state.coordinator.hasFenceMismatch("task-1", first.attemptId, 1)).toBe(false);
		state.coordinator.release("task-1", first.attemptId, 1);
		await vi.waitFor(() => expect(state.drains()).toBeGreaterThan(0));
		expect(
			competing.acquire({
				parentSessionId: "parent-2",
				ownerId: "pi-worker:124:22222222-2222-4222-8222-222222222222",
				taskId: "task-2",
				attemptId: "attempt-2",
				fencingToken: 1,
				access: "write",
				workspace: { repositoryRoot: state.workspace, executionRoot: state.workspace },
				writeScopes: [state.source],
			}),
		).toMatchObject({ kind: "granted" });
		state.coordinator.dispose();
	});

	it("does not serialize machine-wide workers but still fences an explicit workspace", () => {
		const state = fixture();
		const machinePlan = {
			cwd: state.workspace,
			writeEnabled: true,
			writePaths: workerMachinePathRoots(state.workspace),
		};
		expect(state.coordinator.acquire("machine-1", { attemptId: "machine-attempt-1" }, machinePlan)).toEqual({
			kind: "granted",
		});
		expect(state.coordinator.acquire("machine-2", { attemptId: "machine-attempt-2" }, machinePlan)).toEqual({
			kind: "granted",
		});

		const focusedPlan = { cwd: state.workspace, writeEnabled: true, writePaths: [state.source] };
		expect(state.coordinator.acquire("focused-1", { attemptId: "focused-attempt-1" }, focusedPlan)).toEqual({
			kind: "granted",
		});
		expect(state.coordinator.acquire("focused-2", { attemptId: "focused-attempt-2" }, focusedPlan)).toMatchObject({
			kind: "blocked",
			detail: { reasonCode: "overlapping_write_scope", conflicts: [{ local: true, ownerLiveness: "live" }] },
		});
		state.coordinator.dispose();
	});

	it("fails closed with a typed denial before retaining an invalid write scope", () => {
		const state = fixture();
		const admission = state.coordinator.acquire(
			"task-1",
			{ attemptId: "attempt-1" },
			{ writeEnabled: true, writePaths: [join(state.workspace, "..", "outside")] },
		);
		expect(admission).toEqual({ kind: "denied", reasonCode: "write_reservation_scope_invalid" });
		expect(state.warnings).toHaveLength(1);
		expect(
			new WorkerWriteReservationStore({ agentDir: state.agentDir }).recover({
				workspace: { repositoryRoot: state.workspace, executionRoot: state.workspace },
				evidence: [],
			}).outcomes,
		).toEqual([]);
		state.coordinator.dispose();
	});

	it("reclaims only a reservation with positive dead-owner evidence", () => {
		const state = fixture({ isProcessAlive: () => false });
		const store = new WorkerWriteReservationStore({ agentDir: state.agentDir });
		expect(
			store.acquire({
				parentSessionId: "parent-older",
				ownerId: "pi-worker:124:22222222-2222-4222-8222-222222222222",
				taskId: "task-older",
				attemptId: "attempt-older",
				fencingToken: 1,
				access: "write",
				workspace: { repositoryRoot: state.workspace, executionRoot: state.workspace },
				writeScopes: [state.source],
			}),
		).toMatchObject({ kind: "granted" });

		state.coordinator.recoverProvenStale();
		expect(
			store.recover({
				workspace: { repositoryRoot: state.workspace, executionRoot: state.workspace },
				evidence: [],
			}).outcomes,
		).toEqual([]);
		state.coordinator.dispose();
	});

	function foreignReservation(
		agentDir: string,
		repositoryRoot: string,
		writeScope: string,
		overrides: { ownerId?: string; parentSessionId?: string } = {},
	) {
		const store = new WorkerWriteReservationStore({ agentDir });
		expect(
			store.acquire({
				parentSessionId: overrides.parentSessionId ?? "parent-foreign",
				ownerId: overrides.ownerId ?? "pi-worker:124:22222222-2222-4222-8222-222222222222",
				taskId: "task-foreign",
				attemptId: "attempt-foreign",
				fencingToken: 1,
				access: "write",
				workspace: { repositoryRoot, executionRoot: repositoryRoot },
				writeScopes: [writeScope],
			}),
		).toMatchObject({ kind: "granted" });
		return store;
	}

	it("reaps a dead-owner reservation on a repository outside the cwd at acquire time", () => {
		const state = fixture({ isProcessAlive: (pid) => pid !== 124 });
		const other = join(state.workspace, "..", "other-repo");
		const otherSource = join(other, "src");
		mkdirSync(otherSource, { recursive: true });
		const foreign = foreignReservation(state.agentDir, other, otherSource, { parentSessionId: "parent-dead" });

		const admission = state.coordinator.acquire(
			"task-1",
			{ attemptId: "attempt-1" },
			{ cwd: other, writeEnabled: true, writePaths: [otherSource] },
		);
		expect(admission).toEqual({ kind: "granted" });
		expect(state.warnings).toEqual([
			expect.stringMatching(
				/^Released stale worker write reservation .* \(session parent-dead, created .*\) is dead\.$/,
			),
		]);
		expect(
			foreign
				.recover({ workspace: { repositoryRoot: other, executionRoot: other }, evidence: [] })
				.outcomes.map((outcome) => outcome.lease.taskId),
		).toEqual(["task-1"]);
		state.coordinator.dispose();
	});

	it("keeps a live foreign reservation in place and explains the block", () => {
		const state = fixture({ isProcessAlive: () => true });
		foreignReservation(state.agentDir, state.workspace, state.source, { parentSessionId: "parent-live" });

		const admission = state.coordinator.acquire(
			"task-1",
			{ attemptId: "attempt-1" },
			{ writeEnabled: true, writePaths: [state.source] },
		);
		expect(admission).toMatchObject({
			kind: "blocked",
			detail: {
				reasonCode: "overlapping_write_scope",
				reapedReservationIds: [],
				conflicts: [
					{
						ownerId: "pi-worker:124:22222222-2222-4222-8222-222222222222",
						parentSessionId: "parent-live",
						ownerLiveness: "live",
						local: false,
					},
				],
			},
		});
		if (admission.kind !== "blocked" || !admission.detail) throw new Error("expected a described block");
		expect(formatWorkerWriteReservationBlock(admission.detail)).toContain("held by session parent-live");
		expect(state.warnings).toEqual([]);
		state.coordinator.dispose();
	});

	it("never releases a reservation whose owner liveness is unknown", () => {
		const state = fixture({
			isProcessAlive: () => {
				throw new Error("probe unavailable");
			},
		});
		foreignReservation(state.agentDir, state.workspace, state.source);
		const admission = state.coordinator.acquire(
			"task-1",
			{ attemptId: "attempt-1" },
			{ writeEnabled: true, writePaths: [state.source] },
		);
		expect(admission).toMatchObject({
			kind: "blocked",
			detail: { reapedReservationIds: [], conflicts: [{ ownerLiveness: "unknown" }] },
		});
		state.coordinator.dispose();
	});

	it("recovers stale reservations on every persisted repository, not only the host cwd", () => {
		const state = fixture({ isProcessAlive: () => false });
		const other = join(state.workspace, "..", "other-repo");
		const otherSource = join(other, "src");
		mkdirSync(otherSource, { recursive: true });
		const foreign = foreignReservation(state.agentDir, other, otherSource);

		state.coordinator.recoverProvenStale();
		expect(
			foreign.recover({ workspace: { repositoryRoot: other, executionRoot: other }, evidence: [] }).outcomes,
		).toEqual([]);
		state.coordinator.dispose();
	});
});
