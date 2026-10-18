import "../builtin-install.ts";
import { expect } from "vitest";
import {
	orchestrationSessionDir,
	sessionRootMailboxFile,
	workerContextForkFile,
	workerProjectSpecializationFile,
} from "../../../../src/core/agent-paths.ts";
import {
	type BackgroundToolTaskRecord,
	loadBackgroundToolTaskRecordsNewestFirst,
} from "../../../../src/core/background-tool-task-controller.ts";
import { sessionRootAddress, sessionRootReplyMessageId } from "../../../../src/core/delegation/session-root-mailbox.ts";
import { WorkerConversationStore } from "../../../../src/core/delegation/worker-conversation-store.ts";
import { readWorkerMailboxRecord, workerMailboxPath } from "../../../../src/core/delegation/worker-mailbox-record.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import type { ScriptedRequest } from "../scripted-provider.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, type WorkerProjectClaims, withDeadline } from "../session-fixture.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import {
	assertBatchOk,
	backgroundTaskIdOf,
	bundleEntries,
	crashCutChecks,
	expectOwnerWords,
	handoffFor,
	LIMITS_PATH,
	lastToolResultDetails,
	latestBatchResults,
	rawReplyAcknowledgements,
	rawReplyReceiptOf,
} from "./shared.ts";

/** Whether the request's current tail, the only message that may answer a wake, is the worker handoff naming `laneId` with `status`. */
function tailIsWorkerHandoff(request: ScriptedRequest, laneId: string, status: string): boolean {
	const tail = request.context.messages.at(-1);
	if (tail?.role !== "user") return false;
	const text = JSON.stringify(tail);
	return text.includes("Background worker terminal handoff") && text.includes(`- ${laneId}: ${status}`);
}

