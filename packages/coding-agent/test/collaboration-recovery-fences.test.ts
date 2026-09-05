import { expect, it, vi } from "vitest";
import type { CollaborationAgent, CollaborationBackend } from "../src/core/collaboration/backend.ts";
import type { CollaborationJob, CollaborationJobStore } from "../src/core/collaboration/job-store.ts";
import { reconcileCollaborationSessions } from "../src/core/collaboration/session-recovery.ts";

function fixture(count = 1) {
	const jobs = Array.from({ length: count }, (_, index) => ({
		id: `job-${index}`,
		createdAt: 1,
		sessionName: `session-${index}`,
		dismissed: false,
		agents: [
			{
				id: "agent",
				turnId: "original-turn",
				backendName: "owned",
				paneId: "pane",
				terminalId: "terminal",
				provider: "pi",
				closed: false,
			},
		],
	})) as unknown as CollaborationJob[];
	const store = {
		list: () => jobs,
		load: (id: string) => jobs.find((job) => job.id === id)!,
	} as unknown as CollaborationJobStore;
	const pending = jobs.map(() => Promise.withResolvers<CollaborationAgent[]>());
	let active = 0;
	let maximum = 0;
	const backend = vi.fn(async (session: string, _create?: boolean) => {
		const index = jobs.findIndex((job) => job.sessionName === session);
		active++;
		maximum = Math.max(maximum, active);
		return {
			listAgents: () =>
				pending[index]!.promise.finally(() => {
					active--;
				}),
		} as unknown as CollaborationBackend;
	});
	const publish = vi.fn();
	const native = [{ name: "owned", paneId: "pane", terminalId: "terminal", kind: "pi" }] as CollaborationAgent[];
	return { jobs, store, pending, backend, publish, native, maximum: () => maximum };
}

it("restores at most four sessions concurrently and never requests session creation", async () => {
	const f = fixture(9);
	const restored = reconcileCollaborationSessions(f.store, f.backend, f.publish, () => true);
	expect(f.backend).toHaveBeenCalledTimes(4);
	for (const gate of f.pending.slice(0, 4)) gate.resolve(f.native);
	await vi.waitFor(() => expect(f.backend).toHaveBeenCalledTimes(8));
	for (const gate of f.pending.slice(4, 8)) gate.resolve(f.native);
	await vi.waitFor(() => expect(f.backend).toHaveBeenCalledTimes(9));
	f.pending[8]!.resolve(f.native);
	await restored;
	expect(f.maximum()).toBe(4);
	expect(f.backend.mock.calls.every(([, create]) => create === false)).toBe(true);
	expect(f.publish).toHaveBeenCalledTimes(9);
	expect(f.publish.mock.calls.every(([, , error]) => error === undefined)).toBe(true);
});

it("does not publish an old binding's pending result or begin its queued probes", async () => {
	const f = fixture(5);
	let current = true;
	const restored = reconcileCollaborationSessions(f.store, f.backend, f.publish, () => current);
	current = false;
	for (const gate of f.pending.slice(0, 4)) gate.reject(new Error("old server disconnected"));
	await restored;
	expect(f.backend).toHaveBeenCalledTimes(4);
	expect(f.publish).not.toHaveBeenCalled();
});

it("discards a probe after a successor turn changes its saved identity", async () => {
	const f = fixture();
	const restored = reconcileCollaborationSessions(f.store, f.backend, f.publish, () => true);
	f.jobs[0]!.agents[0]!.turnId = "successor-turn";
	f.pending[0]!.reject(new Error("stale result"));
	await restored;
	expect(f.publish).not.toHaveBeenCalled();
});

it("publishes the same failure when its binding and saved turn remain unchanged", async () => {
	const f = fixture();
	const restored = reconcileCollaborationSessions(f.store, f.backend, f.publish, () => true);
	f.pending[0]!.reject(new Error("current server disconnected"));
	await restored;
	expect(f.publish).toHaveBeenCalledExactlyOnceWith(
		"job-0",
		expect.any(String),
		expect.stringContaining("current server disconnected"),
	);
});
