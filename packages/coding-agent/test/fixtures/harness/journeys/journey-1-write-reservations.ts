import "../builtin-install.ts";
import { dirname, resolve } from "node:path";
import { expect } from "vitest";
import { orchestrationSessionDir } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { canonicalPathScopeIdentity } from "../../../../src/core/autonomy/path-scope.ts";
import { TRANSCRIPT_MEMORY_PROVIDER_ID } from "../../../../src/core/context/transcript-memory-provider.ts";
import { WorkerConversationStore } from "../../../../src/core/delegation/worker-conversation-store.ts";
import { parseLocalWorkerProcessOwnerId } from "../../../../src/core/delegation/worker-process-owner.ts";
import { DEFAULT_OWNER_WAIT_TIMEOUT_MS, getLatestHumanInputSnapshots } from "../../../../src/core/human-input.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { getInFlightWorkUnits } from "../../../../src/core/reload-blockers.ts";
import { createAskQuestionToolDefinition } from "../../../../src/core/tools/ask-question.ts";
import { createBashToolDefinition } from "../../../../src/core/tools/bash.ts";
import { disposeShellExecutionSessionAndWait } from "../../../../src/core/tools/shell-execution-session.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import {
	HARNESS_PROJECT_CWD,
	type HarnessWorld,
	projectPath,
	settlementState,
	type WorkerProjectClaims,
	withDeadline,
} from "../session-fixture.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import {
	agentIdForTrack,
	bundleEntries,
	failureText,
	ICM_INTAKE_JUDGMENTS,
	latestBatchResults,
	requestTexts,
} from "./shared.ts";

const e4Judgments = ICM_INTAKE_JUDGMENTS;

