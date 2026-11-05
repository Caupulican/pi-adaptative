import { createHash } from "node:crypto";
import { expect } from "vitest";
import { resolveSemanticUsageEntry } from "../../../../src/core/cost/usage-records.ts";
import {
	appendWorkerClaimSnapshot,
	getWorkerClaimSnapshotForAttempt,
	getWorkerClaimSnapshots,
	WORKER_CLAIM_CUSTOM_TYPE,
	type WorkerClaimSnapshotPayload,
} from "../../../../src/core/delegation/session-worker-claim.ts";
import { WorkerLifecycle } from "../../../../src/core/delegation/worker-lifecycle.ts";
import { captureWorkerReceiptOrigin } from "../../../../src/core/delegation/worker-receipt-origin.ts";
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
import {
	MAX_ROUTINE_INSTANT_MS,
	type RoutineIntakeBatch,
	routineScheduleInputOf,
} from "../../../../src/core/routines/routine-contract.ts";
import { ROUTINE_INTAKE_SUBMISSION_TOOL_NAME } from "../../../../src/core/routines/routine-intake-extractor.ts";
import type { SessionManager } from "../../../../src/kernel/node.ts";
import { parentInputMessage, parentInputOf } from "../../../../src/kernel/session/parent-input-ledger.ts";
import { calls, createBarrier, HARNESS_PROVIDER, type ScriptedRequest, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, icmContinuousSettings, knowledgeJudgment, latestBatchResults } from "./shared.ts";

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
	const settings = icmContinuousSettings("worker-c", {
		autoLearn: { enabled: false },
		proactivity: { enabled: false },
	});
	let root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings,
	});
	const tracks: string[] = [];
	for (let size = 1; size <= 128; size *= 2)
		for (let first = 0; first + size <= 128; first += size) {
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
	const command = async (label: string, input: Record<string, unknown>, error = false, callId = label) => {
		const classified: string[] = [];
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
			},
		});
		await withDeadline(world.trace, label, root.session.prompt(`Apply the ${label} routine command.`));
		if (label === "routine-invalid-interval" && world.systemOne.enabled)
			expect(classified, "the rejected arguments leave owner words for the next executable command").toEqual([
				"Apply the routine-forged-target routine command.",
				"Apply the routine-invalid-interval routine command.",
			]);
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
	) => ({
		...calls(`${label}-report`, [
			{
				id: `${label}-report`,
				name: "submit_report",
				arguments: { status: "completed", summary: `${label} completed.`, ...(ownerUpdate ? { ownerUpdate } : {}) },
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
		// The turn this result opens cannot extend the automation that woke it: a create is refused before admission.
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
				]),
				check: (request) => expect(JSON.stringify(request.context.messages)).toContain(uncertainty),
			},
			{
				...text("routine-uncertain-parent", "The scheduled result is currently uncertain."),
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
					expect(result?.isError, result?.text).toBe(true);
					expect(result?.text).toContain("The owner has not spoken in this turn");
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
		await withDeadline(world.trace, "all recovered parent input batches settled", parentSettled(40));
		expect(world.provider.requests.filter((request) => request.model.id !== "worker-c")).toHaveLength(requests + 4);
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
			agentDir,
			sessionId: awayManager.getSessionId(),
			store: new OrchestrationEventStore({
				agentDir,
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
		world.trace.mark("root", "routine.native-durable-delivery");
	} finally {
		release.release();
		scheduledRelease.release();
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
	await runJourney1RoutineIntake(world, profile);
}

/**
 * Hands-off intake through the real root: after the turn settles, the owner's stated request becomes a read-only
 * routine on host-compiled timing, announced on the next turn with the hour and days the host chose, while a pasted
 * request and an hour the owner's quoted timing words do not carry are never judged. Words the model already answered
 * with a routine save are passed over unread, and a pass replayed after the owner removed its routine creates nothing.
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
	for (let size = 1; size <= 16; size *= 2)
		for (let first = 0; first + size <= 16; first += size) {
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
	const parentSessionId = root.sessionManager.getSessionId();
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
	try {
		world.systemOne.enterPhase("routine-intake-owner", {});
		world.provider.enqueue("root", text("routine-intake-owner-reply", "Noted."));
		await withDeadline(world.trace, "routine intake owner words", root.session.prompt(owner));
		const source = latestSource();
		expect(source.text).toBe(owner);
		// A second request before the pass: its proposed hour is absent from the timing words the model quoted.
		world.systemOne.enterPhase("routine-intake-second-owner", {
			...ICM_INTAKE_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue("root", text("routine-intake-second-owner-reply", "Noted."));
		await withDeadline(world.trace, "routine intake second owner words", root.session.prompt(unstatedHour));
		const second = latestSource();
		expect(second.text).toBe(unstatedHour);

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
											// A part of the day without a time: the host chooses the hour and the days, and says so.
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
											// The quoted timing words lack the hour: the host drops it before any judgment.
											{
												instruction: "Post the build summary",
												when: "every evening",
												timing: { kind: "daily", time: "19:00" },
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
			if (!retained.batch && batch?.requests && batch.requests.every((request) => request.done !== true))
				retained.batch = batch;
		});
		const beforePass = rootRequests();
		const decodedBeforePass = world.systemOne.decoded.length;
		const created = passEnded(1);
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
		const hostDefaults = ['09:00 for "morning"', "weekdays only, as no days were stated"];
		expect(
			routineScheduleInputOf(routine.schedule),
			"the host compiles the stated part of the day to its fixed hour on weekdays, with a start window",
		).toMatchObject({ kind: "calendar", cron: "0 9 * * 1-5", maxLatenessMs: 1_800_000 });
		expect(routine.origin?.defaults, "the origin records what the host chose").toEqual(hostDefaults);
		expect(
			routine.executionSnapshot?.savedIntent.executionContract.worker.profile.readOnly,
			"intake grants no write authority",
		).toBe(true);
		expect(
			retained.batch?.requests?.map((request) => request.prompt),
			"neither the pasted request nor the hour its words do not carry is retained",
		).toEqual([instruction]);
		expect(store().hasRoutineIntakeOrigin(retained.batch!.requests![0]!.key)).toBe(true);
		expect(intakeState()?.through, "the pass ends at the last source it read").toBe(Date.parse(second.createdAt));
		const notice = notices()[0]!;
		const content = notice.type === "custom_message" && typeof notice.content === "string" ? notice.content : "";
		expect(content).toContain("Scheduled (read-only): weekdays at 09:00 (");
		expect(content).toContain(` - ${JSON.stringify(instruction)}\nRoutine ${routine.routineId} was created`);
		expect(content, "the notice names every host choice").toContain(`so the host chose: ${hostDefaults.join("; ")}.`);
		expect(parentInputOf(notice)?.metadata.mode, "the notice waits for the owner's next turn").toBe(
			"next-owner-turn",
		);
		expect(root.sessionManager.getPendingParentInputs("turn"), "a notice never wakes the parent").toHaveLength(0);
		const providerRequests = world.systemOne.enabled ? 1 : 2;
		expect(rootRequests() - beforePass, "one extraction; the session model judges only with System One off").toBe(
			providerRequests,
		);
		expect(
			world.systemOne.decoded.length - decodedBeforePass,
			"System One gates both sources and judges only the grounded request",
		).toBe(world.systemOne.enabled ? 3 : 0);
		const receipts = root.sessionManager.getEntries().flatMap((entry) => {
			const report = resolveSemanticUsageEntry(entry)?.report;
			return report?.route === "routine_intake" ? [report] : [];
		});
		expect(receipts, "every intake request is accounted to the pass").toHaveLength(providerRequests);
		for (const receipt of receipts) expect(receipt.origin?.operationId).toBe(retained.batch?.operationId);
		expect(root.session.backgroundLanes.getRoutineIntakeStatus()).toMatchObject({
			state: "active",
			...(world.systemOne.enabled ? {} : { judge: `structured-llm (${HARNESS_PROVIDER}/root)` }),
			last: { status: "completed", sources: 2, created: 1, refused: 0 },
		});

		// The model answers the next request with a routine save; intake passes those words over unread.
		const handled = "Also check the changelog every day.";
		world.systemOne.enterPhase("routine-intake-tool-save", {
			...ICM_INTAKE_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.02 },
		});
		world.provider.enqueue(
			"root",
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
					expect(JSON.stringify(request.context.messages), "the notice reaches the owner's next turn").toContain(
						"Scheduled (read-only): ",
					),
			},
			{
				...text("routine-intake-tool-save-done", "The changelog routine is saved."),
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
					expect(result?.isError, result?.text).toBe(false);
				},
			},
		);
		await withDeadline(world.trace, "routine intake tool save", root.session.prompt(handled));
		const toolSource = latestSource();
		expect(toolSource.text).toBe(handled);
		expect(store().getRoutine("changelog-review")).toBeDefined();
		world.systemOne.enterPhase("routine-intake-handled", {});
		const beforeHandled = rootRequests();
		expect(
			await withDeadline(
				world.trace,
				"routine intake after the tool save",
				world.timers.whenArmed("routine-intake"),
			),
		).toBe(2_000);
		// A pass with nothing to read ends before its first await.
		expect(world.timers.advance("routine-intake", 2_000)).toBe(1);
		expect(intakeState()?.through, "words the model answered with a routine save are not read").toBe(
			Date.parse(toolSource.createdAt),
		);
		expect(intakeState()?.batch).toBeUndefined();
		expect(rootRequests()).toBe(beforeHandled);
		expect(world.timers.armedDelays("routine-intake"), "nothing is left to read").toEqual([]);

		// The owner removes the routine while the session is closed, and the first pass is replayed as a stop between its
		// creation and its done mark leaves it: the consumed origin creates and announces nothing.
		const replay = retained.batch!;
		const offlineStore = store();
		const file = root.sessionManager.getSessionFile()!;
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		open = false;
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
		const replayed = passEnded(1);
		expect(await withDeadline(world.trace, "replayed routine intake", world.timers.whenArmed("routine-intake"))).toBe(
			2_000,
		);
		expect(world.timers.advance("routine-intake", 2_000)).toBe(1);
		await withDeadline(world.trace, "replayed routine intake pass ended", replayed);
		expect(store().getRoutine(routine.routineId), "a removed routine is never recreated").toBeUndefined();
		expect(notices(), "a replay announces nothing").toHaveLength(1);
		expect(rootRequests(), "a decided request is not extracted or judged again").toBe(beforeReplay);
		expect(root.session.backgroundLanes.getRoutineIntakeStatus()?.last).toEqual({
			status: "completed",
			sources: 2,
			created: 0,
			refused: 0,
		});
		expect(world.timers.armedDelays("routine-intake")).toEqual([]);

		// Once the routine clock passes the changelog routine's end, the routine is removed and the owner hears it once,
		// with the next turn, without a run or a parent wake.
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
		world.trace.mark("root", "routine.owner-intake");
	} finally {
		if (open) expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
}
