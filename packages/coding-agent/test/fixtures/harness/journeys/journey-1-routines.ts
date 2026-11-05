import { createHash } from "node:crypto";
import { expect } from "vitest";
import { captureWorkerReceiptOrigin } from "../../../../src/core/delegation/worker-receipt-origin.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { MAX_ROUTINE_INSTANT_MS } from "../../../../src/core/routines/routine-contract.ts";
import { parentInputMessage, parentInputOf } from "../../../../src/kernel/session/parent-input-ledger.ts";
import { calls, createBarrier, type ScriptedRequest, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, icmContinuousSettings, latestBatchResults } from "./shared.ts";

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
	const workerReply = (label: string, expectedPrompt: string, gate?: Promise<void>, onEntered?: () => void) => ({
		...calls(`${label}-report`, [
			{
				id: `${label}-report`,
				name: "submit_report",
				arguments: { status: "completed", summary: `${label} completed.` },
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
		world.provider.enqueue("root", {
			...text("routine-uncertain-parent", "The scheduled result is currently uncertain."),
			check: (request) => expect(JSON.stringify(request.context.messages)).toContain(uncertainty),
		});
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
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(occurrences()[0]?.phase).toBe("uncertain");
		expect(occurrences()[0]?.result?.delivery).toBe("acknowledged");
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
		world.provider.enqueue("worker-a", workerReply("scheduled-routine", replacement));
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
		const beforeDaemon = store().getRoutine(routineId)!;
		world.timers.advance("routines", 60_000);
		expect(store().queueDueRoutinesForDaemon(world.timers.port("routines").now())).toBe(1);
		expect(store().getRoutine(routineId)?.nextRunAt, "the daemon leaves due-time ownership with the scheduler").toBe(
			at,
		);
		expect(store().getRoutine(routineId)?.revision, "a daemon observation does not edit saved intent").toBe(
			beforeDaemon.revision,
		);
		await withDeadline(world.trace, "scheduled routine parent wake settled", scheduledSettled);
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(occurrences()).toHaveLength(2);
		expect(occurrences().every((entry) => entry.result?.delivery === "acknowledged")).toBe(true);
		expect(occurrences().filter((entry) => entry.trigger.kind === "schedule")).toHaveLength(1);
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
		const recycledId = "recreated-review";
		const recycledInput = {
			routineId: recycledId,
			prompt: original,
			schedule: { kind: "once", at: world.timers.port("routines").now() + 300_000 },
			profileId: profile.profileId,
		};
		await command("routine-recycle-create", { action: "create", ...recycledInput });
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
		// Model a process stopping immediately after its durable claim, before dispatch.
		// An explicit manual run remains recoverable even while its schedule is paused.
		const interrupted = offlineStore.claimManualRoutineOccurrence({
			routineId: recycledId,
			expectedRevision: paused.revision,
			parentSessionId: root.sessionManager.getSessionId(),
			receiptOrigin: paused.executionSnapshot!.savedIntent.receiptOrigin,
			commandId: "paused-manual-recovery",
			owner: "terminated-routine-owner",
			nowMs: world.timers.port("routines").now(),
			leaseMs: 120_000,
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
		const recoveredSettled = parentSettled(6);
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
		expect(occurrences(), "reopening cannot repeat a consumed one-off").toHaveLength(4);
		expect(parentInputs(), "only the recovered manual run adds a new parent input").toHaveLength(6);
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
		await withDeadline(world.trace, "all recovered parent input batches settled", parentSettled(39));
		expect(world.provider.requests.filter((request) => request.model.id !== "worker-c")).toHaveLength(requests + 4);
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		root = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.openSessionManager(file, agentDir),
			settings,
		});
		await root.session.backgroundLanes.tickPersistentRoutines();
		expect(parentInputs(), "recovered inputs retain their original canonical identity").toHaveLength(39);
		expect(root.sessionManager.getPendingParentInputs()).toHaveLength(0);
		expect(world.provider.requests.filter((request) => request.model.id !== "worker-c")).toHaveLength(requests + 4);
		world.trace.mark("root", "routine.native-durable-delivery");
	} finally {
		release.release();
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		await world.provider.waitForProducers();
		for (const track of tracks) world.provider.retireOptional(track);
	}
}
