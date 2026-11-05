import { expect } from "vitest";
import {
	type CiAttemptTerminalEvent,
	type CiSubject,
	ciThreadKey,
	type HostEventSubscriptionInput,
} from "../../../../src/core/events/host-event-contract.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import type { TaskRuntimeProjection } from "../../../../src/core/orchestration/task-runtime-state.ts";
import { createCiHostRuntime } from "../../../../src/host/ci/ci-host-event-source.ts";
import type { CiProvider } from "../../../../src/host/ci/ci-provider.ts";
import type { CiSourceStore } from "../../../../src/host/ci/ci-source-store.ts";
import type { CiGitPaths } from "../../../../src/host/ci/ci-status-record.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { latestBatchResults } from "./shared.ts";

/** Real task admission, worker mailbox consumption, narrowed tools and reusable-worker isolation. */
export async function runJourney1HostEventWorkersPhase(
	world: HarnessWorld,
	input: {
		readonly subject: CiSubject;
		readonly event: CiAttemptTerminalEvent;
		readonly paths: CiGitPaths;
		readonly provider: CiProvider;
		readonly store: CiSourceStore;
	},
): Promise<void> {
	const agentDir = `${world.agentDir}-host-event-workers`;
	const profiles = new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false });
	const profile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "event-reader-a",
		description: "Read-only task event reader.",
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
	profiles.save(profile, "global");
	profiles.save(
		{
			...profile,
			profileId: "event-reader-b",
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: "harness-script", modelId: "worker-b", thinkingLevel: "off" }],
			},
		},
		"global",
	);
	const root = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		systemOneEnabled: false,
		settings: { memorySystem: "okf", autoLearn: { enabled: false }, proactivity: { enabled: true } },
	});
	const abort = new AbortController();
	const binding = root.session.backgroundLanes.openHostEventSession(abort.signal);
	const diagnostics: string[] = [];
	const source = await createCiHostRuntime({
		cwd: HARNESS_PROJECT_CWD,
		paths: input.paths,
		provider: input.provider,
		store: input.store,
		onDiagnostic: (message) => diagnostics.push(message),
		getSubscribedSubjects: () => root.session.backgroundLanes.getHostEventSubjects(),
		subscribeSubjects: (listener) => root.session.backgroundLanes.subscribeOrchestrationStore(listener),
	});
	if (!source) throw new Error("Worker event source did not open.");
	const subscription: HostEventSubscriptionInput = {
		threadKey: ciThreadKey(input.subject),
		subject: input.subject,
		wake: "never",
	};
	const ready = createBarrier();
	const workerAReached = createBarrier();
	const workerBReached = createBarrier();
	const releaseWorkers = createBarrier();
	const workerBConsumed = createBarrier();
	const reuseReady = createBarrier();
	const reuseRelease = createBarrier();
	let prompt: Promise<void> | undefined;
	let agentA: string | undefined;
	let agentB: string | undefined;
	let taskA: string | undefined;
	let taskB: string | undefined;
	const snapshot = () => root.session.backgroundLanes.getTaskRuntimeSnapshot()!;
	const awaitState = (predicate: (state: TaskRuntimeProjection) => boolean) =>
		new Promise<void>((resolve) => {
			const check = () => {
				if (!predicate(snapshot())) return;
				off();
				resolve();
			};
			const off = root.session.backgroundLanes.subscribeOrchestrationStore(check);
			check();
		});
	const report = (id: string) =>
		calls(id, [
			{
				id,
				name: "submit_report",
				arguments: { status: "completed", summary: "Inspected this task's CI evidence." },
			},
		]);
	try {
		world.provider.enqueue(
			"root",
			calls("event-workers-start-a", [
				{
					id: "event-start-a",
					name: "delegate",
					arguments: {
						action: "start",
						profileId: profile.profileId,
						instructions: "Inspect the subscribed CI evidence and report without changing files.",
						subscriptions: [subscription],
					},
				},
			]),
			{
				name: "event-workers-start-b",
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					expect(result?.isError, result?.text).toBe(false);
					const attempt = Object.values(snapshot().attempts).find((attempt) => attempt.status === "running")!;
					agentA = attempt.agentId;
					taskA = attempt.taskId;
					expect(attempt.dispatch.subscriptions).toEqual([subscription]);
				},
				reply: () => ({
					content: [
						{
							type: "toolCall",
							id: "event-start-b",
							name: "delegate",
							arguments: {
								action: "start",
								profileId: "event-reader-b",
								instructions:
									"Independently inspect the subscribed CI evidence and report without changing files.",
								subscriptions: [subscription],
								parallelWork: { independentOf: [agentA], justification: "Independent read-only assessment." },
							},
						},
					],
					stopReason: "toolUse",
				}),
			},
			{
				name: "event-workers-wait",
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					expect(result?.isError, result?.text).toBe(false);
					const attempt = Object.values(snapshot().attempts).find(
						(attempt) => attempt.status === "running" && attempt.agentId !== agentA,
					)!;
					agentB = attempt.agentId;
					taskB = attempt.taskId;
					expect(attempt.dispatch.subscriptions).toEqual([subscription]);
					ready.release();
				},
				reply: () => ({
					content: [
						{
							type: "toolCall",
							id: "event-workers-wait",
							name: "delegate",
							arguments: { action: "wait", agentIds: [agentA, agentB], mode: "all", timeoutMs: 60_000 },
						},
					],
					stopReason: "toolUse",
				}),
			},
			text("event-workers-done", "Both event readers have reported."),
		);
		for (const model of ["worker-a", "worker-b"] as const) {
			world.provider.enqueue(model, {
				name: `${model}-event-held`,
				gate: releaseWorkers.promise,
				check: (request) => {
					expect(request.context.tools?.map((tool) => tool.name)).toContain("task_events");
					expect(request.context.tools?.map((tool) => tool.name)).not.toContain("delegate");
					expect(JSON.stringify(request.context.messages)).not.toContain(input.event.eventId);
					(model === "worker-a" ? workerAReached : workerBReached).release();
				},
				reply: calls(`${model}-event-read`, [
					{
						id: `${model}-event-read`,
						name: "task_events",
						arguments: { action: "events", eventId: input.event.eventId },
					},
				]).reply,
			});
		}
		world.provider.enqueue("worker-b", {
			name: "event-worker-b-consumed",
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "task_events");
				expect(result?.isError, result?.text).toBe(false);
				expect(result?.text).toContain(input.event.eventId);
				expect(JSON.stringify(request.context.messages)).toContain("no new owner instruction");
				workerBConsumed.release();
			},
			reply: report("event-worker-b-report").reply,
		});
		const otherSubject = { ...input.subject, headSha: "b".repeat(40) };
		world.provider.enqueue(
			"worker-a",
			{
				name: "event-worker-a-consumed",
				gate: workerBConsumed.promise,
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "task_events");
					expect(result?.isError, result?.text).toBe(false);
					expect(result?.text).toContain(input.event.eventId);
					expect(JSON.stringify(request.context.messages)).toContain("no new owner instruction");
				},
				reply: calls("event-worker-widen", [
					{
						id: "event-worker-widen",
						name: "task_events",
						arguments: {
							action: "subscriptions",
							expectedRevision: 1,
							subscriptions: [
								{ threadKey: ciThreadKey(otherSubject), subject: otherSubject, wake: "resume_same_task" },
							],
						},
					},
				]).reply,
			},
			{
				name: "event-worker-widen-refused",
				check: (request) =>
					expect(latestBatchResults(request).find((entry) => entry.toolName === "task_events")?.isError).toBe(
						true,
					),
				reply: calls("event-worker-revoke", [
					{
						id: "event-worker-revoke",
						name: "task_events",
						arguments: { action: "subscriptions", expectedRevision: 1, subscriptions: [] },
					},
				]).reply,
			},
			{
				name: "event-worker-revoked",
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "task_events");
					expect(result?.isError, result?.text).toBe(false);
					expect(result?.text).toContain('"subscriptions":[]');
				},
				reply: report("event-worker-a-report").reply,
			},
		);
		prompt = root.session.prompt("Have two independent workers inspect the same subscribed CI subject.");
		await withDeadline(
			world.trace,
			"event workers admitted and running",
			Promise.all([ready.promise, workerAReached.promise, workerBReached.promise]),
		);
		const queued = awaitState((state) => {
			const event = state.hostEvents[input.event.eventId];
			return Boolean(
				event &&
					event.deliveryIds.filter(
						(id) => state.eventDeliveries[id].target.kind === "task" && state.eventDeliveries[id].mailboxAccepted,
					).length === 2,
			);
		});
		await source.source.start(binding.sink);
		await withDeadline(world.trace, "one CI occurrence reaches both admitted mailboxes", queued);
		expect(Object.keys(snapshot().tasks)).toHaveLength(2);
		releaseWorkers.release();
		await withDeadline(world.trace, "both workers consume and report", prompt);
		prompt = undefined;
		await source.source.stop();
		const deliveries = Object.values(snapshot().eventDeliveries).filter(
			(delivery) => delivery.eventId === input.event.eventId && delivery.target.kind === "task",
		);
		expect(deliveries).toHaveLength(2);
		expect(
			deliveries.every(
				(delivery) => delivery.status === "consumed" && delivery.transcriptReceipt && delivery.mailboxSettled,
			),
		).toBe(true);
		expect(new Set(deliveries.map((delivery) => delivery.transcriptReceipt!.taskId))).toEqual(
			new Set([taskA, taskB]),
		);
		expect(
			root.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "host-event"),
		).toEqual([]);

		// Reusing the physical specialist creates another task with no inherited subscriptions or event deliveries.
		world.provider.enqueue(
			"root",
			calls("event-worker-reuse", [
				{
					id: "event-worker-reuse",
					name: "delegate",
					arguments: {
						action: "start",
						agentId: agentA,
						instructions: "Inspect this new task's event scope and report.",
					},
				},
			]),
			{
				name: "event-worker-reuse-wait",
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
					expect(result?.isError, result?.text).toBe(false);
					const attempt = Object.values(snapshot().attempts).find(
						(attempt) => attempt.agentId === agentA && attempt.status === "running",
					)!;
					expect(attempt.taskId).not.toBe(taskA);
					expect(attempt.dispatch.subscriptions ?? []).toEqual([]);
					reuseReady.release();
				},
				reply: calls("event-worker-reuse-wait", [
					{
						id: "event-worker-reuse-wait",
						name: "delegate",
						arguments: { action: "wait", agentId: agentA, timeoutMs: 60_000 },
					},
				]).reply,
			},
			text("event-worker-reuse-done", "The reused specialist has an independent task scope."),
		);
		world.provider.enqueue(
			"worker-a",
			{
				name: "event-worker-reuse-held",
				gate: reuseRelease.promise,
				reply: calls("event-worker-reuse-reads", [
					{ id: "event-worker-reuse-subscriptions", name: "task_events", arguments: { action: "subscriptions" } },
					{ id: "event-worker-reuse-events", name: "task_events", arguments: { action: "events" } },
				]).reply,
			},
			{
				name: "event-worker-reuse-empty",
				check: (request) => {
					const results = latestBatchResults(request).filter((entry) => entry.toolName === "task_events");
					expect(results).toHaveLength(2);
					for (const result of results) {
						expect(result.isError, result.text).toBe(false);
						expect(result.text).toContain('"total":0');
					}
				},
				reply: report("event-worker-reuse-report").reply,
			},
		);
		prompt = root.session.prompt("Reuse the first specialist for a new task without CI subscriptions.");
		await withDeadline(world.trace, "new task admitted on reused specialist", reuseReady.promise);
		const resealed = createBarrier();
		await source.source.start({
			...binding.sink,
			seal: async (seal, signal) => {
				await binding.sink.seal(seal, signal);
				resealed.release();
			},
		});
		await withDeadline(world.trace, "retained CI replay after worker reuse", resealed.promise);
		reuseRelease.release();
		await withDeadline(world.trace, "reused specialist reads empty event scope", prompt);
		prompt = undefined;
		expect(
			Object.values(snapshot().eventDeliveries).filter((delivery) => delivery.target.kind === "task"),
		).toHaveLength(2);
		expect(diagnostics).toEqual([]);
	} finally {
		releaseWorkers.release();
		workerBConsumed.release();
		reuseRelease.release();
		abort.abort();
		await source.source.stop();
		await binding.close();
		if (prompt) await prompt.catch(() => undefined);
		expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
		await world.provider.waitForProducers();
	}
	world.trace.mark("root", "host-events.workers-done");
}
