import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect } from "vitest";
import { configFile, ownerOrchestrationHome } from "../../../../src/core/agent-paths.ts";
import { resolveSemanticUsageEntry } from "../../../../src/core/cost/usage-records.ts";
import { GH_CREDENTIAL_NAMES, parseDaemonGhCredentials } from "../../../../src/core/daemon-environment.ts";
import { BOT_DAEMON_COMMAND } from "../../../../src/core/delegation/bot-daemon-command.ts";
import { PersistentBotTeamStore } from "../../../../src/core/delegation/persistent-bot-team-store.ts";
import {
	appendWorkerClaimSnapshot,
	getWorkerClaimSnapshotForAttempt,
	getWorkerClaimSnapshots,
	WORKER_CLAIM_CUSTOM_TYPE,
	type WorkerClaimSnapshotPayload,
} from "../../../../src/core/delegation/session-worker-claim.ts";
import { WorkerLifecycle } from "../../../../src/core/delegation/worker-lifecycle.ts";
import { captureWorkerReceiptOrigin } from "../../../../src/core/delegation/worker-receipt-origin.ts";
import { type CiSubject, createCiAttemptTerminalEvent } from "../../../../src/core/events/host-event-contract.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE, type HarnessNoticeKind } from "../../../../src/core/harness-notice.ts";
import {
	getOwnerEvidenceSnapshots,
	OWNER_EVIDENCE_CUSTOM_TYPE,
} from "../../../../src/core/learning/owner-evidence-ledger.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
	toJsonObject,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../../../../src/core/orchestration/event-store.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import type { AwayEventSourceFactory } from "../../../../src/core/routines/away-event-feed.ts";
import {
	MAX_ROUTINE_INSTANT_MS,
	ROUTINE_AWAY_SPEND_REFUSAL,
	type RoutineIntakeBatch,
	type RoutineOccurrence,
	routineAwaySpendRoom,
	routineScheduleInputOf,
} from "../../../../src/core/routines/routine-contract.ts";
import { ROUTINE_INTAKE_SUBMISSION_TOOL_NAME } from "../../../../src/core/routines/routine-intake-extractor.ts";
import { ROUTINE_RESULT_WAKES_HOLD } from "../../../../src/core/routines/routine-parent-input.ts";
import type { RoutineToolSummary } from "../../../../src/core/routines/routine-tool.ts";
import { type AwayCiCredentials, createCiAwayEventSources } from "../../../../src/host/ci/ci-away-event-sources.ts";
import { createCiHostRuntime } from "../../../../src/host/ci/ci-host-event-source.ts";
import type { CiProvider, CiRepository } from "../../../../src/host/ci/ci-provider.ts";
import type { CiGitPaths } from "../../../../src/host/ci/ci-status-record.ts";
import type { SessionManager } from "../../../../src/kernel/node.ts";
import {
	parentInputMessage,
	parentInputOf,
	parentInputOriginalDetails,
} from "../../../../src/kernel/session/parent-input-ledger.ts";
import { calls, createBarrier, HARNESS_PROVIDER, type ScriptedRequest, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, SCRIPTED_TRACKS, withDeadline } from "../session-fixture.ts";
import { runJourney1AwayService } from "./journey-1-away-service.ts";
import { verifyParentInputOverlap } from "./journey-1-parent-input-overlap.ts";
import {
	ICM_INTAKE_JUDGMENTS,
	icmContinuousSettings,
	knowledgeJudgment,
	LIMITS_PATH,
	latestBatchResults,
} from "./shared.ts";

