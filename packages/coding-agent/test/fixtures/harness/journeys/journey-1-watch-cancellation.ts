import "../builtin-install.ts";
import { join, sep } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, latestBatchResults } from "./shared.ts";

const PROFILE_ID = "watch-cancellation-reader";

/** A real routine watch is canceled during its glob scan; shutdown joins it before a later watch runs. */
export async function runJourney1WatchCancellationPhase(world: HarnessWorld): Promise<void> {
	const makeProfile = (agentDir: string) =>
		new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(
			{
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				profileId: PROFILE_ID,
				description: "Read-only file-watch worker.",
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
			},
			"global",
		);
	const createSession = async (label: string) => {
		const agentDir = `${world.agentDir}-watch-cancel-${label}`;
		makeProfile(agentDir);
		const sessionManager = world.createSessionManager(agentDir);
		const { session } = await world.createRootSession("root", {
			agentDir,
			sessionManager,
			settings: {
				autoLearn: { enabled: false },
				proactivity: { enabled: false },
				orchestrator: { delegationGate: false },
			},
		});
		return { session, sessionManager };
	};
	const saveWatch = async (
		session: AgentSession,
		routineId: string,
		pattern: string,
		label: string,
	): Promise<void> => {
		const saved = createBarrier();
		let resultText = "";
		world.systemOne.enterPhase(label, ICM_INTAKE_JUDGMENTS);
		world.provider.enqueue(
			"root",
			calls(`${label}-create-call`, [
				{
					id: `${label}-create`,
					name: "routine",
					arguments: {
						action: "create",
						routineId,
						prompt: "Inspect the watched files and report whether they changed.",
						schedule: {
							kind: "event",
							source: "watch",
							condition: { type: "file", path: pattern, on: "changed" },
						},
						profileId: PROFILE_ID,
					},
				},
			]),
			{
				name: `${label}-create-answer`,
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
					expect(result?.isError, result?.text).toBe(false);
					resultText = result?.text ?? "";
					saved.release();
				},
				reply: { content: [{ type: "text", text: "The file watch is saved." }] },
			},
		);
		await withDeadline(
			world.trace,
			`${label} owner saves the watch`,
			session.prompt("Tell me when these files change."),
		);
		await withDeadline(world.trace, `${label} watch is accepted`, saved.promise);
		await withDeadline(world.trace, `${label} owner turn settles`, session.waitForForegroundIdle());
		expect(resultText).toContain("watching");
	};
	const watchState = (session: AgentSession, routineId: string) =>
		session.backgroundLanes.getBotTeamStore().getRoutine(routineId)?.cursor;
	const waitForBaseline = async (session: AgentSession, routineId: string, label: string): Promise<void> => {
		await withDeadline(
			world.trace,
			`${label} watch records its real glob baseline`,
			world.io.waitForMutation(() => {
				const cursor = watchState(session, routineId);
				return cursor?.kind === "watch" && cursor.state !== undefined;
			}),
		);
	};

	const cancelled = await createSession("cancelled");
	const cancelledRoot = projectPath("watch-cancel-tree");
	const cancelledNested = join(cancelledRoot, "nested");
	const cancelledPattern = join(cancelledRoot, "**", "*.txt");
	world.io.mkdirSync(cancelledNested, { recursive: true });
	world.io.writeFileSync(join(cancelledRoot, "root.txt"), "baseline\n");
	world.io.writeFileSync(join(cancelledNested, "child.txt"), "baseline\n");
	const heldRead = world.io.holdNext({
		name: "watch-cancel-in-flight-glob-readdir",
		kind: "readdir",
		matches: (operation) => operation.path === cancelledRoot,
	});
	const readdirReturned = createBarrier();
	const readdirCallbackReturned = createBarrier();
	let watcherClosed = false;
	const watcherClosedBarrier = createBarrier();
	let descendantDenial: { readonly hits: number; clear(): number } | undefined;
	let cancellation: Promise<{ readonly error: unknown } | undefined> | undefined;
	let cancelledSessionOwned = true;
	try {
		await saveWatch(cancelled.session, "watch-cancel-inflight", cancelledPattern, "watch-cancel-inflight");
		await withDeadline(world.trace, "glob enters its actual asynchronous readdir", heldRead.reached);
		world.io.observeNext({
			name: "watch-cancel-readdir-completed",
			kind: "readdir",
			phase: "after",
			matches: (operation) => operation.path === cancelledRoot,
			onMatch: () => readdirReturned.release(),
		});
		world.io.observeNext({
			name: "watch-cancel-readdir-callback-completed",
			kind: "readdir.callback",
			phase: "after",
			matches: (operation) => operation.path === cancelledRoot,
			onMatch: () => readdirCallbackReturned.release(),
		});
		world.io.observeNext({
			name: "watch-cancel-monitor-closed",
			kind: "watch.close",
			matches: (operation) => operation.path === cancelledRoot,
			onMatch: () => {
				watcherClosed = true;
				watcherClosedBarrier.release();
			},
		});
		const requestsBeforeCancel = world.provider.requests.length;
		cancellation = world.disposeSessionInBody(cancelled.session);
		await withDeadline(world.trace, "session shutdown disarms the held glob watch", watcherClosedBarrier.promise);
		const descendantPrefix = cancelledNested + sep;
		const readsAfterCancel = world.io.operations.length;
		descendantDenial = world.io.denyUntilCleared({
			name: "no-recursive-glob-read-after-watch-cancel",
			kind: "readdir",
			matches: (operation) => operation.path === cancelledNested || operation.path.startsWith(descendantPrefix),
		});
		heldRead.release();
		await withDeadline(world.trace, "the held filesystem enumeration returns", readdirReturned.promise);
		await withDeadline(
			world.trace,
			"the actual glob readdir callback returns after cancellation",
			readdirCallbackReturned.promise,
		);
		const disposal = await withDeadline(world.trace, "shutdown joins the canceled glob observation", cancellation);
		cancelledSessionOwned = false;
		expect(disposal, "the real session shutdown completes after the observation settles").toBeUndefined();
		expect(watcherClosed, "shutdown closed the watched directory handle").toBe(true);
		expect(descendantDenial.hits, "aborted glob does not continue into nested directories").toBe(0);
		expect(
			world.io.operations
				.slice(readsAfterCancel)
				.filter(
					(operation) =>
						operation.kind === "readdir" &&
						(operation.path === cancelledRoot || operation.path.startsWith(cancelledRoot + sep)),
				),
			"only the already-issued root read returns after cancellation; no descendant enumeration follows",
		).toEqual([{ kind: "readdir", path: cancelledRoot }]);
		expect(
			cancelled.session.backgroundLanes
				.getBotTeamStore()
				.listRoutineOccurrences({ routineId: "watch-cancel-inflight" }),
			"a canceled baseline creates no routine occurrence or wake",
		).toEqual([]);
		expect(world.provider.requests.length, "a canceled baseline starts no worker or model request").toBe(
			requestsBeforeCancel,
		);
		expect(
			world.io.getWatcherSnapshot().some((watcher) => watcher.path === cancelledRoot),
			"the watch handle is closed",
		).toBe(false);
	} finally {
		heldRead.release();
		if (cancellation) {
			await cancellation;
			cancelledSessionOwned = false;
		}
		if (cancelledSessionOwned) await world.disposeSessionInBody(cancelled.session);
		if (descendantDenial) descendantDenial.clear();
	}

	// The second directory watcher fails after the first has opened. Its first handle must still close.
	const partial = await createSession("partial-arm");
	let partialOwned = true;
	try {
		const parent = projectPath("watch-partial-parent");
		const selected = join(parent, "selected");
		world.io.mkdirSync(selected, { recursive: true });
		world.io.writeFileSync(join(selected, "baseline.txt"), "baseline\n");
		const existing = new Set(world.io.getWatcherSnapshot().map((watcher) => watcher.id));
		const closureMark = world.io.watcherClosures.length;
		const warningMark = world.warnings.length;
		const faultName = "watch-partial-second-target";
		world.io.failNext({
			name: faultName,
			kind: "watch",
			phase: "before",
			code: "EIO",
			matches: (operation) => operation.path === selected,
		});
		await saveWatch(partial.session, "watch-partial-arm", selected, "watch-partial-arm");
		const warning = `Routine watch: Scripted IO fault ${faultName}: watch '${selected}'`;
		await withDeadline(
			world.trace,
			"partial watch arming reports the actual second-target failure",
			world.whenWarnings(warningMark, (warnings) => warnings.includes(warning)),
		);
		expect(world.warnings.slice(warningMark).filter((message) => message === warning)).toHaveLength(1);
		world.warnings.splice(world.warnings.indexOf(warning, warningMark), 1);
		expect(world.io.consumedFaults.filter((name) => name === faultName)).toHaveLength(1);
		expect(
			world.io.failedOperations.filter(
				(operation) => operation.kind === "watch" && operation.path === selected && operation.code === "EIO",
			),
		).toHaveLength(1);
		const closed = world.io.watcherClosures
			.slice(closureMark)
			.filter((record) => record.path === parent && !existing.has(record.id));
		expect(closed, "the first partially armed directory watcher is physically closed").toHaveLength(1);
		expect(closed[0]?.reason).toBe("close");
		expect(world.io.getWatcherSnapshot().some((watcher) => watcher.id === closed[0]?.id)).toBe(false);
		await waitForBaseline(partial.session, "watch-partial-arm", "partial watch");
		const requests = world.provider.requests.length;
		const armed = new Set(world.timers.armedSnapshot("routines").map((alarm) => alarm.handle));
		world.io.renameSync(selected, join(parent, "moved"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(
			world.timers.armedSnapshot("routines").some((alarm) => !armed.has(alarm.handle) && alarm.delayMs === 300),
			"a closed partial watcher cannot schedule a debounce",
		).toBe(false);
		world.timers.advance("routines", 500);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(
			partial.session.backgroundLanes.getBotTeamStore().listRoutineOccurrences({ routineId: "watch-partial-arm" }),
		).toEqual([]);
		expect(world.provider.requests.length).toBe(requests);
		const disposal = await world.disposeSessionInBody(partial.session);
		partialOwned = false;
		expect(disposal).toBeUndefined();
	} finally {
		if (partialOwned) await world.disposeSessionInBody(partial.session);
	}

	const healthy = await createSession("healthy");
	let healthyOwned = true;
	try {
		const healthyRoot = projectPath("watch-healthy-tree");
		world.io.mkdirSync(healthyRoot, { recursive: true });
		const healthyFile = join(healthyRoot, "healthy.txt");
		world.io.writeFileSync(healthyFile, "initial\n");
		const healthyRoutine = "watch-healthy-after-cancel";
		await saveWatch(healthy.session, healthyRoutine, join(healthyRoot, "**", "*.txt"), "watch-healthy");
		await waitForBaseline(healthy.session, healthyRoutine, "healthy follow-up");
		const oldWatch = world.io.getWatcherSnapshot().filter((watcher) => watcher.path === healthyRoot);
		expect(oldWatch, "the original real watch owns one physical directory handle").toHaveLength(1);
		const replacementRoot = projectPath("watch-replacement-tree");
		world.io.mkdirSync(replacementRoot, { recursive: true });
		const replacementFile = join(replacementRoot, "replacement.txt");
		world.io.writeFileSync(replacementFile, "initial\n");
		const oldRoutine = healthy.session.backgroundLanes.getBotTeamStore().getRoutine(healthyRoutine);
		if (!oldRoutine) throw new Error("The H27 watch has no durable routine to update.");
		const replacementRead = createBarrier();
		world.io.observeNext({
			name: "watch-replacement-baseline-read",
			kind: "readdir",
			phase: "after",
			matches: (operation) => operation.path === replacementRoot,
			onMatch: () => replacementRead.release(),
		});
		const closeFault = "watch-replacement-old-close";
		world.io.failNext({
			name: closeFault,
			kind: "watch.close",
			phase: "before",
			code: "EIO",
			matches: (operation) => operation.path === healthyRoot,
		});
		const replacementWarningMark = world.warnings.length;
		world.systemOne.enterPhase("watch-replacement", ICM_INTAKE_JUDGMENTS);
		world.provider.enqueue(
			"root",
			calls("watch-replacement-update", [
				{
					id: "watch-replacement-update",
					name: "routine",
					arguments: {
						action: "update",
						routineId: healthyRoutine,
						expectedRevision: oldRoutine.revision,
						prompt: "Inspect the watched files and report whether they changed.",
						schedule: {
							kind: "event",
							source: "watch",
							condition: { type: "file", path: join(replacementRoot, "**", "*.txt"), on: "changed" },
						},
						profileId: PROFILE_ID,
					},
				},
			]),
			{
				name: "watch-replacement-answer",
				check: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
					expect(result?.isError, result?.text).toBe(false);
				},
				reply: { content: [{ type: "text", text: "The replacement watch is saved." }] },
			},
		);
		await withDeadline(
			world.trace,
			"owner updates the real watch routine",
			healthy.session.prompt("Watch the replacement directory instead."),
		);
		await withDeadline(world.trace, "replacement watch reads its actual baseline", replacementRead.promise);
		await waitForBaseline(healthy.session, healthyRoutine, "replacement follow-up");
		const closeWarning = "Routine watch: Routine watch could not close its directory watchers";
		await withDeadline(
			world.trace,
			"failed old watcher close is reported",
			world.whenWarnings(replacementWarningMark, (warnings) => warnings.includes(closeWarning)),
		);
		expect(world.warnings.slice(replacementWarningMark).filter((message) => message === closeWarning)).toHaveLength(
			1,
		);
		world.warnings.splice(world.warnings.indexOf(closeWarning, replacementWarningMark), 1);
		expect(world.io.consumedFaults.filter((name) => name === closeFault)).toHaveLength(1);
		expect(world.io.getWatcherSnapshot().some((watcher) => watcher.id === oldWatch[0]?.id)).toBe(true);
		const replacement = world.io.getWatcherSnapshot().filter((watcher) => watcher.path === replacementRoot);
		expect(replacement, "the updated routine owns a different live watcher").toHaveLength(1);
		world.io.emitWatcherError(oldWatch[0]!.id, new Error("h27 stale watcher error"));
		expect(
			world.io.getWatcherSnapshot().some((watcher) => watcher.id === oldWatch[0]?.id),
			"the late error retires the old handle",
		).toBe(false);
		expect(
			world.io.getWatcherSnapshot().some((watcher) => watcher.id === replacement[0]?.id),
			"an old watcher error cannot disarm its replacement",
		).toBe(true);
		expect(world.warnings.slice(replacementWarningMark)).not.toContain("Routine watch: h27 stale watcher error");
		const workerStarted = createBarrier();
		let workerTask = "";
		world.provider.enqueue("worker-a", {
			...calls("watch-healthy-report", [
				{
					id: "watch-healthy-report",
					name: "submit_report",
					arguments: { status: "completed", summary: "The watched file changed.", ownerUpdate: "none" },
				},
			]),
			check: (request) => {
				workerTask =
					request.context.messages
						.filter((message) => message.role === "user" && typeof message.content === "string")
						.map((message) => String(message.content))
						.filter((content) => content.startsWith("TASK\n"))
						.at(-1) ?? "";
				workerStarted.release();
			},
		});
		const healthyOccurrences = () =>
			healthy.session.backgroundLanes.getBotTeamStore().listRoutineOccurrences({ routineId: healthyRoutine });
		const fired = world.io.waitForMutation(() => healthyOccurrences().length === 1);
		world.io.writeFileSync(replacementFile, "changed\n");
		for (let step = 0; step < 8 && healthyOccurrences().length === 0; step++) {
			world.timers.advance("routines", 500);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		await withDeadline(world.trace, "the healthy glob watch fires once after cancellation", fired);
		await withDeadline(world.trace, "the healthy watch starts its real worker request", workerStarted.promise);
		await withDeadline(
			world.trace,
			"the healthy worker has a canonical successful terminal and delivery",
			world.io.waitForMutation(() => {
				const occurrence = healthyOccurrences()[0];
				const attemptId = occurrence?.executionRef?.attemptId;
				if (
					!attemptId ||
					occurrence.phase !== "terminal" ||
					occurrence.result?.outcome !== "succeeded" ||
					occurrence.result.delivery !== "acknowledged"
				)
					return false;
				const state = healthy.session.backgroundLanes.getTaskRuntimeSnapshot();
				return (
					state?.attempts[attemptId]?.status === "completed" &&
					Object.values(state.notifications).some(
						(notification) => notification.attemptId === attemptId && notification.status === "delivered",
					)
				);
			}),
		);
		expect(workerTask).toContain("Inspect the watched files and report whether they changed.");
		expect(workerTask).toContain("a condition the host was watching became true");
		expect(healthyOccurrences(), "the post-cancel watch produced exactly one occurrence").toHaveLength(1);
		const healthyDisposal = await world.disposeSessionInBody(healthy.session);
		healthyOwned = false;
		expect(healthyDisposal, "the healthy watch session also joins shutdown").toBeUndefined();
		expect(
			world.io
				.getWatcherSnapshot()
				.filter((watcher) => watcher.id === oldWatch[0]?.id || watcher.id === replacement[0]?.id),
			"shutdown releases both the retained old watcher and its replacement",
		).toEqual([]);
	} finally {
		if (healthyOwned) await world.disposeSessionInBody(healthy.session);
	}
}
