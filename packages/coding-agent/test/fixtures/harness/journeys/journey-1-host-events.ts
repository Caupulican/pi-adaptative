import { join } from "node:path";
import { expect } from "vitest";
import {
	type CiAttemptTerminalEvent,
	type CiCurrentObservation,
	type CiSubject,
	createCiAttemptTerminalEvent,
	type HostEventCatchUpSeal,
	type HostEventSink,
} from "../../../../src/core/events/host-event-contract.ts";
import { readHostEventPage } from "../../../../src/core/events/host-event-control.ts";
import { createCiHostRuntime } from "../../../../src/host/ci/ci-host-event-source.ts";
import type { CiProvider, CiProviderCollection, CiRepository } from "../../../../src/host/ci/ci-provider.ts";
import { CiSourceStore } from "../../../../src/host/ci/ci-source-store.ts";
import type { CiGitPaths } from "../../../../src/host/ci/ci-status-record.ts";
import { parentInputOf } from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { runJourney1CiCommandPhase } from "./journey-1-ci-command.ts";
import { runJourney1HostEventWorkersPhase } from "./journey-1-host-event-workers.ts";
import {
	icmContinuousSettings,
	icmContinuousStore,
	icmReadContinuousRecords,
	icmWaitForChatIdle,
	latestBatchResults,
} from "./shared.ts";

