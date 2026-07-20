import { describe, expect, it } from "vitest";
import type { ProcessMatrixEntry } from "../src/core/process-matrix/codes.ts";
import {
	applyAdoption,
	applyHeartbeat,
	beginWindDown,
	buildMasterEntry,
	buildWorkerEntry,
	detectOrphanedWorkers,
	markClosed,
	markResumable,
	pollWorkerDirective,
	reconcileMatrix,
} from "../src/core/process-matrix/supervisor.ts";

const NOW = "2026-07-19T00:00:00.000Z";

function worker(overrides: Partial<ProcessMatrixEntry> = {}): ProcessMatrixEntry {
	return {
		entryId: "worker-w1",
		role: "worker",
		pid: 200,
		sessionId: "w1",
		hostname: "host-a",
		startedAt: NOW,
		heartbeatAt: NOW,
		status: "running",
		parentPid: 100,
		...overrides,
	};
}

function alwaysAlive(): boolean {
	return true;
}

function neverAlive(): boolean {
	return false;
}

describe("process-matrix supervisor (pure)", () => {
	describe("buildMasterEntry / buildWorkerEntry", () => {
		it("buildMasterEntry produces a running entry keyed master-<sessionId>", () => {
			const entry = buildMasterEntry({ sessionId: "m1", pid: 100, hostname: "host-a", now: NOW });
			expect(entry).toEqual({
				entryId: "master-m1",
				role: "master",
				pid: 100,
				sessionId: "m1",
				hostname: "host-a",
				startedAt: NOW,
				heartbeatAt: NOW,
				status: "running",
			});
		});

		it("buildWorkerEntry produces a running entry keyed worker-<sessionId>, omitting unset optionals", () => {
			const entry = buildWorkerEntry({
				sessionId: "w1",
				pid: 200,
				hostname: "host-a",
				now: NOW,
				parentPid: 100,
			});
			expect(entry).toEqual({
				entryId: "worker-w1",
				role: "worker",
				pid: 200,
				sessionId: "w1",
				hostname: "host-a",
				startedAt: NOW,
				heartbeatAt: NOW,
				status: "running",
				parentPid: 100,
			});
			expect(entry).not.toHaveProperty("laneKey");
			expect(entry).not.toHaveProperty("parentSessionId");
		});

		it("buildWorkerEntry carries through optional identity fields when provided", () => {
			const entry = buildWorkerEntry({
				sessionId: "w1",
				pid: 200,
				hostname: "host-a",
				now: NOW,
				parentPid: 100,
				parentSessionId: "m1",
				laneKey: "adhoc-1",
				tmuxSession: "pi-job-1",
				tmuxPanePid: 300,
				taskRef: "goal-1",
			});
			expect(entry.parentSessionId).toBe("m1");
			expect(entry.laneKey).toBe("adhoc-1");
			expect(entry.tmuxSession).toBe("pi-job-1");
			expect(entry.tmuxPanePid).toBe(300);
			expect(entry.taskRef).toBe("goal-1");
		});
	});

	it("applyHeartbeat only updates heartbeatAt", () => {
		const entry = buildMasterEntry({ sessionId: "m1", pid: 100, hostname: "host-a", now: NOW });
		const later = "2026-07-19T00:00:30.000Z";
		expect(applyHeartbeat(entry, later)).toEqual({ ...entry, heartbeatAt: later });
	});

	describe("detectOrphanedWorkers", () => {
		it("flags a worker whose parentPid is dead", () => {
			const entries = [worker({ parentPid: 999 })];
			expect(detectOrphanedWorkers(entries, { isPidAlive: neverAlive })).toEqual(entries);
		});

		it("does not flag a worker whose parentPid is alive", () => {
			const entries = [worker({ parentPid: 999 })];
			expect(detectOrphanedWorkers(entries, { isPidAlive: alwaysAlive })).toEqual([]);
		});

		it("never flags a master entry, regardless of liveness", () => {
			const entries = [buildMasterEntry({ sessionId: "m1", pid: 100, hostname: "host-a", now: NOW })];
			expect(detectOrphanedWorkers(entries, { isPidAlive: neverAlive })).toEqual([]);
		});

		it("excludes this session's own entry even if it would otherwise match", () => {
			const entries = [worker({ sessionId: "self", entryId: "worker-self", parentPid: 999 })];
			expect(detectOrphanedWorkers(entries, { isPidAlive: neverAlive, ownSessionId: "self" })).toEqual([]);
		});

		it("excludes an already-closed worker", () => {
			const entries = [worker({ status: "closed", parentPid: 999 })];
			expect(detectOrphanedWorkers(entries, { isPidAlive: neverAlive })).toEqual([]);
		});

		it("excludes a worker with no recorded parentPid", () => {
			const entries = [worker({ parentPid: undefined })];
			expect(detectOrphanedWorkers(entries, { isPidAlive: neverAlive })).toEqual([]);
		});
	});

	it("beginWindDown sets status/reason/heartbeat", () => {
		const entry = worker();
		const result = beginWindDown(entry, "parent_lost", "2026-07-19T00:01:00.000Z");
		expect(result).toEqual({
			...entry,
			status: "winding_down",
			windDownReason: "parent_lost",
			heartbeatAt: "2026-07-19T00:01:00.000Z",
		});
	});

	it("markResumable attaches the payload and sets status/heartbeat", () => {
		const entry = beginWindDown(worker(), "parent_lost", "2026-07-19T00:01:00.000Z");
		const payload = { laneKey: "adhoc-1", lastCode: "resumable" as const };
		const result = markResumable(entry, payload, "2026-07-19T00:01:00.000Z");
		expect(result.status).toBe("resumable");
		expect(result.resumable).toEqual(payload);
		expect(result.heartbeatAt).toBe("2026-07-19T00:01:00.000Z");
	});

	it("markClosed sets status/heartbeat only", () => {
		const entry = worker();
		const result = markClosed(entry, "2026-07-19T00:02:00.000Z");
		expect(result).toEqual({ ...entry, status: "closed", heartbeatAt: "2026-07-19T00:02:00.000Z" });
	});

	describe("applyAdoption", () => {
		it("sets status running, adopts the new parent, and clears windDownReason", () => {
			const entry = beginWindDown(worker(), "parent_lost", "2026-07-19T00:01:00.000Z");
			const result = applyAdoption(entry, { parentPid: 500, parentSessionId: "new-master" });
			expect(result.status).toBe("running");
			expect(result.parentPid).toBe(500);
			expect(result.parentSessionId).toBe("new-master");
			expect(result).not.toHaveProperty("windDownReason");
		});

		it("leaves an already-set parentSessionId untouched when omitted", () => {
			const entry = { ...worker(), parentSessionId: "original-master" };
			const result = applyAdoption(entry, { parentPid: 500 });
			expect(result.parentSessionId).toBe("original-master");
		});
	});

	describe("pollWorkerDirective", () => {
		it("returns adopt when parentPid changed to a new, alive pid", () => {
			const fresh = worker({ parentPid: 500 });
			expect(pollWorkerDirective(fresh, 100, { isPidAlive: alwaysAlive })).toEqual({
				code: "adopt",
				parentPid: 500,
			});
		});

		it("returns none when parentPid changed but the new pid is dead", () => {
			const fresh = worker({ parentPid: 500 });
			expect(pollWorkerDirective(fresh, 100, { isPidAlive: neverAlive })).toEqual({ code: "none" });
		});

		it("returns none when parentPid is unchanged", () => {
			const fresh = worker({ parentPid: 100 });
			expect(pollWorkerDirective(fresh, 100, { isPidAlive: alwaysAlive })).toEqual({ code: "none" });
		});

		it("returns user_cleanup when windDownReason is user_cleanup, regardless of parentPid", () => {
			const fresh = worker({ windDownReason: "user_cleanup" });
			expect(pollWorkerDirective(fresh, 100, { isPidAlive: alwaysAlive })).toEqual({ code: "user_cleanup" });
		});

		it("user_cleanup takes priority even when parentPid also changed", () => {
			const fresh = worker({ parentPid: 500, windDownReason: "user_cleanup" });
			expect(pollWorkerDirective(fresh, 100, { isPidAlive: alwaysAlive })).toEqual({ code: "user_cleanup" });
		});
	});

	describe("reconcileMatrix", () => {
		const deps = { isPidAlive: alwaysAlive, now: Date.parse("2026-07-19T01:00:00.000Z"), resumableTtlMs: 60_000 };

		it("prunes closed entries unconditionally", () => {
			const entries = [worker({ status: "closed" })];
			const result = reconcileMatrix(entries, deps);
			expect(result).toEqual({ code: "reconciled", kept: [], prunedEntryIds: ["worker-w1"] });
		});

		it("prunes running/winding_down entries whose own pid is dead", () => {
			const entries = [worker({ status: "running" }), worker({ entryId: "worker-w2", status: "winding_down" })];
			const result = reconcileMatrix(entries, { ...deps, isPidAlive: neverAlive });
			expect(result.kept).toEqual([]);
			expect(result.prunedEntryIds.sort()).toEqual(["worker-w1", "worker-w2"]);
		});

		it("keeps running/winding_down entries whose own pid is alive", () => {
			const entries = [worker({ status: "running" })];
			const result = reconcileMatrix(entries, deps);
			expect(result.kept).toEqual(entries);
			expect(result.prunedEntryIds).toEqual([]);
		});

		it("keeps a resumable entry within the TTL window", () => {
			const entries = [worker({ status: "resumable", heartbeatAt: "2026-07-19T00:59:30.000Z" })];
			const result = reconcileMatrix(entries, deps);
			expect(result.kept).toEqual(entries);
		});

		it("prunes a resumable entry older than the TTL window", () => {
			const entries = [worker({ status: "resumable", heartbeatAt: "2026-07-19T00:00:00.000Z" })];
			const result = reconcileMatrix(entries, deps);
			expect(result.kept).toEqual([]);
			expect(result.prunedEntryIds).toEqual(["worker-w1"]);
		});

		it("applies the same TTL rule to an adopted entry", () => {
			const fresh = [worker({ status: "adopted", heartbeatAt: "2026-07-19T00:59:30.000Z" })];
			const stale = [worker({ status: "adopted", heartbeatAt: "2026-07-19T00:00:00.000Z" })];
			expect(reconcileMatrix(fresh, deps).kept).toEqual(fresh);
			expect(reconcileMatrix(stale, deps).kept).toEqual([]);
		});
	});
});
