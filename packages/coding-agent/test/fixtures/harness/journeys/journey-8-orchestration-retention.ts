import "../builtin-install.ts";
import { join } from "node:path";
import { expect } from "vitest";
import { orchestrationEventStoreDir, ownerOrchestrationHome } from "../../../../src/core/agent-paths.ts";
import { evaluateNewWorkerAdmission } from "../../../../src/core/delegation/worker-fleet-limits.ts";
import { createGoalState } from "../../../../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../../../../src/core/goals/session-goal-state.ts";
import { readRetentionArchives, retentionArchiveDir } from "../../../../src/core/orchestration/retention-archive.ts";
import { RETENTION_IDLE_DELAY_MS } from "../../../../src/core/orchestration/retention-controller.ts";
import { RETENTION_REPLAY_FLOOR_MS } from "../../../../src/core/orchestration/retention-pass.ts";
import {
	workerConversationMetadataFile,
	workerTranscriptLocation,
} from "../../../../src/kernel/session/worker-storage-identity.ts";
import { createBarrier, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { carriesMarker, delegateReceipts, handoffTurn, startOf, submitReport } from "./journey-8-shared.ts";
import { INTAKE_JUDGMENTS_WITHOUT_GRANT } from "./shared.ts";

/**
 * Leg 5: Worker identity headroom and orchestration closed-objective retention + reopen ID safety.
 *
 * 1. A root session with an active goal starts `worker-1` under `goal:ret-goal-1`. While `worker-1` is registered,
 *    a session agent limit of 1 refuses a second durable identity; once `worker-1` is retired (`delegate retire`),
 *    `evaluateNewWorkerAdmission` ignores retired bindings for both session-wide and nested-child headroom.
 * 2. Closing and clearing `ret-goal-1`, advancing the orchestration clock past both `RETENTION_REPLAY_FLOOR_MS` and
 *    `closedObjectiveDays` (2 days > 1 day), and firing the idle `retention` timer runs `runRetentionPass`:
 *    the closed objective, task, attempt, retired `worker-1` agent binding (`v: 2` `agentIds`), and delivered
 *    notification are archived and pruned from the hot projection while `worker-1`'s `.jsonl` and `.worker.json`
 *    transcript files stay intact on disk.
 * 3. Reopening the session from disk and starting a fresh worker mints `worker-2` rather than colliding with the
 *    retained `worker-1` files on disk.
 */

const MODEL = "worker-a";
const NOTE_TEXT = "the retry limit is three\n";
const RETENTION_GOAL_ID = "ret-goal-1";
const RETENTION_OBJECTIVE_ID = `goal:${RETENTION_GOAL_ID}`;
const START_PROMPT = "Start one read-only worker to inspect notes.md.";
const RETIRE_PROMPT = "Retire worker-1 now that its inspection is finished.";
const REOPEN_PROMPT = "Start one read-only worker after reopening the session.";

const GOAL_STEP_JUDGMENTS = {
	step_relevant: { kind: "noul", probability: 0.97 },
	evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
	unsupported_assumption_present: { kind: "noul", probability: 0.02 },
	route: { kind: "choice", choice: "reason", confidence: 0.97 },
	action_accomplished_step: { kind: "noul", probability: 0.02 },
	conclusions_supported: { kind: "noul", probability: 0.97 },
	scope_violation: { kind: "noul", probability: 0.02 },
	unrelated_behavior_change: { kind: "noul", probability: 0.02 },
	replan_required: { kind: "noul", probability: 0.02 },
	next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
} as const;

export async function runJourney8OrchestrationRetentionPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	world.io.seed(join(HARNESS_PROJECT_CWD, "notes.md"), NOTE_TEXT);

	const nowIso = new Date().toISOString();
	const sessionManager = world.createSessionManager();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("expected persisted session file for retention leg");
	const sessionId = sessionManager.getSessionId();

	appendGoalStateSnapshot(
		sessionManager,
		createGoalState({
			goalId: RETENTION_GOAL_ID,
			userGoal: "Inspect notes.md and retire the worker.",
			now: nowIso,
		}),
	);

	const firstWorkerReached = createBarrier();
	const firstWake = createBarrier();
	const secondWorkerReached = createBarrier();
	const secondWake = createBarrier();

	world.provider.enqueueTrack("j8e-first", MODEL, carriesMarker("Inspect notes.md in session 1."), {
		name: "j8e-first-report",
		check: () => firstWorkerReached.release(),
		reply: submitReport("j8e-first-report-1", "Read notes.md: retry limit is three."),
	});
	world.provider.enqueueTrack("j8e-reopen", MODEL, carriesMarker("Inspect notes.md after reopen."), {
		name: "j8e-reopen-report",
		check: () => secondWorkerReached.release(),
		reply: submitReport("j8e-reopen-report-1", "Read notes.md after reopen: retry limit is three."),
	});

	world.provider.enqueue(
		"root",
		{
			name: "j8e-start-1",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j8e-start-call-1",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: HARNESS_PROVIDER, modelId: MODEL },
							instructions: "Inspect notes.md in session 1.",
							readOnly: true,
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		text("j8e-start-1-done", "Noted."),
		handoffTurn("j8e-wake-1", firstWake),
		{
			name: "j8e-retire-1",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j8e-retire-call-1",
						name: "delegate",
						arguments: {
							action: "retire",
							agentId: "worker-1",
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		text("j8e-retire-1-done", "Noted."),
		{
			name: "j8e-start-2",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j8e-start-call-2",
						name: "delegate",
						arguments: {
							action: "start",
							model: { provider: HARNESS_PROVIDER, modelId: MODEL },
							instructions: "Inspect notes.md after reopen.",
							readOnly: true,
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		text("j8e-start-2-done", "Noted."),
		handoffTurn("j8e-wake-2", secondWake),
	);

	world.systemOne.enterPhase("j8e-retention-active", {
		...INTAKE_JUDGMENTS_WITHOUT_GRANT,
		...GOAL_STEP_JUDGMENTS,
	});

	let firstSession: Awaited<ReturnType<typeof world.createRootSession>>["session"] | undefined;
	let reopenedSession: Awaited<ReturnType<typeof world.createRootSession>>["session"] | undefined;
	try {
		const created = await world.createRootSession("root", {
			sessionManager,
			settings: { autonomy: { goalAutoContinue: false } },
		});
		firstSession = created.session;

		await withDeadline(trace, "J8E start worker-1 turn", firstSession.prompt(START_PROMPT));
		await withDeadline(trace, "J8E worker-1 request", firstWorkerReached.promise);
		await withDeadline(trace, "J8E worker-1 handoff", firstWake.promise);
		await withDeadline(trace, "J8E worker-1 handoff settles", firstSession.waitForForegroundIdle());

		const firstStart = startOf(delegateReceipts(firstSession)[0]!);
		expect(firstStart.agentId, "the first worker mints worker-1").toBe("worker-1");

		const worker1Location = workerTranscriptLocation(ownerOrchestrationHome(world.agentDir), {
			parentSessionId: sessionId,
			logicalAgentId: "worker-1",
		});
		const worker1MetaFile = workerConversationMetadataFile(worker1Location.sessionFile);
		expect(
			{
				transcript: world.io.existsSync(worker1Location.sessionFile),
				metadata: world.io.existsSync(worker1MetaFile),
			},
			"worker-1 writes both its JSONL transcript and its .worker.json metadata file",
		).toEqual({ transcript: true, metadata: true });

		const tightSessionLimit = {
			maxDepth: 2,
			maxChildrenPerAgent: 1,
			maxNestedAgentsPerSession: 1,
			maxAgentsPerSession: 1,
		} as const;
		const beforeRetireSnapshot = firstSession.backgroundLanes.getTaskRuntimeSnapshot();
		if (!beforeRetireSnapshot) throw new Error("expected task runtime snapshot before retire");
		expect(
			evaluateNewWorkerAdmission(beforeRetireSnapshot.agents, undefined, tightSessionLimit),
			"while worker-1 is registered, maxAgentsPerSession: 1 blocks a second live worker",
		).toEqual({ ok: false, reasonCode: "worker_agent_session_limit_reached" });

		// Retire worker-1 via `delegate retire` and prove retired bindings no longer block session or child headroom.
		await withDeadline(trace, "J8E retire worker-1 turn", firstSession.prompt(RETIRE_PROMPT));
		await withDeadline(trace, "J8E retire settles", firstSession.waitForForegroundIdle());

		const afterRetireSnapshot = firstSession.backgroundLanes.getTaskRuntimeSnapshot();
		if (!afterRetireSnapshot) throw new Error("expected task runtime snapshot after retire");
		const retiredWorker1 = afterRetireSnapshot.agents["worker-1"];
		if (!retiredWorker1) throw new Error("expected retired worker-1 binding in hot projection before retention");
		const simulatedParentAndRetiredChild = {
			"parent-1": {
				...retiredWorker1,
				agentId: "parent-1",
				rootAgentId: "parent-1",
				depth: 0,
				status: "registered" as const,
			},
			"retired-child-1": {
				...retiredWorker1,
				agentId: "retired-child-1",
				parentAgentId: "parent-1",
				rootAgentId: "parent-1",
				depth: 1,
				status: "retired" as const,
			},
		};
		expect(
			{
				retiredStatus: retiredWorker1.status,
				sessionHeadroom: evaluateNewWorkerAdmission(afterRetireSnapshot.agents, undefined, tightSessionLimit),
				childHeadroom: evaluateNewWorkerAdmission(simulatedParentAndRetiredChild, "parent-1", {
					maxDepth: 2,
					maxChildrenPerAgent: 1,
					maxNestedAgentsPerSession: 1,
					maxAgentsPerSession: 2,
				}),
			},
			"retired worker and child bindings do not block session-wide, direct-child, or nested-session headroom",
		).toEqual({
			retiredStatus: "retired",
			sessionHeadroom: { ok: true, depth: 0 },
			childHeadroom: { ok: true, depth: 1 },
		});

		const attemptId = afterRetireSnapshot.tasks["worker-1"]?.attemptIds[0];
		const notificationIdsBefore = Object.keys(afterRetireSnapshot.notifications);
		expect(attemptId, "worker-1 recorded one attempt under goal:ret-goal-1").toBeDefined();
		expect(afterRetireSnapshot.tasks["worker-1"]?.task.objectiveId).toBe(RETENTION_OBJECTIVE_ID);
		expect(notificationIdsBefore.length, "worker-1 recorded its terminal notification").toBeGreaterThan(0);

		// Close and clear `ret-goal-1` so `goal:ret-goal-1` is closed and no longer held as `currentGoalId`.
		const currentGoal = firstSession.getGoalStateSnapshot();
		if (!currentGoal) throw new Error("expected active goal state before clear");
		firstSession.clearGoalStateSnapshot(currentGoal, new Date().toISOString());

		// Advance orchestration clock past both RETENTION_REPLAY_FLOOR_MS (1h) and closedObjectiveDays (1d), then fire idle retention.
		const advanceMs = Math.max(2 * 86_400_000, RETENTION_REPLAY_FLOOR_MS + 86_400_000);
		world.timers.advance("orchestration", advanceMs);
		expect(
			world.timers.advance("retention", RETENTION_IDLE_DELAY_MS),
			"the armed idle retention timer fires once",
		).toBe(1);

		const prunedSnapshot = firstSession.backgroundLanes.getTaskRuntimeSnapshot();
		if (!prunedSnapshot) throw new Error("expected task runtime snapshot after retention pass");
		const archiveDir = retentionArchiveDir(
			orchestrationEventStoreDir(ownerOrchestrationHome(world.agentDir), sessionId),
		);
		const archiveRead = readRetentionArchives(archiveDir);
		const archive = archiveRead.archives[0];
		expect(
			{
				corruptArchives: archiveRead.corrupt,
				archiveCount: archiveRead.archives.length,
				archivedObjectives: archive?.objectiveIds,
				archivedTasks: archive?.taskIds,
				archivedAttempts: archive?.attemptIds,
				archivedAgents: archive?.agentIds,
				archivedNotifications: archive?.dependents.notificationIds,
				hasArchivedAgentRecord: archive?.records.agents?.["worker-1"] !== undefined,
				committedIdsCount: prunedSnapshot.retentionArchiveIds?.length,
				hotObjective: prunedSnapshot.objectives[RETENTION_OBJECTIVE_ID],
				hotTask: prunedSnapshot.tasks["worker-1"],
				hotAttempt: attemptId ? prunedSnapshot.attempts[attemptId] : undefined,
				hotAgent: prunedSnapshot.agents["worker-1"],
				hotNotifications: Object.keys(prunedSnapshot.notifications),
				retainedTranscript: world.io.existsSync(worker1Location.sessionFile),
				retainedMetadata: world.io.existsSync(worker1MetaFile),
			},
			"retention archives and prunes the closed objective, task, attempt, retired v:2 agent binding, and delivered notification while leaving worker-1 transcript files intact on disk",
		).toEqual({
			corruptArchives: [],
			archiveCount: 1,
			archivedObjectives: [RETENTION_OBJECTIVE_ID],
			archivedTasks: ["worker-1"],
			archivedAttempts: [attemptId],
			archivedAgents: ["worker-1"],
			archivedNotifications: notificationIdsBefore.sort(),
			hasArchivedAgentRecord: true,
			committedIdsCount: 1,
			hotObjective: undefined,
			hotTask: undefined,
			hotAttempt: undefined,
			hotAgent: undefined,
			hotNotifications: [],
			retainedTranscript: true,
			retainedMetadata: true,
		});

		expect(
			await world.disposeSessionInBody(firstSession),
			"session 1 disposes cleanly before reopen",
		).toBeUndefined();
		firstSession = undefined;

		// Reopen the session from disk after worker-1 was pruned from hot projection: starting a fresh worker must mint worker-2, not worker-1!
		world.systemOne.enterPhase("j8e-retention-reopened", INTAKE_JUDGMENTS_WITHOUT_GRANT);
		const reopenedManager = world.openSessionManager(sessionFile);
		const reopened = await world.createRootSession("root", { sessionManager: reopenedManager });
		reopenedSession = reopened.session;

		await withDeadline(trace, "J8E reopened start worker turn", reopenedSession.prompt(REOPEN_PROMPT));
		const reopenedReceipt = delegateReceipts(reopenedSession).at(-1);
		if (!reopenedReceipt || reopenedReceipt.isError) {
			throw new Error(`reopened delegate start failed: ${JSON.stringify(reopenedReceipt)}`);
		}
		const reopenedStart = startOf(reopenedReceipt);
		expect(reopenedStart, "reopened delegate start mints worker-2 immediately").toMatchObject({
			started: true,
			agentId: "worker-2",
			laneId: "worker-2",
		});
		await withDeadline(trace, "J8E reopened worker request", secondWorkerReached.promise);
		await withDeadline(trace, "J8E reopened worker handoff", secondWake.promise);
		await withDeadline(trace, "J8E reopened handoff settles", reopenedSession.waitForForegroundIdle());
		const worker2Location = workerTranscriptLocation(ownerOrchestrationHome(world.agentDir), {
			parentSessionId: sessionId,
			logicalAgentId: "worker-2",
		});
		expect(
			{
				newAgentId: reopenedStart.agentId,
				newLaneId: reopenedStart.laneId,
				newStatus: reopenedSession.getLaneRecords().find((record) => record.laneId === reopenedStart.laneId)
					?.status,
				worker1StillPresent: world.io.existsSync(worker1Location.sessionFile),
				worker2Present: world.io.existsSync(worker2Location.sessionFile),
			},
			"reopening the session after retention pruned worker-1 mints non-colliding worker-2 alongside retained worker-1 files",
		).toEqual({
			newAgentId: "worker-2",
			newLaneId: "worker-2",
			newStatus: "succeeded",
			worker1StillPresent: true,
			worker2Present: true,
		});

		expect(await world.disposeSessionInBody(reopenedSession), "reopened session disposes cleanly").toBeUndefined();
		reopenedSession = undefined;
		trace.mark("root", "j8.orchestration-retention");
	} finally {
		if (firstSession) await world.disposeSessionInBody(firstSession);
		if (reopenedSession) await world.disposeSessionInBody(reopenedSession);
	}
}