export async function runJourney1WriteReservationsPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// E13 (required write-reservation release): a writer holds its exact lease, claim and execution hold while its gated worker runs. Everything
	// the teardown must keep is predeclared from the pre-fault identity: the exact lease, the exact claim tuple with its shutdown shape, the hold
	// count, and the durable reservation bytes. The reservation store's unlink fails before mutation. The owner's certificate accepts exactly that
	// predeclared retention. A later process reaps the dead owner's lease when a fresh owner starts a writer on the same scope.
	const E13_SCOPE = projectPath("e13", "out");
	const e13Admitted = createBarrier();
	const e13Gate = createBarrier();
	const e13Wake = createBarrier();
	const e13Created = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e13Session = e13Created.session;
	const e13Start = (instructions: string) => ({
		id: "e13-start-1",
		name: "delegate",
		arguments: {
			action: "start",
			model: { provider: "harness-script", modelId: "worker-a" },
			writePaths: [E13_SCOPE],
			instructions,
		},
	});
	world.provider.enqueue("root", calls("e13-start-first", [e13Start("E13-WRITER holds its scope.")]), {
		name: "e13-first-reply",
		check: (request) => {
			const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
			if (started?.isError || !started?.text.includes("delegate started (running)")) {
				throw new Error(`the first writer did not start: ${started?.text ?? "no result"}`);
			}
		},
		reply: { content: [{ type: "text", text: "The first writer is started." }] },
	});
	world.provider.enqueue("worker-a", {
		name: "e13-writer-hold",
		check: () => e13Admitted.release(),
		gate: e13Gate.promise,
		reply: { content: [{ type: "text", text: "E13-WRITER reached its gate." }] },
	});
	world.systemOne.enterPhase("e13-first", e4Judgments);
	await withDeadline(trace, "E13 first writer started", e13Session.prompt("Start the scope writer."));
	await withDeadline(trace, "E13 writer admitted", e13Admitted.promise);
	// Predeclared before any fault: the exact lease, the exact claim tuple, the hold count, and the durable reservation bytes.
	const e13Pre = e13Session.getResourceSnapshot().workers;
	if (e13Pre === undefined) throw new Error("the E13 owner reports no worker snapshot before teardown");
	const e13Leases = e13Pre.reservations.heldLeases;
	const e13Holds = e13Pre.executingHolds;
	const e13PreClaims = e13Pre.ownedProjectClaims;
	expect(e13Leases, "the admitted writer holds exactly one write lease before teardown").toHaveLength(1);
	expect(e13PreClaims, "the admitted writer owns exactly one project claim before teardown").toHaveLength(1);
	const e13PreAgent = e13PreClaims[0]?.agents[0];
	if (e13PreAgent === undefined) throw new Error("the admitted claim carries no agent");
	const e13Store = [...world.io.fileEntries()].filter(([storePath]) =>
		storePath.includes("worker-write-reservations"),
	);
	expect(
		e13Store.map(([, content]) => content.includes(e13Leases[0]?.reservationId ?? "")),
		"the admitted lease is durably stored before the fault",
	).toEqual([true]);
	const [e13StorePath, e13StoreBytes] = e13Store[0] ?? [];
	if (e13StorePath === undefined || e13StoreBytes === undefined)
		throw new Error("the reservation store is not in the virtual tree");
	const e13ExpectedClaims: WorkerProjectClaims = e13PreClaims.map((claim) => ({
		...claim,
		agents: [
			{
				agentId: e13PreAgent.agentId,
				agentStatus: "suspended",
				attemptId: e13PreAgent.attemptId,
				attemptStatus: "suspended",
				executingHoldCount: e13PreAgent.executingHoldCount,
				mailboxLoaded: true,
				mailbox: {
					parentSessionId: e13Created.sessionManager.getSessionId(),
					agentId: e13PreAgent.agentId,
					listenerCount: 0,
					hasOpenObligation: false,
					pendingMessageIds: [],
					replyAcknowledgementIds: [],
				},
			},
		],
	}));
	world.io.failNext({
		name: "e13-release-unlink-fails",
		kind: "unlink",
		matches: (operation) => operation.path === e13StorePath,
		code: "EIO",
		times: 1,
	});
	const e13Teardown = await world.disposeSessionInBody(e13Session);
	await world.provider.waitForProducers();
	const e13Failure = e13Teardown === undefined ? "no failure" : failureText(e13Teardown.error);
	expect(e13Failure, "the required release failure keeps the original scripted cause").toContain(
		"e13-release-unlink-fails",
	);
	world.io.assertFaultsConsumed();
	expect(world.io.consumedFaults.at(-1), "the reservation unlink fault fired on the store before mutation").toBe(
		"e13-release-unlink-fails",
	);
	expect(
		world.io.fileEntries().get(e13StorePath),
		"the failed unlink leaves the durable reservation bytes unchanged",
	).toBe(e13StoreBytes);
	const e13Post = e13Session.getResourceSnapshot().workers;
	expect(e13Post?.reservations.heldLeases, "the retained lease is the original owner, fence and paths").toEqual(
		e13Leases,
	);
	expect(e13Post?.executingHolds, "the execution hold count stays original").toEqual(e13Holds);
	expect(e13Post?.ownedProjectClaims, "the retained claim is the predeclared shutdown tuple").toEqual(
		e13ExpectedClaims,
	);
	expect(e13Post?.reservations.watchCount, "the owner's reservation watch is closed by teardown").toBe(0);
	world.certifyDisposedOwner(e13Session, e13ExpectedClaims, { leases: e13Leases, executingHolds: e13Holds });
	// The dead owner's exact lease is reaped at the native boundary: its pid is parsed from the exact lease and probed with signal 0 by the fresh
	// owner, the exact old reservation is absent from the durable store at the fresh admission, and the fresh admitted lease is a different
	// owner, attempt and fence on the same scope. No start receipt text is used as the oracle.
	const e13StoreContent = (): string[] =>
		[...world.io.fileEntries()]
			.filter(([storePath]) => storePath.includes("worker-write-reservations"))
			.map(([, content]) => content);
	const e13OldLease = e13Leases[0];
	if (e13OldLease === undefined) throw new Error("the E13 owner has no exact lease to reap");
	const e13OldPid = parseLocalWorkerProcessOwnerId(e13OldLease.ownerId)?.pid;
	expect(e13OldPid, "the exact lease names the process that owns it").toBe(world.processTable.self);
	expect(
		e13StoreContent().some((content) => content.includes(e13OldLease.reservationId)),
		"the exact old reservation is durable before the process advance",
	).toBe(true);
	world.processTable.advanceProcess();
	const e13ProbeBase = world.processTable.probes.length;
	const e13Fresh = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e13EntranceStoreBefore = e13StoreContent();
	e13Fresh.session.getLaneRecords();
	const e13EntranceProbes = world.processTable.probes.slice(e13ProbeBase);
	expect(
		e13EntranceProbes.some((probe) => probe.pid === e13OldPid && probe.signal === 0),
		"the recovery entrance probes the exact dead owner pid with signal 0",
	).toBe(true);
	expect(
		e13EntranceStoreBefore.some((content) => content.includes(e13OldLease.reservationId)),
		"the exact old reservation is durable before the recovery entrance",
	).toBe(true);
	expect(
		e13StoreContent().some((content) => content.includes(e13OldLease.reservationId)),
		"the recovery entrance releases the exact old reservation from the durable store",
	).toBe(false);
	let e13SecondTaskId: string | undefined;
	world.provider.enqueue(
		"root",
		calls("e13-start-second", [e13Start("E13-WRITER-2 takes the scope.")]),
		{
			name: "e13-second-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the second writer was not admitted as running: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The second writer is started." }] },
		},
		{
			name: "e13-wake",
			maxRequests: 8,
			until: (request) => {
				const everything = JSON.stringify(request.context.messages);
				const done = e13SecondTaskId !== undefined && everything.includes(`- ${e13SecondTaskId}: succeeded`);
				if (done) e13Wake.release();
				return done;
			},
			reply: { content: [{ type: "text", text: "Background work is still settling." }] },
		},
	);
	world.provider.enqueue("worker-a", {
		name: "e13-writer-two",
		reply: {
			content: [
				{
					type: "toolCall",
					id: "e13-report-2",
					name: "submit_report",
					arguments: { status: "completed", summary: "The second writer finished." },
				},
			],
			stopReason: "toolUse",
		},
	});
	expect(
		Object.values(e13Fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}),
		"the fresh owner has no attempt before its second start",
	).toHaveLength(0);
	world.systemOne.enterPhase("e13-second", e4Judgments);
	await withDeadline(trace, "E13 second writer started", e13Fresh.session.prompt("Start the second scope writer."));
	const e13Failures: unknown[] = [];
	try {
		const e13Running = e13Fresh.session.getResourceSnapshot().workers?.reservations.heldLeases ?? [];
		const e13Adm = {
			leases: e13Running,
			probes: world.processTable.probes.slice(e13ProbeBase),
			store: e13StoreContent(),
		};
		e13SecondTaskId = e13Running[0]?.taskId;
		expect(
			e13Adm.probes.some((probe) => probe.pid === e13OldPid && probe.signal === 0),
			"the fresh owner probes the exact dead owner pid with signal 0 before its admission",
		).toBe(true);
		expect(
			e13Adm.store.some((content) => content.includes(e13OldLease.reservationId)),
			"the exact old reservation is absent from the durable store at the fresh admission",
		).toBe(false);
		expect(e13Adm.leases, "the fresh admission holds exactly one lease").toHaveLength(1);
		const e13Second = e13Adm.leases[0];
		expect(e13Second?.ownerId, "the fresh lease has a different owner").not.toBe(e13OldLease.ownerId);
		expect(e13Second?.attemptId, "the fresh lease has a different attempt").not.toBe(e13OldLease.attemptId);
		expect(e13Second?.reservationId, "the fresh lease has a different reservation").not.toBe(
			e13OldLease.reservationId,
		);
		expect(e13Second?.parentSessionId, "the fresh lease names the fresh parent session").toBe(
			e13Fresh.sessionManager.getSessionId(),
		);
		expect(e13Second?.writeScopes, "the fresh lease keeps the exact scope").toEqual([
			canonicalPathScopeIdentity(E13_SCOPE),
		]);
		const e13FreshAttempt = Object.values(
			e13Fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {},
		).find((attempt) => attempt.attemptId === e13Second?.attemptId);
		expect(e13FreshAttempt?.taskId, "the fresh lease names the admitted task").toBe(e13Second?.taskId);
		// The fresh owner had no attempt before its start (asserted before the start), so the prior fence is zero: fence = 0 + 1.
		const e13PriorFence = 0;
		expect(e13Second?.fencingToken, "the fresh lease fence is one above its attempt's prior lease").toBe(
			e13PriorFence + 1,
		);
		expect(e13Second?.fencingToken, "the stored fence is the active native attempt lease fence").toBe(
			e13FreshAttempt?.lease?.fencingToken,
		);
		expect(e13Second?.writeScopes, "the fresh lease keeps the same scope").toEqual(e13OldLease.writeScopes);
		expect(
			e13Adm.store.some((content) => content.includes(e13Second?.reservationId ?? "")),
			"the fresh admitted lease is durable",
		).toBe(true);
	} catch (error) {
		e13Failures.push(error);
	} finally {
		// The admitted task's own terminal handoff and the foreground tail are joined while this owner is live, before its disposal.
		try {
			await withDeadline(trace, "E13 second writer handed off", e13Wake.promise, 90_000).catch((error: unknown) => {
				throw new Error(
					`${failureText(error)}; fresh attempts: ${JSON.stringify(Object.values(e13Fresh.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).map((attempt) => JSON.stringify(Object.fromEntries(Object.entries(attempt).filter(([key]) => key !== "dispatch" && key !== "grant"))).slice(0, 1200)))}; fresh workers: ${JSON.stringify(e13Fresh.session.getResourceSnapshot().workers?.executingHolds)}`,
				);
			});
			await withDeadline(trace, "E13 fresh root idle", e13Fresh.session.waitForForegroundIdle());
		} catch (error) {
			e13Failures.push(error);
		}
		try {
			const e13FreshMark = world.warnings.length;
			expect(
				await world.disposeSessionInBody(e13Fresh.session),
				"the E13 fresh owner disposes cleanly",
			).toBeUndefined();
			expect(
				world.warnings.slice(e13FreshMark),
				"the E13 fresh owner, with no fault armed, discloses nothing at close",
			).toEqual([]);
		} catch (error) {
			e13Failures.push(error);
		}
	}
	if (e13Failures.length === 1) throw e13Failures[0];
	if (e13Failures.length > 1) {
		throw new AggregateError(e13Failures, "the E13 second writer failed before and during its cleanup");
	}
	trace.mark("root", "e13.required-release");

	// E13 after-mutation (required release): the store unlink completes and then fails. The durable store has lost the lease while the owner still
	// holds it in memory, so the required release keeps the lease, its execution hold and its claim, and the disposal reports the exact unlink
	// cause together with the retained lease. Every identity is predeclared from the admitted writer before the fault.
	const E13A_SCOPE = projectPath("e13a", "out");
	const e13aAdmitted = createBarrier();
	const e13aGate = createBarrier();
	const e13aCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e13aSession = e13aCreated.session;
	world.provider.enqueue(
		"root",
		calls("e13a-start-first", [
			{
				id: "e13a-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-a" },
					writePaths: [E13A_SCOPE],
					instructions: "E13A-WRITER holds its scope.",
				},
			},
		]),
		{
			name: "e13a-first-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the after-mutation writer did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The after-mutation writer is started." }] },
		},
	);
	world.provider.enqueue("worker-a", {
		name: "e13a-writer-hold",
		check: () => e13aAdmitted.release(),
		gate: e13aGate.promise,
		reply: { content: [{ type: "text", text: "E13A-WRITER reached its gate." }] },
	});
	world.systemOne.enterPhase("e13a-first", e4Judgments);
	await withDeadline(trace, "E13A first writer started", e13aSession.prompt("Start the after-mutation writer."));
	await withDeadline(trace, "E13A writer admitted", e13aAdmitted.promise);
	const e13aPre = e13aSession.getResourceSnapshot().workers;
	if (e13aPre === undefined) throw new Error("the E13A owner reports no worker snapshot before teardown");
	const e13aLeases = e13aPre.reservations.heldLeases;
	const e13aHolds = e13aPre.executingHolds;
	const e13aPreClaims = e13aPre.ownedProjectClaims;
	expect(e13aLeases, "the after-mutation writer holds exactly one write lease before teardown").toHaveLength(1);
	expect(e13aPreClaims, "the after-mutation writer owns exactly one project claim before teardown").toHaveLength(1);
	const e13aPreAgent = e13aPreClaims[0]?.agents[0];
	if (e13aPreAgent === undefined) throw new Error("the E13A claim carries no agent");
	const e13aLease = e13aLeases[0];
	if (e13aLease === undefined) throw new Error("the E13A owner has no exact lease");
	const e13aStore = [...world.io.fileEntries()].filter(([storePath]) =>
		storePath.includes("worker-write-reservations"),
	);
	expect(
		e13aStore.map(([, content]) => content.includes(e13aLease.reservationId)),
		"the E13A lease is durably stored before the fault",
	).toContain(true);
	const e13aStorePath = e13aStore.find(([, content]) => content.includes(e13aLease.reservationId))?.[0];
	if (e13aStorePath === undefined) throw new Error("the E13A lease has no durable store entry");
	const e13aExpectedClaims: WorkerProjectClaims = e13aPreClaims.map((claim) => ({
		...claim,
		agents: [
			{
				agentId: e13aPreAgent.agentId,
				agentStatus: "suspended",
				attemptId: e13aPreAgent.attemptId,
				attemptStatus: "suspended",
				executingHoldCount: e13aPreAgent.executingHoldCount,
				mailboxLoaded: true,
				mailbox: {
					parentSessionId: e13aCreated.sessionManager.getSessionId(),
					agentId: e13aPreAgent.agentId,
					listenerCount: 0,
					hasOpenObligation: false,
					pendingMessageIds: [],
					replyAcknowledgementIds: [],
				},
			},
		],
	}));
	world.io.failNext({
		name: "e13a-release-unlink-after",
		kind: "unlink",
		matches: (operation) => operation.path === e13aStorePath,
		phase: "after",
		code: "EIO",
		times: 1,
	});
	const e13aTeardown = await world.disposeSessionInBody(e13aSession);
	await world.provider.waitForProducers();
	const e13aFailure = e13aTeardown === undefined ? "no failure" : failureText(e13aTeardown.error);
	expect(e13aFailure, "the after-mutation failure keeps its exact unlink cause").toContain(
		"e13a-release-unlink-after",
	);
	expect(e13aFailure, "the after-mutation failure names the exact retained lease").toContain(
		`${e13aLease.taskId}:${e13aLease.attemptId}:${e13aLease.fencingToken}`,
	);
	world.io.assertFaultsConsumed();
	expect(world.io.consumedFaults.at(-1), "the after-mutation fault is the one that fires").toBe(
		"e13a-release-unlink-after",
	);
	expect(
		world.io.fileEntries().get(e13aStorePath) ?? "",
		"the unlink completed before it failed: the durable store no longer names the lease",
	).not.toContain(e13aLease.reservationId);
	const e13aPost = e13aSession.getResourceSnapshot().workers;
	expect(e13aPost?.reservations.heldLeases, "the owner still holds its exact lease in memory").toEqual(e13aLeases);
	expect(e13aPost?.executingHolds, "the execution hold count stays original").toEqual(e13aHolds);
	expect(e13aPost?.ownedProjectClaims, "the retained claim is the predeclared shutdown tuple").toEqual(
		e13aExpectedClaims,
	);
	expect(e13aPost?.reservations.watchCount, "this writer registered no observer").toBe(0);
	world.certifyDisposedOwner(e13aSession, e13aExpectedClaims, { leases: e13aLeases, executingHolds: e13aHolds });

	// E13 joined teardown (required release): one owner holds a live writer while its reservation observer close and its store unlink fail
	// in the same teardown. Both exact causes are joined into the disposal error, the native observer stays registered with its listeners,
	// the lease and hold stay exact, and the observer is cut off only after this native proof. Every identity is predeclared before the faults.
	expect(
		world.io.getWatcherSnapshot().filter((watcher) => watcher.path.includes("worker-write-reservations")),
		"no reservation observer outlives the disposed owners before the joined control's owner exists",
	).toEqual([]);
	const e13jAdmitted = createBarrier();
	const e13jGate = createBarrier();
	const e13jCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e13jSession = e13jCreated.session;
	world.provider.enqueue(
		"root",
		calls("e13j-start-first", [
			{
				id: "e13j-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-a" },
					writePaths: [E13_SCOPE],
					instructions: "E13J-WRITER holds its scope.",
				},
			},
		]),
		{
			name: "e13j-first-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the joined-teardown writer did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The joined-teardown writer is started." }] },
		},
	);
	world.provider.enqueue("worker-a", {
		name: "e13j-writer-hold",
		check: () => e13jAdmitted.release(),
		gate: e13jGate.promise,
		reply: { content: [{ type: "text", text: "E13J-WRITER reached its gate." }] },
	});
	world.systemOne.enterPhase("e13j-first", e4Judgments);
	await withDeadline(trace, "E13J first writer started", e13jSession.prompt("Start the joined-teardown writer."));
	await withDeadline(trace, "E13J writer admitted", e13jAdmitted.promise);

	const e13jPre = e13jSession.getResourceSnapshot().workers;
	if (e13jPre === undefined) throw new Error("the E13J owner reports no worker snapshot before teardown");
	const e13jLeases = e13jPre.reservations.heldLeases;
	const e13jHolds = e13jPre.executingHolds;
	const e13jPreClaims = e13jPre.ownedProjectClaims;
	expect(e13jLeases, "the E13J writer holds exactly one write lease before teardown").toHaveLength(1);
	expect(e13jPreClaims, "the E13J writer owns exactly one project claim before teardown").toHaveLength(1);
	const e13jPreAgent = e13jPreClaims[0]?.agents[0];
	if (e13jPreAgent === undefined) throw new Error("the E13J claim carries no agent");
	const e13jLease = e13jLeases[0];
	if (e13jLease === undefined) throw new Error("the E13J owner has no exact lease");
	const e13jStore = [...world.io.fileEntries()].filter(([storePath]) =>
		storePath.includes("worker-write-reservations"),
	);
	expect(
		e13jStore.map(([, content]) => content.includes(e13jLease.reservationId)),
		"the E13J lease is the only durable store entry before the faults",
	).toEqual([true]);
	const [e13jStorePath, e13jStoreBytes] = e13jStore[0] ?? [];
	if (e13jStorePath === undefined || e13jStoreBytes === undefined)
		throw new Error("the E13J reservation store is not in the virtual tree");
	// A granted writer registers no observer; the owner's observer exists only once a waiter subscribes to availability. A bounded wait on
	// the running writer is that subscription: it times out by design and leaves the owner's observer registered for the watcher-only teardown.
	world.provider.enqueue(
		"root",
		calls("e13j-wait", [
			{
				id: "e13j-wait-1",
				name: "delegate",
				arguments: { action: "wait", agentId: e13jPreAgent.agentId, timeoutMs: 1000 },
			},
		]),
		{
			name: "e13j-wait-reply",
			check: (request) => {
				const waited = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (waited?.isError) throw new Error(`the bounded wait on the writer failed: ${waited.text}`);
			},
			reply: { content: [{ type: "text", text: "The joined-teardown writer is still running." }] },
		},
	);
	world.systemOne.enterPhase("e13j-wait", e4Judgments);
	await withDeadline(trace, "E13J bounded wait", e13jSession.prompt("Wait briefly for the joined-teardown writer."));
	const e13jWatchPre = world.io.getWatcherSnapshot().filter((watcher) => watcher.path === dirname(e13jStorePath));
	expect(
		e13jWatchPre.length,
		"the bounded wait registers at least one observer on the store directory",
	).toBeGreaterThan(0);
	expect(
		e13jSession.getResourceSnapshot().workers?.reservations.watchCount,
		"the owner's observer count equals the observers the bounded wait registered on the store directory",
	).toBe(e13jWatchPre.length);
	// One observer per host workspace key may share the store directory. Watchers close in registration order, so the
	// first registered observer is the one the single scripted close fault meets; it is the one the teardown retains.
	const e13jWatch = e13jWatchPre[0];
	if (e13jWatch === undefined) throw new Error("the E13J store directory carries no observer");
	if (e13jWatch === undefined) throw new Error("the E13J store directory carries no observer");
	const e13jExpectedClaims: WorkerProjectClaims = e13jPreClaims.map((claim) => ({
		...claim,
		agents: [
			{
				agentId: e13jPreAgent.agentId,
				agentStatus: "suspended",
				attemptId: e13jPreAgent.attemptId,
				attemptStatus: "suspended",
				executingHoldCount: e13jPreAgent.executingHoldCount,
				mailboxLoaded: true,
				mailbox: {
					parentSessionId: e13jCreated.sessionManager.getSessionId(),
					agentId: e13jPreAgent.agentId,
					listenerCount: 0,
					hasOpenObligation: false,
					pendingMessageIds: [],
					replyAcknowledgementIds: [],
				},
			},
		],
	}));
	world.io.failNext({
		name: "e13j-watch-close-fails",
		kind: "watch.close",
		matches: (operation) => operation.path === e13jWatch.path,
		code: "EIO",
		times: 1,
	});
	world.io.failNext({
		name: "e13j-release-unlink-fails",
		kind: "unlink",
		matches: (operation) => operation.path === e13jStorePath,
		code: "EIO",
		times: 1,
	});
	const e13jTeardown = await world.disposeSessionInBody(e13jSession);
	await world.provider.waitForProducers();
	const e13jFailure = e13jTeardown === undefined ? "no failure" : failureText(e13jTeardown.error);
	expect(e13jFailure, "the joined teardown keeps the observer close cause").toContain("e13j-watch-close-fails");
	expect(e13jFailure, "the joined teardown keeps the physical unlink cause").toContain("e13j-release-unlink-fails");
	expect(e13jFailure, "the joined teardown names the exact retained lease").toContain(
		`${e13jLease.taskId}:${e13jLease.attemptId}:${e13jLease.fencingToken}`,
	);
	world.io.assertFaultsConsumed();
	// Native teardown order: the attempt's child cleanup releases the lease first (unlink), then the owner's coordinator closes its observers.
	expect(
		world.io.consumedFaults.slice(-2),
		"both faults fire in native teardown order: lease release, then observer close",
	).toEqual(["e13j-release-unlink-fails", "e13j-watch-close-fails"]);
	expect(
		world.io.fileEntries().get(e13jStorePath),
		"the failed unlink leaves the durable reservation bytes unchanged",
	).toBe(e13jStoreBytes);
	const e13jPost = e13jSession.getResourceSnapshot().workers;
	expect(e13jPost?.reservations.heldLeases, "the retained lease is the original owner, fence and paths").toEqual(
		e13jLeases,
	);
	expect(e13jPost?.executingHolds, "the execution hold count stays original").toEqual(e13jHolds);
	expect(e13jPost?.ownedProjectClaims, "the retained claim is the predeclared shutdown tuple").toEqual(
		e13jExpectedClaims,
	);
	expect(e13jPost?.reservations.watchCount, "the failed observer close keeps its native registration").toBe(1);
	expect(
		world.io.getWatcherSnapshot().filter((watcher) => watcher.path === dirname(e13jStorePath)),
		"the retained observer is the first registered one with its listeners intact",
	).toEqual([e13jWatch]);
	// External transport cutoff of the one observer the native teardown retained, only after the native proof above.
	world.io.cutoffRetainedWatcher({ id: e13jWatch.id, path: e13jWatch.path });
	world.certifyDisposedOwner(e13jSession, e13jExpectedClaims, {
		leases: e13jLeases,
		executingHolds: e13jHolds,
		watchCount: 1,
	});

	const E13W_SCOPE = projectPath("e13w", "out");
	// E13 watcher-only teardown (required release): one owner runs a writer to a typed completion; native cleanup releases its lease, claim and
	// hold. The owner then keeps only its reservation observer: no availability subscribers remain, and the physical observer keeps its one native change callback. That observer's close fails at disposal: the cause is
	// reported, the owner's registration stays, and the observer is cut off only after this native proof. Identities are predeclared before the fault.
	const e13wAdmitted = createBarrier();
	const e13wGate = createBarrier();
	const e13wCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e13wSession = e13wCreated.session;
	world.provider.enqueue(
		"root",
		calls("e13w-start-first", [
			{
				id: "e13w-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-a" },
					writePaths: [E13W_SCOPE],
					instructions: "E13W-WRITER holds its scope.",
				},
			},
		]),
		{
			name: "e13w-first-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the joined-teardown writer did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The joined-teardown writer is started." }] },
		},
	);
	world.provider.enqueue("worker-a", {
		name: "e13w-writer-hold",
		check: () => e13wAdmitted.release(),
		gate: e13wGate.promise,
		reply: {
			content: [
				{
					type: "toolCall",
					id: "e13w-report",
					name: "submit_report",
					arguments: { status: "completed", summary: "E13W-WRITER finished its scope." },
				},
			],
			stopReason: "toolUse",
		},
	});
	world.systemOne.enterPhase("e13w-first", e4Judgments);
	await withDeadline(trace, "E13W first writer started", e13wSession.prompt("Start the joined-teardown writer."));
	await withDeadline(trace, "E13W writer admitted", e13wAdmitted.promise);

	try {
		const e13wPre = e13wSession.getResourceSnapshot().workers;
		if (e13wPre === undefined) throw new Error("the E13W owner reports no worker snapshot before teardown");
		const e13wLeases = e13wPre.reservations.heldLeases;
		const e13wHolds = e13wPre.executingHolds;
		const e13wPreClaims = e13wPre.ownedProjectClaims;
		expect(e13wLeases, "the E13W writer holds exactly one write lease before teardown").toHaveLength(1);
		expect(e13wPreClaims, "the E13W writer owns exactly one project claim before teardown").toHaveLength(1);
		// The live writer is executing at its gate: its one execution hold is the pre-fault identity, the settled state below holds none.
		expect(e13wHolds, "the live E13W writer holds exactly its own execution at its gate").toEqual([
			{ agentId: e13wPreClaims[0]?.agents[0]?.agentId, count: 1 },
		]);
		const e13wPreAgent = e13wPreClaims[0]?.agents[0];
		if (e13wPreAgent === undefined) throw new Error("the E13W claim carries no agent");
		const e13wLease = e13wLeases[0];
		if (e13wLease === undefined) throw new Error("the E13W owner has no exact lease");
		const e13wStore = [...world.io.fileEntries()].filter(([storePath]) =>
			storePath.includes("worker-write-reservations"),
		);
		expect(
			e13wStore.map(([, content]) => content.includes(e13wLease.reservationId)),
			"the E13W lease is the only durable store entry before the faults",
		).toEqual([true]);
		const [e13wStorePath, e13wStoreBytes] = e13wStore[0] ?? [];
		if (e13wStorePath === undefined || e13wStoreBytes === undefined)
			throw new Error("the E13W reservation store is not in the virtual tree");
		// A granted writer registers no observer; the owner's observer exists only once a waiter subscribes to availability. A bounded wait on
		// the running writer is that subscription: it times out by design and leaves the owner's observer registered for the joined teardown.
		world.provider.enqueue(
			"root",
			calls("e13w-wait", [
				{
					id: "e13w-wait-1",
					name: "delegate",
					arguments: { action: "wait", agentId: e13wPreAgent.agentId, timeoutMs: 1000 },
				},
			]),
			{
				name: "e13w-wait-reply",
				check: (request) => {
					const waited = latestBatchResults(request).find((result) => result.toolName === "delegate");
					if (waited?.isError) throw new Error(`the bounded wait on the writer failed: ${waited.text}`);
				},
				reply: { content: [{ type: "text", text: "The joined-teardown writer is still running." }] },
			},
		);
		world.systemOne.enterPhase("e13w-wait", e4Judgments);
		await withDeadline(
			trace,
			"E13W bounded wait",
			e13wSession.prompt("Wait briefly for the joined-teardown writer."),
		);
		const e13wWatchPre = world.io.getWatcherSnapshot().filter((watcher) => watcher.path === dirname(e13wStorePath));
		expect(
			e13wWatchPre.length,
			"the bounded wait registers at least one observer on the store directory",
		).toBeGreaterThan(0);
		expect(
			e13wSession.getResourceSnapshot().workers?.reservations.watchCount,
			"the owner's observer count equals the observers the bounded wait registered on the store directory",
		).toBe(e13wWatchPre.length);
		// One observer per host workspace key may share the store directory. Watchers close in registration order, so the
		// first registered observer is the one the single scripted close fault meets; it is the one the teardown retains.
		const e13wWatch = e13wWatchPre[0];
		if (e13wWatch === undefined) throw new Error("the E13W store directory carries no observer");
		// The root's terminal wait observes the writer's exact completion; the released gate lets the writer send its typed report.
		world.provider.enqueue(
			"root",
			calls("e13w-terminal", [
				{
					id: "e13w-terminal-1",
					name: "delegate",
					arguments: { action: "wait", agentId: e13wPreAgent.agentId, timeoutMs: 60_000 },
				},
			]),
			{
				name: "e13w-terminal-reply",
				check: (request) => {
					const waited = latestBatchResults(request).find((result) => result.toolName === "delegate");
					if (waited?.isError) throw new Error(`the terminal wait on the writer failed: ${waited.text}`);
				},
				reply: { content: [{ type: "text", text: "The joined-teardown writer finished." }] },
			},
		);
		world.systemOne.enterPhase("e13w-terminal", e4Judgments);
		e13wGate.release();
		await withDeadline(trace, "E13W writer terminal observed", e13wSession.prompt("Wait for the writer to finish."));
		await withDeadline(trace, "E13W settled", e13wSession.waitForForegroundIdle());
		const e13wSettled = e13wSession.getResourceSnapshot().workers;
		if (e13wSettled === undefined)
			throw new Error("the E13W owner reports no worker snapshot after the writer finished");
		expect(e13wSettled.reservations.heldLeases, "the finished writer's lease is released before the fault").toEqual(
			[],
		);
		expect(e13wSettled.executingHolds, "the finished writer holds no execution before the fault").toEqual([]);
		expect(e13wSettled.ownedProjectClaims, "the finished writer's claim is released before the fault").toEqual([]);
		expect(
			world.io.fileEntries().get(e13wStorePath) ?? "",
			"the released lease leaves the durable store before the fault",
		).not.toContain(e13wLease.reservationId);
		// Every observer on the store directory is registered by the coordinator, one per host workspace key, and each carries exactly its native change
		// callback. The first registration is the bounded wait's observer; the single close fault meets it first and the coordinator retains it.
		const e13wObservers = world.io.getWatcherSnapshot().filter((watcher) => watcher.path === dirname(e13wStorePath));
		expect(e13wObservers.length, "the settled owner counts every observer it registered on the store directory").toBe(
			e13wSettled.reservations.watchCount,
		);
		expect(e13wObservers[0]?.id, "the first registered observer is the bounded wait's").toBe(e13wWatch.id);
		expect(
			e13wObservers.every((watcher) => watcher.listenerCount === 1),
			"each registered observer carries exactly its native change callback",
		).toBe(true);
		world.io.failNext({
			name: "e13w-watch-close-fails",
			kind: "watch.close",
			matches: (operation) => operation.path === e13wWatch.path,
			code: "EIO",
			times: 1,
		});
		const e13wTeardown = await world.disposeSessionInBody(e13wSession);
		await world.provider.waitForProducers();
		const e13wFailure = e13wTeardown === undefined ? "no failure" : failureText(e13wTeardown.error);
		expect(e13wFailure, "the watcher-only teardown keeps the observer close cause").toContain(
			"e13w-watch-close-fails",
		);
		expect(e13wFailure, "the watcher-only teardown retains no write lease").not.toContain("retained");
		world.io.assertFaultsConsumed();
		expect(world.io.consumedFaults.at(-1), "the observer close fault is the one that fires").toBe(
			"e13w-watch-close-fails",
		);
		const e13wPost = e13wSession.getResourceSnapshot().workers;
		expect(e13wPost?.reservations.heldLeases, "the disposed owner keeps no lease").toEqual([]);
		expect(e13wPost?.executingHolds, "the disposed owner keeps no execution hold").toEqual([]);
		expect(e13wPost?.ownedProjectClaims, "the disposed owner keeps no claim").toEqual([]);
		expect(e13wPost?.reservations.watchCount, "the failed observer close keeps its native registration").toBe(1);
		expect(
			world.io
				.getWatcherSnapshot()
				.filter((watcher) => watcher.path === dirname(e13wStorePath))
				.map((watcher) => ({ id: watcher.id, listenerCount: watcher.listenerCount })),
			"the disposed owner retains only the first observer, with its native callback, and the other one closed",
		).toEqual([{ id: e13wWatch.id, listenerCount: 1 }]);
		// External transport cutoff of the one observer the native teardown retained, only after the native proof above.
		world.io.cutoffRetainedWatcher({ id: e13wWatch.id, path: e13wWatch.path });
		world.certifyDisposedOwner(e13wSession, [], { leases: [], executingHolds: [], watchCount: 1 });
	} finally {
		// Failure-safe: an assertion that fails before the normal release must not leave the writer gated for the journey's cleanup.
		e13wGate.release();
	}
	// E13 failed inner join, recomposed: the writer's bash tool runs inside its isolated completion, and its shell call ignores abort. Owner
	// cancellation leaves that public promise pending, so the physical join is the only settlement the owner can report. The public promise is
	// observed pending before the shell gate is released, and the gate is released in a finally so the producer can join even when the teardown fails.
	const e13bAdmitted = createBarrier();
	const e13bShellGate = createBarrier();
	const E13B_SCOPE = projectPath("e13b", "out");
	const e13bCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const e13bSession = e13bCreated.session;
	world.shell.enqueue({
		name: "e13b-shell",
		command: "echo e13b-shell",
		cwd: HARNESS_PROJECT_CWD,
		output: "e13b-shell\n",
		exitCode: 0,
		gate: e13bShellGate.promise,
		ignoresAbort: true,
		check: () => e13bAdmitted.release(),
	});
	world.provider.enqueue(
		"root",
		calls("e13b-start-first", [
			{
				id: "e13b-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: "harness-script", modelId: "worker-a" },
					writePaths: [E13B_SCOPE],
					instructions: "E13B-WRITER runs its shell command.",
				},
			},
		]),
		{
			name: "e13b-first-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the shell writer did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The shell writer is started." }] },
		},
	);
	world.provider.enqueue("worker-a", {
		name: "e13b-worker-bash",
		reply: {
			content: [{ type: "toolCall", id: "e13b-bash-1", name: "bash", arguments: { command: "echo e13b-shell" } }],
			stopReason: "toolUse",
		},
	});
	world.systemOne.enterPhase("e13b-first", {
		...e4Judgments,
		leaves_machine: { kind: "noul", probability: 0.02 },
		cannot_be_undone: { kind: "noul", probability: 0.02 },
		touches_outside_task: { kind: "noul", probability: 0.02 },
		acquires_external_code: { kind: "noul", probability: 0.02 },
		request_authorizes: { kind: "noul", probability: 0.02 },
	});
	await withDeadline(trace, "E13B first writer started", e13bSession.prompt("Start the shell writer."));
	await withDeadline(trace, "E13B shell admitted", e13bAdmitted.promise);

	const e13bPre = e13bSession.getResourceSnapshot().workers;
	if (e13bPre === undefined) throw new Error("the E13B owner reports no worker snapshot before teardown");
	const e13bLeases = e13bPre.reservations.heldLeases;
	const e13bHolds = e13bPre.executingHolds;
	const e13bPreClaims = e13bPre.ownedProjectClaims;
	const e13bLaneAborts = e13bPre.laneAbortControllerCount;
	expect(e13bLeases, "the shell writer holds exactly one write lease before teardown").toHaveLength(1);
	expect(e13bPreClaims, "the shell writer owns exactly one project claim before teardown").toHaveLength(1);
	const e13bPreAgent = e13bPreClaims[0]?.agents[0];
	if (e13bPreAgent === undefined) throw new Error("the E13B claim carries no agent");
	const e13bLease = e13bLeases[0];
	if (e13bLease === undefined) throw new Error("the E13B owner has no exact lease");
	expect(e13bLease.attemptId, "the exact lease belongs to the admitted attempt").toBe(e13bPreAgent.attemptId);
	const e13bCompletions = world.isolatedCompletions.slice();
	// The reload observable: the lane registration and the isolated registration are the in-flight units this owner holds.
	const e13bUnitsPre = structuredClone(getInFlightWorkUnits(world.agentDir));
	expect(
		e13bUnitsPre.map((unit) => unit.kind).sort(),
		"the shell writer holds exactly its lane and its isolated completion in flight before teardown",
	).toEqual(["isolated-completion", "lane"]);
	expect(
		e13bUnitsPre.find((unit) => unit.kind === "lane")?.label,
		"the in-flight lane is labelled by its exact worker lane id",
	).toBe(`worker:${e13bLease.taskId}`);
	const e13bBefore = await Promise.all(e13bCompletions.map((completion) => settlementState(completion)));
	expect(
		e13bBefore.filter((state) => state === "pending"),
		"exactly one isolated completion is pending while its shell call is gated",
	).toHaveLength(1);
	const e13bExpectedClaims: WorkerProjectClaims = e13bPreClaims.map((claim) => ({
		...claim,
		agents: [
			{
				agentId: e13bPreAgent.agentId,
				agentStatus: "suspended",
				attemptId: e13bPreAgent.attemptId,
				attemptStatus: "suspended",
				executingHoldCount: e13bPreAgent.executingHoldCount,
				mailboxLoaded: true,
				mailbox: {
					parentSessionId: e13bCreated.sessionManager.getSessionId(),
					agentId: e13bPreAgent.agentId,
					listenerCount: 0,
					hasOpenObligation: false,
					pendingMessageIds: [],
					replyAcknowledgementIds: [],
				},
			},
		],
	}));
	const e13bJoinPrefix = `Worker ${e13bPreAgent.agentId} attempt ${e13bPreAgent.attemptId} physical settlement timed out after 5000ms with `;

	try {
		const e13bTeardown = await withDeadline(
			trace,
			"E13B failed-join teardown",
			world.disposeSessionInBody(e13bSession),
			60_000,
		);
		const e13bFailure = e13bTeardown === undefined ? "no failure" : failureText(e13bTeardown.error);
		expect(e13bFailure, "the failed inner join names the exact attempt and the grace bound").toContain(
			e13bJoinPrefix,
		);
		const e13bDuring = await Promise.all(e13bCompletions.map((completion) => settlementState(completion)));
		expect(
			e13bDuring.filter((state) => state === "pending"),
			"the public isolated completion is still pending after owner cancellation, before the shell gate is released",
		).toHaveLength(1);
		expect(
			getInFlightWorkUnits(world.agentDir),
			"the failed join keeps the exact in-flight units while the public completion is pending",
		).toEqual(e13bUnitsPre);
		const e13bPost = e13bSession.getResourceSnapshot().workers;
		expect(e13bPost?.reservations.heldLeases, "the unresolved lane retains its exact fenced lease").toEqual(
			e13bLeases,
		);
		expect(e13bPost?.executingHolds, "the unresolved lane keeps its execution hold").toEqual(e13bHolds);
		expect(e13bPost?.ownedProjectClaims, "the retained claim is the predeclared shutdown tuple").toEqual(
			e13bExpectedClaims,
		);
		expect(e13bPost?.laneAbortControllerCount, "the unresolved lane keeps its lane abort controller").toBe(
			e13bLaneAborts,
		);
		expect(e13bPost?.reservations.watchCount, "this writer registered no observer").toBe(0);
		world.certifyDisposedOwner(e13bSession, e13bExpectedClaims, {
			leases: e13bLeases,
			executingHolds: e13bHolds,
			laneAbortControllers: e13bLaneAborts,
		});
	} finally {
		// Released even when the teardown fails: the gated shell call then settles, and the public completion joins.
		e13bShellGate.release();
	}
	await world.provider.waitForProducers();
	// The shell gate released, the public completion settles and its isolated registration leaves; the lane registration stays,
	// because a failed physical join never deregisters its lane and its cached failure is not re-run.
	await Promise.allSettled(e13bCompletions);
	expect(
		getInFlightWorkUnits(world.agentDir),
		"after the public completion settles only the lane registration remains in flight",
	).toEqual(e13bUnitsPre.filter((unit) => unit.kind === "lane"));

	// VU verifier UNKNOWN restart (positive). A read-only subject requires independent verification; its verifier is the automatic verifier of
	// the native profile, never model-manufactured. The verifier's bash check is held at a shell gate after its assistant call is persisted
	// and its attempt lease is running, and the owner is cut there. The captured owned bytes are restored, and a fresh owner recovers the
	// suspended verifier: the unmatched call is repaired once with the native UNKNOWN result, the verifier runs a fresh check and submits its
	// typed verdict, and the native reconciliation publishes it. Plain text is never a verdict.
	const VU_SUBJECT_PROFILE: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "vu-subject",
		description: "Read-only subject whose automatic independent verifier checks it.",
		role: "explorer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read"],
		readOnly: true,
		toolNames: ["read"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: {},
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: true,
		verificationProfileId: "vu-verifier",
		createdAt: "2026-10-09T00:00:00.000Z",
		updatedAt: "2026-10-09T00:00:00.000Z",
	};
	const VU_VERIFIER_PROFILE: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "vu-verifier",
		description:
			"Independent verifier that checks the subject with a read-only shell command and submits a typed verdict.",
		role: "verifier",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "harness-script", modelId: "worker-b", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "process.exec"],
		readOnly: true,
		toolNames: ["read", "bash"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: {},
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-09T00:00:00.000Z",
		updatedAt: "2026-10-09T00:00:00.000Z",
	};
	const vuProfileStore = new OrchestrationProfileStore({
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	});
	vuProfileStore.save(VU_VERIFIER_PROFILE, "global");
	vuProfileStore.save(VU_SUBJECT_PROFILE, "global");

	const vuHeld = createBarrier();
	const vuAdmitted = createBarrier();
	const vuFreshGate = createBarrier();
	const vuFreshAdmitted = createBarrier();
	const vuWake = createBarrier();
	world.shell.enqueue({
		name: "vu-held-check",
		command: "echo vu-check",
		cwd: HARNESS_PROJECT_CWD,
		output: "vu-check\n",
		exitCode: 0,
		gate: vuHeld.promise,
		check: () => vuAdmitted.release(),
	});
	world.shell.enqueue({
		name: "vu-fresh-check",
		command: "echo vu-fresh",
		cwd: HARNESS_PROJECT_CWD,
		output: "vu-fresh\n",
		exitCode: 0,
		gate: vuFreshGate.promise,
		check: () => vuFreshAdmitted.release(),
	});
	const vuOwnerCreated = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
	const vuOwner = vuOwnerCreated.session;
	world.provider.enqueue(
		"root",
		calls("vu-start", [
			{
				id: "vu-start-1",
				name: "delegate",
				arguments: { action: "start", profileId: "vu-subject", instructions: "VU-SUBJECT reads the record." },
			},
		]),
		{
			name: "vu-start-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the verification subject did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "The verification subject is started." }] },
		},
	);
	world.provider.enqueue("worker-a", {
		name: "vu-subject-report",
		reply: {
			content: [
				{
					type: "toolCall",
					id: "vu-report-subject",
					name: "submit_report",
					arguments: { status: "completed", summary: "The verification subject finished." },
				},
			],
			stopReason: "toolUse",
		},
	});
	world.provider.enqueue("worker-b", {
		name: "vu-verifier-check",
		check: (request) => {
			if (!(request.context.tools ?? []).some((tool) => tool.name === "bash")) {
				throw new Error("the automatic verifier is not offered bash");
			}
		},
		reply: {
			content: [{ type: "toolCall", id: "vu-bash-1", name: "bash", arguments: { command: "echo vu-check" } }],
			stopReason: "toolUse",
		},
	});
	world.provider.enqueue("worker-b", {
		name: "vu-verifier-fresh-check",
		check: (request) => {
			const repairs = request.context.messages.filter(
				(message) => message.role === "toolResult" && message.toolCallId === "vu-bash-1",
			).length;
			if (repairs !== 1)
				throw new Error(`the recovered verifier carries ${repairs} native UNKNOWN results, not one`);
		},
		reply: {
			content: [{ type: "toolCall", id: "vu-bash-2", name: "bash", arguments: { command: "echo vu-fresh" } }],
			stopReason: "toolUse",
		},
	});
	world.provider.enqueue("worker-b", {
		name: "vu-verifier-verdict",
		reply: {
			content: [
				{
					type: "toolCall",
					id: "vu-report-verifier",
					name: "submit_report",
					arguments: {
						status: "completed",
						summary: "The subject record matches the check.",
						verdict: "accepted",
						reasonCodes: ["vu_record_matches"],
					},
				},
			],
			stopReason: "toolUse",
		},
	});
	world.provider.enqueue("root", {
		name: "vu-continue",
		reply: { content: [{ type: "text", text: "The recovered verification is still running." }] },
	});
	world.provider.enqueue("root", {
		name: "vu-wake",
		maxRequests: 8,
		until: (request) => {
			const messages = JSON.stringify(request.context.messages);
			const subjectId = agentIdForTrack(request, "worker-a");
			const settled =
				messages.includes(`- ${subjectId}: `) && messages.includes("independent_verification_accepted");
			if (settled) vuWake.release();
			return settled;
		},
		reply: { content: [{ type: "text", text: "Verification is still settling." }] },
	});
	const vuJudgments = {
		...e4Judgments,
		states_tests_pass: { kind: "choice", choice: "no_current_success", confidence: 0.97 },
		states_committed: { kind: "noul", probability: 0.02 },
		states_pushed: { kind: "noul", probability: 0.02 },
		states_published: { kind: "noul", probability: 0.02 },
		states_files_changed: { kind: "noul", probability: 0.02 },
		leaves_machine: { kind: "noul", probability: 0.02 },
		cannot_be_undone: { kind: "noul", probability: 0.02 },
		touches_outside_task: { kind: "noul", probability: 0.02 },
		acquires_external_code: { kind: "noul", probability: 0.02 },
		request_authorizes: { kind: "noul", probability: 0.02 },
	} as const;
	world.systemOne.enterPhase("vu-start", vuJudgments);
	await withDeadline(trace, "VU subject started", vuOwner.prompt("Start the verification subject."));
	await withDeadline(trace, "VU verifier held at its shell check", vuAdmitted.promise, 90_000);

	// The pre-cut identity: exactly one running verifier attempt with its lease, its agent, and the subject it verifies.
	const vuPre = vuOwner.backgroundLanes.getTaskRuntimeSnapshot();
	if (vuPre === undefined) throw new Error("the VU owner reports no task runtime before the cut");
	const vuRunning = Object.values(vuPre.attempts).filter((attempt) => attempt.status === "running");
	expect(vuRunning, "exactly one verifier attempt is running at its held check").toHaveLength(1);
	const vuAttempt = vuRunning[0];
	if (vuAttempt === undefined || vuAttempt.agentId === undefined || vuAttempt.lease === undefined) {
		throw new Error("the held verifier attempt has no agent or no execution lease");
	}
	const vuVerifierTaskId = vuAttempt.taskId;
	const vuAgentId = vuAttempt.agentId;
	const vuSubjectTaskIds = Object.keys(vuPre.tasks).filter((taskId) => taskId !== vuVerifierTaskId);
	expect(vuSubjectTaskIds, "the verified subject is the only other task").toHaveLength(1);
	const vuSubjectTaskId = vuSubjectTaskIds[0] ?? "";
	const vuSubjectAgentId = Object.values(vuPre.attempts).find(
		(attempt) => attempt.taskId === vuSubjectTaskId,
	)?.agentId;
	if (vuSubjectAgentId === undefined) throw new Error("the subject carries no agent");
	expect(vuPre.tasks[vuSubjectTaskId]?.task.status, "the subject waits for its verifier").toBe("blocked");
	expect(vuPre.tasks[vuSubjectTaskId]?.verification, "the subject has no verdict before its verifier settles").toBe(
		undefined,
	);
	const vuPreWorkers = vuOwner.getResourceSnapshot().workers;
	expect(vuPreWorkers?.ownedProjectClaims, "the automatic verifier holds no project claim").toEqual([]);
	expect(vuPreWorkers?.executingHolds, "the running verifier holds exactly its own execution").toEqual([
		{ agentId: vuAgentId, count: 1 },
	]);
	const vuVerifierAgent = vuPre.agents[vuAgentId];
	if (vuVerifierAgent === undefined) throw new Error("the verifier has no binding");
	expect(
		new WorkerConversationStore().getProjectContextBinding({
			agentDir: world.agentDir,
			resumeContext: vuVerifierAgent.resumeContext,
			expectedLogicalAgentId: vuAgentId,
		}),
		"the automatic verifier never allocated project context",
	).toBeUndefined();
	const vuOpen = (session: AgentSession, agentId: string) => {
		const agent = session.backgroundLanes.getTaskRuntimeSnapshot()?.agents[agentId];
		if (agent === undefined) throw new Error(`no binding for ${agentId}`);
		return new WorkerConversationStore().open({
			agentDir: world.agentDir,
			resumeContext: agent.resumeContext,
			expectedLogicalAgentId: agentId,
		});
	};
	const vuPersisted = vuOpen(vuOwner, vuAgentId).getRawTranscript().at(-1);
	expect(
		vuPersisted?.role === "assistant" &&
			vuPersisted.content.some((content) => content.type === "toolCall" && content.id === "vu-bash-1"),
		"the verifier's assistant call is persisted before its shell check",
	).toBe(true);
	const vuPreGrant = vuAttempt.grant;
	const vuPreDispatch = vuAttempt.dispatch;
	const vuPreFence = vuAttempt.lease.fencingToken;

	// The owned files at the held point: the aux session file, the parent's control-plane bundle without leases or SQLite, and the
	// verifier and subject session files with their sidecars. The cap is explicit; a breach fails.
	const VU_MAX_FILES = 512;
	const VU_MAX_BYTES = 8 * 1024 * 1024;
	const vuAuxFile = vuOwnerCreated.sessionManager.getSessionFile();
	if (vuAuxFile === undefined) throw new Error("the VU owner has no session file");
	const vuManifest = (): Map<string, string> => {
		const entries = world.io.fileEntries();
		const selected = new Map<string, string>();
		const take = (path: string | undefined): void => {
			if (path === undefined) return;
			const content = entries.get(path);
			if (content !== undefined) selected.set(path, content);
		};
		take(vuAuxFile);
		for (const [path, content] of bundleEntries(
			entries,
			orchestrationSessionDir(world.agentDir, vuOwnerCreated.sessionManager.getSessionId()),
		)) {
			selected.set(path, content);
		}
		for (const agentId of [vuAgentId, vuSubjectAgentId]) {
			const sessionFile = vuPre.agents[agentId]?.resumeContext.sessionFile;
			if (sessionFile === undefined) throw new Error(`no session file for ${agentId}`);
			take(sessionFile);
			take(`${sessionFile}.worker.json`);
		}
		const bytes = [...selected.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0);
		if (selected.size > VU_MAX_FILES || bytes > VU_MAX_BYTES) {
			throw new Error(`the VU manifest exceeds its caps: ${selected.size} files, ${bytes} bytes`);
		}
		return selected;
	};
	const vuCapture = vuManifest();

	// The old owner ends: its shell check is cancelled by the abort, the transport producers join, and the disposed owner certifies
	// before any byte is restored.
	expect(
		await world.disposeSessionInBody(vuOwner),
		"the VU owner disposes cleanly after the cut point",
	).toBeUndefined();
	await world.provider.waitForProducers();
	expect(world.provider.failures, "no transport callback failed during the old owner's life").toEqual([]);
	world.certifyDisposedOwner(vuOwner, []);
	for (const [path] of vuManifest()) {
		if (!vuCapture.has(path)) world.io.unlinkSync(path);
	}
	for (const [path, content] of vuCapture) {
		world.io.mkdirSync(resolve(path, ".."), { recursive: true });
		world.io.writeFileSync(path, content);
	}
	expect(vuManifest(), "the cut restores exactly the captured owned files").toEqual(vuCapture);
	world.processTable.advanceProcess();

	// A fresh owner recovers twice through the native entrance, and the suspended verifier resumes on its own.
	const vuFresh = await world.createRootSession("root", { sessionManager: world.openSessionManager(vuAuxFile) });
	vuFresh.session.getLaneRecords();
	vuFresh.session.getLaneRecords();
	world.systemOne.enterPhase("vu-continue", vuJudgments);
	await withDeadline(trace, "VU recovered root turn", vuFresh.session.prompt("Continue after the restart."));
	await withDeadline(trace, "VU verifier resumed to its fresh check", vuFreshAdmitted.promise, 90_000);
	const vuResumed = vuFresh.session.backgroundLanes.getTaskRuntimeSnapshot();
	const vuResumedAttempt = vuResumed?.attempts[vuAttempt.attemptId];
	expect(vuResumedAttempt?.status, "the same verifier attempt is running again").toBe("running");
	expect(vuResumedAttempt?.taskId, "the resumed attempt belongs to the same verifier task").toBe(vuVerifierTaskId);
	expect(vuResumedAttempt?.grant, "the resumed attempt keeps its original grant").toEqual(vuPreGrant);
	expect(vuResumedAttempt?.dispatch, "the resumed attempt keeps its compiled dispatch").toEqual(vuPreDispatch);
	expect(
		(vuResumedAttempt?.lease?.fencingToken ?? 0) > vuPreFence,
		"the resumed attempt's execution lease fence advanced",
	).toBe(true);
	const vuRepairs = vuOpen(vuFresh.session, vuAgentId)
		.getRawTranscript()
		.filter((message) => message.role === "toolResult" && message.toolCallId === "vu-bash-1");
	expect(vuRepairs, "the unmatched call is repaired exactly once").toHaveLength(1);
	expect(vuRepairs[0]?.role === "toolResult" && vuRepairs[0].isError, "the repair is an error outcome").toBe(true);
	expect(JSON.stringify(vuRepairs[0]?.content), "the repair is the native UNKNOWN outcome").toContain(
		"Execution outcome is unknown",
	);
	expect(vuResumed?.tasks[vuSubjectTaskId]?.task.status, "the subject stays pending until its verifier settles").toBe(
		"blocked",
	);
	expect(
		new WorkerConversationStore().getProjectContextBinding({
			agentDir: world.agentDir,
			resumeContext: vuResumed?.agents[vuAgentId]?.resumeContext ?? vuVerifierAgent.resumeContext,
			expectedLogicalAgentId: vuAgentId,
		}),
		"the recovered verifier still never allocated project context",
	).toBeUndefined();
	vuFreshGate.release();
	await withDeadline(trace, "VU verdict published", vuWake.promise);

	// The native verdict: the subject completes on the accepted verdict of its real verifier, under the same verifier identity.
	const vuDone = vuFresh.session.backgroundLanes.getTaskRuntimeSnapshot();
	const vuSubject = vuDone?.tasks[vuSubjectTaskId];
	expect(vuSubject?.task.status, "the verified subject completes on its accepted verdict").toBe("completed");
	expect(vuSubject?.verification?.verdict, "the real verifier's typed verdict is accepted").toBe("accepted");
	expect(vuSubject?.verification?.reasonCode, "the accepted verdict names the independent verification").toBe(
		"independent_verification_accepted",
	);
	expect(vuSubject?.verification?.verifierTaskId, "the verdict names the same verifier task").toBe(vuVerifierTaskId);
	expect(vuSubject?.verification?.verifierAttemptId, "the verdict names the same verifier attempt").toBe(
		vuAttempt.attemptId,
	);
	const vuFinal = vuDone?.attempts[vuAttempt.attemptId];
	expect(vuFinal?.grant, "the verifier keeps its original grant to the end").toEqual(vuPreGrant);

	// Repeated settled recovery: the entrance again repeats nothing: no provider request, no repair, no output.
	const vuProvidersBefore = world.provider.reached.filter((name) => name.startsWith("worker-b:")).length;
	vuFresh.session.getLaneRecords();
	vuFresh.session.getLaneRecords();
	expect(
		world.provider.reached.filter((name) => name.startsWith("worker-b:")).length,
		"the settled recovery makes no new verifier provider request",
	).toBe(vuProvidersBefore);
	expect(
		vuOpen(vuFresh.session, vuAgentId)
			.getRawTranscript()
			.filter((message) => message.role === "toolResult" && message.toolCallId === "vu-bash-1"),
		"the settled recovery repeats no repair",
	).toHaveLength(1);
	expect(await world.disposeSessionInBody(vuFresh.session), "the recovered VU owner disposes cleanly").toBeUndefined();
	// Windows shell contract (Node contract, not a Windows host): the platform bash definition for win32, with its own session key, runs through the
	// released Windows engine adapter. The process platform stays POSIX; this proves the native Windows wiring, not Python, Windows or CI.
	const winOwnedKey = "j1-windows-contract";
	const winTool = createBashToolDefinition(HARNESS_PROJECT_CWD, { platform: "win32", sessionKey: winOwnedKey });
	const winCommand = "Write-Output 'win-contract'";
	const winMissing = "Get-Item 'win-missing.txt'";
	// A real directory of the seeded project. The persistent cd changes the native cwd; the commands after it must run from that changed cwd.
	const winDir = projectPath("src", "features", "retry", "configuration");
	const winChange = 'cd "src/features/retry/configuration"';
	const winAfter = "Get-Item 'limits.ts'";
	const winPlan = [winCommand, winChange, winAfter, winMissing];
	world.shell.enqueue({
		name: "win-contract-echo",
		command: winCommand,
		cwd: HARNESS_PROJECT_CWD,
		output: "win-contract\n",
		exitCode: 0,
	});
	world.shell.enqueue({
		name: "win-contract-change",
		command: winChange,
		cwd: HARNESS_PROJECT_CWD,
		output: "",
		exitCode: 0,
		resultCwd: winDir,
	});
	world.shell.enqueue({
		name: "win-contract-after",
		command: winAfter,
		cwd: winDir,
		output: "limits.ts\n",
		exitCode: 0,
	});
	world.shell.enqueue({
		name: "win-contract-missing",
		command: winMissing,
		cwd: winDir,
		output: "Get-Item: win-missing.txt not found\n",
		exitCode: 1,
	});
	const winCreated = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		customTools: [winTool],
		omitShellOperations: true,
	});
	const winSession = winCreated.session;
	world.provider.enqueue(
		"root",
		calls("win-start", [{ id: "win-call-1", name: winTool.name, arguments: { command: winCommand } }]),
		{
			name: "win-reply",
			check: (request) => {
				const result = latestBatchResults(request).find((item) => item.toolName === winTool.name);
				if (result?.isError || !result?.text.includes("win-contract")) {
					throw new Error(
						`the Windows contract result is not the scripted output: ${result?.text ?? "no result"}`,
					);
				}
			},
			reply: {
				content: [{ type: "toolCall", id: "win-call-2", name: winTool.name, arguments: { command: winChange } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "win-reply-changed",
			check: (request) => {
				const result = latestBatchResults(request).find((item) => item.toolName === winTool.name);
				if (result?.isError) throw new Error(`the persistent cd failed: ${result.text}`);
			},
			reply: {
				content: [{ type: "toolCall", id: "win-call-3", name: winTool.name, arguments: { command: winAfter } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "win-reply-after",
			check: (request) => {
				const result = latestBatchResults(request).find((item) => item.toolName === winTool.name);
				if (result?.isError || !result?.text.includes("limits.ts")) {
					throw new Error(
						`the command after cd did not run in the changed directory: ${result?.text ?? "no result"}`,
					);
				}
			},
			reply: {
				content: [{ type: "toolCall", id: "win-call-4", name: winTool.name, arguments: { command: winMissing } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "win-reply-missing",
			check: (request) => {
				const result = latestBatchResults(request).find((item) => item.toolName === winTool.name);
				if (result?.isError !== true || !result?.text.includes("not found")) {
					throw new Error(
						`the normal failure is not reported as the native error result: ${result?.text ?? "no result"}`,
					);
				}
			},
			reply: { content: [{ type: "text", text: "The Windows contract command ran." }] },
		},
	);
	world.systemOne.enterPhase("win-contract", {
		...e4Judgments,
		leaves_machine: { kind: "noul", probability: 0.02 },
		cannot_be_undone: { kind: "noul", probability: 0.02 },
		touches_outside_task: { kind: "noul", probability: 0.02 },
		acquires_external_code: { kind: "noul", probability: 0.02 },
		request_authorizes: { kind: "noul", probability: 0.02 },
	});
	const winErrors: unknown[] = [];
	try {
		// The offered tool is the bash definition whose backend is the platform shell (PowerShell for win32); the catalog is traced before any authored call.
		expect(winTool.name, "the win32 definition is offered under the bash tool name").toBe("bash");
		expect(winSession.getActiveToolNames(), "the session offers the win32 platform shell").toContain(winTool.name);
		await withDeadline(trace, "Windows contract turn", winSession.prompt("Run the Windows contract command."));
		await withDeadline(trace, "Windows contract settled", winSession.waitForForegroundIdle());
		expect(
			world.shell.requests.filter((request) => request.command === winCommand).length,
			"the Windows contract command reaches the shared shell exactly once",
		).toBe(1);
		// Native requests and frames: the cd's reported cwd is the state the next request carries; the nonzero exit stays a native frame.
		const winRequests = world.windowsShell.requests.filter((record) => winPlan.includes(record.command));
		expect(
			winRequests.map((record) => ({
				command: record.command,
				cwd: record.cwd,
				outcome: record.outcome,
				exitCode: record.exitCode,
				reportedCwd: record.reportedCwd,
				powershell: record.powershell,
			})),
			`the adapter's requests and native frames follow the declared cd state; observed ${JSON.stringify(
				winRequests.map(({ requestId, command, cwd, outcome, exitCode, reportedCwd }) => ({
					requestId,
					command,
					cwd,
					outcome,
					exitCode,
					reportedCwd,
				})),
			)}`,
		).toEqual([
			{
				command: winCommand,
				cwd: HARNESS_PROJECT_CWD,
				outcome: "completed",
				exitCode: 0,
				reportedCwd: HARNESS_PROJECT_CWD,
				powershell: false,
			},
			{
				command: winChange,
				cwd: HARNESS_PROJECT_CWD,
				outcome: "completed",
				exitCode: 0,
				reportedCwd: winDir,
				powershell: false,
			},
			{
				command: winAfter,
				cwd: winDir,
				outcome: "completed",
				exitCode: 0,
				reportedCwd: winDir,
				powershell: false,
			},
			{
				command: winMissing,
				cwd: winDir,
				outcome: "completed",
				exitCode: 1,
				reportedCwd: winDir,
				powershell: false,
			},
		]);
		expect(
			new Set(winRequests.map((record) => record.requestId)).size,
			"every command carries its own request nonce",
		).toBe(winPlan.length);
	} catch (error) {
		winErrors.push(error);
	} finally {
		// Session abort, join and disposal first, then the shell session this owner's key names, while the effect guard stays installed.
		const winDisposal = await world.disposeSessionInBody(winSession);
		if (winDisposal !== undefined) winErrors.push(winDisposal.error);
		try {
			await disposeShellExecutionSessionAndWait(winOwnedKey);
		} catch (error) {
			winErrors.push(error);
		}
	}
	if (winErrors.length === 1) throw winErrors[0];
	if (winErrors.length > 1)
		throw new AggregateError(winErrors, "the Windows contract phase failed and its cleanup failed");
	trace.mark("root", "windows.contract");

	// Whole-journey count of the E2 uncertain-relation warning: one on the relation's own turn, none off. The global allowance only
	// admits the text; this exact count keeps any extra occurrence fatal.
	expect(
		world.warnings.filter(
			(message) =>
				message ===
				"Optional integrations stay available; owner intent for them was not classified: the judgment was uncertain.",
		).length,
		"the uncertain relation warns exactly once on and never off across the whole journey",
	).toBe(world.systemOne.enabled ? 1 : 0);
	// The intentional evaluator outage (the long-path turn) emits exactly one warning on; off runs no System One and emits none.
	expect(
		world.warnings.filter((message) => message.includes("Jev System One unavailable")).length,
		"the intentional evaluator outage warns exactly as its scripted turn requires",
	).toBe(world.systemOne.enabled ? 1 : 0);
	// Production default window, asserted on its own: the short window below replaces it only for this session's ask tool.
	expect(DEFAULT_OWNER_WAIT_TIMEOUT_MS, "the production owner window keeps its default").toBe(300_000);
	// Short owner window, simulated: the native ask tool with a 1000 ms ownerWaitTimeoutMs replaces the built-in ask_question for this
	// session. A question nobody answers stays open for that window, then resolves to the unanswered result. The presenter's gate is
	// never released, so only the native deadline's abort can settle the presentation.
	const SHORT_OWNER_WAIT_MS = 1_000;
	const DEADLINE_CALL_ID = "deadline-ask-1";
	const deadlinePresented = createBarrier();
	const deadlineNeverAnswered = createBarrier();
	let deadlineRequestId: string | undefined;
	const deadlineManager = world.createSessionManager();
	const deadlineAsk = await world.createRootSession("root", {
		sessionManager: deadlineManager,
		customTools: [
			createAskQuestionToolDefinition({
				sessionManager: deadlineManager,
				ownerWaitTimeoutMs: SHORT_OWNER_WAIT_MS,
			}),
		],
	});
	await deadlineAsk.session.bindExtensions({ uiContext: world.humanInput.ui });
	world.provider.enqueue(
		"root",
		calls("deadline-ask", [
			{
				id: DEADLINE_CALL_ID,
				name: "ask_question",
				arguments: {
					questions: [
						{
							id: "deadline",
							header: "Deadline",
							question: "Which limit applies once the owner window closes?",
							options: [
								{ label: "Staging", description: "Use the staging limit." },
								{ label: "Production", description: "Use the production limit." },
							],
						},
					],
				},
			},
		]),
		{
			name: "deadline-unanswered-reported",
			check: (request) => {
				const unanswered = request.context.messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolCallId === DEADLINE_CALL_ID &&
						message.content.some((block) => block.type === "text" && block.text.includes("Owner did not answer")),
				);
				if (!unanswered) throw new Error("the expired question's unanswered result is not in the provider context");
			},
			reply: { content: [{ type: "text", text: "No owner decision was granted." }] },
		},
	);
	world.humanInput.enqueue({
		name: "deadline-presented",
		gate: deadlineNeverAnswered.promise,
		check: (request) => {
			deadlineRequestId = request.requestId;
			deadlinePresented.release();
		},
		reply: { answers: [], cancelled: true, reason: "interrupted", imageContents: [] },
	});
	const deadlineStarted = Date.now();
	const deadlineTurn = deadlineAsk.session.prompt("Ask which limit applies once the owner window closes.");
	await withDeadline(trace, "deadline question presented", deadlinePresented.promise);
	await withDeadline(trace, "short owner window elapsed", deadlineTurn, 10_000);
	expect(
		Date.now() - deadlineStarted,
		"the owner window elapsed in full: the presented question waited the short native window before it settled",
	).toBeGreaterThanOrEqual(SHORT_OWNER_WAIT_MS - 100);
	await withDeadline(trace, "deadline presentation settled", world.humanInput.join());
	expect(
		getLatestHumanInputSnapshots(deadlineAsk.sessionManager).find(
			(snapshot) => snapshot.request.requestId === deadlineRequestId,
		)?.status,
		"the expired question's durable snapshot stays pending: no answer, cancellation or decision was recorded",
	).toBe("pending");
	expect(await world.disposeSessionInBody(deadlineAsk.session), "the deadline owner disposes cleanly").toBeUndefined();
	trace.mark("root", "deadline.window");

	// Root memory query gate: an external context memory provider is queried only by a turn that passes the long-term trigger
	// and carries no credential shape, with external egress explicitly enabled. The secret turn runs first and the normal turn
	// after it, on the same session, so the normal turn proves the blocked turn left the provider usable. The key is joined from
	// two literals (no source line carries it whole). The prompts say "Recall", not "Remember": "remember" is a durable or correction
	// signal (learning/reflection-turn-analysis.ts) that would buy an internal reflection turn on the root track and consume the
	// scripted steps below. "Recall" keeps the explicit-recall trigger that the gate under test depends on.
	const memoryKey = ["AIzaD3kQ9vL", "m2Xp8Rt4Wz6Yc1Nb5Hj7Fg0TsUe9"].join("");
	const memorySecretQuery = `Recall this key for the release deploy: ${memoryKey}`;
	const memoryNormalQuery = "Recall the release preference for this project.";
	const memoryProviderId = "harness-context-memory";
	const memorySearches: string[] = [];
	world.provider.enqueue(
		"root",
		{
			name: "memory-secret-reply",
			check: (request) => {
				if (!requestTexts(request).some((entry) => entry.includes("Recall this key for the release deploy")))
					throw new Error("the first root request is not the secret turn");
			},
			reply: { content: [{ type: "text", text: "The secret query was withheld." }] },
		},
		{
			name: "memory-normal-reply",
			check: (request) => {
				if (!requestTexts(request).some((entry) => entry.includes(memoryNormalQuery)))
					throw new Error("the second root request is not the normal turn");
			},
			reply: { content: [{ type: "text", text: "The preference was looked up." }] },
		},
	);
	const memoryOwner = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		systemOneEnabled: false,
		settings: { contextPolicy: { memory: { allowExternalEgress: true } } },
		extensionFactories: [
			(pi) => {
				// Registration waits for session_start, which only bindExtensions emits: the session is bound below, before its first prompt.
				pi.on("session_start", () => {
					pi.registerContextMemoryProvider({
						id: memoryProviderId,
						label: "Harness context memory",
						source: "external_provider",
						capabilities: {
							search: true,
							fetch: false,
							write: false,
							delete: false,
							shortTerm: false,
							longTerm: true,
							graph: false,
							citations: false,
							scopes: ["session"],
							localOnly: false,
						},
						search: async (request) => {
							memorySearches.push(request.query);
							return [];
						},
						fetch: async () => undefined,
					});
				});
			},
		],
	});
	await memoryOwner.session.bindExtensions({ uiContext: world.humanInput.ui });
	const memorySession = memoryOwner.session;
	await withDeadline(trace, "memory secret turn", memorySession.prompt(memorySecretQuery));
	trace.mark("root", "memory.secret");
	expect(world.provider.reached, "the secret turn reached the root boundary").toContain("root:memory-secret-reply");
	expect(memorySearches, "the secret query never reaches the extension provider's search").toEqual([]);
	const blockedReports = memorySession.getMemoryRetrievalReport().providerReports;
	expect(
		blockedReports.some((report) => report.providerId === memoryProviderId),
		"the withheld extension provider is not queried or reported",
	).toBe(false);
	expect(
		blockedReports.find((report) => report.providerId === TRANSCRIPT_MEMORY_PROVIDER_ID),
		"the transcript provider reports the refusal with its secret_like_query reason",
	).toMatchObject({ status: "blocked", rejectionReasons: ["secret_like_query"], resultCount: 0 });
	await withDeadline(trace, "memory normal turn", memorySession.prompt(memoryNormalQuery));
	trace.mark("root", "memory.normal");
	expect(world.provider.reached, "the normal turn reached the root boundary").toContain("root:memory-normal-reply");
	expect(memorySearches, "the normal query reaches the extension provider's search exactly once").toEqual([
		memoryNormalQuery,
	]);
	expect(
		memorySession.getMemoryRetrievalReport().providerReports.find((report) => report.providerId === memoryProviderId),
		"the normal query is reported as queried with no rejection",
	).toMatchObject({ status: "queried", rejectionReasons: [], resultCount: 0 });
	expect(await world.disposeSessionInBody(memorySession), "the memory gate owner disposes cleanly").toBeUndefined();
	trace.mark("root", "memory.gate");
}
