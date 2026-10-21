import "../builtin-install.ts";
import { expect } from "vitest";
import { WorkerConversationStore } from "../../../../src/core/delegation/worker-conversation-store.ts";
import { readWorkerMailboxRecord, workerMailboxPath } from "../../../../src/core/delegation/worker-mailbox-record.ts";
import { isPlainRecord } from "../../../../src/core/util/value-guards.ts";
import { calls, createBarrier, HARNESS_PROVIDER, type ScriptedRequest, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { assertBatchOk, LIMITS_PATH, lastToolResultDetails, requestTexts } from "./shared.ts";

/** Clean shutdown/reopen of enrolled, previously running work; E7's unsafe crash control stays separate. */
export async function verifyEnrolledWorkerCleanReopen(world: HarnessWorld, pendingFollowUp = false): Promise<void> {
	const label = pendingFollowUp ? "e7-enrolled-pending-reopen" : "e7-enrolled-clean-reopen";
	const pendingWords = `${label}: Include the original source observation in the resumed report.`;
	const agentDir = `${world.agentDir}-${label}`;
	const instructions = "Read the limits file and report its current value after the owner resumes this inspection.";
	const sourceBytes = world.io.readFileSync(LIMITS_PATH, "utf8").toString();
	const readId = `${label}-read`;
	const oldReached = createBarrier();
	const oldGate = createBarrier();
	const freshReached = createBarrier();
	const freshGate = createBarrier();
	const terminalReached = createBarrier();
	const resumeRefused = createBarrier();
	const owner = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
	});
	let fresh: Awaited<ReturnType<HarnessWorld["createRootSession"]>> | undefined;
	let ownerClosed = false;
	let agentId: string | undefined;
	let laneId: string | undefined;
	let oldRequests = 0;
	let resumedRequests = 0;
	let terminalRequests = 0;
	let terminalPostsAfterCleanup = 0;
	let pendingMessageId: string | undefined;
	let pendingMailbox: unknown;
	let unsubscribeFresh = (): void => {};
	const failures: unknown[] = [];
	const observations: Record<string, unknown> = {
		pid: world.processTable.self,
		systemOneEnabled: world.systemOne.enabled,
		pendingFollowUp,
	};
	const report = (): string => {
		const serialized = JSON.stringify({
			...observations,
			agentId,
			laneId,
			oldRequests,
			resumedRequests,
			terminalRequests,
		});
		const bytes = Buffer.byteLength(serialized, "utf8");
		const output =
			bytes <= 8_192
				? serialized
				: JSON.stringify({
						agentId,
						laneId,
						oldRequests,
						resumedRequests,
						terminalRequests,
						reportBytes: bytes,
						failure: observations.failure,
						admitted: observations.admitted,
						resume: observations.resume,
					});
		console.info(`ENROLLED_WORKER_REOPEN ${output}`);
		expect(bytes, output).toBeLessThanOrEqual(8_192);
		return output;
	};
	const assertRead = (request: ScriptedRequest): void => {
		expect(
			requestTexts(request).some((value) => value.includes(instructions)),
			`${label}: original instructions survive`,
		).toBe(true);
		const readCalls = request.context.messages.flatMap((message) =>
			message.role === "assistant"
				? message.content.filter((part) => part.type === "toolCall" && part.id === readId && part.name === "read")
				: [],
		);
		const readResults = request.context.messages.filter(
			(message) => message.role === "toolResult" && message.toolCallId === readId,
		);
		expect(readCalls, `${label}: original read call survives once`).toHaveLength(1);
		expect(readResults, `${label}: original read result survives once`).toHaveLength(1);
		expect(readResults[0]?.role === "toolResult" && readResults[0].isError).toBe(false);
		expect(
			readResults[0]?.role === "toolResult" &&
				readResults[0].content.some((part) => part.type === "text" && part.text.includes(sourceBytes.trim())),
		).toBe(true);
	};
	world.provider.enqueue(
		"worker-c",
		calls(`${label}-read`, [{ id: readId, name: "read", arguments: { path: LIMITS_PATH } }]),
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
				oldRequests++;
				oldReached.release();
			},
			gate: oldGate.promise,
		},
	);
	world.provider.enqueue(
		"root",
		calls(`${label}-start`, [
			{
				id: `${label}-start`,
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: HARNESS_PROVIDER, modelId: "worker-c" },
					instructions,
					readOnly: true,
				},
			},
		]),
		{
			...text(`${label}-started`, "The source inspection is waiting."),
			check: (request) => {
				assertBatchOk(request, label);
				const details = lastToolResultDetails(owner.session, "delegate");
				if (
					typeof details !== "object" ||
					details === null ||
					!("agentId" in details) ||
					!("laneId" in details) ||
					typeof details.agentId !== "string" ||
					typeof details.laneId !== "string"
				)
					throw new Error(`${label}: missing actual worker identity`);
				agentId = details.agentId;
				laneId = details.laneId;
			},
		},
	);
	world.systemOne.enterPhase(`${label}-start`, {
		capabilities_authorized: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
	});
	try {
		await withDeadline(
			world.trace,
			`${label}: admitted dispatch`,
			owner.session.prompt("Start the source inspection."),
		);
		await withDeadline(world.trace, `${label}: actual read before held report`, oldReached.promise);
		await withDeadline(world.trace, `${label}: root idle`, owner.session.waitForForegroundIdle());
		if (!agentId || !laneId) throw new Error(`${label}: no worker identity`);
		const before = owner.session.backgroundLanes.getTaskRuntimeSnapshot();
		const agent = before?.agents[agentId];
		const attempt = Object.values(before?.attempts ?? {}).find((item) => item.taskId === laneId);
		const file = owner.sessionManager.getSessionFile();
		if (!agent || !attempt || !file || !agent.resumeContext.sessionFile)
			throw new Error(`${label}: no admitted worker/session record`);
		const workerFile = agent.resumeContext.sessionFile;
		const binding = new WorkerConversationStore().getProjectContextBinding({
			agentDir,
			resumeContext: agent.resumeContext,
			expectedLogicalAgentId: agent.contextOrigin?.logicalAgentId ?? agentId,
		});
		expect(binding?.ownership.state, `${label}: producer is an enrolled busy project context`).toBe("busy");
		expect(attempt.lease, `${label}: this attempt actually ran`).toBeDefined();
		const admittedClaim = owner.session
			.getResourceSnapshot()
			.workers?.ownedProjectClaims.find((claim) => claim.sessionId === agent.resumeContext.sessionId);
		if (!admittedClaim) throw new Error(`${label}: no admitted project claim`);
		if (binding?.ownership.state !== "busy") throw new Error(`${label}: missing busy native enrollment`);
		expect(binding.ownership.claim).toEqual(admittedClaim.claim);
		if (pendingFollowUp) {
			// No await before close: the consumed old report remains gated while this native intent is persisted.
			const queued = owner.session.backgroundLanes.followUpWorkerAgent(agentId, pendingWords);
			pendingMessageId = queued.messageId;
			const native = readWorkerMailboxRecord(
				workerMailboxPath(agentDir, owner.sessionManager.getSessionId(), agentId),
			);
			observations.pending = { queued, native };
			pendingMailbox = native.mailbox;
			expect(queued).toMatchObject({ started: false, steering: true });
			expect(queued.skipReason).toBeUndefined();
			expect(pendingMessageId).not.toBe("");
			expect(native.mailbox).toMatchObject({
				messages: [
					{
						messageId: pendingMessageId,
						kind: "steer",
						content: pendingWords,
						task: { kind: "agent_turn" },
					},
				],
			});
			if (!isPlainRecord(native.mailbox) || !Array.isArray(native.mailbox.messages))
				throw new Error(`${label}: missing native mailbox messages`);
			const receipt: unknown = native.mailbox.messages[0];
			if (!isPlainRecord(receipt)) throw new Error(`${label}: missing native pending receipt`);
			expect(receipt.deliveredAt).toBeUndefined();
			expect(receipt.failedAt).toBeUndefined();
		}
		observations.admitted = {
			parentSessionId: owner.sessionManager.getSessionId(),
			workerSessionId: agent.resumeContext.sessionId,
			attemptId: attempt.attemptId,
			ownership: binding.ownership,
			instructions,
			workerSessionFile: agent.resumeContext.sessionFile,
			sourceBytes,
		};
		// Keep the consumed old response gated: actual abort/disposal, not its late reply, ends the old producer.
		const disposal = await world.disposeSessionInBody(owner.session);
		ownerClosed = true;
		const closed = owner.session.getResourceSnapshot().workers;
		observations.oldClose = {
			disposal: disposal && String(disposal.error),
			executionPromiseCount: closed?.executionPromiseCount,
			executingHolds: closed?.executingHolds,
			inFlightLedgerCount: closed?.inFlightLedgerCount,
			scheduler: closed?.scheduler,
			claims: closed?.ownedProjectClaims,
		};
		expect(disposal, report()).toBeUndefined();
		world.certifyDisposedOwner(owner.session, []);
		expect(closed?.ownedProjectClaims, `${label}: the closed owner retains no executable claim`).toEqual([]);
		expect(closed?.executionPromiseCount).toBe(0);
		expect(closed?.executingHolds).toEqual([]);
		expect(closed?.inFlightLedgerCount).toBe(0);
		const suspended = owner.session.backgroundLanes.getTaskRuntimeSnapshot();
		expect(suspended?.agents[agentId]?.status).toBe("suspended");
		expect(suspended?.attempts[attempt.attemptId]?.status).toBe("suspended");
		expect(suspended?.attempts[attempt.attemptId]?.dispatch).toEqual(attempt.dispatch);
		const handoff = new WorkerConversationStore().getProjectContextBinding({
			agentDir,
			resumeContext: agent.resumeContext,
			expectedLogicalAgentId: agent.contextOrigin?.logicalAgentId ?? agentId,
		});
		observations.handoff = handoff?.ownership;
		expect(handoff?.ownership).toEqual({ ...binding.ownership, state: "handoff" });
		if (pendingFollowUp) {
			const native = readWorkerMailboxRecord(
				workerMailboxPath(agentDir, owner.sessionManager.getSessionId(), agentId),
			);
			observations.pendingAfterClose = native.reference;
			expect(native.mailbox, `${label}: close preserves the exact undelivered intent and acknowledgements`).toEqual(
				pendingMailbox,
			);
		}
		world.systemOne.enterPhase(`${label}-resume`, {});
		// Reopening can itself recover; enroll both real response tracks before constructing its SDK owner.
		world.provider.enqueue("worker-c", {
			...calls(`${label}-resumed-report`, [
				{
					id: `${label}-report`,
					name: "submit_report",
					arguments: { status: "completed", summary: `Observed source: ${sourceBytes.trim()}` },
				},
			]),
			check: (request) => {
				assertRead(request);
				if (pendingFollowUp) {
					const pending = requestTexts(request).filter((value) => value.includes(pendingWords));
					observations.resumedPending = pending;
					expect(pending, `${label}: admitted pending words reach the resumed provider once`).toHaveLength(1);
					expect(pending[0]?.split(pendingWords)).toHaveLength(2);
					expect(pending[0]).toContain(`[Worker control ${pendingMessageId}`);
				}
				resumedRequests++;
				freshReached.release();
			},
			gate: freshGate.promise,
		});
		world.provider.enqueue("root", {
			...text(`${label}-terminal`, "The source inspection report is noted."),
			check: (request) => {
				expect(
					requestTexts(request).some(
						(value) =>
							value.includes("Background worker terminal handoff") && value.includes(`- ${laneId}: succeeded`),
					),
				).toBe(true);
				terminalRequests++;
				terminalReached.release();
			},
		});
		const warningsBeforeReopen = world.warnings.length;
		fresh = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.openSessionManager(file, agentDir),
		});
		const refusalWarning = (message: string): boolean =>
			message.includes("no proof of never-started") ||
			message.startsWith("Worker conversation setup failed:") ||
			message.startsWith("Worker setup failed:");
		unsubscribeFresh = fresh.session.subscribe((event) => {
			if (event.type === "warning" && refusalWarning(event.message)) {
				observations.refusalEvent = event.message.slice(0, 700);
				resumeRefused.release();
			}
			if (
				event.type === "delegate_workers" &&
				event.terminalSinceFlush.some((item) => item.laneId === laneId && item.status !== "succeeded")
			) {
				observations.refusalEvent = event.terminalSinceFlush.filter((item) => item.laneId === laneId);
				resumeRefused.release();
			}
		});
		// A refusal emitted during completed SDK construction is observed at that public return boundary.
		const constructionRefusal = world.warnings.slice(warningsBeforeReopen).find(refusalWarning);
		if (constructionRefusal) {
			observations.refusalEvent = constructionRefusal.slice(0, 700);
			resumeRefused.release();
		}
		expect(world.processTable.self, `${label}: no simulated process death`).toBe(observations.pid);
		expect(fresh.sessionManager.getSessionId()).toBe(owner.sessionManager.getSessionId());
		fresh.session.getLaneRecords();
		const recovered = fresh.session.backgroundLanes.getTaskRuntimeSnapshot();
		const recoveredAttempt = recovered?.attempts[attempt.attemptId];
		const resume =
			recoveredAttempt?.status === "suspended"
				? fresh.session.backgroundLanes.resumeWorkerAgent(agentId)
				: undefined;
		observations.resume = {
			result: resume,
			attemptStatus: recoveredAttempt?.status,
			warnings: world.warnings
				.slice(warningsBeforeReopen)
				.filter((warning) => warning.includes("Worker") || warning.includes("context"))
				.slice(-6)
				.map((warning) => warning.slice(0, 500)),
		};
		if (resume?.skipReason) resumeRefused.release();
		const disposition = await withDeadline(
			world.trace,
			`${label}: public resume disposition`,
			Promise.race([
				freshReached.promise.then(() => "provider" as const),
				resumeRefused.promise.then(() => "refused" as const),
			]),
			60_000,
		);
		observations.disposition = disposition;
		observations.freshBoundary = {
			attempt: fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[attempt.attemptId]?.status,
			claims: fresh.session.getResourceSnapshot().workers?.ownedProjectClaims,
			physical: fresh.session.getResourceSnapshot().workers?.executionPromiseCount,
		};
		expect(disposition, report()).toBe("provider");
		const resumed = fresh.session.backgroundLanes.getTaskRuntimeSnapshot();
		const acquired = new WorkerConversationStore().getProjectContextBinding({
			agentDir,
			resumeContext: agent.resumeContext,
			expectedLogicalAgentId: agent.contextOrigin?.logicalAgentId ?? agentId,
		});
		observations.acquired = acquired?.ownership;
		expect(acquired?.ownership.state).toBe("busy");
		expect(acquired?.ownership.claim.parentSessionId).toBe(binding.ownership.claim.parentSessionId);
		expect(acquired?.ownership.claim.generation).toBe(binding.ownership.claim.generation + 1);
		expect(acquired?.ownership.claim.incarnation).not.toBe(binding.ownership.claim.incarnation);
		expect(resumed?.agents[agentId]?.resumeContext).toEqual(agent.resumeContext);
		expect(resumed?.attempts[attempt.attemptId]?.dispatch).toEqual(attempt.dispatch);
		expect(Object.values(resumed?.attempts ?? {}).filter((item) => item.taskId === laneId)).toHaveLength(1);
		expect({ oldRequests, resumedRequests }).toEqual({ oldRequests: 1, resumedRequests: 1 });
		freshGate.release();
		await withDeadline(world.trace, `${label}: terminal reaches fresh parent`, terminalReached.promise);
		await withDeadline(world.trace, `${label}: terminal parent turn settles`, fresh.session.waitForForegroundIdle());
		const ready = await withDeadline(
			world.trace,
			`${label}: worker resources settle`,
			fresh.session.backgroundLanes.waitForWorkerAgent(agentId, 60_000),
		);
		const terminal = fresh.session.backgroundLanes.getTaskRuntimeSnapshot();
		observations.terminal = {
			ready,
			attempt: terminal?.attempts[attempt.attemptId]?.status,
			notification: terminal?.notifications[`worker-terminal:${attempt.attemptId}`]?.status,
		};
		expect(ready).toMatchObject({ timedOut: false, status: "idle" });
		expect(terminal?.attempts[attempt.attemptId]?.status).toBe("completed");
		expect(terminal?.notifications[`worker-terminal:${attempt.attemptId}`]?.status).toBe("delivered");
		if (pendingFollowUp) {
			const pendingEntries = world
				.openSessionManager(workerFile, agentDir)
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message.content).includes(pendingWords),
				);
			observations.durablePending = pendingEntries;
			expect(
				pendingEntries,
				`${label}: admitted pending words persist once in the same worker transcript`,
			).toHaveLength(1);
			expect(JSON.stringify(pendingEntries[0])).toContain(`[Worker control ${pendingMessageId}`);
			expect(JSON.stringify(pendingEntries[0]).split(pendingWords)).toHaveLength(2);
		}
		expect(terminalRequests).toBe(1);
		expect(
			fresh.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "background-worker-completion" &&
						JSON.stringify(entry.content).includes(`- ${laneId}: succeeded`),
				),
		).toHaveLength(1);
		expect(fresh.session.getResourceSnapshot().workers?.ownedProjectClaims).toEqual([]);
		const final = fresh.session.getResourceSnapshot().workers;
		observations.final = {
			claims: final?.ownedProjectClaims,
			executionPromiseCount: final?.executionPromiseCount,
			executingHolds: final?.executingHolds,
			inFlightLedgerCount: final?.inFlightLedgerCount,
			scheduler: final?.scheduler,
		};
		report();
	} catch (error) {
		observations.failure = String(error).slice(0, 700);
		failures.push(error);
		try {
			report();
		} catch (reportError) {
			failures.push(reportError);
		}
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
						JSON.stringify(entry.content).includes(`- ${laneId}: succeeded`),
				).length;
			observations.cleanup = {
				terminalRequests,
				terminalPosts: terminalPostsAfterCleanup,
				disposal: disposal && String(disposal.error),
				claims: fresh.session.getResourceSnapshot().workers?.ownedProjectClaims,
			};
		}
		unsubscribeFresh();
		try {
			report();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, `${label}: diagnostic and cleanup failed`);
	expect(terminalRequests, `${label}: no duplicate terminal provider through disposal`).toBe(1);
	expect(terminalPostsAfterCleanup, `${label}: no duplicate durable terminal through disposal`).toBe(1);
}
