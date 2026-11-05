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
import { HARNESS_NOTICE_CUSTOM_TYPE } from "../../../../src/core/harness-notice.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { createCiHostRuntime } from "../../../../src/host/ci/ci-host-event-source.ts";
import type { CiProvider, CiProviderCollection, CiRepository } from "../../../../src/host/ci/ci-provider.ts";
import { CI_PARKED_CONSUMER_TTL_MS, CiSourceStore } from "../../../../src/host/ci/ci-source-store.ts";
import {
	type CiGitPaths,
	ciStatusPath,
	readCiStatusFile,
	writeCiStatus,
} from "../../../../src/host/ci/ci-status-record.ts";
import {
	PARENT_INPUT_SKIPPED_CUSTOM_TYPE,
	parentInputOf,
	parentInputOriginalDetails,
} from "../../../../src/kernel/session/parent-input-ledger.ts";
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
	// The worker an event routine runs; its saved authority is captured when the routine is saved.
	const routineProfile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "ci-routine-reader",
		description: "Read-only CI event routine worker.",
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
		requireIndependentVerification: false,
		createdAt: "2026-11-05T00:00:00.000Z",
		updatedAt: "2026-11-05T00:00:00.000Z",
	};
	new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(
		routineProfile,
		"global",
	);
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
	let jobDetailReads = 0;
	const provider: CiProvider = {
		repository: async () => repository,
		collect: async (requestedSha, signal) => {
			signal.throwIfAborted();
			expect(requestedSha).toBe(sha);
			collections++;
			return collection;
		},
		// Event collection never reads job details; only the display record of a red attempt does.
		failedJobs: async (identity) => {
			expect(identity).toMatchObject({ runId: 701, runAttempt: 4 });
			jobDetailReads++;
			return ["harness job"];
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
	// Event routines are saved through the host entry point: the routine tool answers only a turn the owner spoke in, and
	// no parent turn is spent on authoring here.
	const routineStore = () => owner.session.backgroundLanes.getBotTeamStore();
	const routineRuns = (routineId: string) => routineStore().listRoutineOccurrences({ routineId });
	const routinePrompt = "Check the failing CI attempt and report whether the owner needs to act.";
	const routineSummary = "ci-event-routine completed.";
	const routineDelivered = "It ran for a CI failure result.";
	const saveEventRoutine = async (routineId: string, schedule: Record<string, unknown>) => {
		const saved = await owner.session.backgroundLanes.createRoutine({
			routineId,
			prompt: routinePrompt,
			schedule,
			profileId: routineProfile.profileId,
		});
		expect(saved.routineId).toBe(routineId);
	};
	const routineSettled = (routineId: string) =>
		new Promise<void>((resolve) => {
			const check = () => {
				const runs = routineRuns(routineId);
				if (runs.length !== 1 || runs[0]!.result?.delivery !== "acknowledged") return;
				off();
				resolve();
			};
			const off = routineStore().subscribe(check);
			check();
		});
	const initialRequests = rootRequests();
	try {
		await runJourney1CiCommandPhase(world, subject);
		// Saved before any CI evidence: the attempt a rerun supersedes is counted, never run on its own.
		await saveEventRoutine("ci-failure-watch", {
			kind: "event",
			source: "ci",
			workflowPath: repository.workflowPath,
		});
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
		// The routine is the owner's standing request, independent of the proactivity switch and of the root note.
		world.provider.enqueue("worker-a", {
			...calls("ci-event-routine-report", [
				{
					id: "ci-event-routine-report",
					name: "submit_report",
					arguments: { status: "completed", summary: routineSummary, ownerUpdate: "none" },
				},
			]),
			check: (request) => {
				const messages = JSON.stringify(request.context.messages);
				expect(messages).toContain(routinePrompt);
				expect(messages, "the run carries the sealed attempt as data").toContain(currentFailure.eventId);
				expect(messages).not.toContain(oldFailure.eventId);
				expect(messages).toContain("1 earlier matching attempt was superseded or coalesced into this run.");
			},
		});
		const routineRan = routineSettled("ci-failure-watch");
		failed.release.release();
		await withDeadline(world.trace, "CI failure retained while delivery disabled", failed.done.promise);
		await withDeadline(world.trace, "CI event routine runs once for the sealed failure", routineRan);
		const [eventRun] = routineRuns("ci-failure-watch");
		if (!eventRun) throw new Error("The CI event routine has no occurrence.");
		expect(eventRun.trigger).toMatchObject({ kind: "event", missedCount: 1, event: currentFailure });
		expect(eventRun.trigger, "no source replay gap was observed").not.toHaveProperty("historyGap");
		expect(eventRun.result).toMatchObject({ outcome: "succeeded", ownerUpdate: "none", delivery: "acknowledged" });
		expect(rootRequests(), "a quiet routine result starts no parent turn").toBe(initialRequests);
		expect(owner.sessionManager.getPendingParentInputs("next-owner-turn")).toHaveLength(1);
		expect(entries(), "the routine leaves the retained root note undelivered").toEqual([]);
		// Saved through the host entry point after the current failure was accepted: that failure can never start it.
		await owner.session.backgroundLanes.createRoutine({
			routineId: "ci-failure-anchor",
			prompt: routinePrompt,
			schedule: { kind: "event", source: "ci" },
			profileId: routineProfile.profileId,
		});
		await runtime.source.stop();
		await binding.close();
		owner.settingsManager.setProactivitySettings({
			...owner.settingsManager.getProactivitySettings(),
			enabled: true,
		});
		binding = owner.session.backgroundLanes.openHostEventSession(abort.signal);
		world.provider.enqueue("root", {
			...text("host-event-before-source-recovery", "Independent work can continue while the CI source reconnects."),
			check: (request) => {
				const messages = JSON.stringify(request.context.messages);
				expect(messages).not.toContain(currentFailure.eventId);
				expect(messages, "the quiet routine result rides with the owner's next turn").toContain(routineSummary);
			},
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
		// One complete scheduler pass over the re-sealed, ready and current failure.
		await owner.session.backgroundLanes.tickPersistentRoutines();
		expect(
			routineRuns("ci-failure-watch").map((run) => run.occurrenceId),
			"a re-sealed attempt never runs twice",
		).toEqual([eventRun.occurrenceId]);
		expect(routineRuns("ci-failure-anchor"), "an attempt accepted before the routine was saved").toEqual([]);
		await icmWaitForChatIdle(world, agentDir, 6, (records) =>
			[currentFailure.eventId, routineDelivered].every((needle) =>
				records.some((record) => record.kind === "work" && record.text.includes(needle)),
			),
		);
		const remembered = icmReadContinuousRecords(world, icmContinuousStore(agentDir));
		expect(
			remembered.filter((record) => record.text.includes(routineDelivered)).map((record) => record.kind),
			"the consumed routine result enters continuous chat once, as work",
		).toEqual(["work"]);
		const rememberedFailure = remembered.filter((record) => record.text.includes(currentFailure.eventId));
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
			// The pre-push watcher records the finished run; that local write, not an unchanged HEAD, triggers discovery.
			writeCiStatus(paths, "main", {
				sha,
				branch: "main",
				workflow: "ci.yml",
				state: "completed",
				conclusion: "success",
				runId: 701,
				runAttempt: 3,
				runNumber: 1,
			});
			await withDeadline(
				world.trace,
				"new session retires a result while the original consumer is offline",
				freshCorrection,
			);
			await freshSource.source.stop();
			expect(sourceStore.snapshot().retiredThrough, "the offline consumer's unconsumed custody stays retained").toBe(
				accepted.envelope.sourceSequence,
			);

			// A consumer parked past its retention resumes through a replay gap that names its cause; the owner is told once.
			// Its own workflow and run keep this source's subjects and occurrences apart from the main source's.
			let gapClockSkew = 0;
			const gapPaths: CiGitPaths = { ...paths, statusDir: join(gitDir, "pi-ci-gap") };
			const gapStore = new CiSourceStore(gapPaths.statusDir, { now: () => Date.now() + gapClockSkew });
			const gapSubject: CiSubject = { ...subject, workflowId: 602 };
			const gapAttempt = (runAttempt: number, conclusion: "failure" | "success" = "success") =>
				createCiAttemptTerminalEvent({
					identity: { ...currentFailure.identity, workflowId: 602, runId: 702, runAttempt },
					headSha: sha,
					conclusion,
					workflowPath: repository.workflowPath,
					observedAt: `2026-11-05T01:0${runAttempt}:00.000Z`,
					runUrl: "https://github.com/harness/repository/actions/runs/702",
				});
			let gapEvents = [gapAttempt(1)];
			const gapDiagnostics: string[] = [];
			const gapSource = await createCiHostRuntime({
				cwd: HARNESS_PROJECT_CWD,
				paths: gapPaths,
				provider: {
					...provider,
					repository: async () => ({ ...repository, workflowId: 602 }),
					collect: async (_sha, signal) => {
						signal.throwIfAborted();
						const latest = gapEvents.at(-1)!;
						return {
							subject: gapSubject,
							events: gapEvents,
							current: { ...observation(latest), subject: gapSubject },
						};
					},
					// The red attempt's display record lives in this source's own status directory.
					failedJobs: async () => ["gap job"],
				},
				store: gapStore,
				onDiagnostic: (message) => gapDiagnostics.push(message),
			});
			if (!gapSource) throw new Error("The second CI source did not open.");
			const gapSealed = () => {
				const sealed = createBarrier();
				const sink: HostEventSink = {
					...freshBinding.sink,
					seal: async (seal, signal) => {
						await freshBinding.sink.seal(seal, signal);
						sealed.release();
					},
				};
				return { sealed, sink };
			};
			const gapNotices = () =>
				fresh.sessionManager.getEntries().filter((entry) => {
					const details = parentInputOriginalDetails(entry);
					return (
						entry.type === "custom_message" &&
						entry.customType === HARNESS_NOTICE_CUSTOM_TYPE &&
						typeof details === "object" &&
						details !== null &&
						"kind" in details &&
						details.kind === "host-event-gap"
					);
				});
			// A root host-event append persists inside its task-runtime transaction, where the runtime refuses a re-entrant
			// read and the persistence observer swallows the throw: the condition is read once that synchronous write returned.
			const persisted = (done: () => boolean) =>
				new Promise<void>((resolve, reject) => {
					const check = () => {
						try {
							if (!done()) return;
						} catch (error) {
							off();
							reject(error);
							return;
						}
						off();
						resolve();
					};
					const off = fresh.sessionManager.onEntriesPersisted(() => queueMicrotask(check));
					check();
				});
			const heldEvents = () => {
				const deliveries = fresh.session.backgroundLanes.getTaskRuntimeSnapshot()!.eventDeliveries;
				return fresh.sessionManager.getPendingParentInputs("next-owner-turn").flatMap((input) => {
					const delivery = deliveries[input.metadata.deliveryId];
					return delivery ? [delivery.eventId] : [];
				});
			};
			const skipRecords = () =>
				fresh.sessionManager
					.getEntries()
					.flatMap((entry) =>
						entry.type === "custom" && entry.customType === PARENT_INPUT_SKIPPED_CUSTOM_TYPE ? [entry.data] : [],
					);
			try {
				const registered = gapSealed();
				await gapSource.source.start(registered.sink);
				await withDeadline(
					world.trace,
					"a second CI source registers the fresh consumer",
					registered.sealed.promise,
				);
				await gapSource.source.stop();
				// Parked past its retention while the source retained a later attempt no other consumer pins.
				gapClockSkew = CI_PARKED_CONSUMER_TTL_MS + 60_000;
				gapEvents = [gapAttempt(1), gapAttempt(2)];
				gapStore.retain(gapEvents);
				const noticed = persisted(() => gapNotices().length > 0);
				const resumed = gapSealed();
				await gapSource.source.start(resumed.sink);
				await withDeadline(
					world.trace,
					"an expired consumer resumes through a replay gap and one owner notice",
					Promise.all([resumed.sealed.promise, noticed]),
				);
				await gapSource.source.stop();
				const gapState =
					fresh.session.backgroundLanes.getTaskRuntimeSnapshot()!.eventSources[gapStore.snapshot().sourceId];
				expect(gapState?.lastReplayGap, "the gap names its range and cause").toMatchObject({
					reason: "consumer_expired",
					afterSequence: 1,
					throughSequence: 2,
				});
				expect(gapNotices(), "one owner notice per gap").toHaveLength(1);
				expect(fresh.sessionManager.getPendingParentInputs("turn"), "a gap notice never wakes a turn").toEqual([]);
				expect(gapDiagnostics).toEqual([]);

				// Past the wake bound a red attempt waits for the owner; a later attempt of the same run replaces it, so the
				// held result is skipped with a record instead of reaching the owner stale.
				fresh.settingsManager.setProactivitySettings({
					...fresh.settingsManager.getProactivitySettings(),
					maxTurnWakesPerDay: 0,
				});
				const red = gapAttempt(3, "failure");
				gapEvents = [...gapEvents, red];
				const redSealed = gapSealed();
				const redHeld = persisted(() => heldEvents().includes(red.eventId));
				await gapSource.source.start(redSealed.sink);
				await withDeadline(
					world.trace,
					"a red attempt past the wake bound is held for the owner's next turn",
					Promise.all([redSealed.sealed.promise, redHeld]),
				);
				await gapSource.source.stop();
				const rerun = gapAttempt(4);
				gapEvents = [...gapEvents, rerun];
				const rerunSealed = gapSealed();
				const replaced = persisted(() => skipRecords().length > 0 && heldEvents().includes(rerun.eventId));
				await gapSource.source.start(rerunSealed.sink);
				await withDeadline(
					world.trace,
					"a held red result a later attempt replaced is skipped with a record",
					Promise.all([rerunSealed.sealed.promise, replaced]),
				);
				await gapSource.source.stop();
				const redDelivery = Object.values(
					fresh.session.backgroundLanes.getTaskRuntimeSnapshot()!.eventDeliveries,
				).find((delivery) => delivery.eventId === red.eventId && delivery.target.kind === "root");
				expect(skipRecords(), "one record names the skipped result and its cause").toEqual([
					expect.objectContaining({ deliveryId: redDelivery?.deliveryId, reason: "source_superseded" }),
				]);
				expect(heldEvents(), "only the passing rerun waits for the owner").toEqual([rerun.eventId]);
				expect(fresh.sessionManager.getPendingParentInputs("turn"), "held results never wake a turn").toEqual([]);
				expect(gapDiagnostics).toEqual([]);
			} finally {
				await gapSource.source.stop();
			}
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
		await owner.session.backgroundLanes.tickPersistentRoutines();
		expect(
			routineRuns("ci-failure-watch").map((run) => run.occurrenceId),
			"a successful attempt never starts a failure routine",
		).toEqual([eventRun.occurrenceId]);
		expect(routineRuns("ci-failure-anchor")).toEqual([]);
		await runtime.source.stop();
		expect(entries()).toHaveLength(2);
		expect(rootRequests() - initialRequests).toBe(6);
		await icmWaitForChatIdle(world, agentDir, 8, (records) =>
			records.some((record) => record.kind === "work" && record.text.includes(success.eventId)),
		);
		const rememberedEvents = icmReadContinuousRecords(world, icmContinuousStore(agentDir)).filter(
			(record) => record.text.includes(currentFailure.eventId) || record.text.includes(success.eventId),
		);
		expect(rememberedEvents.filter((record) => record.kind === "work")).toHaveLength(2);
		expect(rememberedEvents.some((record) => record.kind === "user")).toBe(false);
		expect(collections, "source writes and unrelated runtime commits cannot drive a discovery loop").toBe(7);
		expect(watchedRuns, "one pending run starts one physical monitor despite repeated source reconciliation").toBe(1);
		expect(diagnostics).toEqual([handoffFailure]);
		const recovered = owner.session.backgroundLanes.getTaskRuntimeSnapshot()!;
		const recoveredSource = recovered.eventSources[accepted.envelope.sourceId];
		expect(
			recovered.hostEvents[success.eventId].receipt.consumerId,
			"the parked consumer receives the offline result from its own retained custody",
		).toBe(accepted.receipt.consumerId);
		expect(recovered.hostEvents[success.eventId].envelope.sourceSequence).toBe(accepted.envelope.sourceSequence + 1);
		expect(recoveredSource.lastReplayGap, "nothing was retired while the consumer was offline").toBeUndefined();
		expect(recoveredSource.replayFloor).toBe(1);
		expect(
			Object.keys(owner.session.backgroundLanes.getTaskRuntimeSnapshot()!.tasks).filter(
				(taskId) => taskId !== eventRun.executionRef?.taskId,
			),
			"host events start no task; only the event routine's own run has one",
		).toEqual([]);
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
		expect(
			readCiStatusFile(ciStatusPath(paths.statusDir, "main")),
			"the display record is rebuilt from the red attempt alone",
		).toMatchObject({
			sha,
			state: "completed",
			conclusion: "failure",
			runAttempt: 4,
			failedJobs: ["harness job"],
			reconciledBy: "pi",
		});
		expect(readCiStatusFile(ciStatusPath(paths.statusDir, "main"))).not.toHaveProperty("error");
		expect(jobDetailReads, "only the red display record reads job details, once; event collection never does").toBe(
			1,
		);
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