export async function runJourney2QueuedRecoveryPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// E7 (queued, never-started recovery through the claim path): an auxiliary file-backed root starts a held worker A and
	// queues a fresh worker B behind it under the natural concurrency cap. The owned files are captured while B is queued,
	// the old owner joins and disposes, the files are cut back to that capture, the owner pid advances, and a fresh root
	// recovers twice. B resumes from its queued state; A's busy lease is refused by the queued-context guard and never resumed.
	// The judgments a plain start prompt consumes (the same set as the J2 dispatch phase); nothing undeclared is scripted.
	const e7Judgments = {
		capabilities_authorized: { kind: "noul", probability: 0.02 },
		changes_model_pools: { kind: "noul", probability: 0.02 },
		local_commits_only: { kind: "noul", probability: 0.02 },
		lifts_delivery_block: { kind: "noul", probability: 0.02 },
		full_handoff: { kind: "noul", probability: 0.02 },
		optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
	} as const;
	const e7AHeldReached = createBarrier();
	const e7AHeld = createBarrier();
	// B's completion reaches the recovered root as a wake turn; that turn, not foreground idleness, is what proves B ran.
	const e7WakeReached = createBarrier();
	let e7AHeldRequests = 0;
	world.provider.enqueueTrack("worker-a", "worker-a", undefined, {
		name: "e7-a-held",
		check: () => {
			e7AHeldRequests += 1;
			e7AHeldReached.release();
		},
		gate: e7AHeld.promise,
		reply: { content: [{ type: "text", text: "Worker A reports the held value." }] },
	});
	const e7Owner = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	// Explicit scenario host configuration: the native global layer keeps its existing workerDelegation fields and sets the cap.
	const e7GlobalDelegation = world.settingsManager.getGlobalSettings().workerDelegation ?? {};
	world.settingsManager.setWorkerDelegationSettings({ ...e7GlobalDelegation, maxConcurrent: 1 });
	expect(world.settingsManager.getWorkerDelegationSettings().maxConcurrent, "the scenario caps workers at one").toBe(
		1,
	);
	world.provider.enqueue(
		"root",
		calls("e7-start-a", [
			{
				id: "e7-start-a-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-a" },
					instructions: "Read the limits file, then hold.",
					readOnly: true,
				},
			},
		]),
		{ name: "e7-a-reported", reply: { content: [{ type: "text", text: "Worker A is started." }] } },
	);
	world.systemOne.enterPhase("e7-start", e7Judgments, {
		expect: expectOwnerWords({
			sessionManager: () => e7Owner.sessionManager,
			userRequests: ["Start the held check."],
			optionalToolNames: ["secret_store"],
		}),
	});
	await withDeadline(trace, "E7 start A", e7Owner.session.prompt("Start the held check."));
	await withDeadline(trace, "E7 worker A held at its first request", e7AHeldReached.promise, 90_000);
	// B starts only after A is physically held, so A's running lease is what the natural cap counts.
	world.provider.enqueue(
		"root",
		calls("e7-start-b", [
			{
				id: "e7-start-b-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-b" },
					instructions: "Report the current limits value.",
				},
			},
		]),
		{ name: "e7-b-reported", reply: { content: [{ type: "text", text: "Worker B is queued." }] } },
	);
	world.systemOne.enterPhase("e7-queue", e7Judgments, {
		expect: expectOwnerWords({
			sessionManager: () => e7Owner.sessionManager,
			userRequests: ["Queue the second check behind it."],
			optionalToolNames: ["secret_store"],
		}),
	});
	await withDeadline(trace, "E7 queue B", e7Owner.session.prompt("Queue the second check behind it."));
	const e7Start = (toolCallId: string): { started: boolean; agentId: string; laneId: string; text: string } => {
		const entry = e7Owner.sessionManager
			.getBranch()
			.find(
				(candidate) =>
					candidate.type === "message" &&
					candidate.message.role === "toolResult" &&
					candidate.message.toolCallId === toolCallId,
			);
		if (entry?.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error(`no durable start result for ${toolCallId}`);
		}
		const details = entry.message.details as { started?: unknown; agentId?: unknown; laneId?: unknown } | undefined;
		if (typeof details?.agentId !== "string" || typeof details.laneId !== "string") {
			throw new Error(`the start result ${toolCallId} carries no agent or lane id`);
		}
		return {
			started: details.started === true,
			agentId: details.agentId,
			laneId: details.laneId,
			text: entry.message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
		};
	};
	const e7StartA = e7Start("e7-start-a-1");
	const e7StartB = e7Start("e7-start-b-1");
	expect({ a: e7StartA.started, b: e7StartB.started }, "both starts are accepted").toEqual({ a: true, b: true });
	expect(
		e7StartB.text.includes("capacity: 1 running of 1 allowed"),
		`B queues behind the natural capacity cap; its start receipt: ${e7StartB.text}`,
	).toBe(true);
	const e7Runtime = e7Owner.session.backgroundLanes.getTaskRuntimeSnapshot();
	if (e7Runtime === undefined) throw new Error("the auxiliary owner has no task runtime snapshot");
	const e7AttemptOf = (laneId: string) =>
		Object.values(e7Runtime.attempts)
			.filter((attempt) => attempt.taskId === laneId)
			.at(-1);
	expect(
		{
			bAgent: e7Runtime.agents[e7StartB.agentId]?.status,
			bActiveAttempt: e7Runtime.agents[e7StartB.agentId]?.activeAttemptId,
			bAttempt: e7AttemptOf(e7StartB.laneId)?.status,
			bLease: e7AttemptOf(e7StartB.laneId)?.lease,
		},
		"B is registered and queued with no lease or active attempt",
	).toEqual({ bAgent: "registered", bActiveAttempt: undefined, bAttempt: "queued", bLease: undefined });
	expect(e7AttemptOf(e7StartA.laneId)?.lease, "A holds a live lease at the cut").toBeDefined();
	// A's native authority is read-only and nonreserving: no edit, write, or python tool, and no write lease at the cut.
	expect(e7StartA.text, "A's granted tools exclude every editing tool").not.toMatch(
		/tools: [^;]*\b(edit|write|python)\b/,
	);
	const e7PreCutWorkers = e7Owner.session.getResourceSnapshot().workers;
	if (e7PreCutWorkers === undefined) throw new Error("the auxiliary owner reports no worker snapshot before the cut");
	expect(
		e7PreCutWorkers.reservations.heldLeases.filter((lease) => lease.taskId === e7StartA.laneId),
		"A holds no write reservation",
	).toEqual([]);
	// B's birth: a registered agent with no context origin, one birth attempt, and no agent, lease, or grant yet.
	const e7BTask = e7Runtime.tasks[e7StartB.laneId];
	const e7BAgent = e7Runtime.agents[e7StartB.agentId];
	const e7BAttempt = e7AttemptOf(e7StartB.laneId);
	expect(
		{
			contextOrigin: e7BAgent?.contextOrigin,
			attemptCount: e7BTask?.attemptIds.length,
			agentId: e7BAttempt?.agentId,
			lease: e7BAttempt?.lease,
			grantId: e7BAttempt?.grantId,
			grant: e7BAttempt?.grant,
		},
		"B is a fresh birth: no context origin, one birth attempt, and no agent, lease, or grant yet",
	).toEqual({
		contextOrigin: undefined,
		attemptCount: 1,
		agentId: undefined,
		lease: undefined,
		grantId: undefined,
		grant: undefined,
	});
	const e7BClaim = e7PreCutWorkers.ownedProjectClaims.find(
		(claim) => claim.sessionId === e7Runtime.agents[e7StartB.agentId]?.resumeContext.sessionId,
	);
	expect(e7BClaim?.claim.parentSessionId, "B's busy context is owned by the auxiliary parent").toBe(
		e7Owner.sessionManager.getSessionId(),
	);
	expect(
		e7BClaim?.claim.incarnation.startsWith(`pi-worker:${world.processTable.self}:`),
		"B's busy claim names this process as its owner",
	).toBe(true);
	// Owned files: the auxiliary session file, captured with the bounded referenced manifest below before any owner ends.
	const e7AuxFile = e7Owner.sessionManager.getSessionFile();
	if (e7AuxFile === undefined) throw new Error("the auxiliary root has no session file");
	const e7Context = (agentId: string): string => {
		const sessionId = e7Runtime.agents[agentId]?.resumeContext.sessionId;
		if (sessionId === undefined) throw new Error(`no resume context for ${agentId}`);
		return sessionId;
	};
	// Native conversation reads, taken once before the cut: each worker's validated project-context binding (enrollment included,
	// read-only) and its durable birth fork reference, which exists even for an empty fresh-birth snapshot.
	const e7Store = new WorkerConversationStore();
	const e7Native = new Map(
		[e7StartA.agentId, e7StartB.agentId].map((agentId) => {
			const agent = e7Runtime.agents[agentId];
			if (agent === undefined) throw new Error(`no binding for ${agentId}`);
			const options = {
				agentDir: world.agentDir,
				resumeContext: agent.resumeContext,
				expectedLogicalAgentId: agentId,
			};
			return [
				agentId,
				{
					binding: e7Store.getProjectContextBinding(options),
					birth: e7Store.open(options).getBirthContextForkReference(),
					dispatch: e7AttemptOf(agentId)?.dispatch.birthContextForkReference,
				},
			] as const;
		}),
	);
	// The canonical referenced manifest, bounded and explicit: the auxiliary session file, the control-plane children of this parent
	// (without the SQLite store or live work-lease markers), each worker's session file and sidecar, the specialization file its native
	// binding names, and the birth fork file its native reference names. A missing optional file is absent; a cap breach fails.
	const E7_MAX_FILES = 512;
	const E7_MAX_BYTES = 8 * 1024 * 1024;
	const e7Manifest = (): Map<string, string> => {
		const entries = world.io.fileEntries();
		const selected = new Map<string, string>();
		const take = (path: string | undefined): void => {
			if (path === undefined) return;
			const content = entries.get(path);
			if (content !== undefined) selected.set(path, content);
		};
		take(e7AuxFile);
		for (const [path, content] of bundleEntries(
			entries,
			orchestrationSessionDir(world.agentDir, e7Owner.sessionManager.getSessionId()),
		)) {
			selected.set(path, content);
		}
		for (const agentId of [e7StartA.agentId, e7StartB.agentId]) {
			const sessionFile = e7Runtime.agents[agentId]?.resumeContext.sessionFile;
			if (sessionFile === undefined) throw new Error(`no session file for ${agentId}`);
			take(sessionFile);
			take(`${sessionFile}.worker.json`);
			const native = e7Native.get(agentId);
			if (native?.binding !== undefined) {
				take(workerProjectSpecializationFile(world.agentDir, native.binding.specializationKey));
			}
			if (native?.birth !== undefined) {
				take(
					workerContextForkFile(
						world.agentDir,
						e7Owner.sessionManager.getSessionId(),
						native.birth.identityDigest,
						native.birth.contentDigest,
					),
				);
			}
		}
		const bytes = [...selected.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0);
		if (selected.size > E7_MAX_FILES || bytes > E7_MAX_BYTES) {
			throw new Error(`the E7 manifest exceeds its caps: ${selected.size} files, ${bytes} bytes`);
		}
		return selected;
	};
	const e7Capture = e7Manifest();
	// Native facts before the cut: each binding is busy, and each birth reference names a file the manifest captured.
	for (const [agentId, native] of e7Native) {
		expect(native.binding?.ownership.state, `${agentId}'s native project-context binding is busy`).toBe("busy");
		// The native binding owns exactly the pre-cut claim, and its reference names this aux parent and this worker.
		const preCutClaim = e7PreCutWorkers.ownedProjectClaims.find(
			(claim) => claim.sessionId === e7Runtime.agents[agentId]?.resumeContext.sessionId,
		)?.claim;
		expect(native.binding?.ownership.claim, `${agentId}'s binding owns its pre-cut claim`).toEqual(preCutClaim);
		expect(native.binding?.reference.parentSessionId, `${agentId}'s binding names the aux parent`).toBe(
			e7Owner.sessionManager.getSessionId(),
		);
		expect(native.binding?.reference.logicalAgentId, `${agentId}'s binding names its own worker`).toBe(agentId);
		// The attempt's dispatch carries the birth fork reference, which must be the one its conversation holds.
		expect(native.birth, `${agentId} has a durable birth fork reference`).toBeDefined();
		expect(native.dispatch, `${agentId}'s dispatch carries the reference its conversation holds`).toEqual(
			native.birth,
		);
		if (native.birth !== undefined) {
			const forkFile = workerContextForkFile(
				world.agentDir,
				e7Owner.sessionManager.getSessionId(),
				native.birth.identityDigest,
				native.birth.contentDigest,
			);
			expect(e7Capture.has(forkFile), `${agentId}'s birth fork reference names a captured file`).toBe(true);
		}
	}
	// A's exact retained claim, predeclared from its pre-cut identity: the original owner keeps it by design after disposal.
	const e7APreClaim = (e7Owner.session.getResourceSnapshot().workers?.ownedProjectClaims ?? []).find(
		(claim) => claim.sessionId === e7Context(e7StartA.agentId),
	);
	if (e7APreClaim === undefined) throw new Error("A holds no project claim before the cut");
	const e7ARetainedClaims: WorkerProjectClaims = [
		{
			...e7APreClaim,
			agents: [
				{
					agentId: e7StartA.agentId,
					agentStatus: "suspended",
					attemptId: e7AttemptOf(e7StartA.laneId)?.attemptId,
					attemptStatus: "suspended",
					executingHoldCount: 0,
					mailboxLoaded: true,
					mailbox: {
						parentSessionId: e7Owner.sessionManager.getSessionId(),
						agentId: e7StartA.agentId,
						listenerCount: 0,
						hasOpenObligation: false,
						pendingMessageIds: [],
						replyAcknowledgementIds: [],
					},
				},
			],
		},
	];
	// The crash cut: certified from the disposed owner itself, before any prefix is restored, the receipt names exactly A's
	// predeclared claim; the owned files are cut back to the capture; SQLite is not rewound.
	const e7Fresh = await world.restart({
		owner: e7Owner.session,
		sessionFile: e7AuxFile,
		cut: { manifest: e7Manifest, capture: e7Capture },
		rewindSqlite: false,
		retainedClaims: e7ARetainedClaims,
		check: crashCutChecks("the auxiliary owner disposes cleanly"),
	});
	expect(
		world.settingsManager.getWorkerDelegationSettings().maxConcurrent,
		"the recovered owner keeps the scenario cap",
	).toBe(1);
	// Only the CURRENT tail may answer a wake: a user-role worker handoff whose header names one of the phase's lanes. Earlier
	// history never counts, so unrelated words in old turns cannot admit a wake.
	const e7IsHandoffWake = (request: ScriptedRequest, lanes: readonly string[]): boolean => {
		const tail = request.context.messages.at(-1);
		if (tail?.role !== "user") return false;
		const text = JSON.stringify(tail);
		return text.includes("Background worker terminal handoff") && lanes.some((lane) => text.includes(`- ${lane}:`));
	};
	// B's birth is a real admitted read and a truthful submitted report of the bytes it read.
	world.provider.enqueue(
		"worker-b",
		calls("e7-b-read", [{ id: "e7-b-read-1", name: "read", arguments: { path: LIMITS_PATH } }]),
		{
			...calls("e7-b-report", [
				{
					id: "e7-b-report-1",
					name: "submit_report",
					arguments: { status: "completed", summary: "The limits file holds MAX_RETRIES = 5." },
				},
			]),
			check: (request) => {
				const read = latestBatchResults(request).find((result) => result.toolName === "read");
				if (!read?.text.includes("MAX_RETRIES = 5")) {
					throw new Error(`B's read did not show the limits value: ${read?.text ?? "no read result"}`);
				}
			},
		},
	);
	// The recovered root's first prompt reply precedes B's wake turn; the prompt's foreground-idle boundary is what drains the queue.
	world.provider.enqueue("root", {
		name: "e7-resume-reported",
		reply: { content: [{ type: "text", text: "The restart is noted." }] },
	});
	// B's completion reaches the recovered root as a wake turn, possibly coalesced with earlier turns: the step answers each root
	// request until the production context carries B's succeeded handoff, and only then is the wake proven.
	world.provider.enqueue("root", {
		name: "e7-wake",
		maxRequests: 8,
		check: (request) => {
			if (!e7IsHandoffWake(request, [e7StartA.laneId, e7StartB.laneId])) {
				throw new Error("B's wake was not triggered by a user handoff");
			}
		},
		until: (request) => {
			const done = tailIsWorkerHandoff(request, e7StartB.laneId, "succeeded");
			if (done) e7WakeReached.release();
			return done;
		},
		reply: { content: [{ type: "text", text: "Background work is still settling." }] },
	});
	// Recovery is entered twice on purpose, after the tracks it resumes are queued. The first pass reconciles the cut; the
	// second pass must change no owned file.
	e7Fresh.session.getLaneRecords();
	const e7AfterFirstRecovery = e7Manifest();
	e7Fresh.session.getLaneRecords();
	expect(e7Manifest(), "a second recovery pass changes no owned file").toEqual(e7AfterFirstRecovery);
	world.systemOne.enterPhase("e7-resume", e7Judgments, {
		expect: expectOwnerWords({
			sessionManager: () => e7Fresh.sessionManager,
			userRequests: ["Continue after the restart."],
			optionalToolNames: ["secret_store"],
		}),
	});
	await withDeadline(trace, "E7 recovered root turn", e7Fresh.session.prompt("Continue after the restart."));
	await withDeadline(trace, "E7 B wake reached the recovered root", e7WakeReached.promise, 120_000);
	await withDeadline(trace, "E7 recovered work settled", e7Fresh.session.waitForForegroundIdle(), 120_000);
	expect(e7AHeldRequests, "A's held request is never resumed after the cut").toBe(1);
	const e7Settled = e7Fresh.session.backgroundLanes.getTaskRuntimeSnapshot();
	if (e7Settled === undefined) throw new Error("the recovered owner has no task runtime snapshot");
	// B's birth attempt and its compiled contract survive the fresh recovery unchanged, now bound to B's own agent.
	const e7BSettled = Object.values(e7Settled.attempts)
		.filter((attempt) => attempt.taskId === e7StartB.laneId)
		.at(-1);
	expect(
		{ attemptId: e7BSettled?.attemptId, dispatch: e7BSettled?.dispatch, agentId: e7BSettled?.agentId },
		"B's birth attempt and its compiled contract survive the fresh recovery",
	).toEqual({ attemptId: e7BAttempt?.attemptId, dispatch: e7BAttempt?.dispatch, agentId: e7StartB.agentId });
	// B's birth agent is idle with its resources released before the follow-up is admitted: the wait is the readiness gate, and it
	// observes exactly B's first generation as terminal. Its outcome is bounded by the deadline, never joined as a promise elsewhere.
	const e7BReady = await withDeadline(
		trace,
		"E7 B birth agent idle before the follow-up",
		e7Fresh.session.backgroundLanes.waitForWorkerAgent(e7StartB.agentId, 60_000),
		70_000,
	);
	expect(e7BReady.timedOut, "B's birth agent settles inside its wait").toBe(false);
	expect(e7BReady.status, "B is idle before the follow-up is admitted").toBe("idle");
	expect(e7BReady.terminalLaneIds, "the wait observes exactly B's first generation as terminal").toEqual([
		e7StartB.laneId,
	]);
	// The pinned birth attempt is read again from the pure runtime projection after the wait: same agent, task, attempt and
	// completed status, and its compiled dispatch is the one captured at birth.
	const e7BPinnedAttemptId = e7BSettled?.attemptId;
	if (e7BPinnedAttemptId === undefined) throw new Error("B's birth attempt is not in the fresh runtime");
	const e7BReceipt = e7Fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[e7BPinnedAttemptId];
	expect(e7BReceipt, "B's pinned birth attempt is present after the wait").toBeDefined();
	expect(
		{
			attemptId: e7BReceipt?.attemptId,
			agentId: e7BReceipt?.agentId,
			taskId: e7BReceipt?.taskId,
			status: e7BReceipt?.status,
			dispatch: e7BReceipt?.dispatch,
		},
		"B's pinned birth attempt is unchanged after the wait",
	).toEqual({
		attemptId: e7BPinnedAttemptId,
		agentId: e7StartB.agentId,
		taskId: e7StartB.laneId,
		status: "completed",
		dispatch: e7BAttempt?.dispatch,
	});
	// Post-birth native control through the public seam: the recovered owner admits one follow-up to B with an explicit replay key,
	// a thread, and an expected reply. B's turn is held after the control is delivered; B's answer is then recorded through the public
	// reply path against the admitted message; only then is B released. Its handoff must name the admitted lane, and replaying the same
	// options after the tail settles returns the same message and starts nothing.
	const e7FollowUpKey = "e7-follow-up-1";
	const e7FollowUpThread = "e7-thread-1";
	const e7FollowUpMessage = "The confirmed retry count is 5.";
	const e7FollowUpOptions = { threadId: e7FollowUpThread, expectReply: true, idempotencyKey: e7FollowUpKey };
	const e7FollowUpWake = createBarrier();
	const e7FollowUpDelivered = createBarrier();
	const e7FollowUpRelease = createBarrier();
	world.provider.enqueue("worker-b", {
		...calls("e7-b-followup-held", [
			{
				id: "e7-b-followup-report-1",
				name: "submit_report",
				arguments: { status: "completed", summary: "The confirmed retry count is 5." },
			},
		]),
		check: (request) => {
			const tail = JSON.stringify(request.context.messages.at(-1) ?? null);
			if (!tail.includes(e7FollowUpMessage)) throw new Error("B's follow-up did not reach its own turn");
			e7FollowUpDelivered.release();
		},
		gate: e7FollowUpRelease.promise,
	});
	const e7FollowUp = e7Fresh.session.backgroundLanes.followUpSessionRootWorkerAgent(
		e7StartB.agentId,
		e7FollowUpMessage,
		e7FollowUpOptions,
	);
	if (!e7FollowUp.started || e7FollowUp.record === undefined) {
		throw new Error(`the follow-up was not admitted: ${JSON.stringify({ ...e7FollowUp, record: undefined })}`);
	}
	const e7FollowUpLane = e7FollowUp.record.laneId;
	await withDeadline(trace, "E7 follow-up control delivered to B", e7FollowUpDelivered.promise, 120_000);
	// Paired outbox fault at the held boundary: the session-root target rename fails first; the source rollback rename fails only after
	// that target fault has fired. The reply throws both causes in order; root bytes and the source acknowledgement are inspected from the
	// raw records before any active getter, and the native listing then repairs the source outbox before B is released.
	const e7SessionId = e7Fresh.sessionManager.getSessionId();
	const e7RootMailbox = sessionRootMailboxFile(world.agentDir, e7SessionId);
	const e7SourceMailbox = workerMailboxPath(world.agentDir, e7SessionId, e7StartB.agentId);
	const e7ReplyId = sessionRootReplyMessageId(e7SessionId, e7StartB.agentId, e7FollowUp.messageId);
	// Held-boundary failure safety: whatever throws inside the boundary, B's reply is repaired and acked only on its exact admitted lineage,
	// B's gate is released, and B's foreground tail is joined while this owner is live. The primary and every cleanup error are thrown.
	const e7HeldFailures: unknown[] = [];
	let e7ReceiptBeforeRepair: unknown;
	// The wake is a root request triggered by a user handoff; only that bounded context is answered, and only B's own succeeded line
	// for this admitted lane completes the wait. Earlier coalesced wake requests get the generic settling reply.
	world.provider.enqueue("root", {
		name: "e7-follow-up-wake",
		maxRequests: 8,
		check: (request) => {
			if (!e7IsHandoffWake(request, [e7FollowUpLane, e7StartB.laneId])) {
				throw new Error("the follow-up wake was not triggered by a user handoff");
			}
		},
		until: (request) => {
			const done = tailIsWorkerHandoff(request, e7FollowUpLane, "succeeded");
			if (done) e7FollowUpWake.release();
			return done;
		},
		reply: { content: [{ type: "text", text: "Background work is still settling." }] },
	});
	// The repair: lists this admitted request's pending reply and acks it only when it is exactly that reply.
	// The admitted follow-up receipt: exactly one durable attempt names its control message, and it is B's completed attempt on the admitted lane.
	const e7PinAdmittedTerminal = (): void => {
		const admitted = e7Fresh.session.backgroundLanes.getTaskRuntimeSnapshot();
		if (admitted === undefined)
			throw new Error("the recovered owner has no task runtime snapshot after the matched handoff");
		const receipts = Object.values(admitted.attempts).filter(
			(attempt) => attempt.dispatch.controlMessageId === e7FollowUp.messageId,
		);
		expect(receipts.length, "the admitted control message owns exactly one durable attempt").toBe(1);
		const [receipt] = receipts;
		expect(
			receipt === undefined
				? undefined
				: {
						agentId: receipt.agentId,
						taskId: receipt.taskId,
						logicalLaneId: receipt.dispatch.logicalLaneId,
						status: receipt.status,
					},
			"the admitted receipt pins B's agent, the admitted lane, and a completed attempt",
		).toEqual({
			agentId: e7StartB.agentId,
			taskId: e7FollowUpLane,
			logicalLaneId: e7StartB.agentId,
			status: "completed",
		});
	};
	const e7HeldRepair = (): void => {
		const pending = e7Fresh.session.backgroundLanes.listSessionRootReplies({
			sourceAgentId: e7StartB.agentId,
			requestMessageId: e7FollowUp.messageId,
		});
		if (pending.length > 1)
			throw new Error(`${pending.length} pending root replies name the admitted request; nothing is acked`);
		const reply = pending[0];
		if (reply !== undefined) {
			if (
				reply.messageId !== e7ReplyId ||
				reply.requestMessageId !== e7FollowUp.messageId ||
				reply.threadId !== e7FollowUpThread ||
				reply.content !== "Noted: the retry count is 5."
			)
				throw new Error(
					`the pending root reply ${reply.messageId} is not the admitted reply ${e7ReplyId}; its fence is kept and nothing is acked`,
				);
			if (typeof reply.ackToken !== "string")
				throw new Error(`the pending reply ${reply.messageId} carries no ack token`);
			if (!e7Fresh.session.backgroundLanes.acknowledgeSessionRootReply(reply.messageId, reply.ackToken))
				throw new Error(`the native ack refused the admitted reply ${reply.messageId}`);
		}
	};
	try {
		const e7RootBefore = world.io.fileEntries().get(e7RootMailbox);
		let e7TargetFaultFired = false;
		const e7ConsumedBefore = world.io.consumedFaults.length;
		world.io.failNext({
			name: "e7-session-root-target-rename-fails",
			kind: "rename",
			matches: (operation) => {
				if (operation.destination !== e7RootMailbox) return false;
				e7TargetFaultFired = true;
				return true;
			},
			code: "EIO",
			times: 1,
		});
		world.io.failNext({
			name: "e7-source-rollback-rename-fails",
			kind: "rename",
			matches: (operation) => e7TargetFaultFired && operation.destination === e7SourceMailbox,
			code: "EIO",
			times: 1,
		});
		let e7FaultError: unknown;
		try {
			e7Fresh.session.backgroundLanes.replyToWorkerAgentMessage(
				e7StartB.agentId,
				"Noted: the retry count is 5.",
				e7FollowUp.messageId,
			);
		} catch (error) {
			e7FaultError = error;
		}
		expect(e7TargetFaultFired, "the target rename fired before the rollback was attempted").toBe(true);
		world.io.assertFaultsConsumed();
		expect(
			world.io.consumedFaults.slice(e7ConsumedBefore),
			"the two armed faults are the newly consumed ones, in order",
		).toEqual(["e7-session-root-target-rename-fails", "e7-source-rollback-rename-fails"]);
		expect(e7FaultError, "the paired fault surfaces as an ordered AggregateError").toBeInstanceOf(AggregateError);
		const e7Causes =
			e7FaultError instanceof AggregateError
				? e7FaultError.errors.map((cause) =>
						(cause instanceof Error ? cause.message : String(cause)).slice(
							0,
							(cause instanceof Error ? cause.message : String(cause)).indexOf(":"),
						),
					)
				: [];
		expect(e7Causes, `both raw causes are preserved in order: ${JSON.stringify(e7Causes)}`).toEqual([
			"Scripted IO fault e7-session-root-target-rename-fails",
			"Scripted IO fault e7-source-rollback-rename-fails",
		]);
		expect(
			world.io.fileEntries().get(e7RootMailbox),
			"the failed target leaves the root mailbox bytes unchanged",
		).toBe(e7RootBefore);
		world.faultMatrix.witness("R8", { control: false });
		// The held boundary after both faults, before any listing: the faulted reply already committed its native receipt to the source.
		// That raw receipt is the pre-repair baseline; the test reads it and computes no digest of its own.
		e7ReceiptBeforeRepair = rawReplyReceiptOf(readWorkerMailboxRecord(e7SourceMailbox).mailbox, e7FollowUp.messageId);
		expect(e7ReceiptBeforeRepair, "the faulted reply committed its receipt to the source before any repair").toEqual({
			replyMessageId: e7ReplyId,
			requestSenderId: sessionRootAddress(e7SessionId),
			contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(
			rawReplyAcknowledgements(readWorkerMailboxRecord(e7SourceMailbox).mailbox),
			"the raw source holds exactly the deterministic acknowledgement tuple before any repair",
		).toEqual([
			{
				messageId: e7FollowUp.messageId,
				acknowledgementId: e7ReplyId,
				replyContent: "Noted: the retry count is 5.",
			},
		]);
		const e7FollowUpReply = { messageId: e7ReplyId };
		// Lineage, while B is still held: the request-scoped list actively reconciles the source outbox and yields exactly one root reply.
		const e7Replies = e7Fresh.session.backgroundLanes.listSessionRootReplies({
			sourceAgentId: e7StartB.agentId,
			requestMessageId: e7FollowUp.messageId,
		});
		expect(e7Replies.length, "one root reply for the admitted control").toBe(1);
		const e7Reply = e7Replies[0];
		expect(
			{
				messageId: e7Reply?.messageId,
				requestMessageId: e7Reply?.requestMessageId,
				threadId: e7Reply?.threadId,
				content: e7Reply?.content,
				sourceReconciled: e7Reply?.sourceReconciledAt !== undefined,
				acknowledged: e7Reply?.acknowledgedAt,
			},
			"the reply names its admitted request, thread and content, is source-reconciled, and is unacknowledged",
		).toEqual({
			messageId: e7FollowUpReply.messageId,
			requestMessageId: e7FollowUp.messageId,
			threadId: e7FollowUpThread,
			content: "Noted: the retry count is 5.",
			sourceReconciled: true,
			acknowledged: undefined,
		});
		expect(e7Reply?.ackToken, "the reply carries an acknowledgement token").toEqual(expect.any(String));
		// After the repair the source keeps no acknowledgement marker, and its receipt is the pre-repair receipt, unchanged.
		const e7SourceAfter = readWorkerMailboxRecord(e7SourceMailbox).mailbox;
		expect(rawReplyAcknowledgements(e7SourceAfter), "the repaired source keeps zero acknowledgement markers").toEqual(
			[],
		);
		expect(
			rawReplyReceiptOf(e7SourceAfter, e7FollowUp.messageId),
			"the repair leaves the pre-repair native receipt unchanged",
		).toEqual(e7ReceiptBeforeRepair);
		// The native ack consumes the reply: no unacknowledged reply remains for this request.
		expect(
			e7Fresh.session.backgroundLanes.acknowledgeSessionRootReply(
				e7FollowUpReply.messageId,
				e7Reply?.ackToken ?? "",
			),
			"the native ack accepts the reply's own token",
		).toBe(true);
		expect(
			e7Fresh.session.backgroundLanes
				.listSessionRootReplies({ sourceAgentId: e7StartB.agentId, requestMessageId: e7FollowUp.messageId })
				.filter((reply) => reply.acknowledgedAt === undefined),
			"no unacknowledged reply remains after the ack",
		).toEqual([]);
	} catch (error) {
		e7HeldFailures.push(error);
	} finally {
		// The native repair lists only this admitted request's pending reply; it is acked only when it is exactly that reply.
		try {
			e7HeldRepair();
		} catch (error) {
			e7HeldFailures.push(error);
		}
		e7FollowUpRelease.release();
		try {
			// The matched handoff: the wake step releases only when B's own succeeded handoff for this admitted lane reaches the root.
			await withDeadline(trace, "E7 matched B handoff", e7FollowUpWake.promise, 120_000);
			// Pin the admitted task's terminal attempt from a fresh snapshot. Physical join of B's process stays with native disposal.
			e7PinAdmittedTerminal();
		} catch (error) {
			e7HeldFailures.push(error);
		}
		try {
			await withDeadline(
				trace,
				"E7 held B tail joins while the owner is live",
				e7Fresh.session.waitForForegroundIdle(),
				120_000,
			);
		} catch (error) {
			e7HeldFailures.push(error);
		}
	}
	if (e7HeldFailures.length === 1) throw e7HeldFailures[0];
	if (e7HeldFailures.length > 1)
		throw new AggregateError(e7HeldFailures, "the held E7 reply boundary failed before and during its cleanup");
	await withDeadline(trace, "E7 follow-up tail settled", e7Fresh.session.waitForForegroundIdle(), 120_000);
	// Replay after the real tail: the same key and the same options name the same durable control and start no second B turn.
	const e7Replay = e7Fresh.session.backgroundLanes.followUpSessionRootWorkerAgent(
		e7StartB.agentId,
		e7FollowUpMessage,
		e7FollowUpOptions,
	);
	expect(e7Replay.messageId, "a replayed key names the same durable control").toBe(e7FollowUp.messageId);
	expect(e7Replay.started, "a replayed key starts no second B turn").toBe(false);
	await withDeadline(trace, "E7 replay settled", e7Fresh.session.waitForForegroundIdle(), 120_000);
	expect(
		world.provider.reached.filter((name) => name.includes("e7-b-followup")).length,
		"B's follow-up ran exactly once",
	).toBe(1);
	// The replayed control reinserts no reply: the pending list stays empty after the tail, because acknowledged replies are not listed.
	expect(
		e7Fresh.session.backgroundLanes.listSessionRootReplies({
			sourceAgentId: e7StartB.agentId,
			requestMessageId: e7FollowUp.messageId,
		}).length,
		"the replay reinserts no pending root reply",
	).toBe(0);
	// Reply-level replay after the tail: the same B, request and content return the deterministic reply id and reinsert nothing,
	// distinct from the control-key replay above.
	const e7ReplyReplay = e7Fresh.session.backgroundLanes.replyToWorkerAgentMessage(
		e7StartB.agentId,
		"Noted: the retry count is 5.",
		e7FollowUp.messageId,
	);
	expect(e7ReplyReplay, "a reply replay returns the same deterministic reply id").toEqual({
		destination: "session_root",
		messageId: e7ReplyId,
	});
	expect(
		e7Fresh.session.backgroundLanes.listSessionRootReplies({
			sourceAgentId: e7StartB.agentId,
			requestMessageId: e7FollowUp.messageId,
		}).length,
		"the reply replay reinserts no pending root reply",
	).toBe(0);
	expect(
		rawReplyReceiptOf(readWorkerMailboxRecord(e7SourceMailbox).mailbox, e7FollowUp.messageId),
		"the reply receipt is unchanged across the tail and the reply replay",
	).toEqual(e7ReceiptBeforeRepair);
	world.faultMatrix.witness("R8", { control: true });
	// A repeated recovery after B's terminal repeats no provider step of B and publishes no new session entry.
	const e7EntriesBefore = e7Fresh.sessionManager.getEntries().length;
	const e7BStepsBefore = world.provider.reached.filter((name) => name.includes("e7-b-")).length;
	e7Fresh.session.getLaneRecords();
	expect(e7Fresh.sessionManager.getEntries().length, "a repeated recovery publishes nothing new").toBe(
		e7EntriesBefore,
	);
	expect(
		world.provider.reached.filter((name) => name.includes("e7-b-")).length,
		"a repeated recovery repeats no B provider step",
	).toBe(e7BStepsBefore);
	world.faultMatrix.witness("E7", { control: true });
	expect(
		Object.values(e7Settled.attempts)
			.filter((attempt) => attempt.taskId === e7StartB.laneId)
			.at(-1)?.status,
		"B resumes from its queued state and completes",
	).toBe("completed");
	world.faultMatrix.witness("E7", { control: false });
	expect(
		world.warnings.some((warning) => warning.includes("no proof of never-started")),
		"the queued-context guard refuses A's busy lease",
	).toBe(true);
	expect(await world.disposeSessionInBody(e7Fresh.session), "the recovered owner disposes cleanly").toBeUndefined();
	// R21, System One off (the background start and the wake turn ask on-mode questions no reading of this phase derives): a crash
	// cut while a background task is running. An auxiliary root starts a held echo in the background and goes idle, and its session
	// file, which records the task running, is captured. The disposal cancels the running task and records it canceled, its wake-up
	// owed to the next session: the control, that is what the next session would deliver without the cut. The cut writes the running
	// record back, so the next session finds a running task whose owning process is gone: it records the task failed and delivers
	// that terminal to the idle root as a wake turn.
	if (!world.systemOne.enabled) {
		const r21Gate = createBarrier();
		const r21Admitted = createBarrier();
		const r21Wake = createBarrier();
		const r21Started: { taskId?: string } = {};
		const r21Aux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
		world.systemOne.enterPhase("r21-background-cut", {});
		// Admitted at its gate before the cut, so the disposal's cancellation reaches a command that is running, not one never started.
		world.shell.enqueue({
			name: "r21-running",
			command: "echo r21-running",
			output: "r21-running\n",
			exitCode: 0,
			gate: r21Gate.promise,
			check: () => r21Admitted.release(),
		});
		world.provider.enqueue(
			"root",
			calls("r21-start", [
				{ id: "r21-bg-1", name: "bash", arguments: { command: "echo r21-running", background: true } },
			]),
			{
				name: "r21-started",
				check: (request) => {
					r21Started.taskId = backgroundTaskIdOf(request);
				},
				reply: { content: [{ type: "text", text: "The check runs in the background." }] },
			},
		);
		await withDeadline(trace, "R21 background start", r21Aux.session.prompt("Start the check in the background."));
		await withDeadline(trace, "R21 start settled", r21Aux.session.waitForForegroundIdle());
		await withDeadline(trace, "R21 command admitted at its gate", r21Admitted.promise, 60_000);
		const r21File = r21Aux.sessionManager.getSessionFile();
		if (r21File === undefined) throw new Error("the R21 root has no session file");
		const r21TaskId = r21Started.taskId;
		if (r21TaskId === undefined) throw new Error("the R21 start result carried no task id");
		// The task's latest durable record on `manager`'s branch.
		const r21Record = (manager: Parameters<typeof loadBackgroundToolTaskRecordsNewestFirst>[0]) =>
			loadBackgroundToolTaskRecordsNewestFirst(manager).find(
				(record): record is BackgroundToolTaskRecord => isRecordObject(record) && record.taskId === r21TaskId,
			);
		expect(r21Record(r21Aux.sessionManager)?.status, "the held echo is recorded running").toBe("running");
		const r21Files = (): Map<string, string> => {
			const files = new Map<string, string>();
			const content = world.io.peekFile(r21File);
			if (content !== undefined) files.set(r21File, content);
			return files;
		};
		const r21Capture = r21Files();
		expect([...r21Capture.keys()], "the R21 capture holds the session file").toEqual([r21File]);
		// The next session's wake turn: its context carries the handoff of the restored task.
		world.provider.enqueue("root", {
			name: "r21-wake",
			check: (request) => {
				if (!handoffFor(request, r21TaskId)) throw new Error("the restored terminal does not reach the fresh root");
				r21Wake.release();
			},
			reply: { content: [{ type: "text", text: "The check ended with its process." }] },
		});
		const r21Fresh = await withDeadline(
			trace,
			"R21 restart",
			world.restart({
				owner: r21Aux.session,
				sessionFile: r21File,
				cut: { manifest: r21Files, capture: r21Capture },
				rewindSqlite: false,
				retainedClaims: [],
				check: {
					...crashCutChecks("the R21 root disposes cleanly"),
					disposed: (result) => {
						expect(result, "the R21 root disposes cleanly").toBeUndefined();
						const canceled = r21Record(r21Aux.sessionManager);
						expect(
							{
								status: canceled?.status,
								delivery: canceled?.terminalDelivery,
								ended: canceled?.output.includes("Session ended before the background tool completed."),
							},
							"the disposal records the running task canceled, its wake-up owed to the next session",
						).toEqual({ status: "canceled", delivery: "pending", ended: true });
						world.faultMatrix.witness("R21", { control: true });
					},
				},
			}),
			60_000,
		);
		await withDeadline(trace, "R21 restored terminal delivered", r21Wake.promise);
		await withDeadline(trace, "R21 wake settled", r21Fresh.session.waitForForegroundIdle());
		const r21Failed = r21Record(r21Fresh.sessionManager);
		expect(
			{
				status: r21Failed?.status,
				delivery: r21Failed?.terminalDelivery,
				resumed: r21Failed?.output.includes(
					"The session resumed after the owning process ended; the original tool completion is unavailable.",
				),
			},
			"the next session records the cut running task failed with its process gone, and delivers that terminal",
		).toEqual({ status: "failed", delivery: "delivered", resumed: true });
		world.faultMatrix.witness("R21", { control: false });
		r21Gate.release();
		expect(await world.disposeSessionInBody(r21Fresh.session), "the R21 next root disposes cleanly").toBeUndefined();
		await workerHandoffAcrossRestart(world);
	}
}

/** The branch's worker terminal handoff posts that name `laneId`. */
function workerHandoffPosts(sessionManager: SessionManager, laneId: string): number {
	return sessionManager
		.getBranch()
		.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "background-worker-completion" &&
				JSON.stringify(entry.content).includes(`- ${laneId}: `),
		).length;
}

