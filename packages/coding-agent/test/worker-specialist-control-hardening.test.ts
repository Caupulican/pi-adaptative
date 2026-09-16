/**
 * Control-plane hardening around reuse: what survives bounded mailbox retention, what a refused
 * start is allowed to persist, and what a replayed tool call is allowed to mean.
 *
 * Every case drives real owners: the real `WorkerAgentControlCoordinator` over a real
 * `WorkerLifecycle` and a real `WorkerAgentMailbox` file, and the session's own registered
 * `delegate` tool over its real execution-plane controller. Mailbox pruning and saturation happen
 * through ORDINARY retention and the mailbox's own named capacity -- real messages, really
 * delivered or really pending. No state is hand-patched into the mailbox file, and later durable
 * turns are settled through the real ledger rather than fabricated.
 *
 * Current behaviour these pin (draft baseline, batch8-production-baseline-manifest.txt):
 * - `hasMatchingReceiptIntent` answers `true` when the message body is gone, so after pruning a
 *   same-key replay that changed new-work intent, or changed its resource selection, is accepted;
 * - `hasMatchingNewTaskCorrelation` never compares `resourcePointerIds`;
 * - `startIdleAgentTask` synchronizes the new-task goal before the mailbox can refuse the message,
 *   so a start refused for size or for mailbox saturation still leaves a new objective behind;
 * - the anonymous-start replay shortcut matches on the raw replay key alone and returns the original
 *   record without comparing instructions, grant or requested target.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerAgentTaskStartOptions } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerAgentMailbox } from "../src/core/delegation/worker-agent-control.ts";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { GoalState } from "../src/core/goals/goal-state.ts";
import {
	type AgentResumeContext,
	MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
	type WorkerResultContract,
} from "../src/core/orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../src/core/orchestration/delegation-ledger.ts";
import type { AttemptRuntimeState } from "../src/core/orchestration/task-runtime.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import type { DelegateDispatchToolDetails, DelegateToolInput } from "../src/core/tools/delegate.ts";
import { createReuseHarness, type ReuseHarness } from "./fixtures/specialist-reuse-harness.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const LEASE_TTL_MS = 60_000;
const AGENT_ID = "worker-1";
const FIRST_GOAL_ID = "goal-alpha";
const FIRST_REQUIREMENT_ID = "req-alpha";
const SECOND_GOAL_ID = "goal-beta";
const SECOND_REQUIREMENT_ID = "req-beta";
const RESOURCE_A = `skill:${"a".repeat(64)}`;
const RESOURCE_B = `prompt:${"b".repeat(64)}`;
/** The mailbox's own named pending-message capacity. */
const MAILBOX_PENDING_LIMIT = 64;

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) {
		const directory = roots.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

function goalFixture(goalId: string, requirementId: string): GoalState {
	const now = new Date().toISOString();
	return {
		goalId,
		userGoal: `Goal ${goalId}`,
		status: "active",
		requirements: [
			{
				id: requirementId,
				text: `Requirement for ${goalId}`,
				status: "open",
				evidenceIds: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		evidence: [],
		events: [],
		createdAt: now,
		updatedAt: now,
		lastProgressAt: now,
		stallTurns: 0,
	};
}

function profileFixture(): OrchestrationProfile {
	return createTestWorkerOrchestrationProfile({
		profileId: "implementer",
		model: { provider: "anthropic", id: "test-model" },
	});
}

function contractFor(profile: OrchestrationProfile) {
	return createWorkerExecutionContract({
		worker: {
			profile,
			modelBinding: profile.modelPolicy.candidates[0]!,
			authority: createTestWorkerExecutionAuthority(profile),
			resourcePointers: [
				{ id: RESOURCE_A, kind: "skill" as const, uri: "file:///repo/alpha.md", readOnly: true },
				{ id: RESOURCE_B, kind: "prompt" as const, uri: "file:///repo/beta.md", readOnly: true },
			],
		},
	});
}

function resumeContext(): AgentResumeContext {
	return {
		provider: "pi",
		sessionId: `worker-${AGENT_ID}`,
		cwd: "/repo",
		resourceProfileNames: [],
		contextPointers: [],
	};
}

function completedResult(handle: StartedDelegationAttempt, criterionIds: readonly string[]): WorkerResultContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: `result-${handle.attemptId}`,
		objectiveId: handle.objectiveId,
		taskId: handle.taskId,
		attemptId: handle.attemptId,
		leaseId: handle.leaseId,
		fencingToken: handle.fencingToken,
		status: "completed",
		reasonCode: "worker_completed",
		summary: "completed",
		artifacts: [],
		evidence: criterionIds.map((criterionId) => ({
			evidenceId: `evidence-${handle.attemptId}-${criterionId}`,
			criterionId,
			kind: "observation" as const,
			summary: `Observed ${criterionId}`,
			artifactIds: [],
			trusted: true,
			createdAt: new Date().toISOString(),
		})),
		errors: [],
		usage: { costUsd: 0, wallClockMs: 1, toolCalls: 0 },
		createdAt: new Date().toISOString(),
	};
}

interface Seam {
	agentDir: string;
	sessionId: string;
	lifecycle: WorkerLifecycle;
	coordinator: WorkerAgentControlCoordinator;
	mailbox: WorkerAgentMailbox;
	objectiveIds(): string[];
	turnTaskIds(): string[];
	/** Run one already-admitted durable turn to completion through the real ledger. */
	settleTurn(taskId: string): void;
	/** A fresh coordinator over the same durable state, as a restarted process would build. */
	restart(): WorkerAgentControlCoordinator;
}

function buildCoordinator(agentDir: string, sessionId: string, lifecycle: WorkerLifecycle) {
	const enqueued: string[] = [];
	// `startWorkerAgentTask` -> mailbox -> reconcile -> prepareAgentTurn uses exactly these deps; one
	// documented cast avoids stubbing the controller's unrelated surface. Production pairs the control
	// coordinator's parent session with the ledger session it writes.
	const coordinator = new WorkerAgentControlCoordinator({
		agentDir,
		parentSessionId: sessionId,
		processOwnerId: "control-hardening-owner",
		isControlAvailable: () => true,
		getLifecycle: () => lifecycle,
		recoveredRequest: (attempt: AttemptRuntimeState): WorkerDelegationRequest =>
			({
				instructions: attempt.dispatch.instructions,
				profileId: attempt.dispatch.profileId,
			}) as WorkerDelegationRequest,
		run: async () => ({ started: false, skipReason: "test_harness_does_not_execute" }),
		scheduler: {
			enqueue: (record: { laneId: string }) => {
				enqueued.push(record.laneId);
				return true;
			},
			track: () => {},
			drain: () => {},
			dropQueued: () => {},
		},
		statusChanged: () => {},
		abortLane: () => {},
		cancelLane: () => undefined,
	} as unknown as ConstructorParameters<typeof WorkerAgentControlCoordinator>[0]);
	return { coordinator, enqueued };
}

/** One idle specialist whose first task completed under its own goal, with a real control seam. */
function seamWithIdleSpecialist(sessionId: string): Seam {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-specialist-control-"));
	roots.push(agentDir);
	const lifecycle = new WorkerLifecycle({ agentDir, sessionId });
	const profile = profileFixture();
	const prepared = lifecycle.prepare(
		{
			instructions: "first task",
			executionContract: contractFor(profile),
			requiredCapabilities: [],
			goal: goalFixture(FIRST_GOAL_ID, FIRST_REQUIREMENT_ID),
			taskContext: {
				requirementIds: [FIRST_REQUIREMENT_ID],
				acceptanceCriterionIds: [FIRST_REQUIREMENT_ID],
				resourcePointerIds: [RESOURCE_A],
				dependsOnTaskIds: [],
			},
		},
		AGENT_ID,
	);
	lifecycle.ensureAgent({ agentId: AGENT_ID, role: profile.role, resumeContext: resumeContext() });
	const settleTurn = (taskId: string): void => {
		const attemptId = lifecycle.getTaskRuntimeSnapshot().tasks[taskId]?.attemptIds.at(-1);
		const task = lifecycle.getTask(taskId);
		if (!attemptId || !task) throw new Error(`no durable attempt for ${taskId}`);
		lifecycle.bindGrant(
			attemptId,
			createTestExecutionGrant({ objectiveId: task.task.objectiveId, taskId, attemptId }),
		);
		const handle = lifecycle.startAgent(taskId, AGENT_ID, LEASE_TTL_MS);
		lifecycle.finish(completedResult(handle, task.task.acceptanceCriterionIds), { notify: false });
	};
	settleTurn(prepared.attempt.taskId);

	return {
		agentDir,
		sessionId,
		lifecycle,
		coordinator: buildCoordinator(agentDir, sessionId, lifecycle).coordinator,
		mailbox: new WorkerAgentMailbox({ agentDir, parentSessionId: sessionId, agentId: AGENT_ID }),
		objectiveIds: () => Object.keys(lifecycle.getTaskRuntimeSnapshot().objectives).sort(),
		turnTaskIds: () =>
			Object.values(lifecycle.getTaskRuntimeSnapshot().attempts)
				.filter((attempt) => attempt.dispatch.logicalLaneId === AGENT_ID && attempt.taskId !== AGENT_ID)
				.map((attempt) => attempt.taskId)
				.sort(),
		settleTurn,
		restart: () => buildCoordinator(agentDir, sessionId, new WorkerLifecycle({ agentDir, sessionId })).coordinator,
	};
}

/**
 * Drive ORDINARY retention until the named message's body is pruned: real peer messages, really
 * delivered, until the durable byte bound drops the oldest completed one.
 */
function pruneDeliveredBody(seam: Seam, messageId: string): void {
	// The task message was delivered to the worker, exactly as the execution path acknowledges it.
	seam.mailbox.acknowledgeDelivered(messageId);
	const filler = "f".repeat(4_000);
	for (let index = 0; index < 96; index++) {
		if (!seam.mailbox.getMessage(messageId)) return;
		const queued = seam.coordinator.sendSessionRootWorkerAgentMessage(AGENT_ID, `${filler} ${index}`);
		seam.mailbox.acknowledgeDelivered(queued.messageId);
	}
	throw new Error("ordinary retention never pruned the delivered task message");
}

/** The session's own registered delegate tool, as production built it. */
function delegateTool(context: ReuseHarness): ToolDefinition {
	const definition = context.harness.session.getToolDefinition("delegate");
	if (!definition) throw new Error("this session registered no delegate tool");
	return definition;
}

function toolContext(context: ReuseHarness): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => context.harness.sessionManager.getSessionId(),
			getLeafId: () => context.harness.sessionManager.getLeafId(),
		},
	} as unknown as ExtensionContext;
}