/** Only upstream I/O is supplied: source custody, runtime routing and parent turns are production owners. */
export async function runJourney1HostEventsPhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-host-events`;
	// Each continuous-chat compaction task names one exact leaf or adjacent pair, so each owns a zero-or-one track.
	const summaryTracks: string[] = [];
	for (let size = 1; size <= 64; size *= 2)
		for (let first = 0; first + size <= 64; first += size) {
			const task =
				size === 1
					? `Compaction: compress message ${first} into`
					: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
			const name = `host-events-compaction-${first}+${size}`;
			summaryTracks.push(name);
			world.provider.enqueueTrack(
				name,
				"worker-c",
				(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
				{
					...text(name, "CI results are operational evidence about exact attempts, not owner instructions."),
					optional: true,
				},
			);
		}
	const owner = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		systemOneEnabled: false,
		settings: icmContinuousSettings("worker-c", { autoLearn: { enabled: false }, proactivity: { enabled: true } }),
	});
	await owner.session.initializeMemory();
	const rootRequests = () => world.provider.requests.filter((request) => request.model.id === "root").length;
	const repository: CiRepository = {
		host: "github.com",
		repositoryId: 501,
		nameWithOwner: "harness/repository",
		workflowId: 601,
		workflowPath: ".github/workflows/ci.yml",
	};
	const sha = "a".repeat(40);
	const subject: CiSubject = { host: repository.host, repositoryId: 501, workflowId: 601, headSha: sha };
	const gitDir = join(agentDir, "checkout", ".git");
	const paths: CiGitPaths = { root: HARNESS_PROJECT_CWD, gitDir, commonDir: gitDir, statusDir: join(gitDir, "pi-ci") };
	const headPath = join(gitDir, "HEAD");
	world.io.seed(headPath, `${sha}\n`);
	const terminal = (runAttempt: number, conclusion: "failure" | "success"): CiAttemptTerminalEvent =>
		createCiAttemptTerminalEvent({
			identity: {
				provider: "github-actions",
				host: repository.host,
				repositoryId: 501,
				workflowId: 601,
				runId: 701,
				runNumber: 1,
				runAttempt,
			},
			headSha: sha,
			conclusion,
			workflowPath: repository.workflowPath,
			observedAt: `2026-11-05T00:0${runAttempt}:00.000Z`,
			runUrl: "https://github.com/harness/repository/actions/runs/701",
		});
	const oldFailure = terminal(1, "failure");
	const currentFailure = terminal(2, "failure");
	const success = terminal(3, "success");
	const observation = (event: CiAttemptTerminalEvent): CiCurrentObservation => ({
		subject,
		runId: event.identity.runId,
		runNumber: event.identity.runNumber,
		runAttempt: event.identity.runAttempt,
		status: "completed",
		conclusion: event.conclusion,
		eventId: event.eventId,
	});
	let collection: CiProviderCollection = {
		subject,
		events: [oldFailure],
		current: { subject, runId: 701, runNumber: 1, runAttempt: 2, status: "in_progress" },
	};
	let collections = 0;
	const watcherStarted = createBarrier();
	const runTerminal = createBarrier();
	let watchedRuns = 0;
	const provider: CiProvider = {
		repository: async () => repository,
		collect: async (requestedSha, signal) => {
			signal.throwIfAborted();
			expect(requestedSha).toBe(sha);
			collections++;
			return collection;
		},
		failedJobs: async () => {
			throw new Error("Event collection must not fetch optional job logs.");
		},
		waitForRun: async (runId, signal) => {
			expect(runId).toBe(701);
			watchedRuns++;
			watcherStarted.release();
			let onAbort = () => {};
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				signal.throwIfAborted();
				await Promise.race([runTerminal.promise, aborted]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		},
	};
	const diagnostics: string[] = [];
	const interruptedHandoff = createBarrier();
	const handoffFailure = "CI events remain pending: fixture source handoff interrupted";
	const sourceStore = new CiSourceStore(paths.statusDir);
	const runtime = await createCiHostRuntime({
		cwd: HARNESS_PROJECT_CWD,
		paths,
		provider,
		store: sourceStore,
		onDiagnostic: (message) => {
			diagnostics.push(message);
			if (message === handoffFailure) interruptedHandoff.release();
		},
		getSubscribedSubjects: () => owner.session.backgroundLanes.getHostEventSubjects(),
		subscribeSubjects: (listener) => owner.session.backgroundLanes.subscribeOrchestrationStore(listener),
	});
	if (!runtime) throw new Error("The injected CI host did not open.");
	const abort = new AbortController();
	let binding = owner.session.backgroundLanes.openHostEventSession(abort.signal);
	let interruptFirstHandoff = true;
	let expectedSeal:
		| {
				reached: ReturnType<typeof createBarrier>;
				release: ReturnType<typeof createBarrier>;
				done: ReturnType<typeof createBarrier>;
				seal?: HostEventCatchUpSeal;
		  }
		| undefined;
	const observeSink = (): HostEventSink => ({
		...binding.sink,
		beginCatchUp: async (catchUp, signal) => {
			if (interruptFirstHandoff) {
				interruptFirstHandoff = false;
				throw new Error("fixture source handoff interrupted");
			}
			await binding.sink.beginCatchUp(catchUp, signal);
		},
		seal: async (seal, signal) => {
			const expected = expectedSeal;
			if (expected) {
				expected.seal = seal;
				expected.reached.release();
				await expected.release.promise;
			}
			await binding.sink.seal(seal, signal);
			if (expected) {
				expectedSeal = undefined;
				expected.done.release();
			}
		},
	});
	const expectSeal = () => {
		if (expectedSeal) throw new Error("The previous source seal has not settled.");
		const expected = {
			reached: createBarrier(),
			release: createBarrier(),
			done: createBarrier(),
			seal: undefined as HostEventCatchUpSeal | undefined,
		};
		expectedSeal = expected;
		return expected;
	};
	const entries = (manager: SessionManager = owner.sessionManager) =>
		manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "host-event");
	const awaitParent = (count: number, manager: SessionManager = owner.sessionManager) =>
		new Promise<void>((resolve) => {
			const check = () => {
				if (entries(manager).length !== count || manager.getPendingParentInputs().length !== 0) return;
				off();
				resolve();
			};
			const off = manager.onEntriesPersisted(check);
			check();
		});
	const initialRequests = rootRequests();
	try {
		await runJourney1CiCommandPhase(world, subject);
		// Replay is held until a complete current observation proves whether an old failure still applies.
		const initial = expectSeal();
		await runtime.source.start(observeSink());
		await withDeadline(
			world.trace,
			"source begin is interrupted after local persistence",
			interruptedHandoff.promise,
		);
		expect(entries()).toEqual([]);
		world.io.writeFileSync(headPath, `${sha}\n`);
		await withDeadline(world.trace, "CI initial catch-up reaches the seal", initial.reached.promise);
		expect(entries()).toEqual([]);
		expect(rootRequests()).toBe(initialRequests);
		initial.release.release();
		await withDeadline(world.trace, "CI initial catch-up commits", initial.done.promise);
		await withDeadline(world.trace, "host watches the upstream pending run", watcherStarted.promise);
		expect(entries(), "a failure superseded by an in-progress rerun cannot wake the owner").toEqual([]);
		const historical = readHostEventPage(owner.session.backgroundLanes.getTaskRuntimeSnapshot()!, {
			eventId: oldFailure.eventId,
		});
		expect(historical.items).toEqual([expect.objectContaining({ current: false, event: oldFailure })]);

		// The upstream run ends without a local push/file notification and requests a fresh exact observation.
		collection = { subject, events: [oldFailure, currentFailure], current: observation(currentFailure) };
		const failed = expectSeal();
		runTerminal.release();
		await withDeadline(world.trace, "CI current failure reaches seal boundary", failed.reached.promise);
		expect(rootRequests(), "accepted but unreconciled evidence cannot start inference").toBe(initialRequests);
		owner.settingsManager.setProactivitySettings({
			...owner.settingsManager.getProactivitySettings(),
			enabled: false,
		});
		failed.release.release();
		await withDeadline(world.trace, "CI failure retained while delivery disabled", failed.done.promise);
		await runtime.source.stop();
		await binding.close();
		owner.settingsManager.setProactivitySettings({
			...owner.settingsManager.getProactivitySettings(),
			enabled: true,
		});
		binding = owner.session.backgroundLanes.openHostEventSession(abort.signal);
		world.provider.enqueue("root", {
			...text("host-event-before-source-recovery", "Independent work can continue while the CI source reconnects."),
			check: (request) => expect(JSON.stringify(request.context.messages)).not.toContain(currentFailure.eventId),
		});
		await withDeadline(
			world.trace,
			"owner turn before source recovery",
			owner.session.prompt("Continue independent work while CI reconnects."),
		);
		expect(entries(), "a new source lifetime cannot use the previous lifetime's persisted seal").toEqual([]);
		const revalidated = expectSeal();
		revalidated.release.release();
		world.provider.enqueue(
			"root",
			{
				...calls("host-event-current-failure", [
					{
						id: "host-event-recall",
						name: "delegate",
						arguments: { action: "events", eventId: currentFailure.eventId },
					},
				]),
				check: (request) => {
					const messages = JSON.stringify(request.context.messages);
					expect(messages).toContain(currentFailure.eventId);
					expect(messages).not.toContain(oldFailure.eventId);
					expect(messages).toContain("no new owner instruction");
				},
			},
			{
				...text("host-event-current-failure-recalled", "The current CI failure is recorded for the existing work."),
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					expect(result?.isError, result?.text).toBe(false);
					expect(result?.text).toContain(currentFailure.eventId);
					expect(result?.text).toContain('"current":true');
				},
			},
		);
		const failedParent = awaitParent(1);
		await runtime.source.start(observeSink());
		await withDeadline(world.trace, "CI current failure revalidated", revalidated.done.promise);
		await withDeadline(world.trace, "CI failure parent turn settles", failedParent);
		expect(parentInputOf(entries()[0]!)).toBeDefined();
		expect(rootRequests() - initialRequests).toBe(3);
		await icmWaitForChatIdle(world, agentDir, 6);
		const rememberedFailure = icmReadContinuousRecords(world, icmContinuousStore(agentDir)).filter((record) =>
			record.text.includes(currentFailure.eventId),
		);
		expect(
			rememberedFailure.filter((record) => record.kind === "work"),
			"one consumed event enters continuous chat once",
		).toHaveLength(1);
		expect(
			rememberedFailure.some((record) => record.kind === "user"),
			"external CI evidence is never owner-authored memory",
		).toBe(false);
		await runtime.source.stop();
		const accepted = owner.session.backgroundLanes.getTaskRuntimeSnapshot()!.hostEvents[currentFailure.eventId];
		expect(accepted.receipt.eventId).toBe(currentFailure.eventId);
		expect(sourceStore.snapshot().retiredThrough).toBeGreaterThanOrEqual(accepted.envelope.sourceSequence);

		// Restart the actual source and its session binding: canonical receipts prevent another parent turn.
		await binding.close();
		binding = owner.session.backgroundLanes.openHostEventSession(abort.signal);
		const replay = expectSeal();
		replay.release.release();
		await runtime.source.start(observeSink());
		await withDeadline(world.trace, "CI replay after source restart", replay.done.promise);
		await runtime.source.stop();
		expect(entries()).toHaveLength(1);
		expect(rootRequests() - initialRequests).toBe(3);
		expect(
			owner.session.backgroundLanes.getTaskRuntimeSnapshot()!.hostEvents[currentFailure.eventId].receipt,
		).toEqual(accepted.receipt);

		// A new session joins after stream retirement and still receives the currently red HEAD's snapshot.
		const freshDir = `${agentDir}-new-consumer`;
		const fresh = await world.createRootSession("root", {
			agentDir: freshDir,
			sessionManager: world.createSessionManager(freshDir),
			systemOneEnabled: false,
			settings: { memorySystem: "okf", autoLearn: { enabled: false }, proactivity: { enabled: true } },
		});
		const freshBinding = fresh.session.backgroundLanes.openHostEventSession(abort.signal);
		const freshSource = await createCiHostRuntime({
			cwd: HARNESS_PROJECT_CWD,
			paths,
			provider,
			store: sourceStore,
			onDiagnostic: (message) => diagnostics.push(message),
		});
		if (!freshSource) throw new Error("The fresh CI consumer did not open.");
		try {
			world.provider.enqueue("root", {
				...text("host-event-new-session", "The currently red revision is visible in this session too."),
				check: (request) => expect(JSON.stringify(request.context.messages)).toContain(currentFailure.eventId),
			});
			const freshParent = awaitParent(1, fresh.sessionManager);
			await freshSource.source.start(freshBinding.sink);
			await withDeadline(world.trace, "new CI consumer receives retained current snapshot", freshParent);
			const freshAccepted =
				fresh.session.backgroundLanes.getTaskRuntimeSnapshot()!.hostEvents[currentFailure.eventId];
			expect(freshAccepted.envelope).toEqual(accepted.envelope);
			expect(freshAccepted.receipt.consumerId).not.toBe(accepted.receipt.consumerId);
			expect(rootRequests() - initialRequests).toBe(4);
			collection = { subject, events: [oldFailure, currentFailure, success], current: observation(success) };
			world.provider.enqueue("root", {
				...text("host-event-new-session-success", "The new session observed the successful rerun."),
				check: (request) => expect(JSON.stringify(request.context.messages)).toContain(success.eventId),
			});
			const freshCorrection = awaitParent(2, fresh.sessionManager);
			world.io.writeFileSync(headPath, `${sha}\n`);
			await withDeadline(
				world.trace,
				"new session retires a result while the original consumer is offline",
				freshCorrection,
			);
			await freshSource.source.stop();
			expect(sourceStore.snapshot().retiredThrough).toBeGreaterThan(accepted.envelope.sourceSequence);
		} finally {
			await freshSource.source.stop();
			await freshBinding.close();
			expect(await world.disposeSessionInBody(fresh.session)).toBeUndefined();
		}

		// A later successful attempt corrects previously consumed red evidence, without inventing another task.
		collection = { subject, events: [oldFailure, currentFailure, success], current: observation(success) };
		const corrected = expectSeal();
		corrected.release.release();
		world.provider.enqueue("root", {
			...text("host-event-now-success", "The later CI attempt passed; the earlier red result is superseded."),
			check: (request) => expect(JSON.stringify(request.context.messages)).toContain(success.eventId),
		});
		const correctedParent = awaitParent(2);
		await runtime.source.start(observeSink());
		await withDeadline(world.trace, "CI correction sealed", corrected.done.promise);
		await withDeadline(world.trace, "CI correction parent turn settles", correctedParent);
		await runtime.source.stop();
		expect(entries()).toHaveLength(2);
		expect(rootRequests() - initialRequests).toBe(6);
		await icmWaitForChatIdle(world, agentDir, 8);
		const rememberedEvents = icmReadContinuousRecords(world, icmContinuousStore(agentDir)).filter(
			(record) => record.text.includes(currentFailure.eventId) || record.text.includes(success.eventId),
		);
		expect(rememberedEvents.filter((record) => record.kind === "work")).toHaveLength(2);
		expect(rememberedEvents.some((record) => record.kind === "user")).toBe(false);
		expect(collections, "source writes and unrelated runtime commits cannot drive a discovery loop").toBe(7);
		expect(watchedRuns, "one pending run starts one physical monitor despite repeated source reconciliation").toBe(1);
		expect(diagnostics).toEqual([handoffFailure]);
		const recoveredSource =
			owner.session.backgroundLanes.getTaskRuntimeSnapshot()!.eventSources[accepted.envelope.sourceId];
		expect(recoveredSource.lastReplayGap, "unavailable offline history is recorded explicitly").toMatchObject({
			afterSequence: accepted.envelope.sourceSequence,
			throughSequence: accepted.envelope.sourceSequence + 1,
			reason: "consumer_inactive",
		});
		expect(recoveredSource.replayFloor).toBe(accepted.envelope.sourceSequence + 2);
		expect(Object.values(owner.session.backgroundLanes.getTaskRuntimeSnapshot()!.tasks)).toEqual([]);
		const workerFailure = terminal(4, "failure");
		collection = {
			subject,
			events: [oldFailure, currentFailure, success, workerFailure],
			current: observation(workerFailure),
		};
		await runJourney1HostEventWorkersPhase(world, {
			subject,
			event: workerFailure,
			paths,
			provider,
			store: sourceStore,
		});
	} finally {
		expectedSeal?.release.release();
		abort.abort();
		await runtime.source.stop();
		await binding.close();
		expect(await world.disposeSessionInBody(owner.session)).toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of summaryTracks) world.provider.retireOptional(track);
	}
	world.trace.mark("root", "host-events.done");
}