/** Saved intent, native execution, daemon due-time ownership and one durable parent delivery. */
export async function runJourney1RoutinesPhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-routines`;
	const profile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "routine-reader",
		description: "Read-only scheduled task worker.",
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
	new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(profile, "global");
	// The leg starts more routine-result turns in a day than the default wake bound; its own witness sets a tight one.
	const settings = icmContinuousSettings("worker-c", {
		autoLearn: { enabled: false },
		proactivity: { enabled: false },
		routines: { maxResultWakesPerDay: 1_000 },
	});
	let root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings,
	});
	// Whether `root` is still owned by the world: a disposal in the body ends that ownership before it is awaited, so the
	// cleanup below never disposes a closed parent again and a failure while it is closed surfaces as itself.
	let open = true;
	const tracks: string[] = [];
	for (let size = 1; size <= 256; size *= 2)
		for (let first = 0; first + size <= 256; first += size) {
			const task =
				size === 1
					? `Compaction: compress message ${first} into`
					: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
			const name = `routine-compaction-${first}+${size}`;
			tracks.push(name);
			world.provider.enqueueTrack(
				name,
				"worker-c",
				(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
				{
					name,
					optional: true,
					reply: {
						content: [
							{
								type: "text",
								text: "Saved routine commands and their results; consult original turns for details.",
							},
						],
					},
				},
			);
		}
	const routineId = "scheduled-review";
	const original = "Inspect the original scheduled review task and report its status.";
	const replacement = "Inspect the revised scheduled review task and report its status.";
	const at = world.timers.port("routines").now() + 60_000;
	const schedule = { kind: "once", at };
	const store = () => root.session.backgroundLanes.getBotTeamStore();
	const occurrences = () => store().listRoutineOccurrences({ routineId });
	const parentInputs = () =>
		root.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "routine-completion");
	/** One owner turn whose model calls the routine tool once; resolves to that call's result text. */
	const command = async (label: string, input: Record<string, unknown>, error = false, callId = label) => {
		const classified: string[] = [];
		let answer = "";
		world.systemOne.enterPhase(
			label,
			label === "routine-forged-target"
				? {}
				: {
						...ICM_INTAKE_JUDGMENTS,
						...(label === "routine-invalid-interval"
							? { carries_0: { kind: "noul" as const, probability: 0.02 } }
							: {}),
					},
			label === "routine-invalid-interval"
				? {
						expect: (request) => {
							if ("carries_0" in request.questions)
								expect(request.state).toMatchObject({
									owner_messages: ["Apply the routine-forged-target routine command."],
								});
							else if ("changes_model_pools" in request.questions) {
								const state = request.state;
								if (typeof state !== "object" || state === null || !("user_request" in state))
									throw new Error("Routine owner classification has no request text.");
								classified.push(String(state.user_request));
							}
						},
					}
				: {},
		);
		world.provider.enqueue("root", calls(`${label}-call`, [{ id: callId, name: "routine", arguments: input }]), {
			...text(`${label}-done`, "The routine command is recorded."),
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
				expect(result?.isError, result?.text).toBe(error);
				answer = result?.text ?? "";
			},
		});
		await withDeadline(world.trace, label, root.session.prompt(`Apply the ${label} routine command.`));
		if (label === "routine-invalid-interval" && world.systemOne.enabled)
			expect(classified, "the rejected arguments leave owner words for the next executable command").toEqual([
				"Apply the routine-forged-target routine command.",
				"Apply the routine-invalid-interval routine command.",
			]);
		return answer;
	};
	const parentSettled = (count: number): Promise<void> =>
		new Promise((resolve) => {
			const check = () => {
				if (parentInputs().length === count && root.sessionManager.getPendingParentInputs().length === 0) {
					unsubscribe();
					resolve();
				}
			};
			const unsubscribe = root.sessionManager.onEntriesPersisted(check);
			check();
		});
	const workerReply = (
		label: string,
		expectedPrompt: string,
		gate?: Promise<void>,
		onEntered?: () => void,
		ownerUpdate?: "none",
		blocked = false,
	) => ({
		...calls(`${label}-report`, [
			{
				id: `${label}-report`,
				name: "submit_report",
				arguments: blocked
					? { status: "blocked", summary: `${label} blocked.`, blockers: [`${label} cannot reach its source.`] }
					: { status: "completed", summary: `${label} completed.`, ...(ownerUpdate ? { ownerUpdate } : {}) },
			},
		]),
		check: (request: ScriptedRequest) => {
			expect(JSON.stringify(request.context.messages)).toContain(expectedPrompt);
			expect(
				request.context.tools?.map((tool) => tool.name),
				"workers cannot create recursive routines",
			).not.toContain("routine");
			onEntered?.();
		},
		...(gate ? { gate } : {}),
	});
	const release = createBarrier();
	const entered = createBarrier();
	const scheduledRelease = createBarrier();
	try {
		await command(
			"routine-forged-target",
			{
				action: "create",
				routineId,
				prompt: original,
				schedule,
				profileId: profile.profileId,
				target: { kind: "session", parentSessionId: "another-owner" },
			},
			true,
		);
		expect(store().getRoutine(routineId), "model arguments cannot choose a different parent").toBeUndefined();
		await command(
			"routine-invalid-interval",
			{
				action: "create",
				routineId: "out-of-range-interval",
				prompt: original,
				schedule: { kind: "interval", intervalMs: MAX_ROUTINE_INSTANT_MS },
				profileId: profile.profileId,
			},
			true,
		);
		expect(
			store().getRoutine("out-of-range-interval"),
			"an interval whose first occurrence exceeds the clock range cannot enter durable state",
		).toBeUndefined();
		await command("routine-create", {
			action: "create",
			routineId,
			prompt: original,
			schedule,
			profileId: profile.profileId,
		});
		const first = store().getRoutine(routineId)!;
		expect(
			first.executionSnapshot?.savedIntent.objectiveId,
			"a routine cannot adopt a future unrelated goal",
		).toBeNull();
		expect(first.executionSnapshot?.savedIntent.knowledgeReferences).toEqual([]);
		expect(first.nextRunAt).toBe(at);
		for (const [schedule, refusal] of [
			[{ kind: "calendar", cron: "60 9 * * *", timeZone: "UTC" }, /minute field/],
			[{ kind: "calendar", cron: "0 9 * * *", timeZone: "Mars/Olympus_Mons" }, /not supported/],
			[{ kind: "calendar", cron: "0 0 31 2 *", timeZone: "UTC" }, /never matches/],
		] as const)
			expect(
				() =>
					store().upsertRoutine({
						routineId: "refused-calendar",
						target: first.target,
						prompt: original,
						schedule,
						executionSnapshot: first.executionSnapshot,
						createOnly: true,
					}),
				"an invalid, unsupported or unsatisfiable calendar rule never enters durable state",
			).toThrow(refusal);
		expect(store().getRoutine("refused-calendar")).toBeUndefined();
		world.provider.enqueue("worker-a", workerReply("manual-routine", original, release.promise, entered.release));
		await command("routine-manual", { action: "run", routineId, expectedRevision: first.revision });
		await withDeadline(world.trace, "manual routine entered its saved worker request", entered.promise);
		expect(occurrences(), "manual invocation has one durable occurrence").toHaveLength(1);
		expect(store().getRoutine(routineId)?.nextRunAt, "manual invocation does not consume the scheduled slot").toBe(
			at,
		);
		await command("routine-update", {
			action: "update",
			routineId,
			expectedRevision: first.revision,
			prompt: replacement,
			schedule,
			profileId: profile.profileId,
		});
		expect(occurrences()[0]?.definition.prompt, "a running occurrence retains its admitted definition").toBe(
			original,
		);
		expect(store().getRoutine(routineId)?.prompt).toBe(replacement);
		await root.session.backgroundLanes.tickPersistentRoutines();
		const admitted = occurrences()[0]!;
		expect(admitted.phase).toBe("running");
		const uncertainSettled = parentSettled(1);
		const uncertainty = "The native task was admitted, but its immediate readback was unavailable.";
		world.systemOne.enterPhase("routine-uncertain-parent", {});
		// The turn this result opens cannot extend or re-trigger the automation that woke it: a create and a manual run
		// (with the routine's exact current revision, so only the owner-turn gate can refuse it) are refused before admission.
		world.provider.enqueue(
			"root",
			{
				...calls("routine-wake-create-call", [
					{
						id: "routine-wake-create",
						name: "routine",
						arguments: {
							action: "create",
							routineId: "wake-authored",
							prompt: original,
							schedule: { kind: "interval", intervalMs: 86_400_000 },
							profileId: profile.profileId,
						},
					},
					{
						id: "routine-wake-run",
						name: "routine",
						arguments: { action: "run", routineId, expectedRevision: store().getRoutine(routineId)!.revision },
					},
				]),
				check: (request) => expect(JSON.stringify(request.context.messages)).toContain(uncertainty),
			},
			{
				...text("routine-uncertain-parent", "The scheduled result is currently uncertain."),
				check: (request) => {
					const results = latestBatchResults(request).filter((entry) => entry.toolName === "routine");
					expect(results, "the wake turn's create and run each get an answer").toHaveLength(2);
					for (const result of results) {
						expect(result.isError, result.text).toBe(true);
						expect(result.text).toContain("The owner has not spoken in this turn");
					}
				},
			},
		);
		// Simulate post-admission readback uncertainty at the real store boundary;
		// the admitted native worker remains gated and has not finished.
		store().markRoutineUncertain({
			occurrenceId: admitted.occurrenceId,
			claimToken: admitted.claim!.token,
			reason: uncertainty,
			recipient: root.sessionManager.getSessionId(),
			nowMs: world.timers.port("routines").now(),
		});
		await withDeadline(world.trace, "uncertain routine outcome accepted before native completion", uncertainSettled);
		await withDeadline(world.trace, "the woken parent turn ends", root.session.agent.waitForIdle());
		expect(store().getRoutine("wake-authored"), "a turn a routine result opened saves no routine").toBeUndefined();
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(occurrences()[0]?.phase).toBe("uncertain");
		expect(occurrences()[0]?.result?.delivery).toBe("acknowledged");
		world.provider.enqueue("worker-a", workerReply("scheduled-routine", replacement, scheduledRelease.promise));
		const deferred = createBarrier();
		const stopObservingDeferral = store().subscribe(() => {
			if (occurrences().some((entry) => entry.trigger.kind === "schedule" && entry.phase === "pending"))
				deferred.release();
		});
		const beforeDaemon = store().getRoutine(routineId)!;
		world.timers.advance("routines", 60_000);
		expect(
			store().queueDueRoutinesForDaemon(world.timers.port("routines").now()),
			"the daemon never marks a session routine; its occurrence journal is its only run state",
		).toBe(0);
		const afterDaemon = store().getRoutine(routineId)!;
		expect(afterDaemon.nextRunAt, "the daemon leaves due-time ownership with the scheduler").toBe(at);
		expect(afterDaemon.revision, "a daemon observation does not edit saved intent").toBe(beforeDaemon.revision);
		expect(afterDaemon.updatedAt, "a daemon observation does not rewrite the admitted definition").toBe(
			beforeDaemon.updatedAt,
		);
		expect(afterDaemon.lastStatus, "a daemon observation does not mark session run state").toBe(
			beforeDaemon.lastStatus,
		);
		try {
			await withDeadline(world.trace, "busy specialist leaves the scheduled occurrence pending", deferred.promise);
		} finally {
			stopObservingDeferral();
		}
		store().reload();
		const pending = occurrences().find((entry) => entry.trigger.kind === "schedule")!;
		expect(pending.phase).toBe("pending");
		expect(pending.claim).toBeUndefined();
		expect(pending.dispatchKey).toBeUndefined();
		expect(pending.result, "a busy specialist is not a failed routine").toBeUndefined();
		expect(Object.keys(root.session.backgroundLanes.getTaskRuntimeSnapshot()!.tasks)).toHaveLength(1);
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(occurrences().find((entry) => entry.occurrenceId === pending.occurrenceId)).toEqual(pending);
		expect(parentInputs(), "deferral cannot publish a terminal result").toHaveLength(1);
		const manualSettled = parentSettled(2);
		world.systemOne.enterPhase("routine-manual-parent", {});
		world.provider.enqueue("root", {
			...text("routine-manual-parent", "The original scheduled review completed."),
			check: (request) => expect(JSON.stringify(request.context.messages)).toContain("manual-routine completed."),
		});
		let nativeStatusesAtAcceptance: string[] | undefined;
		const stopObservingAcceptance = root.sessionManager.onEntriesPersisted((event) => {
			if (nativeStatusesAtAcceptance !== undefined) return;
			if (
				!event.entryIds.some((id) => {
					const entry = root.sessionManager.getEntry(id);
					return (
						entry?.type === "custom_message" &&
						entry.customType === "routine-completion" &&
						typeof entry.content === "string" &&
						entry.content.includes("manual-routine completed.")
					);
				})
			)
				return;
			nativeStatusesAtAcceptance = Object.values(
				root.session.backgroundLanes.getTaskRuntimeSnapshot()?.notifications ?? {},
			)
				.filter((notification) => notification.attemptId === admitted.executionRef?.attemptId)
				.map((notification) => notification.status);
		});
		try {
			release.release();
			await withDeadline(world.trace, "manual routine parent wake settled", manualSettled);
		} finally {
			stopObservingAcceptance();
		}
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(occurrences()[0]?.occurrenceId).toBe(admitted.occurrenceId);
		expect(occurrences()[0]?.phase).toBe("terminal");
		expect(occurrences()[0]?.priorUncertaintyResult?.delivery).toBe("acknowledged");
		expect(occurrences()[0]?.result?.delivery).toBe("acknowledged");
		expect(parentInputs()).toHaveLength(2);
		expect(parentInputs().every((entry) => parentInputOf(entry) !== undefined)).toBe(true);
		expect(new Set(parentInputs().map((entry) => parentInputOf(entry)?.metadata.deliveryId)).size).toBe(2);
		expect(
			nativeStatusesAtAcceptance,
			"observe physical result acceptance before native acknowledgment",
		).toBeDefined();
		expect(
			nativeStatusesAtAcceptance,
			"an existing native receipt stays pending until result acceptance",
		).not.toContain("delivered");
		const nativeReceipts = Object.values(
			root.session.backgroundLanes.getTaskRuntimeSnapshot()?.notifications ?? {},
		).filter((notification) => notification.attemptId === admitted.executionRef?.attemptId);
		expect(nativeReceipts).toHaveLength(1);
		expect(nativeReceipts[0]?.status).toBe("delivered");
		world.provider.enqueue("root", {
			...text("routine-scheduled-parent", "The revised scheduled review completed."),
			check: (request) => {
				const wire = JSON.stringify(request.context.messages);
				const snapshot = root.session.backgroundLanes.getTaskRuntimeSnapshot();
				const diagnostic = wire.includes("scheduled-routine completed.")
					? undefined
					: JSON.stringify({
							occurrences: occurrences().map((occurrence) => ({
								occurrenceId: occurrence.occurrenceId,
								phase: occurrence.phase,
								trigger: occurrence.trigger,
								claim: occurrence.claim,
								executionRef: occurrence.executionRef,
								result: occurrence.result,
							})),
							tasks: Object.entries(snapshot?.tasks ?? {}).map(([id, task]) => ({
								id,
								attemptIds: task.attemptIds,
							})),
							attempts: Object.values(snapshot?.attempts ?? {}).map((attempt) => ({
								attemptId: attempt.attemptId,
								taskId: attempt.taskId,
								status: attempt.status,
								reasonCode: attempt.reasonCode,
								reasonDetail: attempt.reasonDetail,
								result: attempt.result,
							})),
							notifications: snapshot?.notifications,
							parentInputs: parentInputs().slice(-4),
							request: wire.slice(-8_000),
						}).slice(0, 24_000);
				expect(wire, diagnostic).toContain("scheduled-routine completed.");
			},
		});
		const scheduledSettled = parentSettled(3);
		scheduledRelease.release();
		await withDeadline(world.trace, "scheduled routine parent wake settled", scheduledSettled);
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(occurrences()).toHaveLength(2);
		expect(occurrences().every((entry) => entry.result?.delivery === "acknowledged")).toBe(true);
		expect(occurrences().filter((entry) => entry.trigger.kind === "schedule")).toHaveLength(1);
		expect(occurrences().find((entry) => entry.trigger.kind === "schedule")?.occurrenceId).toBe(pending.occurrenceId);
		for (let run = 0; run < 2; run++) {
			const label = `routine-repeated-provider-id-${run}`;
			world.provider.enqueue("worker-a", workerReply(label, replacement));
			const settled = parentSettled(4 + run);
			const running = command(
				label,
				{ action: "run", routineId, expectedRevision: store().getRoutine(routineId)!.revision },
				false,
				"call_0",
			);
			world.provider.enqueue("root", text(`${label}-parent`, `Manual run ${run} is complete.`));
			await running;
			await withDeadline(world.trace, label, settled);
		}
		expect(occurrences(), "distinct requests may reuse the same provider tool-call ID").toHaveLength(4);
		// Two runs whose workers report no owner update, with no owner turn between them: the first delivered is kept
		// and carried with the owner's next turn without a parent wake; the other is acknowledged against it.
		const quietRelease = createBarrier();
		const known = new Set(occurrences().map((entry) => entry.occurrenceId));
		const quietRuns = () => occurrences().filter((entry) => !known.has(entry.occurrenceId));
		const quietAcknowledged = createBarrier();
		const stopObservingQuiet = store().subscribe(() => {
			if (quietRuns().length === 2 && quietRuns().every((entry) => entry.result?.delivery === "acknowledged"))
				quietAcknowledged.release();
		});
		world.provider.enqueue(
			"worker-a",
			workerReply("routine-quiet-0", replacement, quietRelease.promise, undefined, "none"),
			workerReply("routine-quiet-1", replacement, undefined, undefined, "none"),
		);
		// The last woken parent turn ends before the owner prompts again.
		await withDeadline(world.trace, "routine wakes end before the quiet runs", root.session.agent.waitForIdle());
		world.systemOne.enterPhase("routine-quiet-runs", ICM_INTAKE_JUDGMENTS);
		const quietRevision = store().getRoutine(routineId)!.revision;
		world.provider.enqueue(
			"root",
			calls("routine-quiet-runs-call", [
				{
					id: "quiet-run-0",
					name: "routine",
					arguments: { action: "run", routineId, expectedRevision: quietRevision },
				},
				{
					id: "quiet-run-1",
					name: "routine",
					arguments: { action: "run", routineId, expectedRevision: quietRevision },
				},
			]),
			text("routine-quiet-runs-done", "Both routine runs are queued."),
		);
		await withDeadline(world.trace, "routine-quiet-runs", root.session.prompt("Run the scheduled review twice."));
		const rootRequestsBeforeQuiet = world.provider.requests.filter((request) => request.model.id === "root").length;
		try {
			quietRelease.release();
			await withDeadline(world.trace, "both quiet routine results acknowledged", quietAcknowledged.promise);
		} finally {
			stopObservingQuiet();
		}
		const carried = parentInputs().filter((entry) => parentInputOf(entry)?.metadata.mode === "next-owner-turn");
		expect(carried, "a later quiet run adds no parent input while an earlier one is carried").toHaveLength(1);
		const carriedSummary = ["routine-quiet-0 completed.", "routine-quiet-1 completed."].find((summary) =>
			JSON.stringify(carried[0]).includes(summary),
		);
		expect(carriedSummary, "the carried input holds one quiet run's result").toBeDefined();
		expect(
			quietRuns().map((entry) => [entry.result?.outcome, entry.result?.ownerUpdate, entry.result?.deliveryMarker]),
			"both quiet results stay in the occurrence history, acknowledged against the one carried input",
		).toEqual([
			["succeeded", "none", carried[0]!.id],
			["succeeded", "none", carried[0]!.id],
		]);
		expect(root.sessionManager.getPendingParentInputs("turn"), "a quiet result never wakes the parent").toHaveLength(
			0,
		);
		expect(
			world.provider.requests.filter((request) => request.model.id === "root"),
			"no parent turn ran for the quiet results",
		).toHaveLength(rootRequestsBeforeQuiet);
		expect(store().getRoutine(routineId)?.lastStatus, "a finished run is not reported as running").toBe("succeeded");
		expect(
			quietRuns().map((entry) => entry.result?.summary),
			"a quiet result stays visible as the routine's last summary",
		).toContain(store().getRoutine(routineId)?.lastSummary);
		const recycledId = "recreated-review";
		const recycledInput = {
			routineId: recycledId,
			prompt: original,
			schedule: { kind: "once", at: world.timers.port("routines").now() + 300_000 },
			profileId: profile.profileId,
		};
		await command("routine-recycle-create", { action: "create", ...recycledInput });
		await withDeadline(world.trace, "the owner's next turn consumes the quiet result", parentSettled(6));
		expect(
			world.provider.requests
				.filter((request) => request.model.id === "root")
				.slice(rootRequestsBeforeQuiet)
				.some((request) => JSON.stringify(request.context.messages).includes(carriedSummary!)),
			"the quiet result reaches the owner's next turn",
		).toBe(true);
		const retired = store().getRoutine(recycledId)!;
		await command("routine-recycle-delete", {
			action: "delete",
			routineId: recycledId,
			expectedRevision: retired.revision,
		});
		await command("routine-recycle-recreate", { action: "create", ...recycledInput });
		const recreated = store().getRoutine(recycledId)!;
		expect(recreated.revision, "recreation cannot reuse a stale command's revision").toBeGreaterThan(
			retired.revision,
		);
		expect(recreated.incarnationId).not.toBe(retired.incarnationId);
		for (const action of ["pause", "run", "delete"] as const)
			await command(
				`routine-recycle-stale-${action}`,
				{ action, routineId: recycledId, expectedRevision: retired.revision },
				true,
			);
		expect(store().getRoutine(recycledId)).toEqual(recreated);
		expect(store().listRoutineOccurrences({ routineId: recycledId })).toHaveLength(0);
		await command("routine-recycle-current-pause", {
			action: "pause",
			routineId: recycledId,
			expectedRevision: recreated.revision,
		});
		expect(store().getRoutine(recycledId)?.enabled, "the current revision still permits an intentional edit").toBe(
			false,
		);
		const paused = store().getRoutine(recycledId)!;
		const offlineStore = store();
		const file = root.sessionManager.getSessionFile()!;
		const requests = world.provider.requests.filter((request) => request.model.id !== "worker-c").length;
		open = false;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		const manualClaim = {
			routineId: recycledId,
			expectedRevision: paused.revision,
			parentSessionId: root.sessionManager.getSessionId(),
			receiptOrigin: paused.executionSnapshot!.savedIntent.receiptOrigin,
			owner: "terminated-routine-owner",
			leaseMs: 120_000,
		};
		expect(
			() =>
				offlineStore.claimManualRoutineOccurrence({
					...manualClaim,
					commandId: "clock-behind-last-edit",
					nowMs: Date.parse(paused.updatedAt) - 1,
				}),
			"a clock set back before the last edit refuses the run instead of writing an occurrence older than its definition",
		).toThrow(/clock reads earlier than the routine's last edit/);
		// Model a process stopping immediately after its durable claim, before dispatch.
		// An explicit manual run remains recoverable even while its schedule is paused.
		const interrupted = offlineStore.claimManualRoutineOccurrence({
			...manualClaim,
			commandId: "paused-manual-recovery",
			nowMs: world.timers.port("routines").now(),
		});
		expect(interrupted.phase).toBe("claimed");
		world.systemOne.enterPhase("routine-paused-recovery", {});
		world.provider.enqueue("worker-a", workerReply("paused-recovered-routine", original));
		world.provider.enqueue("root", {
			...text("routine-paused-recovery-parent", "The requested manual run recovered and completed."),
			check: (request) =>
				expect(JSON.stringify(request.context.messages)).toContain("paused-recovered-routine completed."),
		});
		root = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.openSessionManager(file, agentDir),
			settings,
		});
		open = true;
		const recoveredSettled = parentSettled(7);
		world.timers.advance("routines", 120_000);
		await root.session.backgroundLanes.tickPersistentRoutines();
		await withDeadline(world.trace, "paused manual claim recovered after lease expiry", recoveredSettled);
		await root.session.backgroundLanes.tickPersistentRoutines();
		const recovered = store().listRoutineOccurrences({ routineId: recycledId });
		expect(recovered).toHaveLength(1);
		expect(recovered[0]?.occurrenceId).toBe(interrupted.occurrenceId);
		expect(recovered[0]?.claim?.token).not.toBe(interrupted.claim?.token);
		expect(recovered[0]?.result?.delivery).toBe("acknowledged");
		expect(store().getRoutine(recycledId)?.enabled).toBe(false);
		expect(store().getRoutine(recycledId)?.lastStatus, "the routine reports its last run's outcome").toBe(
			"succeeded",
		);
		expect(store().getRoutine(recycledId)?.lastSummary).toBe(recovered[0]?.result?.summary);
		expect(occurrences(), "reopening cannot repeat a consumed one-off").toHaveLength(6);
		expect(parentInputs(), "only the recovered manual run adds a new parent input").toHaveLength(7);
		expect(world.provider.requests.filter((request) => request.model.id !== "worker-c")).toHaveLength(requests + 2);
		// Stop after canonical acceptance but before a live parent can run: startup must
		// process selected exact inputs without pulling the unselected tail into that request.
		open = false;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		const pendingManager = world.openSessionManager(file, agentDir);
		const origin = captureWorkerReceiptOrigin(pendingManager);
		const pendingTexts = [
			"First recovered routine result: the copper deployment is blocked by its missing manifest.",
			"Second recovered routine result: the violet documentation review is complete.",
			...Array.from({ length: 31 }, (_, index) => `Recovered event ${index}: the inspection result is retained.`),
		];
		for (const [index, content] of pendingTexts.entries()) {
			const message = { customType: "routine-completion", content, display: true };
			pendingManager.appendParentInput(
				parentInputMessage(
					{
						deliveryId: `routine-recovery-${index}`,
						payloadDigest: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
						origin,
					},
					message,
				),
			);
		}
		world.systemOne.enterPhase("routine-parent-recovery", {});
		world.provider.enqueue(
			"root",
			{
				...text("routine-parent-recovery", "Copper is blocked; the violet review is complete."),
				check: (request) => {
					const wire = JSON.stringify(request.context.messages);
					for (const content of pendingTexts.slice(0, 32)) expect(wire).toContain(content);
					expect(wire, "an unselected input cannot enter the first wake request").not.toContain(pendingTexts[32]);
				},
			},
			{
				...text("routine-parent-recovery-tail", "The remaining inspection result is handled."),
				check: (request) => expect(JSON.stringify(request.context.messages)).toContain(pendingTexts[32]),
			},
		);
		root = await world.createRootSession("root", { agentDir, sessionManager: pendingManager, settings });
		open = true;
		await withDeadline(world.trace, "all recovered parent input batches settled", parentSettled(40));
		expect(world.provider.requests.filter((request) => request.model.id !== "worker-c")).toHaveLength(requests + 4);
		open = false;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		// Another host records parent writes in the attempt's outbox while this parent is closed. The first one landed
		// before its acknowledgement was recorded (a stop between import and acknowledgement); the second never landed.
		const awayManager = world.openSessionManager(file, agentDir);
		const awayAttempt = recovered[0]!.executionRef!;
		const parentWriteIds = (manager: SessionManager) =>
			manager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" &&
					entry.customType === WORKER_CLAIM_CUSTOM_TYPE &&
					typeof (entry.data as WorkerClaimSnapshotPayload).parentWriteId === "string"
						? [(entry.data as WorkerClaimSnapshotPayload).parentWriteId]
						: [],
				);
		expect(parentWriteIds(awayManager), "no foreground claim carries a parent-write marker").toEqual([]);
		world.faultMatrix.witness("R51", { control: true });
		// The recovered run recorded no parent write, and its result was delivered and acknowledged above.
		world.faultMatrix.witness("R52", { control: true });
		const awayClaim = getWorkerClaimSnapshotForAttempt(
			awayManager.getEntries(),
			awayAttempt.taskId,
			awayAttempt.attemptId,
		)!;
		expect(awayClaim, "the recovered run saved its claim through the parent write port").toBeDefined();
		const attemptClaims = (manager: SessionManager) =>
			getWorkerClaimSnapshots(manager.getEntries()).filter(
				(claim) => claim.terminalAttemptId === awayAttempt.attemptId,
			).length;
		expect(attemptClaims(awayManager), "the foreground port saved the recovered run's claim exactly once").toBe(1);
		const orchestrationClock = world.timers.port("orchestration");
		const awayRuntime = new WorkerLifecycle({
			orchestrationHome: ownerOrchestrationHome(agentDir),
			sessionId: awayManager.getSessionId(),
			store: new OrchestrationEventStore({
				orchestrationHome: ownerOrchestrationHome(agentDir),
				sessionId: awayManager.getSessionId(),
				now: () => new Date(orchestrationClock.now()).toISOString(),
				sleepSync: (delayMs) => world.timers.sleepSync(delayMs),
			}),
			now: () => orchestrationClock.now(),
		}).ledger.runtime;
		const awayBody = {
			kind: "worker_claim" as const,
			claim: toJsonObject(awayClaim.claim),
			...(awayClaim.request ? { request: toJsonObject(awayClaim.request) } : {}),
		};
		awayRuntime.recordParentWrite(awayAttempt.attemptId, "away-claim-landed", awayBody);
		awayRuntime.recordParentWrite(awayAttempt.attemptId, "away-claim-pending", awayBody);
		appendWorkerClaimSnapshot(awayManager, awayClaim.claim, awayClaim.request, {
			parentWriteId: "away-claim-landed",
		});
		root = await world.createRootSession("root", { agentDir, sessionManager: awayManager, settings });
		open = true;
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(parentInputs(), "recovered inputs retain their original canonical identity").toHaveLength(40);
		expect(root.sessionManager.getPendingParentInputs()).toHaveLength(0);
		expect(world.provider.requests.filter((request) => request.model.id !== "worker-c")).toHaveLength(requests + 4);
		root.session.backgroundLanes.signalWorkerReceiptDelivery();
		expect(
			parentWriteIds(root.sessionManager),
			"each recorded parent write lands exactly once, in record order",
		).toEqual(["away-claim-landed", "away-claim-pending"]);
		expect(
			root.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[awayAttempt.attemptId]?.parentWrites,
			"both recorded writes are acknowledged",
		).toBeUndefined();
		expect(attemptClaims(root.sessionManager), "the pre-landed write was found, not appended again").toBe(3);
		// A second import pass over the acknowledged outbox lands nothing.
		root.session.backgroundLanes.drainQueuedWorkerDelegations();
		expect(parentWriteIds(root.sessionManager)).toEqual(["away-claim-landed", "away-claim-pending"]);
		expect(attemptClaims(root.sessionManager)).toBe(3);
		world.faultMatrix.witness("R51", { control: false });

		// A routine of this parent comes due while the parent is closed, and nothing the owner types runs it: its save
		// brings the detached daemon up by itself (the launched process's production body runs here, on the world's
		// timers), and the daemon runs it on the parent opened away, under the owner's away settings file.
		const awayRoutineId = "away-review";
		const awayPrompt = "Inspect the away review task and report its status.";
		const awayAt = world.timers.port("routines").now() + 60_000;
		const seedAwaySettings = (maxUsdPerDay: number) =>
			world.io.seed(
				configFile(agentDir, "settings.json"),
				JSON.stringify({
					modelFavorites: SCRIPTED_TRACKS.map((modelId) => ({ provider: HARNESS_PROVIDER, modelId })),
					routines: { away: { maxUsdPerDay } },
				}),
			);
		// No room for one run (the default run bound is 0.25): the spend gate refuses before any claim.
		seedAwaySettings(0.1);
		// A daemon an earlier save launched is released first, so this save is the one that brings it up.
		root.session.backgroundLanes.stopPersistentBotDaemon();
		const daemonLaunches = () => world.processes.botDaemonLaunches.length;
		const launchesBeforeSave = daemonLaunches();
		const savedDaemon = world.processes.runNextBotDaemon();
		await command("routine-away-create", {
			action: "create",
			routineId: awayRoutineId,
			prompt: awayPrompt,
			schedule: { kind: "once", at: awayAt },
			profileId: profile.profileId,
		});
		expect(daemonLaunches() - launchesBeforeSave, "the save launched exactly one daemon").toBe(1);
		const firstDaemon = await savedDaemon;
		expect(firstDaemon.launch.args.slice(-3)).toEqual([BOT_DAEMON_COMMAND, agentDir, firstDaemon.launch.token]);
		for (const name of ["PI_SESSION_ROLE", "PI_PARENT_PID", "PI_PARENT_SESSION", "PI_WORKTREE_LANE"])
			expect(firstDaemon.launch.env[name], `the daemon carries no session identity (${name})`).toBeUndefined();
		open = false;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		const fileWhileAway = world.io.peekFile(file);
		const workerRequests = () => world.provider.requests.filter((request) => request.model.id === "worker-a").length;
		const workerRequestsBeforeAway = workerRequests();
		const storeDiagnostics: string[] = [];
		const harnessNotices = (kind: HarnessNoticeKind) =>
			root.sessionManager.getEntries().filter((entry) => {
				const details = parentInputOriginalDetails(entry);
				return (
					entry.type === "custom_message" &&
					entry.customType === HARNESS_NOTICE_CUSTOM_TYPE &&
					typeof details === "object" &&
					details !== null &&
					"kind" in details &&
					details.kind === kind
				);
			});
		const awayStore = new PersistentBotTeamStore(agentDir, (message) => storeDiagnostics.push(message));
		try {
			const daemonStatus = () => {
				awayStore.reload();
				return awayStore.getDaemonStatus(world.timers.port("routines").now());
			};
			const spendReports = (status: ReturnType<typeof daemonStatus>) =>
				status.reports.filter((report) => report.message.includes(ROUTINE_AWAY_SPEND_REFUSAL));
			const refused = createBarrier();
			const stopObservingRefusal = awayStore.subscribe(() => {
				if (awayStore.getRoutine(awayRoutineId)?.awayRefusal?.reason === ROUTINE_AWAY_SPEND_REFUSAL)
					refused.release();
			});
			try {
				// The parent's session is closed; the daemon's next renewal wakes its supervisor on the due slot.
				world.timers.advance("routines", 60_000);
				await withDeadline(world.trace, "the spend gate refuses the due run away", refused.promise);
			} finally {
				stopObservingRefusal();
			}
			expect(workerRequests(), "a refused run makes no worker request").toBe(workerRequestsBeforeAway);
			expect(awayStore.listRoutineOccurrences({ routineId: awayRoutineId }), "a refusal claims nothing").toEqual([]);
			expect(awayStore.getRoutine(awayRoutineId)?.nextRunAt, "the refused slot stays due").toBe(awayAt);
			const refusedStatus = daemonStatus();
			expect(refusedStatus.running, "the daemon runs on with every session closed").toBe(true);
			expect(refusedStatus.awayRefusals, "the daemon status lists the refusal").toContainEqual(
				expect.objectContaining({ routineId: awayRoutineId, reason: ROUTINE_AWAY_SPEND_REFUSAL }),
			);
			expect(spendReports(refusedStatus), "the refusal is reported once").toHaveLength(1);
			expect(await firstDaemon.stop(), "a signalled daemon exits cleanly once its stop is joined").toBe(0);
			const stoppedStatus = daemonStatus();
			expect(stoppedStatus.running).toBe(false);
			expect(stoppedStatus.lastEnd?.reason, "its end is recorded").toBe("signal");
			expect(spendReports(stoppedStatus), "its reports outlive it").toHaveLength(1);

			// Room for one run again, and the daemon comes back by itself: another session's start revives it while a
			// routine is enabled, and it runs this parent's due slot away. That other session saves its own routine and
			// closes; when its slot comes due while this parent's run still holds the day's room, it is refused and claims
			// nothing, and it runs once the first run's settled spend leaves room.
			seedAwaySettings(0.25);
			const firstRunRelease = createBarrier();
			const contenderId = "away-contender";
			const contenderPrompt = "Inspect the contending review task and report its status.";
			world.provider.enqueue(
				"worker-a",
				workerReply("away-routine", awayPrompt, firstRunRelease.promise),
				workerReply("away-contender", contenderPrompt),
			);
			const claimedAway = createBarrier();
			const contenderRefused = createBarrier();
			const ranAway = createBarrier();
			const ran = (routineId: string) =>
				awayStore.listRoutineOccurrences({ routineId }).some((occurrence) => occurrence.phase === "terminal");
			const stopObservingRun = awayStore.subscribe(() => {
				if (awayStore.listRoutineOccurrences({ routineId: awayRoutineId }).length > 0) claimedAway.release();
				if (awayStore.getRoutine(contenderId)?.awayRefusal?.reason === ROUTINE_AWAY_SPEND_REFUSAL)
					contenderRefused.release();
				if (ran(awayRoutineId) && ran(contenderId)) ranAway.release();
			});
			let contenderAt = 0;
			try {
				const launchesBeforeStart = daemonLaunches();
				const startedDaemon = world.processes.runNextBotDaemon();
				const other = await world.createRootSession("root", {
					agentDir,
					sessionManager: world.createSessionManager(agentDir),
					settings,
				});
				expect(daemonLaunches() - launchesBeforeStart, "the session start launched exactly one daemon").toBe(1);
				await withDeadline(world.trace, "the revived daemon claims the due run away", claimedAway.promise);
				expect(
					awayStore.listRoutineOccurrences({ routineId: awayRoutineId }).map((occurrence) => occurrence.executor),
					"a single parent with room runs its due slot away",
				).toEqual(["away"]);
				world.faultMatrix.witness("R56", { control: true });
				// Due before the daemon's next 10 s renewal, which the advance below fires.
				contenderAt = world.timers.port("routines").now() + 5_000;
				world.systemOne.enterPhase("routine-away-contender-create", ICM_INTAKE_JUDGMENTS);
				world.provider.enqueue(
					"root",
					calls("routine-away-contender-create-call", [
						{
							id: "routine-away-contender-create",
							name: "routine",
							arguments: {
								action: "create",
								routineId: contenderId,
								prompt: contenderPrompt,
								schedule: { kind: "once", at: contenderAt },
								profileId: profile.profileId,
							},
						},
					]),
					{
						...text("routine-away-contender-create-done", "The routine command is recorded."),
						check: (request) => {
							const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
							expect(result?.isError, result?.text).toBe(false);
						},
					},
				);
				await withDeadline(
					world.trace,
					"routine-away-contender-create",
					other.session.prompt("Apply the routine-away-contender-create routine command."),
				);
				expect(await world.disposeSessionInBody(other.session)).toBeUndefined();
				const revivedDaemon = await startedDaemon;
				// The other parent's slot comes due on the daemon's next renewal while the first run still holds its room.
				world.timers.advance("routines", 10_000);
				await withDeadline(world.trace, "the spend gate refuses the contending run away", contenderRefused.promise);
				expect(
					awayStore.listRoutineOccurrences({ routineId: contenderId }),
					"the refused parent claims nothing",
				).toEqual([]);
				expect(awayStore.getRoutine(contenderId)?.nextRunAt, "its refused slot stays due").toBe(contenderAt);
				expect(ran(awayRoutineId), "the first run still holds the day's room").toBe(false);
				firstRunRelease.release();
				await withDeadline(world.trace, "the revived daemon runs both due routines away", ranAway.promise);
				expect(await revivedDaemon.stop()).toBe(0);
			} finally {
				firstRunRelease.release();
				stopObservingRun();
			}
			expect(
				spendReports(daemonStatus()),
				"the revived daemon reports the contending run's refusal once and the first run's none",
			).toHaveLength(1);
			expect(storeDiagnostics, "the observing store read every write").toEqual([]);
			const contenderRuns = awayStore.listRoutineOccurrences({ routineId: contenderId });
			expect(
				contenderRuns.map((occurrence) => [
					occurrence.executor,
					occurrence.result?.outcome,
					occurrence.result?.delivery,
				]),
				"the refused run runs away once the first run's settled spend leaves room, its result left for its parent",
			).toEqual([["away", "succeeded", "pending"]]);
			expect(awayStore.getRoutine(contenderId)?.awayRefusal, "its admission cleared the refusal").toBeUndefined();
			world.faultMatrix.witness("R56", { control: false });
			const ranOccurrences = awayStore.listRoutineOccurrences({ routineId: awayRoutineId });
			expect(ranOccurrences).toHaveLength(1);
			expect(ranOccurrences[0]?.executor).toBe("away");
			// The run's settled spend is saved on the run (zero on the scripted zero-price track), so a store read after
			// the daemon stopped, with nothing left in its memory, charges the run what it spent instead of the run bound:
			// four more runs fit a $1 day bound again and a fifth does not.
			expect(ranOccurrences[0]?.awaySettlement?.costUsd, "the run's settled spend is saved on the run").toBe(0);
			const roomAfterStop = routineAwaySpendRoom(
				awayStore.listRoutineOccurrences({ routineId: awayRoutineId }),
				{ maxUsdPerRun: 0.25, maxUsdPerDay: 1 },
				world.timers.port("routines").now(),
			);
			expect(roomAfterStop.chargedMicros, "the stopped daemon's run is charged its settled spend").toBe(0);
			expect(roomAfterStop.fits(3), "four runs fit the day bound after the daemon stopped").toBe(true);
			expect(roomAfterStop.fits(4), "a fifth run does not").toBe(false);
			expect(ranOccurrences[0]?.result?.outcome).toBe("succeeded");
			expect(ranOccurrences[0]?.result?.delivery, "a run away leaves its result for the parent").toBe("pending");
			expect(
				awayStore.getRoutine(awayRoutineId)?.awayRefusal,
				"the admitted run cleared the refusal",
			).toBeUndefined();
			expect(workerRequests(), "each run away made exactly one worker request").toBe(workerRequestsBeforeAway + 2);
			expect(world.io.peekFile(file), "nothing wrote the parent transcript while it was closed").toBe(fileWhileAway);
			const awayRunAttempt = ranOccurrences[0]!.executionRef!;

			// Reopening imports the run's recorded claim first, then delivers its result once.
			world.systemOne.enterPhase("routine-away-parent", {});
			world.provider.enqueue("root", {
				...text("routine-away-parent", "The away review completed."),
				check: (request) => expect(JSON.stringify(request.context.messages)).toContain("away-routine completed."),
			});
			root = await world.createRootSession("root", {
				agentDir,
				sessionManager: world.openSessionManager(file, agentDir),
				settings,
			});
			open = true;
			const awaySettled = parentSettled(41);
			await root.session.backgroundLanes.tickPersistentRoutines();
			await withDeadline(world.trace, "the run away is delivered on reopen", awaySettled);
			const awayClaimIndexes = (manager: SessionManager) =>
				manager
					.getEntries()
					.flatMap((entry, index) =>
						entry.type === "custom" &&
						entry.customType === WORKER_CLAIM_CUSTOM_TYPE &&
						(entry.data as WorkerClaimSnapshotPayload).claim.terminalAttemptId === awayRunAttempt.attemptId
							? [index]
							: [],
					);
			const claimIndexes = awayClaimIndexes(root.sessionManager);
			expect(claimIndexes, "the run's claim lands exactly once").toHaveLength(1);
			const claimEntry = root.sessionManager.getEntries()[claimIndexes[0]!];
			if (claimEntry?.type !== "custom") throw new Error("The away claim index names no custom entry.");
			expect(
				(claimEntry.data as WorkerClaimSnapshotPayload).parentWriteId,
				"the claim came through the parent write outbox",
			).toBeDefined();
			const completionIndex = root.sessionManager
				.getEntries()
				.findIndex(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "routine-completion" &&
						JSON.stringify(entry).includes("away-routine completed."),
				);
			expect(completionIndex, "the run's result is delivered").toBeGreaterThanOrEqual(0);
			expect(claimIndexes[0], "the claim lands before the result it explains").toBeLessThan(completionIndex);
			expect(
				store().listRoutineOccurrences({ routineId: awayRoutineId })[0]?.result?.delivery,
				"the reopened parent acknowledged the result",
			).toBe("acknowledged");
			expect(
				root.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[awayRunAttempt.attemptId]?.parentWrites,
				"every write recorded away is acknowledged",
			).toBeUndefined();
			root.session.backgroundLanes.drainQueuedWorkerDelegations();
			expect(awayClaimIndexes(root.sessionManager), "a second import pass lands nothing").toHaveLength(1);
			expect(parentInputs()).toHaveLength(41);
			world.faultMatrix.witness("R52", { control: false });
			world.faultMatrix.witness("R54", { control: true });

			// Another host records a write while the parent is open: it lands on the next routine store change, without a
			// reopen. The change here is an edit committed through another store instance, as another process commits it.
			const openWriteId = "away-claim-open";
			const openClaim = getWorkerClaimSnapshotForAttempt(
				root.sessionManager.getEntries(),
				awayRunAttempt.taskId,
				awayRunAttempt.attemptId,
			)!;
			const landed = createBarrier();
			const stopObservingLanding = root.sessionManager.onEntriesPersisted(() => {
				if (parentWriteIds(root.sessionManager).includes(openWriteId)) landed.release();
			});
			try {
				awayRuntime.recordParentWrite(awayRunAttempt.attemptId, openWriteId, {
					kind: "worker_claim",
					claim: toJsonObject(openClaim.claim),
					...(openClaim.request ? { request: toJsonObject(openClaim.request) } : {}),
				});
				expect(parentWriteIds(root.sessionManager), "a recorded write alone lands nothing").not.toContain(
					openWriteId,
				);
				awayStore.reload();
				expect(
					awayStore.deleteRoutine(
						recycledId,
						awayStore.getRoutine(recycledId)!.revision,
						world.timers.port("routines").now(),
					),
				).toBe(true);
				await withDeadline(world.trace, "the open parent lands a write recorded away", landed.promise);
			} finally {
				stopObservingLanding();
			}
			root.session.backgroundLanes.drainQueuedWorkerDelegations();
			expect(
				parentWriteIds(root.sessionManager).filter((id) => id === openWriteId),
				"the write recorded while open lands exactly once",
			).toHaveLength(1);
			expect(parentInputs(), "the import delivers no result again").toHaveLength(41);
			world.faultMatrix.witness("R54", { control: false });

			// An event routine of this parent follows its CI while the parent is closed: the daemon builds the production away
			// CI source for the parent's checkout (only the checkout's paths and the provider's upstream answers are scripted).
			// A source it cannot ready is told once, as the routine's away refusal. Once it is followed, the refusal clears
			// before anything is decided, and a sealed failure runs the routine once away. The reopened session's own CI source
			// then takes the consumer back from the running daemon, which stops following and says so; the parent receives
			// one result, and the re-sealed attempt runs nothing again. The accepted failure's root delivery stays pending in
			// the parent's ledger: proactivity is off in this leg's settings, so no lane delivers it, and a later leg that
			// enables proactivity on this parent must settle it first.
			const ciRoutineId = "away-ci-watch";
			const ciParentSessionId = root.sessionManager.getSessionId();
			const ciPrompt = "Check the failing CI attempt of the closed session and report its status.";
			const ciRepository: CiRepository = {
				host: "github.com",
				repositoryId: 502,
				nameWithOwner: "harness/routines",
				workflowId: 602,
				workflowPath: ".github/workflows/ci.yml",
			};
			const ciSha = "b".repeat(40);
			const ciSubject: CiSubject = { host: ciRepository.host, repositoryId: 502, workflowId: 602, headSha: ciSha };
			const ciGitDir = join(agentDir, "away-checkout", ".git");
			const ciPaths: CiGitPaths = {
				root: HARNESS_PROJECT_CWD,
				gitDir: ciGitDir,
				commonDir: ciGitDir,
				statusDir: join(ciGitDir, "pi-ci"),
			};
			const ciHead = join(ciGitDir, "HEAD");
			world.io.seed(ciHead, `${ciSha}\n`);
			const ciFailure = createCiAttemptTerminalEvent({
				identity: {
					provider: "github-actions",
					host: ciRepository.host,
					repositoryId: 502,
					workflowId: 602,
					runId: 702,
					runNumber: 1,
					runAttempt: 1,
				},
				headSha: ciSha,
				conclusion: "failure",
				workflowPath: ciRepository.workflowPath,
				observedAt: "2026-11-05T00:01:00.000Z",
				runUrl: "https://github.com/harness/routines/actions/runs/702",
			});
			// What the scripted upstream was asked that it does not answer; checked after every wait, since a throw inside a
			// production callback would surface only as that wait's timeout.
			const ciMismatches: string[] = [];
			let ghInstalled = false;
			let ciCompleted = false;
			const ciRunCompleted = createBarrier();
			const ciProvider: CiProvider = {
				repository: async (signal) => {
					signal.throwIfAborted();
					if (!ghInstalled) throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
					return ciRepository;
				},
				collect: async (requestedSha, signal) => {
					signal.throwIfAborted();
					if (requestedSha !== ciSha) ciMismatches.push(`collected ${requestedSha}`);
					if (!ciCompleted)
						return {
							subject: ciSubject,
							events: [],
							current: { subject: ciSubject, runId: 702, runNumber: 1, runAttempt: 1, status: "in_progress" },
						};
					return {
						subject: ciSubject,
						events: [ciFailure],
						current: {
							subject: ciSubject,
							runId: 702,
							runNumber: 1,
							runAttempt: 1,
							status: "completed",
							conclusion: "failure",
							eventId: ciFailure.eventId,
						},
					};
				},
				failedJobs: async () => ["harness job"],
				// The in-progress attempt's watch ends when the scripted run completes.
				waitForRun: (runId, signal) =>
					new Promise<void>((resolve, reject) => {
						if (runId !== 702) ciMismatches.push(`watched run ${runId}`);
						const onAbort = () => reject(signal.reason);
						if (signal.aborted) {
							onAbort();
							return;
						}
						signal.addEventListener("abort", onAbort, { once: true });
						void ciRunCompleted.promise.then(() => {
							signal.removeEventListener("abort", onAbort);
							resolve();
						});
					}),
			};
			let handOverGhCredentials: (credentials: AwayCiCredentials) => void = () => {};
			const awayCiFactory = createCiAwayEventSources(
				new Promise<AwayCiCredentials>((resolve) => {
					handOverGhCredentials = resolve;
				}),
				{ paths: ciPaths, provider: ciProvider },
			);
			const awayCiSources: AwayEventSourceFactory = (request) => {
				if (request.cwd !== HARNESS_PROJECT_CWD) ciMismatches.push(`followed away in ${request.cwd}`);
				return awayCiFactory(request);
			};
			root.session.backgroundLanes.stopPersistentBotDaemon();
			const launchesBeforeCiSave = daemonLaunches();
			const ciDaemonStarted = world.processes.runNextBotDaemon({ eventSources: awayCiSources });
			// The starting session holds a gh token while its save launches the daemon: it travels only on the daemon's input.
			const ghTokenSentinel = "harness-gh-token-sentinel";
			const ghTokenBefore = process.env.GH_TOKEN;
			process.env.GH_TOKEN = ghTokenSentinel;
			try {
				await root.session.backgroundLanes.createRoutine({
					routineId: ciRoutineId,
					prompt: ciPrompt,
					schedule: { kind: "event", source: "ci", workflowPath: ciRepository.workflowPath },
					profileId: profile.profileId,
				});
			} finally {
				if (ghTokenBefore === undefined) delete process.env.GH_TOKEN;
				else process.env.GH_TOKEN = ghTokenBefore;
			}
			// An event routine is active until it ends: its save alone brings the daemon up.
			expect(daemonLaunches() - launchesBeforeCiSave, "the event routine's save launched one daemon").toBe(1);
			const ciDaemon = await withDeadline(world.trace, "the event routine's daemon starts", ciDaemonStarted);
			for (const name of GH_CREDENTIAL_NAMES)
				expect(ciDaemon.launch.env[name], `no gh token reaches the daemon's environment (${name})`).toBeUndefined();
			const handedGhCredentials = parseDaemonGhCredentials(ciDaemon.launch.stdin());
			expect(
				handedGhCredentials.GH_TOKEN,
				"the starting session handed its gh token over on the daemon's input",
			).toBe(ghTokenSentinel);
			handOverGhCredentials({ credentials: handedGhCredentials });
			const ciRuns = () => awayStore.listRoutineOccurrences({ routineId: ciRoutineId });
			const ghMissing = "the gh command is not installed";
			const ciReports = (fragment: string) =>
				daemonStatus().reports.filter((report) => report.message.includes(fragment));
			const followedAgain = "are followed away again.";
			const handedBack = `Events of session ${ciParentSessionId} are no longer followed away: its session opened, so the session follows its events`;
			const ciRefused = createBarrier();
			const ciFollowed = createBarrier();
			const ciRan = createBarrier();
			const stopObservingCi = awayStore.subscribe(() => {
				const refusal = awayStore.getRoutine(ciRoutineId)?.awayRefusal?.reason;
				if (refusal?.includes(ghMissing) === true) ciRefused.release();
				if (ghInstalled && refusal === undefined && ciReports(followedAgain).length > 0) ciFollowed.release();
				if (ciRuns().some((run) => run.phase === "terminal")) ciRan.release();
			});
			world.provider.enqueue("worker-a", workerReply("away-ci-routine", ciPrompt));
			let ciRunId: string;
			try {
				open = false;
				expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
				const fileWhileCiAway = world.io.peekFile(file);
				// The daemon's next renewal finds the parent closed and opens its one event feed.
				world.timers.advance("routines", 10_000);
				await withDeadline(world.trace, "the away host reports the source it cannot ready", ciRefused.promise);
				expect(ciMismatches, "the away host asked the scripted upstream only for its checkout").toEqual([]);
				expect(
					awayStore.getRoutine(ciRoutineId)?.awayRefusal?.reason,
					"the routine waits for its session, with the exact reason",
				).toContain("waits for the session to open");
				expect(ciRuns(), "a source that cannot be followed is refused and runs nothing").toEqual([]);
				expect(ciReports(ghMissing), "the unready source is reported once").toHaveLength(1);
				// gh is installed: the source's next check (a HEAD write is its local trigger) follows the checkout, whose
				// attempt is still in progress. Its seal clears the refusal and decides nothing.
				ghInstalled = true;
				world.io.writeFileSync(ciHead, `${ciSha}\n`);
				await withDeadline(world.trace, "following again clears the away refusal", ciFollowed.promise);
				expect(ciMismatches, "the followed checkout asked nothing unscripted").toEqual([]);
				expect(ciRuns(), "an attempt still in progress runs nothing").toEqual([]);
				// The attempt completes: its watch ends, and the sealed failure runs the routine away.
				ciCompleted = true;
				ciRunCompleted.release();
				await withDeadline(world.trace, "the sealed CI failure runs the routine away", ciRan.promise);
				expect(ciMismatches, "the completed attempt asked nothing unscripted").toEqual([]);
				const runs = ciRuns();
				expect(
					runs.map((run) => [run.executor, run.result?.outcome, run.result?.delivery]),
					"the closed session's event routine ran once away, its result left for its parent",
				).toEqual([["away", "succeeded", "pending"]]);
				expect(runs[0]?.trigger).toMatchObject({ kind: "event", event: ciFailure });
				expect(ciReports(ghMissing), "and repeated no report").toHaveLength(1);
				expect(ciReports(followedAgain), "following again is reported once").toHaveLength(1);
				expect(
					[
						...ciReports("CI events remain pending"),
						...ciReports("Host event remains pending"),
						...ciReports("are no longer followed away"),
					],
					"the away host opening for the run is no open session: the feed keeps following",
				).toEqual([]);
				expect(world.io.peekFile(file), "nothing wrote the parent transcript while it was closed").toBe(
					fileWhileCiAway,
				);
				ciRunId = runs[0]!.occurrenceId;

				// The session reopens while the daemon still follows its events. Its own CI source starts with it, before
				// its first routine tick, and takes the consumer back from the daemon's live activation. The wake turn calls no
				// tool and its answer names no claim kind, so System One is asked nothing for it.
				world.systemOne.enterPhase("routine-away-ci-parent", {});
				world.provider.enqueue("root", {
					...text("routine-away-ci-parent", "The away CI run is reported."),
					check: (request) =>
						expect(JSON.stringify(request.context.messages)).toContain("away-ci-routine completed."),
				});
				root = await world.createRootSession("root", {
					agentDir,
					sessionManager: world.openSessionManager(file, agentDir),
					settings,
				});
				open = true;
				const sessionCiDiagnostics: string[] = [];
				const sessionCiSealed = createBarrier();
				const sessionCiAbort = new AbortController();
				const sessionCiBinding = root.session.backgroundLanes.openHostEventSession(sessionCiAbort.signal);
				const sessionCi = await createCiHostRuntime({
					cwd: HARNESS_PROJECT_CWD,
					paths: ciPaths,
					provider: ciProvider,
					onDiagnostic: (message) => sessionCiDiagnostics.push(message),
					getSubscribedSubjects: () => root.session.backgroundLanes.getHostEventSubjects(),
					subscribeSubjects: (listener) => root.session.backgroundLanes.subscribeOrchestrationStore(listener),
				});
				if (!sessionCi) throw new Error("The scripted CI source did not open.");
				try {
					await sessionCi.source.start({
						...sessionCiBinding.sink,
						seal: async (seal, signal) => {
							await sessionCiBinding.sink.seal(seal, signal);
							sessionCiSealed.release();
						},
					});
					await withDeadline(
						world.trace,
						"the reopened session takes its CI back from the running daemon and re-seals",
						sessionCiSealed.promise,
					);
					const ciSettled = parentSettled(42);
					await root.session.backgroundLanes.tickPersistentRoutines();
					await withDeadline(world.trace, "the event run away is delivered on reopen", ciSettled);
					// The handback report lands in the daemon's lease record after its last routine write: wait on any write.
					await withDeadline(
						world.trace,
						"the daemon stops following the reopened session",
						world.io.waitForMutation(() => ciReports(handedBack).length > 0),
					);
					await root.session.backgroundLanes.tickPersistentRoutines();
				} finally {
					await withDeadline(world.trace, "the session's CI source stops", sessionCi.source.stop());
					await withDeadline(world.trace, "the session's host event binding closes", sessionCiBinding.close());
				}
				expect(sessionCiDiagnostics, "the session takes the consumer back from the daemon cleanly").toEqual([]);
				expect(
					harnessNotices("host-event-source"),
					"the daemon followed the CI up to the handback, so the session is told no away connection state",
				).toEqual([]);
				expect(ciMismatches, "the reopened session asked nothing unscripted").toEqual([]);
				expect(ciReports(handedBack), "the daemon says once that the session follows its events").toHaveLength(1);
				expect(
					[...ciReports("CI events remain pending"), ...ciReports("Host event remains pending")],
					"the handback leaves no pending source behind in the daemon",
				).toEqual([]);
				expect(await withDeadline(world.trace, "the CI daemon stops", ciDaemon.stop())).toBe(0);
			} finally {
				stopObservingCi();
			}
			expect(
				store()
					.listRoutineOccurrences({ routineId: ciRoutineId })
					.map((run) => [run.occurrenceId, run.result?.delivery]),
				"a re-sealed attempt never runs twice, and its one result is acknowledged",
			).toEqual([[ciRunId, "acknowledged"]]);
			expect(parentInputs(), "the event run's result is delivered once").toHaveLength(42);
			// Later legs and daemons never see this routine.
			expect(
				store().deleteRoutine(
					ciRoutineId,
					store().getRoutine(ciRoutineId)!.revision,
					world.timers.port("routines").now(),
				),
			).toBe(true);
		} finally {
			awayStore.dispose();
		}

		// A routine whose runs keep failing pauses itself in the write of its third failed result in a row, keeps the
		// revision the owner resumes against, tells the owner once and takes no further slot; a success restarts the count.
		const wakesSettled = (count: number): Promise<void> =>
			new Promise((resolve) => {
				const check = () => {
					if (parentInputs().length === count && root.sessionManager.getPendingParentInputs("turn").length === 0) {
						unsubscribe();
						resolve();
					}
				};
				const unsubscribe = root.sessionManager.onEntriesPersisted(check);
				check();
			});
		const failingId = "failing-review";
		const failingPrompt = "Inspect the failing review task and report its status.";
		await command("routine-failing-create", {
			action: "create",
			routineId: failingId,
			prompt: failingPrompt,
			schedule: { kind: "interval", intervalMs: 3_600_000 },
			profileId: profile.profileId,
		});
		const failingRevision = store().getRoutine(failingId)!.revision;
		const failingRuns = () => store().listRoutineOccurrences({ routineId: failingId });
		const pauseNoticed = createBarrier();
		const stopObservingPause = root.sessionManager.onEntriesPersisted(() => {
			if (harnessNotices("routine-paused").length > 0) pauseNoticed.release();
		});
		try {
			for (const [run, blocked] of [true, true, false, true, true, true].entries()) {
				const label = `routine-failing-${run}`;
				world.provider.enqueue(
					"worker-a",
					workerReply(label, failingPrompt, undefined, undefined, undefined, blocked),
				);
				const settled = wakesSettled(parentInputs().length + 1);
				const running = command(label, { action: "run", routineId: failingId, expectedRevision: failingRevision });
				const wakeEntered = createBarrier();
				const wakeRelease = createBarrier();
				if (run === 5) {
					world.provider.enqueue(
						"root",
						{
							...calls("h25-wake-read", [
								{ id: "h25-wake-read", name: "read", arguments: { path: LIMITS_PATH } },
							]),
							check: (request) => {
								expect(JSON.stringify(request.context.messages)).toContain("routine-failing-5 blocked.");
								wakeEntered.release();
							},
							gate: wakeRelease.promise,
						},
						{
							...text("h25-wake-owner-answer", "The failed routine and the owner's request are noted."),
							check: (request) => {
								const input = JSON.stringify(request.context.messages);
								expect(input).toContain("routine-failing-5 blocked.");
								expect(input).toContain("Routine failing-review was paused");
								expect(input).toContain("Please acknowledge the pause and the failed result.");
							},
						},
					);
				} else world.provider.enqueue("root", text(`${label}-parent`, `Failing run ${run} is reported.`));
				try {
					await running;
					if (run === 5) {
						await withDeadline(world.trace, "H25 real routine wake request is held", wakeEntered.promise);
						await withDeadline(world.trace, "H25 real paused-routine notice is saved", pauseNoticed.promise);
						expect(
							root.sessionManager
								.getPendingParentInputs("next-owner-turn")
								.some((item) => item.metadata.mode === "next-owner-turn"),
						).toBe(true);
						world.systemOne.enterPhase("h25-authenticated-steer", ICM_INTAKE_JUDGMENTS);
						const steered = await withDeadline(
							world.trace,
							"H25 owner steer",
							root.session.steer("Please acknowledge the pause and the failed result."),
						);
						expect(steered.ended).toBeUndefined();
					}
				} finally {
					wakeRelease.release();
				}
				await withDeadline(world.trace, label, settled);
				await withDeadline(world.trace, `${label} turn ended`, root.session.agent.waitForIdle());
				if (run === 5) await verifyParentInputOverlap(world, root.sessionManager, agentDir, root.session);
				const failing = store().getRoutine(failingId)!;
				if (run < 5) {
					expect(failing.enabled, `${label}: fewer than three failures in a row keep the routine running`).toBe(
						true,
					);
					expect(failing.failureStreak, `${label}: the count follows the results in a row`).toBe(
						[1, 2, undefined, 1, 2][run],
					);
				}
			}
			await withDeadline(world.trace, "the pause notice is saved", pauseNoticed.promise);
		} finally {
			stopObservingPause();
		}
		expect(
			failingRuns().map((entry) => entry.result?.outcome),
			"a reported blocker is a failed result",
		).toEqual(["failed", "failed", "succeeded", "failed", "failed", "failed"]);
		const selfPaused = store().getRoutine(failingId)!;
		expect(selfPaused.enabled, "the third failure in a row pauses the routine").toBe(false);
		expect(selfPaused.revision, "the pause keeps the revision the owner resumes against").toBe(failingRevision);
		expect(selfPaused.failurePause).toMatchObject({
			after: 3,
			occurrenceId: failingRuns().at(-1)!.occurrenceId,
		});
		expect(selfPaused.failurePause?.lastError).toContain("routine-failing-5 blocked.");
		expect(
			harnessNotices("routine-paused").map((entry) => parentInputOf(entry)?.metadata.mode),
			"the owner is told once, with their next turn",
		).toEqual(["next-owner-turn"]);
		// The schedule's first slot passes while paused: nothing is claimed for it.
		world.timers.advance("routines", 3_600_000);
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(failingRuns(), "a paused routine takes no scheduled run").toHaveLength(6);
		expect(harnessNotices("routine-paused"), "a later pass repeats no notice").toHaveLength(1);

		// A readyBy window starts a slot's run before the slot, and the run still belongs to that slot. A routine without
		// a window takes nothing at the same instant, and an unfinished run of the windowed routine keeps its next window
		// shut until that run ends.
		const readyId = "ready-review";
		const readyPrompt = "Inspect the ready review task and report its status.";
		const readyControlId = "ready-review-control";
		const readyLeadMs = 120_000;
		await command("routine-ready-create", {
			action: "create",
			routineId: readyId,
			prompt: readyPrompt,
			schedule: { kind: "interval", intervalMs: 600_000, readyBy: true, readyLeadMs },
			profileId: profile.profileId,
		});
		const nextOwner = root.sessionManager
			.getEntries()
			.findLast(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					(typeof entry.message.content === "string"
						? entry.message.content === "Apply the routine-ready-create routine command."
						: entry.message.content.some(
								(part) =>
									part.type === "text" && part.text === "Apply the routine-ready-create routine command.",
							)),
			);
		if (!nextOwner) throw new Error("H25 next owner prompt was not persisted.");
		const nextRequest = root.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "request_snapshot" && entry.messageEntryIds.includes(nextOwner.id));
		if (nextRequest?.type !== "request_snapshot") throw new Error("H25 next owner prompt was not admitted.");
		expect(
			root.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "provider_request_terminal" &&
						entry.requestId === nextRequest.requestId &&
						entry.outcome === "completed",
				),
		).toBe(true);
		await command("routine-ready-control-create", {
			action: "create",
			routineId: readyControlId,
			prompt: readyPrompt,
			schedule: { kind: "interval", intervalMs: 600_000 },
			profileId: profile.profileId,
		});
		const readyRuns = (id = readyId) => store().listRoutineOccurrences({ routineId: id });
		const readyReaches = (test: (runs: readonly RoutineOccurrence[]) => boolean, id = readyId): Promise<void> =>
			new Promise((resolve) => {
				const check = () => {
					if (!test(readyRuns(id))) return;
					stop();
					resolve();
				};
				const stop = store().subscribe(check);
				check();
			});
		const firstSlot = store().getRoutine(readyId)!.nextRunAt;
		// Each interval slot is placed from its own save instant (the routines clock follows the wall clock), so the control's
		// first slot is the windowed one's or later, never earlier.
		expect(
			store().getRoutine(readyControlId)!.nextRunAt,
			"the routine without a window was saved after the windowed one",
		).toBeGreaterThanOrEqual(firstSlot);
		const readyGate = createBarrier();
		world.provider.enqueue(
			"worker-a",
			workerReply("routine-ready-early", readyPrompt, readyGate.promise, undefined, "none"),
		);
		const earlyRunning = readyReaches((runs) => runs[0]?.phase === "running");
		world.timers.advance("routines", firstSlot - world.timers.port("routines").now() - 60_000);
		await root.session.backgroundLanes.tickPersistentRoutines();
		await withDeadline(world.trace, "the early run is running", earlyRunning);
		const [early] = readyRuns();
		expect(early?.trigger, "the early run belongs to the nominal slot").toEqual({
			kind: "schedule",
			scheduledAt: firstSlot,
			missedCount: 0,
		});
		expect(early!.createdAt, "it was claimed before the slot").toBeLessThan(firstSlot);
		expect(firstSlot - early!.createdAt, "and no earlier than its lead").toBeLessThanOrEqual(readyLeadMs);
		expect(
			store().listRoutineOccurrences({ routineId: readyControlId }),
			"a routine without a window does not start before its slot",
		).toEqual([]);
		const readyControl = store().getRoutine(readyControlId)!;
		expect(store().deleteRoutine(readyControlId, readyControl.revision, world.timers.port("routines").now())).toBe(
			true,
		);
		const secondSlot = store().getRoutine(readyId)!.nextRunAt;
		expect(secondSlot, "the early claim consumed its slot").toBe(firstSlot + 600_000);
		world.timers.advance("routines", secondSlot - world.timers.port("routines").now() - 90_000);
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(readyRuns(), "an unfinished run keeps the next window shut").toHaveLength(1);
		world.provider.enqueue("worker-a", workerReply("routine-ready-next", readyPrompt, undefined, undefined, "none"));
		const nextFinished = readyReaches(
			(runs) => runs.length === 2 && runs.every((run) => run.result?.delivery === "acknowledged"),
		);
		readyGate.release();
		await withDeadline(world.trace, "the run after the early one starts in its own window", nextFinished);
		const runs = readyRuns();
		expect(
			runs.map((run) => [
				run.trigger.kind === "schedule" ? run.trigger.scheduledAt : undefined,
				run.result?.outcome,
			]),
			"each run names its own slot",
		).toEqual([
			[firstSlot, "succeeded"],
			[secondSlot, "succeeded"],
		]);
		expect(runs[1]!.createdAt, "the next run also started before its slot").toBeLessThan(secondSlot);
		expect(
			parentInputs().map((entry) => parentInputOriginalDetails(entry)),
			"the delivered result names the early run's slot occurrence",
		).toContainEqual(expect.objectContaining({ routineId: readyId, occurrenceId: early!.occurrenceId }));
		// Without readyLeadMs the lead is derived: 15 minutes before any measured run, then the slowest measured run (claim
		// to result) plus a quarter and one minute, kept between one minute and two hours. An explicit lead keeps no run
		// times and stays as set (a derived one would meet the half-gap floor, 5 minutes); a plain routine keeps none.
		const readySlot = store().getRoutine(readyId)!.nextRunAt;
		const readyStatus = (await root.session.autonomyStatus()).routines;
		expect(
			readyStatus.status === "available"
				? readyStatus.value.routines.items.find((item) => item.routineId === readyId)
				: readyStatus,
			"an explicit lead stays as set after measured runs",
		).toMatchObject({ nextRunAt: readySlot, startsFrom: readySlot - readyLeadMs });
		expect(store().getRoutine(readyId)!.runDurations, "an explicit lead keeps no run times").toBeUndefined();
		expect(store().getRoutine(routineId)!.runDurations, "a routine without readyBy keeps none").toBeUndefined();
		expect(
			store().deleteRoutine(readyId, store().getRoutine(readyId)!.revision, world.timers.port("routines").now()),
		).toBe(true);
		const derivedId = "ready-derived";
		const routineOf = (answer: string) => (JSON.parse(answer) as { routine: RoutineToolSummary }).routine;
		const derivedCreated = routineOf(
			await command("routine-ready-derived-create", {
				action: "create",
				routineId: derivedId,
				prompt: readyPrompt,
				schedule: { kind: "interval", intervalMs: 3_600_000, readyBy: true },
				profileId: profile.profileId,
			}),
		);
		const derivedSlot = derivedCreated.nextRunAt!;
		expect(derivedCreated.startsFrom, "before any measured run the lead is 15 minutes").toBe(derivedSlot - 900_000);
		const derivedGate = createBarrier();
		world.provider.enqueue(
			"worker-a",
			workerReply("routine-ready-derived", readyPrompt, derivedGate.promise, undefined, "none"),
		);
		world.timers.advance("routines", derivedSlot - 960_000 - world.timers.port("routines").now());
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(readyRuns(derivedId), "a minute before its lead the window is shut").toEqual([]);
		const derivedRunning = readyReaches((runs) => runs[0]?.phase === "running", derivedId);
		world.timers.advance("routines", derivedSlot - 900_000 - world.timers.port("routines").now());
		await root.session.backgroundLanes.tickPersistentRoutines();
		await withDeadline(world.trace, "the derived window opens 15 minutes before its slot", derivedRunning);
		const derivedSpan = 360_000;
		world.timers.advance("routines", derivedSpan);
		const derivedDelivered = readyReaches((runs) => runs[0]?.result?.delivery === "acknowledged", derivedId);
		derivedGate.release();
		await withDeadline(world.trace, "the derived run is delivered", derivedDelivered);
		// The routines clock follows the wall clock plus the advance: the measured span is the advance and the real time
		// of the scripted run, so the expectation is computed from the stored span.
		const measured = store().getRoutine(derivedId)!.runDurations ?? [];
		expect(measured, "the succeeded scheduled run is measured once").toHaveLength(1);
		expect(measured[0], "from its claim to its result").toBeGreaterThanOrEqual(derivedSpan);
		expect(measured[0], "the rest is the scripted run's real time").toBeLessThan(derivedSpan + 60_000);
		const derived = routineOf(await command("routine-ready-derived-get", { action: "get", routineId: derivedId }));
		expect(derived.nextRunAt, "the early claim consumed the first slot").toBe(derivedSlot + 3_600_000);
		expect(derived.startsFrom, "the next window opens the derived lead before its slot").toBe(
			derived.nextRunAt! - Math.min(7_200_000, Math.max(60_000, Math.ceil(measured[0]! * 1.25) + 60_000)),
		);
		expect(
			store().deleteRoutine(derivedId, store().getRoutine(derivedId)!.revision, world.timers.port("routines").now()),
		).toBe(true);

		// Past routines.maxResultWakesPerDay a result starts no turn: it is saved for the owner's next turn, with one
		// notice naming the setting. The bound here is exactly the routine-result turns this session already started.
		const wakeBound = parentInputs().filter((entry) => parentInputOf(entry)?.metadata.mode === "turn").length;
		open = false;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		root = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.openSessionManager(file, agentDir),
			settings: { ...settings, routines: { maxResultWakesPerDay: wakeBound } },
		});
		open = true;
		const heldSummary = "routine-held-result completed.";
		const heldEntries = () => parentInputs().filter((entry) => JSON.stringify(entry).includes(heldSummary));
		const heldSaved = createBarrier();
		const stopObservingHeld = root.sessionManager.onEntriesPersisted(() => {
			if (heldEntries().length > 0 && harnessNotices("routine-result-wakes").length > 0) heldSaved.release();
		});
		const heldRelease = createBarrier();
		let rootRequestsBeforeHeld = -1;
		try {
			// The run reports only after the owner's turn ends. No parent reply is scripted for its result: a turn it
			// started would find none.
			world.provider.enqueue("worker-a", workerReply("routine-held-result", replacement, heldRelease.promise));
			await command("routine-held-run", {
				action: "run",
				routineId,
				expectedRevision: store().getRoutine(routineId)!.revision,
			});
			expect(
				world.provider.requests
					.filter((request) => request.model.id === "root")
					.some((request) => JSON.stringify(request.context.messages).includes("was paused after 3 failed runs")),
				"the owner's turn carried the pause notice",
			).toBe(true);
			rootRequestsBeforeHeld = world.provider.requests.filter((request) => request.model.id === "root").length;
			heldRelease.release();
			await withDeadline(world.trace, "the held result and its notice are saved", heldSaved.promise);
		} finally {
			heldRelease.release();
			stopObservingHeld();
		}
		await withDeadline(world.trace, "nothing runs for the held result", root.session.agent.waitForIdle());
		expect(
			world.provider.requests.filter((request) => request.model.id === "root"),
			"the held result made no root request",
		).toHaveLength(rootRequestsBeforeHeld);
		expect(
			heldEntries().map((entry) => [parentInputOf(entry)?.metadata.mode, parentInputOriginalDetails(entry)]),
			"the result past the bound waits for the owner's next turn",
		).toEqual([["next-owner-turn", expect.objectContaining({ deliveryHold: ROUTINE_RESULT_WAKES_HOLD })]]);
		expect(root.sessionManager.getPendingParentInputs("turn"), "the held result starts no turn").toEqual([]);
		expect(harnessNotices("routine-result-wakes"), "the hold is told once").toHaveLength(1);
		// This turn calls no tool and no later owner turn follows in this session, so its owner words are never settled:
		// System One is asked nothing here.
		world.systemOne.enterPhase("routine-held-owner-turn", {});
		world.provider.enqueue("root", {
			...text("routine-held-owner-turn", "The held routine result is reported."),
			check: (request) => {
				const wire = JSON.stringify(request.context.messages);
				expect(wire, "the owner's next turn carries the held result").toContain(heldSummary);
				expect(wire, "and the notice naming the bound").toContain("Routine results started");
			},
		});
		await withDeadline(
			world.trace,
			"routine-held-owner-turn",
			root.session.prompt("What did the scheduled review report?"),
		);
		expect(world.provider.requests.filter((request) => request.model.id === "root")).toHaveLength(
			rootRequestsBeforeHeld + 1,
		);
		expect(root.sessionManager.getPendingParentInputs(), "the owner's turn consumed what was held").toEqual([]);
		world.trace.mark("root", "routine.native-durable-delivery");
	} finally {
		release.release();
		scheduledRelease.release();
		if (open) {
			open = false;
			expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		}
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
	await runJourney1AwayService(world, profile);
	await runJourney1RoutineIntake(world, profile);
}

