import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import { ManagedLaneController } from "../src/core/delegation/managed-lane-controller.ts";
import type { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";

describe("managed lane release", () => {
	it("releases every reload blocker even when one deregistration throws", () => {
		const warn = vi.fn();
		const controller = new ManagedLaneController(
			{
				isDisposed: () => true,
				getAgentDir: () => "/unused",
				getCwd: () => "/unused",
				getSessionManager: () => undefined as unknown as SessionManager,
				getGoalStateSnapshot: () => undefined,
				getCapabilityEnvelope: () => undefined,
				saveWorkerClaimSnapshot: () => "unused",
			},
			{} as WorkerLifecycle,
			() => undefined,
			warn,
		);
		const first = vi.fn(() => {
			throw new Error("first reload blocker failed");
		});
		const second = vi.fn();
		const internals = controller as unknown as { deregisterByLane: Map<string, () => void> };
		internals.deregisterByLane.set("lane-first", first);
		internals.deregisterByLane.set("lane-second", second);

		expect(() => controller.release()).not.toThrow();
		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("lane-first"));

		controller.release();
		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
	});
});
