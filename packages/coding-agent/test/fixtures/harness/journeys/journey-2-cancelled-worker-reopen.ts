import "../builtin-install.ts";
import { expect } from "vitest";
import type { WorkerAgentControlPort } from "../../../../src/core/delegation/worker-agent-control.ts";
import { WorkerConversationStore } from "../../../../src/core/delegation/worker-conversation-store.ts";
import { readWorkerMailboxRecord, workerMailboxPath } from "../../../../src/core/delegation/worker-mailbox-record.ts";
import { cancelPersistedGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import { createGoalState } from "../../../../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../../../../src/core/goals/goal-tool-core.ts";
import { goalObjectiveId } from "../../../../src/core/orchestration/work-state-projection.ts";
import { isPlainRecord } from "../../../../src/core/util/value-guards.ts";
import { calls, createBarrier, HARNESS_PROVIDER, type ScriptedRequest, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { LIMITS_PATH, requestTexts } from "./shared.ts";

/** Cancelling an ordinary task steer must not strand its context or revive that task after close. */
export async function verifyCancelledWorkerCleanReopen(world: HarnessWorld): Promise<void> {
	const label = "goal-cancel-pending-worker-reopen";
	const agentDir = `${world.agentDir}-${label}`;
	const instructions = "Read the limits source and report its current text.";
	const pendingWords = `${label}: Include the original limits observation in this task's report.`;
	const bWords = `${label}: Report the retained limits observation for the second objective.`;
	const sourceBytes = world.io.readFileSync(LIMITS_PATH, "utf8").toString();
	const oldReached = createBarrier();
	const oldGate = createBarrier();
	const freshReached = createBarrier();
	const freshGate = createBarrier();
	const refused = createBarrier();
	const terminalReached = createBarrier();
	const owner = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
	});
	let fresh: Awaited<ReturnType<HarnessWorld["createRootSession"]>> | undefined;
	let ownerClosed = false;
	let unsubscribe = (): void => {};
	let workerRequestsBeforeB = 0;
	let bRequested = false;
	let bProviderRequests = 0;
	let terminalRequests = 0;
	let oldReports = 0;
	let bRequest: ScriptedRequest | undefined;
	let terminalPostsAfterCleanup: number | undefined;
	let bLaneId: string | undefined;
	let bMessageId: string | undefined;
	let resumedWorkerFile: string | undefined;
	let oldLaneId: string | undefined;
	let oldTerminalPostsAfterCleanup: number | undefined;
	const failures: unknown[] = [];
	const observations: Record<string, unknown> = {
		systemOneEnabled: world.systemOne.enabled,
		pid: world.processTable.self,
	};
	const report = (): string => {
		const serialized = JSON.stringify({
			...observations,
			oldReports,
			workerRequestsBeforeB,
			bProviderRequests,
			terminalRequests,
		});
		const bytes = Buffer.byteLength(serialized, "utf8");
		const cancelled = isPlainRecord(observations.cancelled) ? observations.cancelled : undefined;
		const reopened = isPlainRecord(observations.fresh) ? observations.fresh : undefined;
		const output =
			bytes <= 8_192
				? serialized
				: JSON.stringify({
						reportBytes: bytes,
						failure: observations.failure,
						admitted: observations.admitted,
						cancelled: {
							result: cancelled?.result,
							goal: cancelled?.goal,
							agentStatus: cancelled?.agentStatus,
							attemptStatus: cancelled?.attemptStatus,
							ownership: cancelled?.ownership,
							executionPromiseCount: cancelled?.executionPromiseCount,
							oldControlEntries: cancelled?.oldControlEntries,
						},
						fresh: {
							disposition: reopened?.disposition,
							originalAttempt: reopened?.originalAttempt,
							goalId: reopened?.goalId,
						},
						bStartError: observations.bStartError,
						oldReports,
						workerRequestsBeforeB,
						bProviderRequests,
						terminalRequests,
					});
		console.info(`CANCELLED_WORKER_REOPEN ${output}`);
		expect(bytes, output).toBeLessThanOrEqual(8_192);
		return output;
	};
	const assertRead = (request: ScriptedRequest): void => {
		expect(requestTexts(request).some((value) => value.includes(instructions))).toBe(true);
		expect(
			request.context.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter(
							(part) => part.type === "toolCall" && part.id === `${label}-read` && part.name === "read",
						)
					: [],
			),
		).toHaveLength(1);
		const results = request.context.messages.filter(
			(message) => message.role === "toolResult" && message.toolCallId === `${label}-read`,
		);
		expect(results).toHaveLength(1);
		expect(
			results[0]?.role === "toolResult" &&
				!results[0].isError &&
				results[0].content.some((part) => part.type === "text" && part.text.includes(sourceBytes.trim())),
		).toBe(true);
	};
	world.systemOne.enterPhase(`${label}-start`, {});
	world.provider.enqueue(
		"worker-c",
		calls(`${label}-read`, [{ id: `${label}-read`, name: "read", arguments: { path: LIMITS_PATH } }]),
		{
			...calls(`${label}-old-report`, [
				{
					id: `${label}-old-report`,
					name: "submit_report",
					arguments: { status: "completed", summary: `Observed source: ${sourceBytes.trim()}` },
				},
			]),
			check: (request) => {
				assertRead(request);
				oldReports++;
				oldReached.release();
			},
			gate: oldGate.promise,
		},
	);
	try {
		// A new manager buffers custom goal entries until a real reply/lifecycle publication.
		// Establish this parent's durable identity through its public conversation before relying on reopen.
		const warmReply = "The limits boundary remains under inspection.";
		const warmRequestsBefore = world.provider.requests.length;
		world.systemOne.enterPhase(`${label}-persist-parent`, {});
		world.provider.enqueue("root", text(`${label}-persist-parent`, warmReply));
		await withDeadline(world.trace, `${label}: real parent reply`, owner.session.prompt("Hello."));
		await withDeadline(world.trace, `${label}: parent reply settles`, owner.session.waitForForegroundIdle());
		const persistedFile = owner.sessionManager.getSessionFile();
		if (!persistedFile) throw new Error(`${label}: parent reply has no canonical file`);
		const persistedParent = world.openSessionManager(persistedFile, agentDir);
		const persistedReplies = persistedParent
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some((part) => part.type === "text" && part.text === warmReply),
			);
		observations.parentPersistence = {
			parentSessionId: owner.sessionManager.getSessionId(),
			coldParentSessionId: persistedParent.getSessionId(),
			assistantReplies: persistedReplies.length,
			providerRequests: world.provider.requests.length - warmRequestsBefore,
		};
		expect(persistedParent.getSessionId(), report()).toBe(owner.sessionManager.getSessionId());
		expect(persistedReplies).toHaveLength(1);
		expect(world.provider.requests.length - warmRequestsBefore).toBe(1);
		world.systemOne.enterPhase(`${label}-start`, {});
		const a = createGoalState({
			goalId: `${label}-a`,
			userGoal: "Inspect the first limits boundary.",
			now: new Date().toISOString(),
		});
		owner.session.saveGoalStateSnapshot(a);
		const started = await owner.session.backgroundLanes.startWorkerDelegation({
			instructions,
			objectiveId: goalObjectiveId(a.goalId),
			authority: { model: { provider: HARNESS_PROVIDER, modelId: "worker-c" }, readOnly: true },
		});
		if (!started.started) throw new Error(`${label}: initial worker admission refused: ${started.skipReason}`);
		oldLaneId = started.record.laneId;
		await withDeadline(world.trace, `${label}: actual read before old report`, oldReached.promise);
		const runtime = owner.session.backgroundLanes.getTaskRuntimeSnapshot();
		const attempt = Object.values(runtime?.attempts ?? {}).find((item) => item.taskId === started.record.laneId);
		const agent = Object.values(runtime?.agents ?? {}).find((item) => item.activeAttemptId === attempt?.attemptId);
		const file = owner.sessionManager.getSessionFile();
		if (!attempt || !agent || !file || !agent.resumeContext.sessionFile)
			throw new Error(`${label}: missing admitted worker identity`);
		const workerFile = agent.resumeContext.sessionFile;
		resumedWorkerFile = workerFile;
		expect(runtime?.tasks[started.record.laneId]?.task.objectiveId).toBe(goalObjectiveId(a.goalId));
		expect(attempt.lease).toBeDefined();
		const bindingOptions = {
			agentDir,
			resumeContext: agent.resumeContext,
			expectedLogicalAgentId: agent.contextOrigin?.logicalAgentId ?? agent.agentId,
		};
		const beforeBinding = new WorkerConversationStore().getProjectContextBinding(bindingOptions);
		expect(beforeBinding?.ownership.state).toBe("busy");
		const queued = owner.session.backgroundLanes.followUpWorkerAgent(agent.agentId, pendingWords);
		const mailboxFile = workerMailboxPath(agentDir, owner.sessionManager.getSessionId(), agent.agentId);
		const pending = readWorkerMailboxRecord(mailboxFile).mailbox;
		expect(queued).toMatchObject({ started: false, steering: true });
		expect(queued.skipReason).toBeUndefined();
		expect(pending).toMatchObject({
			messages: [
				{ messageId: queued.messageId, content: pendingWords, kind: "steer", task: { kind: "agent_turn" } },
			],
		});
		if (!isPlainRecord(pending) || !Array.isArray(pending.messages) || !isPlainRecord(pending.messages[0]))
			throw new Error(`${label}: missing native pending steer`);
		expect(pending.messages[0].deliveredAt).toBeUndefined();
		expect(pending.messages[0].failedAt).toBeUndefined();
		expect(pending.messages[0].expectReply).not.toBe(true);
		expect(pending.messages[0].replyToMessageId).toBeUndefined();
		observations.admitted = {
			agentId: agent.agentId,
			attemptId: attempt.attemptId,
			objectiveId: runtime?.tasks[started.record.laneId]?.task.objectiveId,
			pendingMessageId: queued.messageId,
			ownership: beforeBinding?.ownership,
		};
		// No await: close this controller before aborted execution can reconcile the pending task into new work.
		const cancelled = cancelPersistedGoal(owner.session);
		owner.session.dispose();
		const disposal = await world.disposeSessionInBody(owner.session);
		ownerClosed = true;
		const cancelledRuntime = owner.session.backgroundLanes.getTaskRuntimeSnapshot();
		const settledMailbox = readWorkerMailboxRecord(mailboxFile).mailbox;
		const closedBinding = new WorkerConversationStore().getProjectContextBinding(bindingOptions);
		const closed = owner.session.getResourceSnapshot().workers;
		const oldTranscript = world.openSessionManager(workerFile, agentDir).getBranch();
		const oldControlEntries = oldTranscript.filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(`[Worker control ${queued.messageId}`),
		);
		observations.cancelled = {
			result: cancelled.ok,
			goal: owner.session.getGoalStateSnapshot()?.status,
			goalTokensUsed: owner.session.getGoalStateSnapshot()?.tokensUsed,
			agentStatus: cancelledRuntime?.agents[agent.agentId]?.status,
			activeAttemptId: cancelledRuntime?.agents[agent.agentId]?.activeAttemptId,
			attemptStatus: cancelledRuntime?.attempts[attempt.attemptId]?.status,
			mailbox: settledMailbox,
			ownership: closedBinding?.ownership,
			disposal: disposal && String(disposal.error),
			claims: closed?.ownedProjectClaims,
			executionPromiseCount: closed?.executionPromiseCount,
			executingHolds: closed?.executingHolds,
			inFlightLedgerCount: closed?.inFlightLedgerCount,
			oldControlEntries: oldControlEntries.length,
		};
		// Arm both tracks before fresh construction: constructor recovery is itself an observable producer.
		world.systemOne.enterPhase(`${label}-reopen`, {});
		world.provider.enqueue("worker-c", {
			...calls(`${label}-potential-b-report`, [
				{
					id: `${label}-b-report`,
					name: "submit_report",
					arguments: { status: "completed", summary: `Observed source: ${sourceBytes.trim()}` },
				},
			]),
			check: (request) => {
				bRequest = request;
				if (bRequested) bProviderRequests++;
				else workerRequestsBeforeB++;
				observations.workerRequest = {
					beforeB: !bRequested,
					pendingWordsPresent: requestTexts(request).some((value) => value.includes(pendingWords)),
					pendingControlPresent: JSON.stringify(request.context.messages).includes(
						`[Worker control ${queued.messageId}`,
					),
					bWordsCount: requestTexts(request).filter((value) => value.includes(bWords)).length,
				};
				freshReached.release();
			},
			gate: freshGate.promise,
		});
		world.provider.enqueue("root", {
			...text(`${label}-b-terminal`, "The second limits report is noted."),
			check: (request) => {
				observations.parentRequest = {
					bLaneId,
					hasMatchingTerminal: requestTexts(request).some(
						(value) =>
							value.includes("Background worker terminal handoff") && value.includes(`- ${bLaneId}: succeeded`),
					),
				};
				terminalRequests++;
				terminalReached.release();
			},
		});
		const warningsBefore = world.warnings.length;
		fresh = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.openSessionManager(file, agentDir),
		});
		const refusalWarning = (message: string): boolean =>
			message.startsWith("Worker conversation setup failed:") ||
			message.startsWith("Worker setup failed:") ||
			message.includes("no proof of never-started");
		unsubscribe = fresh.session.subscribe((event) => {
			if (event.type === "warning" && refusalWarning(event.message)) {
				observations.refusal = event.message.slice(0, 700);
				refused.release();
			}
			if (
				event.type === "delegate_workers" &&
				event.terminalSinceFlush.some(
					(item) => item.laneId !== oldLaneId && (item.status === "failed" || item.status === "canceled"),
				)
			) {
				observations.refusalTerminal = event.terminalSinceFlush;
				refused.release();
			}
			if (event.type === "delegate_workers" && event.terminalSinceFlush.some((item) => item.laneId === oldLaneId))
				observations.cancelledTerminalEvent = event.terminalSinceFlush.filter((item) => item.laneId === oldLaneId);
		});
		const constructionRefusal = world.warnings.slice(warningsBefore).find(refusalWarning);
		if (constructionRefusal) {
			observations.refusal = constructionRefusal.slice(0, 700);
			refused.release();
		}
		const b = applyGoalAction(
			fresh.session.getGoalStateSnapshot(),
			{ action: "start", goalId: `${label}-b`, userGoal: "Inspect the second limits boundary." },
			new Date().toISOString(),
		);
		if (!b.ok) throw new Error(b.error);
		fresh.session.saveGoalStateSnapshot(b.state);
		bRequested = true;
		let bStart: ReturnType<WorkerAgentControlPort["startWorkerAgentTask"]> | undefined;
		try {
			bStart = fresh.session.backgroundLanes.startWorkerAgentTask(agent.agentId, bWords, {
				newTask: { goal: b.state },
				idempotencyKey: `${label}-b-start`,
			});
		} catch (error) {
			observations.bStartError = String(error).slice(0, 700);
			failures.push(error);
			refused.release();
		}
		bLaneId = bStart?.record?.laneId;
		bMessageId = bStart?.messageId;
		observations.bStart = bStart;
		if (!bStart?.started || bStart.skipReason) refused.release();
		const disposition = await withDeadline(
			world.trace,
			`${label}: fresh B provider or refusal`,
			Promise.race([
				freshReached.promise.then(() => "provider" as const),
				refused.promise.then(() => "refused" as const),
			]),
			60_000,
		);
		const freshRuntime = fresh.session.backgroundLanes.getTaskRuntimeSnapshot();
		observations.fresh = {
			pid: world.processTable.self,
			parentSessionId: fresh.sessionManager.getSessionId(),
			disposition,
			originalAttempt: freshRuntime?.attempts[attempt.attemptId]?.status,
			attempts: Object.values(freshRuntime?.attempts ?? {}).map((item) => ({
				attemptId: item.attemptId,
				taskId: item.taskId,
				status: item.status,
			})),
			claims: fresh.session.getResourceSnapshot().workers?.ownedProjectClaims,
			goalId: fresh.session.getGoalStateSnapshot()?.goalId,
			goalTokensUsed: fresh.session.getGoalStateSnapshot()?.tokensUsed,
			warningCount: world.warnings.length - warningsBefore,
			warnings: world.warnings
				.slice(warningsBefore)
				.slice(-6)
				.map((warning) => warning.slice(0, 500)),
		};
		const diagnostic = report();
		// Policy assertions follow the actual cancellation/close/fresh-start observations.
		expect(cancelled.ok, diagnostic).toBe(true);
		expect(disposal, diagnostic).toBeUndefined();
		expect(cancelledRuntime?.attempts[attempt.attemptId]?.status, diagnostic).toBe("cancelled");
		expect(cancelledRuntime?.agents[agent.agentId], diagnostic).toMatchObject({ status: "registered" });
		expect(cancelledRuntime?.agents[agent.agentId]?.activeAttemptId, diagnostic).toBeUndefined();
		expect(closed?.ownedProjectClaims, diagnostic).toEqual([]);
		expect(closed?.executionPromiseCount, diagnostic).toBe(0);
		expect(closed?.executingHolds, diagnostic).toEqual([]);
		expect(closed?.inFlightLedgerCount, diagnostic).toBe(0);
		if (!isPlainRecord(settledMailbox) || !Array.isArray(settledMailbox.messages))
			throw new Error(`${label}: missing settled mailbox`);
		const receipt: unknown = settledMailbox.messages.find(
			(message: unknown) => isPlainRecord(message) && message.messageId === queued.messageId,
		);
		if (!isPlainRecord(receipt)) throw new Error(`${label}: missing cancelled steer receipt`);
		expect(receipt.failedAt, diagnostic).toEqual(expect.any(String));
		expect(receipt.failureReason, diagnostic).toEqual(expect.stringMatching(/\S/));
		expect(receipt.deliveredAt, diagnostic).toBeUndefined();
		expect(oldControlEntries, diagnostic).toEqual([]);
		expect(workerRequestsBeforeB, diagnostic).toBe(0);
		expect(freshRuntime?.attempts[attempt.attemptId]?.status, diagnostic).toBe("cancelled");
		expect(world.processTable.self, diagnostic).toBe(observations.pid);
		expect(fresh.sessionManager.getSessionId(), diagnostic).toBe(owner.sessionManager.getSessionId());
		expect(disposition, diagnostic).toBe("provider");
		expect(bStart?.started, diagnostic).toBe(true);
		expect(bStart?.skipReason, diagnostic).toBeUndefined();
		if (!bRequest || !bLaneId) throw new Error(`${label}: no actual B request/lane`);
		assertRead(bRequest);
		expect(freshRuntime?.agents[agent.agentId]?.resumeContext, diagnostic).toEqual(agent.resumeContext);
		expect(freshRuntime?.tasks[bLaneId]?.task.objectiveId, diagnostic).toBe(goalObjectiveId(b.state.goalId));
		expect(
			Object.values(freshRuntime?.attempts ?? {}).filter((item) => item.taskId === bLaneId),
			diagnostic,
		).toHaveLength(1);
		expect(bLaneId, diagnostic).not.toBe(started.record.laneId);
		expect(JSON.stringify(bRequest.context.messages), diagnostic).not.toContain(pendingWords);
		expect(JSON.stringify(bRequest.context.messages), diagnostic).not.toContain(
			`[Worker control ${queued.messageId}`,
		);
		expect(
			requestTexts(bRequest).filter((value) => value.includes(bWords)),
			diagnostic,
		).toHaveLength(1);
		freshGate.release();
		await withDeadline(world.trace, `${label}: B terminal parent`, terminalReached.promise);
		await withDeadline(world.trace, `${label}: B parent idle`, fresh.session.waitForForegroundIdle());
		expect(
			await withDeadline(
				world.trace,
				`${label}: B worker settles`,
				fresh.session.backgroundLanes.waitForWorkerAgent(agent.agentId, 60_000),
			),
		).toMatchObject({ timedOut: false, status: "idle" });
		expect(observations.parentRequest).toMatchObject({ hasMatchingTerminal: true });
		expect(fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[attempt.attemptId]?.status).toBe(
			"cancelled",
		);
		expect(bProviderRequests).toBe(1);
		observations.bTerminal = {
			goalId: fresh.session.getGoalStateSnapshot()?.goalId,
			goalTokensUsed: fresh.session.getGoalStateSnapshot()?.tokensUsed,
			attempt: bLaneId && fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.tasks[bLaneId]?.task.status,
		};
		expect(fresh.session.getResourceSnapshot().workers?.ownedProjectClaims).toEqual([]);
	} catch (error) {
		observations.failure = String(error).slice(0, 700);
		failures.push(error);
	} finally {
		freshGate.release();
		if (!ownerClosed) {
			const disposal = await world.disposeSessionInBody(owner.session);
			if (disposal) failures.push(disposal.error);
		}
		oldGate.release();
		if (fresh) {
			const disposal = await world.disposeSessionInBody(fresh.session);
			if (disposal) failures.push(disposal.error);
			terminalPostsAfterCleanup = fresh.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "background-worker-completion" &&
						JSON.stringify(entry.content).includes(`- ${bLaneId}: succeeded`),
				).length;
			oldTerminalPostsAfterCleanup = fresh.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "background-worker-completion" &&
						JSON.stringify(entry.content).includes(`- ${oldLaneId}: canceled`),
				).length;
			observations.cleanup = {
				disposal: disposal && String(disposal.error),
				claims: fresh.session.getResourceSnapshot().workers?.ownedProjectClaims,
				terminalPostsAfterCleanup,
				oldTerminalPostsAfterCleanup,
			};
		}
		unsubscribe();
		try {
			report();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, `${label}: diagnostic and cleanup failed`);
	if (!resumedWorkerFile) throw new Error(`${label}: no canonical worker transcript`);
	const transcript = world.openSessionManager(resumedWorkerFile, agentDir).getBranch();
	expect(
		transcript.filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(bWords),
		),
	).toHaveLength(1);
	expect(JSON.stringify(transcript)).toContain(`[Worker control ${bMessageId}`);
	expect(JSON.stringify(transcript)).not.toContain(pendingWords);
	expect(oldTerminalPostsAfterCleanup).toBeLessThanOrEqual(1);
	expect({
		oldReports,
		workerRequestsBeforeB,
		bProviderRequests,
		terminalRequests,
		terminalPostsAfterCleanup,
	}).toEqual({
		oldReports: 1,
		workerRequestsBeforeB: 0,
		bProviderRequests: 1,
		terminalRequests: 1,
		terminalPostsAfterCleanup: 1,
	});
}