async function runDelegate(
	context: ReuseHarness,
	toolCallId: string,
	input: DelegateToolInput,
): Promise<DelegateDispatchToolDetails> {
	const result = await delegateTool(context).execute(toolCallId, input, undefined, undefined, toolContext(context));
	const details = result.details;
	if (!details || typeof details !== "object" || Array.isArray(details) || !("started" in details)) {
		throw new TypeError("delegate returned no dispatch details");
	}
	await context.settleLanes();
	return details as DelegateDispatchToolDetails;
}

/** Durable evidence a replay must not disturb. */
function durableShape(context: ReuseHarness) {
	return {
		attempts: context.attempts().length,
		workerRequests: context.workerRequests().length,
		agents: Object.keys(context.agents()).sort(),
	};
}

describe("worker specialist control hardening", () => {
	it("rejects a same-key replay whose intent changed after retention pruned its message", () => {
		const seam = seamWithIdleSpecialist("hardening-pruned-intent");
		const options: WorkerAgentTaskStartOptions = {
			idempotencyKey: "pruned-1",
			newTask: { goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID), requirementIds: [SECOND_REQUIREMENT_ID] },
		};
		const admitted = seam.coordinator.startWorkerAgentTask(AGENT_ID, "pruned intent work", options);
		expect(admitted.messageId).not.toBe("");
		const turnsBefore = seam.turnTaskIds();
		pruneDeliveredBody(seam, admitted.messageId);
		expect(seam.mailbox.getMessage(admitted.messageId)).toBeUndefined();

		const replayedAsContinuation = seam.coordinator.startWorkerAgentTask(AGENT_ID, "pruned intent work", {
			idempotencyKey: "pruned-1",
		});

		// The body is gone, but the durable replay receipt still proves what was admitted. Losing the
		// payload is not permission to accept a different intent under the same receipt.
		expect(replayedAsContinuation.started).toBe(false);
		expect(replayedAsContinuation.skipReason ?? "").toMatch(/conflict/i);
		expect(seam.turnTaskIds()).toEqual(turnsBefore);
	});

	it("rejects a same-key replay whose resource selection changed after retention pruned its message", () => {
		const seam = seamWithIdleSpecialist("hardening-pruned-resources");
		const admitted = seam.coordinator.startWorkerAgentTask(AGENT_ID, "pruned resource work", {
			idempotencyKey: "pruned-2",
			newTask: {
				goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID),
				requirementIds: [SECOND_REQUIREMENT_ID],
				resourcePointerIds: [RESOURCE_A],
			},
		});
		expect(admitted.messageId).not.toBe("");
		const turnsBefore = seam.turnTaskIds();
		pruneDeliveredBody(seam, admitted.messageId);

		const replayedWithOtherResources = seam.coordinator.startWorkerAgentTask(AGENT_ID, "pruned resource work", {
			idempotencyKey: "pruned-2",
			newTask: {
				goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID),
				requirementIds: [SECOND_REQUIREMENT_ID],
				resourcePointerIds: [RESOURCE_B],
			},
		});

		// A different admitted resource is different work even when goal and requirements match.
		expect(replayedWithOtherResources.started).toBe(false);
		expect(replayedWithOtherResources.skipReason ?? "").toMatch(/conflict/i);
		expect(seam.turnTaskIds()).toEqual(turnsBefore);
	});

	it("negative control: the exact same receipt replays onto its own task after pruning and later work", () => {
		const seam = seamWithIdleSpecialist("hardening-exact-replay");
		const options: WorkerAgentTaskStartOptions = {
			idempotencyKey: "exact-1",
			newTask: { goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID), requirementIds: [SECOND_REQUIREMENT_ID] },
		};
		const admitted = seam.coordinator.startWorkerAgentTask(AGENT_ID, "exact replay work", options);
		const originalTaskId = seam.lifecycle.getLatestAgentAttempt(AGENT_ID)?.taskId;
		expect(originalTaskId).toBeDefined();
		// The receipt's own body is pruned by ordinary retention, then the specialist really does more
		// work: its original task settles and a LATER task is admitted and settled through the ledger.
		pruneDeliveredBody(seam, admitted.messageId);
		seam.settleTurn(originalTaskId ?? "");
		const later = seam.coordinator.startWorkerAgentTask(AGENT_ID, "later work", {
			idempotencyKey: "exact-later",
			newTask: { goal: goalFixture("goal-gamma", "req-gamma"), requirementIds: ["req-gamma"] },
		});
		expect(later.messageId).not.toBe("");
		const laterTaskId = seam.lifecycle.getLatestAgentAttempt(AGENT_ID)?.taskId;
		expect(laterTaskId).not.toBe(originalTaskId);
		seam.settleTurn(laterTaskId ?? "");
		const turnsBefore = seam.turnTaskIds();

		const replay = seam.coordinator.startWorkerAgentTask(AGENT_ID, "exact replay work", options);

		// An exact replay still resolves to ITS OWN original task: a blanket refusal of pruned receipts
		// would break this, and so would answering with the specialist's newest task. The record is
		// asserted directly, so a refusal or a missing projection cannot pass as agreement.
		expect(replay.messageId).toBe(admitted.messageId);
		expect(replay.skipReason ?? "").not.toMatch(/conflict/i);
		expect(replay.started).toBe(true);
		expect(replay.record?.laneId).toBe(originalTaskId);
		expect(seam.turnTaskIds()).toEqual(turnsBefore);
	});

	it("does not persist a new objective when the start's own message is refused as oversized", () => {
		const seam = seamWithIdleSpecialist("hardening-oversized-brief");
		const before = seam.objectiveIds();
		const oversized = "x".repeat(MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH + 1);

		let refused = false;
		try {
			const outcome = seam.coordinator.startWorkerAgentTask(AGENT_ID, oversized, {
				idempotencyKey: "oversized-1",
				newTask: { goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID) },
			});
			refused = outcome.started === false;
		} catch {
			refused = true;
		}

		// Nothing was accepted, so nothing of the refused request's context may be durable.
		expect(refused).toBe(true);
		expect(seam.objectiveIds()).toEqual(before);
		expect(seam.objectiveIds()).not.toContain(`goal:${SECOND_GOAL_ID}`);
		expect(seam.turnTaskIds()).toEqual([]);
	});

	it("does not persist a new objective when the mailbox refuses the start at its pending capacity", () => {
		const seam = seamWithIdleSpecialist("hardening-saturated-mailbox");
		// Fill the mailbox's own named pending capacity with real peer messages. The specialist stays
		// idle and has no pending executable work, so the start is refused by the MAILBOX, not by an
		// earlier activity gate.
		for (let index = 0; index < MAILBOX_PENDING_LIMIT; index++) {
			seam.coordinator.sendSessionRootWorkerAgentMessage(AGENT_ID, `saturating message ${index}`);
		}
		expect(seam.mailbox.pending().length).toBeGreaterThanOrEqual(MAILBOX_PENDING_LIMIT);
		const before = seam.objectiveIds();

		let refusal = "";
		try {
			const outcome = seam.coordinator.startWorkerAgentTask(AGENT_ID, "work for a saturated mailbox", {
				idempotencyKey: "saturated-1",
				newTask: { goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID) },
			});
			refusal = outcome.started === false ? (outcome.skipReason ?? "refused") : "started";
		} catch (error) {
			refusal = error instanceof Error ? error.message : String(error);
		}

		expect(refusal).not.toBe("started");
		expect(refusal).toMatch(/message limit|capacity|mailbox/i);
		expect(seam.objectiveIds()).toEqual(before);
		expect(seam.turnTaskIds()).toEqual([]);
	});

	it("negative control: an accepted start persists its goal and its durable turn together", () => {
		const seam = seamWithIdleSpecialist("hardening-accepted-start");

		const accepted = seam.coordinator.startWorkerAgentTask(AGENT_ID, "accepted work", {
			idempotencyKey: "accepted-1",
			newTask: { goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID), requirementIds: [SECOND_REQUIREMENT_ID] },
		});

		expect(accepted.messageId).not.toBe("");
		expect(seam.objectiveIds()).toContain(`goal:${SECOND_GOAL_ID}`);
		expect(seam.turnTaskIds()).toHaveLength(1);
		const attempt = seam.lifecycle.getLatestAgentAttempt(AGENT_ID);
		expect(attempt?.dispatch.requirementIds).toEqual([SECOND_REQUIREMENT_ID]);
	});

	it("recovers an accepted task whose durable preparation failed, from the persisted mailbox alone", () => {
		const seam = seamWithIdleSpecialist("hardening-prepare-failure");
		// The mailbox accepts, then durable preparation fails exactly once: the crash window between
		// an accepted control message and the task it owns.
		const fault = vi.spyOn(seam.lifecycle, "prepareAgentTurn").mockImplementationOnce(() => {
			throw new Error("interrupted before durable task creation");
		});

		const accepted = seam.coordinator.startWorkerAgentTask(AGENT_ID, "interrupted work", {
			idempotencyKey: "recovery-1",
			newTask: { goal: goalFixture(SECOND_GOAL_ID, SECOND_REQUIREMENT_ID), requirementIds: [SECOND_REQUIREMENT_ID] },
		});

		expect(accepted.messageId).not.toBe("");
		expect(accepted.started).toBe(false);
		expect(seam.turnTaskIds()).toEqual([]);
		fault.mockRestore();

		// A restarted process reconciles from the persisted message alone; no caller repeats the task.
		seam.restart().reconcileTaskBearingMailboxTurns();

		const recovered = seam.turnTaskIds();
		expect(recovered).toHaveLength(1);
		const attempt = seam.lifecycle.getLatestAgentAttempt(AGENT_ID);
		expect(attempt?.dispatch.instructions).toBe("interrupted work");
		expect(attempt?.dispatch.requirementIds).toEqual([SECOND_REQUIREMENT_ID]);
	});

	it("rejects an anonymous start that replays one tool call with different instructions", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("first anonymous task done");
		const first = await runDelegate(context, "call-anon", { action: "start", instructions: "Original brief" });
		expect(first.started).toBe(true);
		const before = durableShape(context);

		const changed = await runDelegate(context, "call-anon", { action: "start", instructions: "Different brief" });

		// Same durable tool call, different work: a replay key is not a licence to report someone
		// else's task as this request's result.
		expect(changed.started ? "started" : (changed.skipReason ?? "refused")).not.toBe("started");
		expect(durableShape(context)).toEqual(before);
	});

	it("rejects an anonymous start that replays one tool call with a different admitted grant", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("first anonymous task done");
		const first = await runDelegate(context, "call-grant", { action: "start", instructions: "Grant brief" });
		expect(first.started).toBe(true);
		const before = durableShape(context);

		// readOnly is an admitted narrowing of the same session's tools, not an invalid schema.
		const changed = await runDelegate(context, "call-grant", {
			action: "start",
			instructions: "Grant brief",
			readOnly: true,
		});

		expect(changed.started ? "started" : (changed.skipReason ?? "refused")).not.toBe("started");
		expect(durableShape(context)).toEqual(before);
	});

	it("rejects a replayed tool call whose text changed on the reused specialist", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("first task done");
		context.appendWorkerReply("reused task done");
		await runDelegate(context, "call-1", { action: "start", instructions: "Open the specialist" });
		const reused = await runDelegate(context, "call-reuse", { action: "start", instructions: "Reused brief" });
		expect(reused.started).toBe(true);
		const before = durableShape(context);

		const changed = await runDelegate(context, "call-reuse", { action: "start", instructions: "Rewritten brief" });

		expect(changed.started ? "started" : (changed.skipReason ?? "refused")).not.toBe("started");
		expect(durableShape(context)).toEqual(before);
	});

	it("rejects a replayed tool call whose grant changed on the reused specialist", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("first task done");
		context.appendWorkerReply("second task done");
		await runDelegate(context, "call-1", { action: "start", instructions: "Open the specialist" });
		const reused = await runDelegate(context, "call-reuse", { action: "start", instructions: "Reused brief" });
		expect(reused.started).toBe(true);
		const before = durableShape(context);

		const changedGrant = await runDelegate(context, "call-reuse", {
			action: "start",
			instructions: "Reused brief",
			readOnly: true,
		});

		expect(changedGrant.started ? "started" : (changedGrant.skipReason ?? "refused")).not.toBe("started");
		expect(durableShape(context)).toEqual(before);
	});

	it("rejects a replayed tool call retargeted at a genuinely different specialist", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("first specialist done");
		context.appendWorkerReply("second specialist done");
		const first = await runDelegate(context, "call-target", { action: "start", instructions: "Targeted brief" });
		// A second, genuinely different eligible specialist: its own admitted read-only grant.
		const other = await runDelegate(context, "call-other", {
			action: "start",
			instructions: "Other specialist brief",
			readOnly: true,
		});
		const otherAgentId = other.agentId ?? "";
		expect(otherAgentId).not.toBe("");
		expect(otherAgentId).not.toBe(first.agentId);
		const before = durableShape(context);

		const retargeted = await runDelegate(context, "call-target", {
			action: "start",
			agentId: otherAgentId,
			instructions: "Targeted brief",
		});

		// The original call admitted work on one specialist; replaying it at another specialist is a
		// different request, and must neither be accepted nor answered with the first one's task.
		expect(retargeted.started ? "started" : (retargeted.skipReason ?? "refused")).not.toBe("started");
		expect(retargeted.laneId ?? "").not.toBe(first.laneId ?? "");
		expect(durableShape(context)).toEqual(before);
	});

	it("negative control: the exact same initial and reused tool calls replay with no new work", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("first task done");
		context.appendWorkerReply("reused task done");
		const initial = await runDelegate(context, "call-initial", { action: "start", instructions: "Initial brief" });
		const afterInitial = durableShape(context);

		const initialReplay = await runDelegate(context, "call-initial", {
			action: "start",
			instructions: "Initial brief",
		});

		expect(initialReplay.started).toBe(true);
		expect(initialReplay.laneId).toBe(initial.laneId);
		expect(durableShape(context)).toEqual(afterInitial);

		const reused = await runDelegate(context, "call-reuse", { action: "start", instructions: "Reused brief" });
		expect(reused.agentId).toBe(initial.agentId);
		const afterReuse = durableShape(context);

		const reusedReplay = await runDelegate(context, "call-reuse", { action: "start", instructions: "Reused brief" });

		expect(reusedReplay.started).toBe(true);
		expect(reusedReplay.laneId).toBe(reused.laneId);
		expect(reusedReplay.agentId).toBe(reused.agentId);
		expect(durableShape(context)).toEqual(afterReuse);
	});
});
