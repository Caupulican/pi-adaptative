import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { RealWorkerDispatcher } from "../src/core/adaptive/execution-ports.ts";
import type { MaterializedSpecialist } from "../src/core/adaptive/types.ts";
import { ownerOrchestrationHome } from "../src/core/agent-paths.ts";
import { composeObjectiveRoute } from "../src/core/objective-execution/objective-route-policy.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import {
	reconcileArchivedWorkerRouteStarts,
	subscribeWorkerRouteStarts,
} from "../src/core/operator-projection/worker-route-starts.ts";
import type { WorkerResultContract } from "../src/core/orchestration/contracts.ts";
import { projectionForStorage } from "../src/core/orchestration/dispatch-storage.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import {
	buildRetentionArchive,
	retentionArchiveDir,
	writeRetentionArchive,
} from "../src/core/orchestration/retention-archive.ts";
import { retentionArchiveId } from "../src/core/orchestration/retention-event.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";
import { carriedPlansFold } from "../src/core/plan/plan-carry.ts";

it("repairs only provable worker decisions on recovery and on later starts without another objective turn", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-route-recovery-"));
	const sessionId = "parent";
	const openJournal = () => new OrchestrationEventStore({ sessionId, orchestrationHome: ownerOrchestrationHome(dir) });
	const store = openJournal();
	const runtime = new DurableTaskRuntime({ store });
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decisions.sqlite") });
	let off: (() => void) | undefined;
	try {
		const { objectiveId } = runtime.createObjective({
			objectiveId: `session:${sessionId}`,
			title: "Investigation",
			description: "Collect a receipt",
		});
		const record = (cycleId: string, route = "retrieve", scope = objectiveId, session = sessionId) =>
			ledger.recordRoute({
				sessionId: session,
				cwd: dir,
				objectiveId: scope,
				cycleId,
				route,
				reasonCodes: [],
				decidedAt: 1,
				evidenceMarker: 1,
			});
		const read = (cycle: string, scope = objectiveId, session = sessionId) =>
			ledger
				.recentRoutes(session, scope, 64)
				.filter((row) => row.cycleId === cycle)
				.map((row) => row.executor);
		const prepare = (cycleId: string, origin = true) => {
			const taskId = `task-${cycleId}`;
			return runtime.prepareTaskAttempt(
				{ taskId, objectiveId, title: "Work", description: "Read", role: "implementer" },
				{
					taskId,
					profileId: "reader",
					instructions: "Read",
					resourcePointerIds: [],
					...(origin && {
						objectiveRouteOrigin: {
							sessionId,
							objectiveId,
							cycleId,
							executor: cycleId === "escalated" ? "worker:escalated" : "worker",
						},
					}),
				},
				"grant",
			).attempt;
		};
		const run = (cycle: string, origin = true) => {
			const { attemptId } = prepare(cycle, origin);
			const lease = runtime.leaseAttempt(attemptId, sessionId, 60_000);
			runtime.startAttempt(attemptId, lease.leaseId, lease.fencingToken);
			runtime.cancelAttempt(attemptId, "test_finished");
		};
		record("terminal");
		run("terminal");
		record("legacy");
		run("legacy", false);
		record("foreign", "retrieve", "other-objective");
		run("foreign");
		record("other-session", "retrieve", objectiveId, "foreign-session");
		run("other-session");
		record("stamp");
		ledger.noteRouteExecutor(sessionId, "stamp", "root", objectiveId);
		run("stamp");
		record("duplicate");
		record("duplicate");
		run("duplicate");
		record("wait", "wait_for_worker");
		run("wait");
		record("escalated", "escalate_capability");
		run("escalated");
		run("missing-row");
		record("later");
		const queued = prepare("later");
		const checkpoint = runtime.getSnapshot();
		store.compactIfNeeded(checkpoint.lastOrdinal, carriedPlansFold(checkpoint), undefined, true);
		const opened = openJournal();
		const reopenedRuntime = new DurableTaskRuntime({ store: opened });
		const host = { getSessionId: () => sessionId, systemOne: { getDecisionLedger: () => ledger } };
		const observe = () =>
			subscribeWorkerRouteStarts(
				opened,
				{ getTaskRuntimeSnapshot: () => reopenedRuntime.getSnapshot() },
				host,
				() => {},
			);
		off = observe();
		expect(read("terminal")).toEqual(["worker"]);
		expect(read("legacy")).toEqual([undefined]);
		expect(read("foreign", "other-objective")).toEqual([undefined]);
		expect(read("other-session", objectiveId, "foreign-session")).toEqual([undefined]);
		expect(read("stamp")).toEqual(["root"]);
		expect(read("duplicate")).toEqual([undefined, undefined]);
		expect(read("wait")).toEqual([undefined]);
		expect(read("escalated")).toEqual(["worker:escalated"]);
		expect(read("missing-row")).toEqual([]);
		expect(read("later")).toEqual([undefined]);
		const lease = reopenedRuntime.leaseAttempt(queued.attemptId, sessionId, 60_000);
		off();
		off = observe();
		expect(read("later")).toEqual([undefined]);
		reopenedRuntime.startAttempt(queued.attemptId, lease.leaseId, lease.fencingToken);
		expect(read("later")).toEqual(["worker"]);
		off();
		off = observe();
		expect(read("later")).toEqual(["worker"]);
		const terminal = checkpoint.tasks["task-terminal"]!;
		const archive = buildRetentionArchive({
			sessionId,
			cutoff: new Date().toISOString(),
			projection: projectionForStorage(checkpoint),
			selection: {
				objectiveIds: [],
				taskIds: [terminal.task.taskId],
				attemptIds: terminal.attemptIds,
				planIds: [],
				agentIds: [],
				dependents: { checkpointIds: [], notificationIds: [], approvalIds: [], planIds: [], subscriptionIds: [] },
				carry: new Map(),
				held: 0,
				truncated: false,
			},
		});
		writeRetentionArchive(retentionArchiveDir(store.rootDir), archive);
		const archivedLedger = new DecisionLedgerStore({ databasePath: ":memory:" });
		try {
			archivedLedger.recordRoute({
				sessionId,
				objectiveId,
				cycleId: "terminal",
				route: "retrieve",
				reasonCodes: [],
				cwd: dir,
				decidedAt: 1,
				evidenceMarker: 1,
			});
			const archivedExecutor = () => archivedLedger.recentRoutes(sessionId, objectiveId, 1)[0]?.executor;
			reconcileArchivedWorkerRouteStarts(sessionId, store.rootDir, ["ar-uncommitted"], () => archivedLedger);
			expect(archivedExecutor()).toBeUndefined();
			reconcileArchivedWorkerRouteStarts(
				sessionId,
				store.rootDir,
				[retentionArchiveId(archive.digest)],
				() => archivedLedger,
			);
			expect(archivedExecutor()).toBe("worker");
		} finally {
			archivedLedger.close();
		}
	} finally {
		off?.();
		ledger.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("keeps the native specialist's real attempt identity and requires a start before importing its result", async () => {
	const route = composeObjectiveRoute({
		objectiveId: "session:scope",
		cycleId: "S",
		semantic: { capabilityEscalationRequired: true },
	});
	const specialist = {
		profileId: "reviewer",
		expert: { providerId: "local", modelId: "small" },
		spec: { mission: "Read the function" },
	} as MaterializedSpecialist;
	const result: WorkerResultContract = {
		schemaVersion: 1,
		resultId: "R",
		objectiveId: route.objective_id,
		taskId: "native-task",
		attemptId: "native-attempt",
		leaseId: "native-lease",
		fencingToken: 1,
		status: "completed",
		reasonCode: "done",
		summary: "Read",
		artifacts: [],
		evidence: [],
		errors: [],
		usage: { wallClockMs: 1, toolCalls: 1 },
		createdAt: "2026-11-26T12:00:00.000Z",
	};
	for (const admitted of [false, true]) {
		const record = {
			laneId: result.taskId,
			attemptId: result.attemptId,
			type: "worker" as const,
			status: admitted ? ("succeeded" as const) : ("canceled" as const),
			...(admitted && { firstStartedAt: result.createdAt }),
		};
		const read = vi.fn(() => result);
		const dispatch = new RealWorkerDispatcher({
			getAttemptResult: read,
			session: {
				sessionId: "parent",
				runWorkerDelegationOnce: async (request) => {
					expect(request).toMatchObject({
						objectiveId: route.objective_id,
						objectiveRouteOrigin: {
							sessionId: "parent",
							objectiveId: route.objective_id,
							cycleId: "S",
							executor: "worker:escalated",
						},
					});
					return { started: true, record };
				},
			},
		});
		const actual = await dispatch.dispatchSpecialist({
			route,
			objectiveId: route.objective_id,
			specialist,
			taskId: "requested-task",
			attemptId: "requested-attempt",
		});
		if (admitted) {
			expect(actual).toBe(result);
			expect(read).toHaveBeenCalledWith("native-attempt");
		} else {
			expect(actual).toMatchObject({ started: false });
			expect(read).not.toHaveBeenCalled();
		}
	}
});
