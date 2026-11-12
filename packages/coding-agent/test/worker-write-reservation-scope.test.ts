import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workerMachinePathRoots } from "../src/core/delegation/worker-machine-scope.ts";
import {
	WorkerWriteReservationScopeError,
	WorkerWriteReservationStore,
} from "../src/core/delegation/worker-write-reservation.ts";
import { WorkerWriteReservationCoordinator } from "../src/core/delegation/worker-write-reservation-coordinator.ts";

const executionRoot = path.resolve(tmpdir(), "pi-worker-scope-workspace");
const outsideRoot = path.resolve(tmpdir(), "pi-worker-scope-outside");

function reservationCoordinator(): WorkerWriteReservationCoordinator {
	return new WorkerWriteReservationCoordinator({
		agentDir: path.resolve(tmpdir(), "pi-worker-scope-agent"),
		getCwd: () => executionRoot,
		getParentSessionId: () => "session-1",
		ownerId: "owner-1",
		drainQueuedWorkers: () => undefined,
		warn: () => undefined,
	});
}

describe("worker write reservation scope admission", () => {
	it("refuses explicit write scopes outside the execution workspace before dispatch", () => {
		const result = reservationCoordinator().validateAdmission({
			ok: true as const,
			executionPlan: {
				cwd: executionRoot,
				writeEnabled: true,
				writePaths: [executionRoot, outsideRoot],
				writeReservationPaths: [outsideRoot],
			},
		});

		expect(result).toEqual({
			ok: false,
			skipReason: "write_reservation_scope_invalid:Write reservation scopes must be within the execution root.",
		});
	});

	it("allows workspace scopes and preserves machine-wide unreserved plans", () => {
		const coordinator = reservationCoordinator();
		const workspace = coordinator.validateAdmission({
			ok: true as const,
			executionPlan: {
				cwd: executionRoot,
				writeEnabled: true,
				writePaths: [executionRoot, path.join(executionRoot, "output")],
				writeReservationPaths: [path.join(executionRoot, "output")],
			},
		});
		const machineRoots = workerMachinePathRoots(executionRoot);
		const machineWide = coordinator.validateAdmission({
			ok: true as const,
			executionPlan: {
				cwd: executionRoot,
				writeEnabled: true,
				writePaths: machineRoots,
				writeReservationPaths: machineRoots,
			},
		});

		expect(workspace.ok).toBe(true);
		expect(machineWide.ok).toBe(true);
	});

	it("uses the store's write-path fallback and ignores disabled write scopes", () => {
		const coordinator = reservationCoordinator();
		const fallback = coordinator.validateAdmission({
			ok: true as const,
			executionPlan: {
				cwd: executionRoot,
				writeEnabled: true,
				writePaths: [outsideRoot],
			},
		});
		const disabled = coordinator.validateAdmission({
			ok: true as const,
			executionPlan: {
				cwd: executionRoot,
				writeEnabled: false,
				writePaths: [outsideRoot],
				writeReservationPaths: [outsideRoot],
			},
		});

		expect(fallback.ok).toBe(false);
		expect(disabled.ok).toBe(true);
	});

	it("keeps the durable reservation store's scope defense in depth", () => {
		const store = new WorkerWriteReservationStore({ agentDir: path.resolve(tmpdir(), "pi-worker-scope-agent") });

		expect(() =>
			store.acquire({
				parentSessionId: "session-1",
				ownerId: "owner-1",
				taskId: "worker-1",
				attemptId: "attempt-1",
				fencingToken: 1,
				access: "write",
				workspace: { repositoryRoot: executionRoot, executionRoot },
				writeScopes: [outsideRoot],
			}),
		).toThrow(WorkerWriteReservationScopeError);
	});
});