/**
 * R34, System One off with R21 (the dying owner's wake turn may or may not run, and an on-mode turn's judgments cannot be both
 * declared and optional): a crash cut while a worker terminal handoff waits for the foreground lease. An auxiliary root starts a
 * held reader on a fresh birth, a second prompt holds the foreground at its provider gate, and the reader ends: its terminal
 * belongs to the earlier submission, so it never folds into the held one and waits in the handoff controller's lease wait, its
 * durable `worker-terminal:<attemptId>` receipt pending and nothing posted to the root (the control). The session file and the
 * orchestration bundle are captured there. The restart's interrupt frees the lease before the disposal, so settlement order
 * decides what the dying owner does with the waiting delivery: it starts its wake turn (the optional step answers it), the
 * disposal rejects it and the disposed outbox drops the rejection silently, or a disposal text is reported once. Whichever
 * happens, the cut restores the pending receipt, and the next owner replays it and delivers the terminal exactly once: its
 * first root request is the wake that carries the handoff, the receipt reads delivered, and one handoff post is on its branch.
 */
async function workerHandoffAcrossRestart(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const readerHeld = createBarrier();
	const readerRelease = createBarrier();
	const foregroundHeld = createBarrier();
	const foregroundRelease = createBarrier();
	const deliveryWaiting = createBarrier();
	const nextWake = createBarrier();
	const started: { agentId?: string; laneId?: string } = {};
	const nextWakeHandoffs: number[] = [];
	const handoffFailures = (): string[] =>
		world.warnings.filter((message) => message.startsWith("Background worker handoff failed:"));
	const failuresBefore = handoffFailures().length;
	expect(
		{ root: world.provider.getPendingStepNames("root"), reader: world.provider.getPendingStepNames("worker-c") },
		"no earlier root or worker-c step is left pending",
	).toEqual({ root: [], reader: [] });
	const aux = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		// Observation only: the delivery runs at once and its own promise is returned. `deliver()` adds the delivery to the
		// handoff controller's pending set before it returns, so the barrier opens with the delivery already waiting.
		workerTerminalDelivery: (records, deliver) => {
			const delivery = deliver();
			if (records.some((record) => record.laneId === started.laneId)) deliveryWaiting.release();
			return delivery;
		},
	});
	world.systemOne.enterPhase("r34-handoff-cut", {});
	world.provider.enqueue("worker-c", {
		...calls("r34-report", [
			{
				id: "r34-report-1",
				name: "submit_report",
				arguments: { status: "completed", summary: "The restart reader report is ready." },
			},
		]),
		check: () => readerHeld.release(),
		gate: readerRelease.promise,
	});
	world.provider.enqueue(
		"root",
		calls("r34-start", [
			{
				id: "r34-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-c" },
					instructions: "Report once you are released.",
					readOnly: true,
				},
			},
		]),
		{
			name: "r34-started",
			check: (request) => {
				assertBatchOk(request, "the restart reader start");
				const details = lastToolResultDetails(aux.session, "delegate");
				const agentId = isRecordObject(details) ? details.agentId : undefined;
				const laneId = isRecordObject(details) ? details.laneId : undefined;
				if (typeof agentId !== "string" || typeof laneId !== "string") {
					throw new Error("the restart reader start carries no agent or lane id");
				}
				started.agentId = agentId;
				started.laneId = laneId;
			},
			reply: { content: [{ type: "text", text: "The restart reader is started." }] },
		},
	);
	await withDeadline(trace, "R34 reader start turn", aux.session.prompt("Start the restart reader."), 90_000);
	const { agentId, laneId } = started;
	if (agentId === undefined || laneId === undefined) throw new Error("the R34 start carried no agent or lane id");
	await withDeadline(trace, "R34 reader held at its request", readerHeld.promise, 90_000);
	expect(
		aux.session.backgroundLanes.getTaskRuntimeSnapshot()?.agents[agentId]?.contextOrigin,
		"the reader is a fresh birth, not an idle specialist's context",
	).toBeUndefined();
	// A later submission holds the foreground at its provider gate; it does not ignore abort, so the restart's interrupt ends it.
	world.provider.enqueue("root", {
		name: "r34-foreground-held",
		check: () => foregroundHeld.release(),
		gate: foregroundRelease.promise,
		reply: { content: [{ type: "text", text: "The foreground hold ends." }] },
	});
	const heldPrompt = aux.session.prompt("Hold the foreground while the reader ends.").catch((error: unknown) => error);
	await withDeadline(trace, "R34 foreground held at its provider gate", foregroundHeld.promise, 90_000);
	readerRelease.release();
	await withDeadline(trace, "R34 reader terminal waits for the foreground lease", deliveryWaiting.promise, 90_000);
	const runtime = aux.session.backgroundLanes.getTaskRuntimeSnapshot();
	const attempt = Object.values(runtime?.attempts ?? {})
		.filter((candidate) => candidate.taskId === laneId)
		.at(-1);
	if (attempt === undefined) throw new Error("the R34 reader has no attempt");
	const notificationId = `worker-terminal:${attempt.attemptId}`;
	expect(
		{
			attempt: attempt.status,
			receipt: runtime?.notifications[notificationId]?.status,
			waiting: aux.session.getResourceSnapshot().terminalHandoffs.pendingDeliveries,
			posts: workerHandoffPosts(aux.sessionManager, laneId),
		},
		"the ended reader's handoff waits for the held foreground, its durable receipt pending and nothing posted",
	).toEqual({ attempt: "completed", receipt: "pending", waiting: 1, posts: 0 });
	world.faultMatrix.witness("R34", { control: true });
	const auxFile = aux.sessionManager.getSessionFile();
	if (auxFile === undefined) throw new Error("the R34 root has no session file");
	const orchestrationDir = orchestrationSessionDir(world.agentDir, aux.sessionManager.getSessionId());
	const ownedFiles = (): Map<string, string> => {
		const entries = world.io.fileEntries();
		const files = new Map(bundleEntries(entries, orchestrationDir));
		const content = entries.get(auxFile);
		if (content !== undefined) files.set(auxFile, content);
		return files;
	};
	const capture = ownedFiles();
	expect(capture.has(auxFile), "the R34 capture holds the session file").toBe(true);
	// The dying owner's wake, if settlement order starts one: zero or one request, answered at once.
	world.provider.enqueue("root", {
		name: "r34-dying-owner-wake",
		optional: true,
		check: (request) => {
			if (!tailIsWorkerHandoff(request, laneId, "succeeded"))
				throw new Error("the dying owner's root request is not the reader's handoff");
		},
		reply: { content: [{ type: "text", text: "The reader ended while the owner closed." }] },
	});
	const checks = crashCutChecks("the R34 root disposes cleanly");
	let dyingWake: { readonly consumed: boolean; readonly retired: readonly string[] } | undefined;
	const fresh = await withDeadline(
		trace,
		"R34 restart",
		world.restart({
			owner: aux.session,
			sessionFile: auxFile,
			cut: { manifest: ownedFiles, capture },
			rewindSqlite: false,
			retainedClaims: [],
			check: {
				...checks,
				transport: (failures) => {
					checks.transport(failures);
					// The dying owner has stopped and every producer has joined: no request can consume its optional wake any more.
					dyingWake = {
						consumed: world.provider.reached.includes("root:r34-dying-owner-wake"),
						retired: world.provider.retireOptional("root"),
					};
					// Queued before the next owner exists, which may replay the receipt as it opens.
					world.provider.enqueue("root", {
						name: "r34-next-owner-wake",
						check: (request) => {
							if (!tailIsWorkerHandoff(request, laneId, "succeeded"))
								throw new Error("the next owner's first root request is not the reader's replayed handoff");
							nextWakeHandoffs.push(
								request.context.messages.filter((message) => {
									const text = JSON.stringify(message);
									return text.includes("Background worker terminal handoff") && text.includes(`- ${laneId}: `);
								}).length,
							);
							nextWake.release();
						},
						reply: { content: [{ type: "text", text: "The restart reader's report is noted." }] },
					});
				},
			},
		}),
		60_000,
	);
	foregroundRelease.release();
	await withDeadline(trace, "R34 held prompt settled", heldPrompt);
	if (dyingWake === undefined) throw new Error("the R34 restart reached no transport check");
	expect(
		dyingWake.retired,
		"the dying owner either consumed its optional wake or left it to be retired, never both",
	).toEqual(dyingWake.consumed ? [] : ["r34-dying-owner-wake"]);
	expect(
		handoffFailures().length - failuresBefore,
		"the dying owner reports at most one handoff failure, and none once its wake ran",
	).toBeLessThanOrEqual(dyingWake.consumed ? 0 : 1);
	// Recovery is entered explicitly: the next owner replays the pending receipt it finds in the restored bundle.
	fresh.session.getLaneRecords();
	await withDeadline(trace, "R34 next owner's wake", nextWake.promise, 90_000);
	await withDeadline(trace, "R34 next owner's wake settled", fresh.session.waitForForegroundIdle(), 90_000);
	expect(
		{
			handoffs: nextWakeHandoffs,
			receipt: fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.notifications[notificationId]?.status,
			posts: workerHandoffPosts(fresh.sessionManager, laneId),
		},
		"the next owner delivers the restored terminal exactly once and marks its receipt delivered",
	).toEqual({ handoffs: [1], receipt: "delivered", posts: 1 });
	world.faultMatrix.witness("R34", { control: false });
	// The reader leaves the world as it found it: idle once delivered, then retired.
	const ready = await withDeadline(
		trace,
		"R34 reader idle in the next owner",
		fresh.session.backgroundLanes.waitForWorkerAgent(agentId, 60_000),
		70_000,
	);
	expect(
		{ timedOut: ready.timedOut, status: ready.status },
		"the reader is idle in the next owner before its retirement",
	).toEqual({ timedOut: false, status: "idle" });
	world.provider.enqueue(
		"root",
		calls("r34-retire", [{ id: "r34-retire-1", name: "delegate", arguments: { action: "retire", agentId } }]),
		{
			name: "r34-retired",
			check: (request) => {
				const [retirement] = latestBatchResults(request);
				if (retirement?.isError !== false || !retirement.text.includes("retired"))
					throw new Error(`the restart reader was not retired: ${JSON.stringify(retirement)}`);
			},
			reply: { content: [{ type: "text", text: "The restart reader is retired." }] },
		},
	);
	await withDeadline(trace, "R34 reader retired", fresh.session.prompt("Retire the restart reader."), 90_000);
	expect(
		fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.agents[agentId]?.status,
		"the reader's durable binding is retired",
	).toBe("retired");
	expect(await world.disposeSessionInBody(fresh.session), "the R34 next root disposes cleanly").toBeUndefined();
}
