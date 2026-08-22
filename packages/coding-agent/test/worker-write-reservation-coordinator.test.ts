import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerWriteReservationStore } from "../src/core/delegation/worker-write-reservation.ts";
import { WorkerWriteReservationCoordinator } from "../src/core/delegation/worker-write-reservation-coordinator.ts";

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
		expect(state.coordinator.acquire("task-3", second, plan)).toEqual({ kind: "blocked" });

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
		const machineRoot = parse(resolve(state.workspace)).root;
		const machinePlan = { cwd: state.workspace, writeEnabled: true, writePaths: [machineRoot] };
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
		expect(state.coordinator.acquire("focused-2", { attemptId: "focused-attempt-2" }, focusedPlan)).toEqual({
			kind: "blocked",
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
});
