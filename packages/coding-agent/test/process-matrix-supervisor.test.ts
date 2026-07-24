import { describe, expect, it } from "vitest";
import type { AgentIdentityContract } from "../src/core/orchestration/contracts.ts";
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
	markTerminal,
	markTerminalNotificationDelivered,
	pollWorkerDirective,
	reconcileMatrix,
} from "../src/core/process-matrix/supervisor.ts";

const NOW = "2026-07-19T00:00:00.000Z";

function agent(sessionId: string, worktreeLaneKey?: string): AgentIdentityContract {
	return {
		agentId: `agent-${sessionId}`,
		resumeContext: {
			provider: "pi",
			sessionId,
			cwd: "/repo",
			...(worktreeLaneKey ? { worktreeLaneKey } : {}),
			resourceProfileNames: [],
			contextPointers: [],
		},
	};
}

function worker(overrides: Partial<ProcessMatrixEntry> = {}): ProcessMatrixEntry {
	return {
		entryId: "worker-w1",
		role: "worker",
		agent: agent("w1"),
		pid: 200,
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
			const entry = buildMasterEntry({ agent: agent("m1"), pid: 100, hostname: "host-a", now: NOW });
			expect(entry).toEqual({
				entryId: "master-m1",
				role: "master",
				agent: agent("m1"),
				pid: 100,
				hostname: "host-a",
				startedAt: NOW,
				heartbeatAt: NOW,
				status: "running",
			});
		});

		it("buildWorkerEntry produces a running entry keyed worker-<sessionId>, omitting unset optionals", () => {
			const entry = buildWorkerEntry({
				agent: agent("w1"),
				pid: 200,
				hostname: "host-a",
				now: NOW,
				parentPid: 100,
			});
			expect(entry).toEqual({
				entryId: "worker-w1",
				role: "worker",
				agent: agent("w1"),
				pid: 200,
				hostname: "host-a",
				startedAt: NOW,
				heartbeatAt: NOW,
				status: "running",
				parentPid: 100,
			});
			expect(entry.agent.resumeContext.worktreeLaneKey).toBeUndefined();
			expect(entry).not.toHaveProperty("parentSessionId");
		});

		it("buildWorkerEntry carries through optional identity fields when provided", () => {
			const entry = buildWorkerEntry({
				agent: agent("w1", "adhoc-1"),
				pid: 200,
				hostname: "host-a",
				now: NOW,
				parentPid: 100,
				parentSessionId: "m1",
				tmuxSession: "pi-job-1",
				tmuxPanePid: 300,
				taskRef: "goal-1",
				taskSummary: "Ship goal 1",
			});
			expect(entry.parentSessionId).toBe("m1");
			expect(entry.agent.resumeContext.worktreeLaneKey).toBe("adhoc-1");
			expect(entry.tmuxSession).toBe("pi-job-1");
			expect(entry.tmuxPanePid).toBe(300);
			expect(entry.taskRef).toBe("goal-1");
			expect(entry.taskSummary).toBe("Ship goal 1");
		});
	});

	it("applyHeartbeat only updates heartbeatAt", () => {
		const entry = buildMasterEntry({ agent: agent("m1"), pid: 100, hostname: "host-a", now: NOW });
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
			const entries = [buildMasterEntry({ agent: agent("m1"), pid: 100, hostname: "host-a", now: NOW })];
			expect(detectOrphanedWorkers(entries, { isPidAlive: neverAlive })).toEqual([]);
		});

		it("excludes this session's own entry even if it would otherwise match", () => {
			const entries = [worker({ agent: agent("self"), entryId: "worker-self", parentPid: 999 })];
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
		const payload = { agent: agent("w1", "adhoc-1"), lastCode: "resumable" as const };
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

	it("markTerminal creates an undelivered outbox and marks delivery separately", () => {
		const terminal = markTerminal(worker(), { code: 0, signal: null }, "2026-07-19T00:02:00.000Z");
		expect(terminal).toMatchObject({
			status: "closed",
			terminal: { code: 0, signal: null, observedAt: "2026-07-19T00:02:00.000Z" },
		});
		const delivered = markTerminalNotificationDelivered(terminal, "2026-07-19T00:03:00.000Z");
		expect(delivered.terminal?.notificationDeliveredAt).toBe("2026-07-19T00:03:00.000Z");
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

		it("prunes closed entries without a pending terminal handoff", () => {
			const entries = [worker({ status: "closed" })];
			const result = reconcileMatrix(entries, deps);
			expect(result).toEqual({
				code: "reconciled",
				kept: [],
				prunedEntryIds: ["worker-w1"],
				recoveredEntryIds: [],
			});
		});

		it("retains an undelivered terminal outbox until delivery or TTL expiry", () => {
			const fresh = markTerminal(worker(), { code: 0, signal: null }, "2026-07-19T00:59:30.000Z");
			const delivered = markTerminalNotificationDelivered(fresh, "2026-07-19T00:59:40.000Z");
			const expired = markTerminal(worker({ entryId: "worker-w2" }), { code: 1, signal: null }, NOW);

			expect(reconcileMatrix([fresh], deps).kept).toEqual([fresh]);
			expect(reconcileMatrix([delivered], deps).prunedEntryIds).toEqual([delivered.entryId]);
			expect(reconcileMatrix([expired], deps).prunedEntryIds).toEqual([expired.entryId]);
		});

		it("repairs interrupted Pi workers into resumable records", () => {
			const entries = [
				worker({ status: "running", taskRef: "goal-1", taskSummary: "Ship goal 1" }),
				worker({ entryId: "worker-w2", status: "winding_down" }),
			];
			const result = reconcileMatrix(entries, { ...deps, isPidAlive: neverAlive });
			expect(result.kept.map((entry) => entry.status)).toEqual(["resumable", "resumable"]);
			expect(result.kept.map((entry) => entry.resumable?.agent)).toEqual(entries.map((entry) => entry.agent));
			expect(result.kept[0]?.resumable).toMatchObject({ taskRef: "goal-1", taskSummary: "Ship goal 1" });
			expect(result.prunedEntryIds).toEqual([]);
			expect(result.recoveredEntryIds.sort()).toEqual(["worker-w1", "worker-w2"]);
		});

		it("prunes dead masters and external workers that Pi cannot resume", () => {
			const master = buildMasterEntry({ agent: agent("m1"), pid: 100, hostname: "host-a", now: NOW });
			const externalWorker = worker({
				entryId: "worker-external",
				agent: {
					agentId: "external",
					resumeContext: {
						provider: "external",
						sessionId: "external",
						cwd: "/repo",
						resourceProfileNames: [],
						contextPointers: [],
					},
				},
			});
			const result = reconcileMatrix([master, externalWorker], { ...deps, isPidAlive: neverAlive });
			expect(result.kept).toEqual([]);
			expect(result.prunedEntryIds).toEqual(["master-m1", "worker-external"]);
			expect(result.recoveredEntryIds).toEqual([]);
		});

		it("keeps running/winding_down entries whose own pid is alive", () => {
			const entries = [worker({ status: "running" })];
			const result = reconcileMatrix(entries, deps);
			expect(result.kept).toEqual(entries);
			expect(result.prunedEntryIds).toEqual([]);
			expect(result.recoveredEntryIds).toEqual([]);
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

		it("prunes malformed-age recovery records instead of retaining them forever", () => {
			const entries = [worker({ status: "resumable", heartbeatAt: "not-a-time" })];
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