/**
 * Hands-off intake through the real root: after the turn settles, the owner's stated request becomes a read-only
 * routine on host-compiled timing, announced on the next turn with the hour and days the host chose, while a pasted
 * request (quoted, or undelimited and known only by the editor's recorded paste provenance) and an hour the owner's
 * quoted timing words do not carry are never judged; the owner hears once, with the next turn, which stated request
 * the host could not schedule. Words the model's context held when it saved a routine, steered words included, are
 * passed over unread while earlier words nothing answered are still read; a request the owner navigates away from
 * while it is judged creates nothing; a stale pass restored after the owner removed its routine creates nothing; and the
 * routine the model saved with an end is removed, and told once, after the owner returns to the conversation that saved it.
 * A request meant only until something happens ends when its run reports that end met: removed after the result is
 * delivered, told once, and no later slot runs.
 */
async function runJourney1RoutineIntake(world: HarnessWorld, profile: OrchestrationProfile): Promise<void> {
	const agentDir = `${world.agentDir}-routine-intake`;
	new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(profile, "global");
	const settings = icmContinuousSettings("worker-c", {
		autoLearn: { enabled: false },
		proactivity: { enabled: false },
	});
	let root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings,
	});
	let open = true;
	const tracks: string[] = [];
	// About sixteen chat records are written (owner words, replies, the steered run's calls and consumed notices); the
	// optional summary tracks cover twice that, and the ones never reached are retired.
	for (let size = 1; size <= 32; size *= 2)
		for (let first = 0; first + size <= 32; first += size) {
			const task =
				size === 1
					? `Compaction: compress message ${first} into`
					: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
			const name = `routine-intake-compaction-${first}+${size}`;
			tracks.push(name);
			world.provider.enqueueTrack(
				name,
				"worker-c",
				(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
				{
					name,
					optional: true,
					reply: {
						content: [{ type: "text", text: "Owner requests and saved routines; see the original turns." }],
					},
				},
			);
		}
	// The session whose intake is read; the conditional request at the end is stated in a fresh session.
	let parentSessionId = root.sessionManager.getSessionId();
	const store = () => root.session.backgroundLanes.getBotTeamStore();
	const intakeState = () => store().getRoutineIntakeSession(parentSessionId);
	const notices = () =>
		root.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "routine-intake");
	const rootRequests = () => world.provider.requests.filter((request) => request.model.id === "root").length;
	const latestSource = () =>
		getOwnerEvidenceSnapshots(root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE])).at(-1)!;
	// A pass has ended once its retained batch is cleared and the notices it owes are persisted, in either order.
	const passEnded = (expectedNotices: number): Promise<void> =>
		new Promise((resolve) => {
			const stops: Array<() => void> = [];
			const check = () => {
				if (intakeState()?.batch !== undefined || notices().length !== expectedNotices) return;
				for (const stop of stops.splice(0)) stop();
				resolve();
			};
			stops.push(store().subscribe(check), root.sessionManager.onEntriesPersisted(check));
			check();
		});
	const owner =
		"My colleague wrote:\n> Check the release notes every hour.\nEvery morning, summarize the open review comments.";
	const instruction = "summarize the open review comments";
	const unstatedHour = "Post the build summary every evening at 7.";
	// Pasted with no quotation syntax: only the paste provenance the editor reports shows these are not the owner's words.
	const pastedRequest = "Rotate the deploy keys every hour.";
	const secondOwner = `${unstatedHour}\n${pastedRequest}`;
	const pasted = { start: unstatedHour.length + 1, end: secondOwner.length };
	// Negative controls of the timing grammar: an event word is no hour, and a one-time CI watch needs a one-time slot.
	const controls = "Every day at lunch, list the stale branches.\nSummarize the failing jobs the next time CI fails.";
	try {
		world.systemOne.enterPhase("routine-intake-owner", {});
		world.provider.enqueue("root", text("routine-intake-owner-reply", "Noted."));
		await withDeadline(world.trace, "routine intake owner words", root.session.prompt(owner));
		const source = latestSource();
		expect(source.text).toBe(owner);
		// A second request before the pass: the host reads its hour as 19:00, not the proposed 07:00.
		world.systemOne.enterPhase("routine-intake-second-owner", {
			...ICM_INTAKE_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue("root", text("routine-intake-second-owner-reply", "Noted."));
		await withDeadline(
			world.trace,
			"routine intake second owner words",
			root.session.prompt(secondOwner, { pasted: [pasted] }),
		);
		const second = latestSource();
		expect(second.text).toBe(secondOwner);
		expect(second.pasted, "the owner evidence keeps which words were pasted").toEqual([pasted]);
		world.systemOne.enterPhase("routine-intake-control-owner", {
			...ICM_INTAKE_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue("root", text("routine-intake-control-owner-reply", "Noted."));
		await withDeadline(world.trace, "routine intake control owner words", root.session.prompt(controls));
		expect(latestSource().text).toBe(controls);
		// Words with no timing at all: the pass reads past them without a gate or an extraction.
		const noTiming = "Thanks, that covers it.";
		world.systemOne.enterPhase("routine-intake-third-owner", {
			...ICM_INTAKE_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue("root", text("routine-intake-third-owner-reply", "Noted."));
		await withDeadline(world.trace, "routine intake words without timing", root.session.prompt(noTiming));
		const third = latestSource();
		expect(third.text).toBe(noTiming);

		world.systemOne.enterPhase("routine-intake-pass", {
			requests_automation: { kind: "noul", probability: 0.98 },
			explicit: { kind: "noul", probability: 0.98 },
			faithful: { kind: "noul", probability: 0.98 },
		});
		world.provider.enqueue(
			"root",
			{
				name: "routine-intake-extraction",
				check: (request) => {
					expect(request.context.tools?.map((tool) => tool.name)).toEqual([ROUTINE_INTAKE_SUBMISSION_TOOL_NAME]);
					expect(
						request.context.messages,
						"extraction carries the owner's originals in its only message",
					).toHaveLength(1);
					expect(JSON.stringify(request.context.messages)).toContain(instruction);
					expect(JSON.stringify(request.context.messages)).toContain(unstatedHour);
					expect(JSON.stringify(request.context.messages)).toContain("list the stale branches");
					expect(JSON.stringify(request.context.messages), "pasted words are not sent").not.toContain(
						pastedRequest,
					);
					expect(JSON.stringify(request.context.messages), "words without timing are not read").not.toContain(
						noTiming,
					);
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: "routine-intake-extraction",
							name: ROUTINE_INTAKE_SUBMISSION_TOOL_NAME,
							arguments: {
								messages: [
									{
										id: "m1",
										requests: [
											// The pasted line: the host finds it only as shown text, so it is never judged.
											{
												instruction: "Check the release notes",
												when: "every hour",
												timing: { kind: "interval", every: 1, unit: "hour" },
											},
											// A part of the day without a time: the host chooses the hour, runs it every day, and says so.
											{
												instruction,
												when: "Every morning",
												timing: { kind: "daily", partOfDay: "morning" },
											},
										],
									},
									{
										id: "m2",
										requests: [
											// The whole timing is quoted but the model picks the morning hour: the host reads "every
											// evening at 7" as 19:00 and drops it before any judgment, telling the owner which words.
											{
												instruction: "Post the build summary",
												when: "every evening at 7",
												timing: { kind: "daily", time: "07:00" },
											},
											// Undelimited pasted words: shown by their recorded provenance alone, so never judged.
											{
												instruction: "Rotate the deploy keys",
												when: "every hour",
												timing: { kind: "interval", every: 1, unit: "hour" },
											},
										],
									},
									{
										id: "m3",
										requests: [
											// "lunch" is an event, not an hour: the host refuses it although the daily slot fits "Every day".
											{
												instruction: "list the stale branches",
												when: "Every day at lunch",
												timing: { kind: "daily" },
											},
											// The words watch only the next failure; a slot without lasts would watch every one.
											{
												instruction: "Summarize the failing jobs",
												when: "the next time CI fails",
												timing: { kind: "event" },
											},
										],
									},
								],
							},
						},
					],
					stopReason: "toolUse",
				},
			},
			...(world.systemOne.enabled
				? []
				: [
						knowledgeJudgment(
							"routine-intake-judgment",
							"routine.intake",
							[
								{ id: "explicit", value: true, confidence: 0.98 },
								{ id: "faithful", value: true, confidence: 0.98 },
							],
							() => instruction,
						),
					]),
		);
		const retained: { batch?: RoutineIntakeBatch } = {};
		const stopRetaining = store().subscribe(() => {
			const batch = intakeState()?.batch;
			if (!retained.batch && batch?.requests && batch.requests.every((request) => request.outcome === undefined))
				retained.batch = batch;
		});
		const beforePass = rootRequests();
		const decodedBeforePass = world.systemOne.decoded.length;
		// The pass owes four notices: the routine it created and the three requests it dropped.
		const created = passEnded(4);
		try {
			expect(
				await withDeadline(world.trace, "routine intake idle delay", world.timers.whenArmed("routine-intake")),
				"intake reads the owner's words after the turn settles",
			).toBe(2_000);
			expect(world.timers.advance("routine-intake", 2_000)).toBe(1);
			await withDeadline(world.trace, "routine intake pass created its routine", created);
		} finally {
			stopRetaining();
		}
		const automatic = store()
			.listRoutines()
			.filter((routine) => routine.origin !== undefined);
		expect(automatic, "only the owner's stated request becomes a routine").toHaveLength(1);
		const routine = automatic[0]!;
		expect(routine.origin?.sourceId).toBe(source.sourceId);
		expect(routine.prompt, "the routine runs the owner's own words").toBe(instruction);
		const hostDefaults = ['09:00 for "morning"'];
		expect(
			routineScheduleInputOf(routine.schedule),
			"the host compiles the stated part of the day to its fixed hour on every day, with a start window",
		).toMatchObject({ kind: "calendar", cron: "0 9 * * *", maxLatenessMs: 1_800_000 });
		expect(routine.origin?.defaults, "the origin records what the host chose").toEqual(hostDefaults);
		expect(
			routine.executionSnapshot?.savedIntent.executionContract.worker.profile.readOnly,
			"intake grants no write authority",
		).toBe(true);
		expect(
			retained.batch?.requests?.map((request) => request.prompt),
			"neither pasted request (quoted or undelimited) nor an hour the words read differently is retained",
		).toEqual([instruction]);
		expect(
			retained.batch?.dropped?.map((drop) => drop.excerpt),
			"every request whose timing the host could not compile is kept as dropped",
		).toEqual(["Post the build summary", "list the stale branches", "Summarize the failing jobs"]);
		expect(store().hasRoutineIntakeOrigin(retained.batch!.requests![0]!.key)).toBe(true);
		expect(intakeState()?.through, "the pass ends past the words without timing it skipped").toBe(
			Date.parse(third.createdAt),
		);
		const contentOf = (entry: ReturnType<typeof notices>[number] | undefined): string =>
			entry?.type === "custom_message" && typeof entry.content === "string" ? entry.content : "";
		const notice = notices().find((entry) => contentOf(entry).startsWith("Scheduled (read-only): "))!;
		const content = contentOf(notice);
		expect(content).toContain("Scheduled (read-only): every day at 09:00 (");
		expect(content).toContain(` - ${JSON.stringify(instruction)}\nRoutine ${routine.routineId} was created`);
		expect(content, "the notice names every host choice").toContain(`so the host chose: ${hostDefaults.join("; ")}.`);
		const droppedNotices = notices().filter((entry) => contentOf(entry).startsWith("Could not schedule "));
		expect(droppedNotices, "each dropped request is noticed once").toHaveLength(3);
		const dropReasons = [
			'the host reads "every evening at 7" differently from the proposed timing - "Post the build summary"',
			'the host cannot schedule "lunch" exactly - "list the stale branches"',
			'the host reads "the next time CI fails" differently from the proposed timing - "Summarize the failing jobs"',
		];
		expect(
			droppedNotices.map(contentOf).sort(),
			"the owner hears which stated request was not scheduled, and which of its words why",
		).toEqual(
			dropReasons
				.map(
					(reason) =>
						`Could not schedule what reads as a request: ${reason}\nNo routine was created. If it was meant, the owner can restate it.`,
				)
				.sort(),
		);
		for (const entry of [notice, ...droppedNotices])
			expect(parentInputOf(entry!)?.metadata.mode, "each notice waits for the owner's next turn").toBe(
				"next-owner-turn",
			);
		expect(root.sessionManager.getPendingParentInputs("turn"), "a notice never wakes the parent").toHaveLength(0);
		const providerRequests = world.systemOne.enabled ? 1 : 2;
		expect(rootRequests() - beforePass, "one extraction; the session model judges only with System One off").toBe(
			providerRequests,
		);
		expect(
			world.systemOne.decoded.length - decodedBeforePass,
			"System One gates the three timed sources, not the words without timing, and judges only the grounded request",
		).toBe(world.systemOne.enabled ? 4 : 0);
		const receipts = root.sessionManager.getEntries().flatMap((entry) => {
			const report = resolveSemanticUsageEntry(entry)?.report;
			return report?.route === "routine_intake" ? [report] : [];
		});
		expect(receipts, "every intake request is accounted to the pass").toHaveLength(providerRequests);
		for (const receipt of receipts) expect(receipt.origin?.operationId).toBe(retained.batch?.operationId);
		expect(root.session.backgroundLanes.getRoutineIntakeStatus()).toMatchObject({
			state: "active",
			...(world.systemOne.enabled ? {} : { judge: `structured-llm (${HARNESS_PROVIDER}/root)` }),
			last: { status: "completed", sources: 3, created: 1, refused: 0 },
		});

		// The owner states a request the model only acknowledges, so nothing answers it. The four notices of the first pass
		// reach this turn, are saved once and buy no request of their own.
		const unanswered = "Every evening, summarize the failing builds.";
		const unansweredInstruction = "summarize the failing builds";
		const beforeUnanswered = root.sessionManager.getLeafId()!;
		world.systemOne.enterPhase("routine-intake-unanswered", {
			...ICM_INTAKE_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue("root", {
			...text("routine-intake-unanswered-reply", "Noted."),
			check: (request) => {
				const context = JSON.stringify(request.context.messages);
				expect(context, "the creation notice reaches the owner's next turn").toContain("Scheduled (read-only): ");
				expect(context, "the drop notice reaches the owner's next turn").toContain(
					"Could not schedule what reads as a request: ",
				);
			},
		});
		const beforeUnansweredTurn = rootRequests();
		await withDeadline(world.trace, "routine intake unanswered request", root.session.prompt(unanswered));
		expect(latestSource().text).toBe(unanswered);
		expect(rootRequests() - beforeUnansweredTurn, "the notices ride the owner's turn without a request").toBe(1);
		expect(notices(), "each notice is saved once").toHaveLength(4);
		expect(intakeState()?.unannounced, "every notice the first pass owed was accepted").toBeUndefined();

		// The model answers the next request with a routine save while the owner steers another request into the same run:
		// the context that saved held both, so intake reads neither, yet it still reads the earlier words nothing answered.
		const handled = "Also check the changelog every day.";
		const steered = "And review the dependency updates every Friday.";
		const saveReached = createBarrier();
		const saveRelease = createBarrier();
		world.systemOne.enterPhase("routine-intake-tool-save", {
			...ICM_INTAKE_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue(
			"root",
			{
				...text("routine-intake-tool-save-first", "Looking at the changelog."),
				check: () => saveReached.release(),
				gate: saveRelease.promise,
			},
			{
				...calls("routine-intake-tool-save-call", [
					{
						id: "routine-intake-tool-save",
						name: "routine",
						arguments: {
							action: "create",
							routineId: "changelog-review",
							prompt: "Check the changelog.",
							// Saved for an hour only: its first slot lies a day out, so it ends without a run.
							schedule: {
								kind: "interval",
								intervalMs: 86_400_000,
								expiresAt: world.timers.port("routines").now() + 3_600_000,
							},
							profileId: profile.profileId,
						},
					},
				]),
				check: (request) =>
					expect(
						JSON.stringify(request.context.messages),
						"the steered words reach the run before its save",
					).toContain(steered),
			},
			{
				...text("routine-intake-tool-save-done", "The changelog routine is saved."),
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
					expect(result?.isError, result?.text).toBe(false);
				},
			},
		);
		const saving = root.session.prompt(handled);
		try {
			await withDeadline(world.trace, "routine intake tool-save run reached", saveReached.promise);
			const admitted = await withDeadline(
				world.trace,
				"routine intake owner steer admitted",
				root.session.steer(steered),
			);
			expect(admitted.ended, "the steer joins the running turn").toBeUndefined();
		} finally {
			saveRelease.release();
		}
		await withDeadline(world.trace, "routine intake tool save", saving);
		await withDeadline(world.trace, "routine intake tool save settled", root.session.waitForForegroundIdle());
		// The conversation that saved the changelog routine: its routine runs and ends only while the owner is on it.
		const savedLeaf = root.sessionManager.getLeafId()!;
		const sourceOf = (words: string) =>
			getOwnerEvidenceSnapshots(root.sessionManager.getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE])).find(
				(entry) => entry.text === words,
			)!;
		const handledSource = sourceOf(handled);
		const steeredSource = sourceOf(steered);
		expect(store().getRoutine("changelog-review")).toBeDefined();
		expect(intakeState()?.answered, "the save records every owner source its context held").toEqual([
			handledSource.sourceId,
			steeredSource.sourceId,
		]);

		// The pass reads only the words nothing answered. While their judgment is held, the owner moves the session back to
		// before those words: the judged request creates nothing and stays undecided, and the next pass, finding the words
		// off the branch, passes it without a notice.
		const judgmentReached = createBarrier();
		const judgmentRelease = createBarrier();
		const judgment = knowledgeJudgment(
			"routine-intake-unanswered-judgment",
			"routine.intake",
			[
				{ id: "explicit", value: true, confidence: 0.98 },
				{ id: "faithful", value: true, confidence: 0.98 },
			],
			() => unansweredInstruction,
		);
		world.systemOne.enterPhase("routine-intake-unanswered-pass", {
			requests_automation: { kind: "noul", probability: 0.98 },
		});
		world.provider.enqueue(
			"root",
			{
				name: "routine-intake-unanswered-extraction",
				check: (request) => {
					const context = JSON.stringify(request.context.messages);
					expect(context, "the words nothing answered are read").toContain(unansweredInstruction);
					expect(context, "words the save answered are not read").not.toContain(handled);
					expect(context, "steered words the save's context held are not read").not.toContain(steered);
					// The gate before the extraction has answered; only the judgment is held.
					world.systemOne.enterPhase(
						"routine-intake-unanswered-judgment",
						{
							explicit: { kind: "noul", probability: 0.98 },
							faithful: { kind: "noul", probability: 0.98 },
						},
						{ gate: judgmentRelease.promise, onAdmit: () => judgmentReached.release() },
					);
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: "routine-intake-unanswered-extraction",
							name: ROUTINE_INTAKE_SUBMISSION_TOOL_NAME,
							arguments: {
								messages: [
									{
										id: "m1",
										requests: [
											{
												instruction: unansweredInstruction,
												when: "Every evening",
												timing: { kind: "daily", partOfDay: "evening" },
											},
										],
									},
								],
							},
						},
					],
					stopReason: "toolUse",
				},
			},
			...(world.systemOne.enabled
				? []
				: [
						{
							...judgment,
							check: (request: ScriptedRequest) => {
								judgment.check?.(request);
								judgmentReached.release();
							},
							gate: judgmentRelease.promise,
						},
					]),
		);
		const beforeUnansweredPass = rootRequests();
		const decodedBeforeUnansweredPass = world.systemOne.decoded.length;
		expect(
			await withDeadline(
				world.trace,
				"routine intake after the tool save",
				world.timers.whenArmed("routine-intake"),
			),
		).toBe(2_000);
		expect(world.timers.advance("routine-intake", 2_000)).toBe(1);
		let rearmed: Promise<number> | undefined;
		try {
			await withDeadline(world.trace, "routine intake judgment held", judgmentReached.promise);
			// The pass starts past the call that fired its alarm and arms its deadline before it reaches the judgment; the
			// next alarm it arms after that is the one it leaves for the next pass.
			rearmed = world.timers.nextArmed("routine-intake");
			const moved = await withDeadline(
				world.trace,
				"routine intake owner moves back",
				root.session.navigateTree(beforeUnanswered, { summarize: false }),
			);
			expect(moved.cancelled, "the owner's move applies").toBe(false);
			expect(sourceOf(unanswered), "the request's words are off the branch").toBeUndefined();
		} finally {
			judgmentRelease.release();
		}
		expect(
			await withDeadline(
				world.trace,
				"routine intake pass left its request undecided",
				rearmed ?? Promise.reject(new Error("the pass never reached its judgment")),
			),
			"the pass completes and decides the request again on the next idle",
		).toBe(2_000);
		expect(
			intakeState()?.batch?.requests?.map((request) => request.outcome),
			"a judgment about words the owner moved away from is not recorded",
		).toEqual([undefined]);
		const automaticIds = () =>
			store()
				.listRoutines()
				.filter((entry) => entry.origin !== undefined)
				.map((entry) => entry.routineId);
		expect(automaticIds(), "the words the owner moved away from create no routine").toEqual([routine.routineId]);
		world.systemOne.enterPhase("routine-intake-moved-away", {});
		const passedOver = passEnded(4);
		expect(world.timers.advance("routine-intake", 2_000)).toBe(1);
		await withDeadline(world.trace, "routine intake passed the words the owner moved away from", passedOver);
		expect(automaticIds(), "steered, answered and abandoned words create no routine").toEqual([routine.routineId]);
		expect(notices(), "a request passed for a move is not noticed").toHaveLength(4);
		expect(
			rootRequests() - beforeUnansweredPass,
			"one extraction of the unanswered words; the session model judges only with System One off",
		).toBe(world.systemOne.enabled ? 1 : 2);
		expect(
			world.systemOne.decoded.length - decodedBeforeUnansweredPass,
			"System One gates and judges the unanswered words once",
		).toBe(world.systemOne.enabled ? 2 : 0);
		expect(intakeState()?.through, "the pass ends past the answered words").toBe(Date.parse(steeredSource.createdAt));
		expect(root.session.backgroundLanes.getRoutineIntakeStatus()?.last).toEqual({
			status: "completed",
			sources: 1,
			created: 0,
			refused: 0,
		});
		expect(world.timers.armedDelays("routine-intake"), "nothing is left to read").toEqual([]);

		// The owner removes the routine while the session is closed, and a stale copy of the first pass, retained before any
		// decision, is restored: the consumed origin creates nothing, and its drop notice, already saved, is not saved again.
		const replay = retained.batch!;
		const offlineStore = store();
		const file = root.sessionManager.getSessionFile()!;
		open = false;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		const removed = offlineStore.getRoutine(routine.routineId)!;
		expect(offlineStore.deleteRoutine(routine.routineId, removed.revision, world.timers.port("routines").now())).toBe(
			true,
		);
		offlineStore.recordRoutineIntake(parentSessionId, world.timers.port("routine-intake").now(), { batch: replay });
		world.systemOne.enterPhase("routine-intake-replay", {});
		const beforeReplay = rootRequests();
		root = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.openSessionManager(file, agentDir),
			settings,
		});
		open = true;
		const replayed = passEnded(4);
		expect(await withDeadline(world.trace, "replayed routine intake", world.timers.whenArmed("routine-intake"))).toBe(
			2_000,
		);
		expect(world.timers.advance("routine-intake", 2_000)).toBe(1);
		await withDeadline(world.trace, "replayed routine intake pass ended", replayed);
		expect(store().getRoutine(routine.routineId), "a removed routine is never recreated").toBeUndefined();
		expect(notices(), "a replay saves no notice twice").toHaveLength(4);
		expect(rootRequests(), "a decided request is not extracted or judged again").toBe(beforeReplay);
		expect(root.session.backgroundLanes.getRoutineIntakeStatus()?.last).toEqual({
			status: "completed",
			sources: 3,
			created: 0,
			refused: 0,
		});
		expect(world.timers.armedDelays("routine-intake")).toEqual([]);

		// The changelog routine was saved on the conversation the owner moved away from: while the owner stays away, its end
		// passes and this branch neither removes nor tells it. Once the owner returns to that conversation, the routine is
		// removed and the owner hears it once, with the next turn, without a run or a parent wake.
		expect(sourceOf(handled), "the reopened session is still away from the save").toBeUndefined();
		const completions = () =>
			root.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "routine-completion");
		expect(store().getRoutine("changelog-review")).toBeDefined();
		expect(completions()).toHaveLength(0);
		const expiryNoticed = new Promise<void>((resolve) => {
			const stop = root.sessionManager.onEntriesPersisted(() => {
				if (completions().length === 0) return;
				stop();
				resolve();
			});
		});
		world.timers.advance("routines", 3_600_000);
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(store().getRoutine("changelog-review"), "a branch away from the save does not end it").toBeDefined();
		expect(completions(), "nor tells its end").toHaveLength(0);
		const returned = await withDeadline(
			world.trace,
			"routine intake owner returns to the save",
			root.session.navigateTree(savedLeaf, { summarize: false }),
		);
		expect(returned.cancelled, "the owner's return applies").toBe(false);
		expect(sourceOf(handled), "the words that saved the routine are on the branch again").toBeDefined();
		await root.session.backgroundLanes.tickPersistentRoutines();
		await withDeadline(world.trace, "routine expiry notice", expiryNoticed);
		expect(store().getRoutine("changelog-review"), "an ended routine is removed").toBeUndefined();
		expect(completions(), "the end is announced once").toHaveLength(1);
		const expiry = completions()[0]!;
		const expiryText = expiry.type === "custom_message" && typeof expiry.content === "string" ? expiry.content : "";
		expect(expiryText).toContain("Routine changelog-review reached the end time it was saved with and was removed");
		expect(parentInputOf(expiry)?.metadata.mode, "the end waits for the owner's next turn").toBe("next-owner-turn");
		expect(root.sessionManager.getPendingParentInputs("turn")).toHaveLength(0);
		expect(
			store()
				.listRoutineOccurrences({ routineId: "changelog-review" })
				.map((occurrence) => occurrence.trigger.kind),
			"the routine ended without a run",
		).toEqual(["expiry"]);

		// A request meant only until something happens, stated in a fresh session of the same store whose workers run on a
		// pinned track: its run reports the stated end met, so once that result is delivered the host removes the routine,
		// tells the owner once with the next turn, and starts no later slot.
		open = false;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		root = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.createSessionManager(agentDir),
			settings: {
				...settings,
				workerDelegation: {
					modelPins: { default: { provider: HARNESS_PROVIDER, modelId: "worker-a", thinkingLevel: "off" } },
				},
			},
		});
		open = true;
		parentSessionId = root.sessionManager.getSessionId();
		const untilOwner = "Check the release tag every hour until the release ships.";
		const untilInstruction = "Check the release tag";
		world.systemOne.enterPhase("routine-intake-until-owner", {});
		world.provider.enqueue("root", text("routine-intake-until-owner-reply", "Noted."));
		await withDeadline(world.trace, "routine intake conditional request", root.session.prompt(untilOwner));
		expect(latestSource().text).toBe(untilOwner);
		world.systemOne.enterPhase("routine-intake-until-pass", {
			requests_automation: { kind: "noul", probability: 0.98 },
			explicit: { kind: "noul", probability: 0.98 },
			faithful: { kind: "noul", probability: 0.98 },
		});
		world.provider.enqueue(
			"root",
			{
				name: "routine-intake-until-extraction",
				reply: {
					content: [
						{
							type: "toolCall",
							id: "routine-intake-until-extraction",
							name: ROUTINE_INTAKE_SUBMISSION_TOOL_NAME,
							arguments: {
								messages: [
									{
										id: "m1",
										requests: [
											{
												instruction: untilInstruction,
												when: "every hour until the release ships",
												timing: { kind: "interval", every: 1, unit: "hour" },
												lasts: "until_condition",
											},
										],
									},
								],
							},
						},
					],
					stopReason: "toolUse",
				},
			},
			...(world.systemOne.enabled
				? []
				: [
						knowledgeJudgment(
							"routine-intake-until-judgment",
							"routine.intake",
							[
								{ id: "explicit", value: true, confidence: 0.98 },
								{ id: "faithful", value: true, confidence: 0.98 },
							],
							() => untilInstruction,
						),
					]),
		);
		const untilCreated = passEnded(1);
		expect(
			await withDeadline(world.trace, "conditional intake idle delay", world.timers.whenArmed("routine-intake")),
		).toBe(2_000);
		expect(world.timers.advance("routine-intake", 2_000)).toBe(1);
		await withDeadline(world.trace, "conditional intake pass created its routine", untilCreated);
		const conditional = store()
			.listRoutines()
			.find((entry) => entry.origin?.endCondition !== undefined);
		expect(conditional, "the conditional request becomes a routine").toBeDefined();
		const conditionalId = conditional!.routineId;
		const endCondition = conditional!.origin!.endCondition!;
		expect(endCondition, "the host keeps the end the owner stated, from their own words").toBe(
			"until the release ships",
		);
		expect(contentOf(notices()[0]), "the creation notice states the bound").toContain("for at most 14 days");
		expect(contentOf(notices()[0]), "and how a run ends it").toContain(
			"the routine ends once a run reports it reached",
		);
		const workerRequests = () => world.provider.requests.filter((request) => request.model.id === "worker-a").length;
		const conditionMetSummary = "The release tag exists and the release shipped.";
		world.systemOne.enterPhase("routine-intake-condition-run", {});
		world.provider.enqueue("worker-a", {
			...calls("routine-condition-report", [
				{
					id: "routine-condition-report",
					name: "submit_report",
					arguments: { status: "completed", summary: conditionMetSummary, conditionMet: true },
				},
			]),
			check: (request) => {
				const wire = JSON.stringify(request.context.messages);
				expect(wire, "the run carries the owner's words").toContain(untilInstruction);
				expect(wire, "the brief asks for the stated end truthfully").toContain("Report conditionMet truthfully");
			},
		});
		world.provider.enqueue("root", {
			...text("routine-condition-parent", "The release shipped."),
			check: (request) =>
				expect(JSON.stringify(request.context.messages), "the run's result wakes the parent").toContain(
					conditionMetSummary,
				),
		});
		const conditionNotices = () =>
			completions().filter((entry) => contentOf(entry).includes(" was reported met by "));
		const resultDelivered = new Promise<void>((resolve) => {
			const check = () => {
				// The creation notice still waits for the owner's next turn; only the woken turn must have taken the result.
				if (completions().length === 0 || root.sessionManager.getPendingParentInputs("turn").length !== 0) return;
				stop();
				resolve();
			};
			const stop = root.sessionManager.onEntriesPersisted(check);
		});
		const workerRequestsBeforeRun = workerRequests();
		world.timers.advance("routines", 3_600_000);
		await root.session.backgroundLanes.tickPersistentRoutines();
		await withDeadline(world.trace, "the conditional routine's result is delivered", resultDelivered);
		await withDeadline(world.trace, "the woken parent turn ends", root.session.agent.waitForIdle());
		const conditionNoticed = new Promise<void>((resolve) => {
			const check = () => {
				if (conditionNotices().length === 0) return;
				stop();
				resolve();
			};
			const stop = root.sessionManager.onEntriesPersisted(check);
			queueMicrotask(check);
		});
		// One pass acknowledges the taken result; the next removes the routine whose runs are then all settled.
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(
			store()
				.listRoutineOccurrences({ routineId: conditionalId })
				.find((occurrence) => occurrence.trigger.kind === "schedule")?.result?.delivery,
			"the woken turn's result is acknowledged",
		).toBe("acknowledged");
		await root.session.backgroundLanes.tickPersistentRoutines();
		await withDeadline(world.trace, "the reported end is noticed", conditionNoticed);
		expect(workerRequests(), "one run reported the end").toBe(workerRequestsBeforeRun + 1);
		expect(
			store().getRoutine(conditionalId),
			"a routine whose run reported its stated end is removed",
		).toBeUndefined();
		expect(conditionNotices(), "the end is told once").toHaveLength(1);
		const conditionNotice = conditionNotices()[0]!;
		expect(contentOf(conditionNotice)).toContain(
			`Routine ${conditionalId} ended: ${JSON.stringify(endCondition)} was reported met by its run `,
		);
		expect(parentInputOf(conditionNotice)?.metadata.mode, "the end waits for the owner's next turn").toBe(
			"next-owner-turn",
		);
		expect(root.sessionManager.getPendingParentInputs("turn"), "the end wakes no turn").toHaveLength(0);
		const conditionOccurrences = () => store().listRoutineOccurrences({ routineId: conditionalId });
		expect(
			conditionOccurrences()
				.map((occurrence) => occurrence.trigger.kind)
				.sort(),
			"one run and one end notice",
		).toEqual(["condition", "schedule"]);
		expect(
			conditionOccurrences().find((occurrence) => occurrence.trigger.kind === "schedule")?.result,
			"the delivered result keeps the reported end",
		).toMatchObject({ outcome: "succeeded", conditionMet: true, delivery: "acknowledged" });
		// The next slot passes: nothing runs and nothing more is told.
		world.timers.advance("routines", 3_600_000);
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(workerRequests(), "no run starts after the end was reported").toBe(workerRequestsBeforeRun + 1);
		expect(conditionOccurrences(), "no slot is taken after the end").toHaveLength(2);
		expect(conditionNotices(), "the end is not told again").toHaveLength(1);
		world.trace.mark("root", "routine.owner-intake");
	} finally {
		if (open) {
			open = false;
			expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		}
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
}
