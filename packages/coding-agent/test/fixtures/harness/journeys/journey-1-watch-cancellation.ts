import "../builtin-install.ts";
import { join, sep } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { scriptWatchWake, settleWatchWake } from "./journey-watch-wake.ts";
import { ICM_INTAKE_JUDGMENTS, latestBatchResults } from "./shared.ts";

/** A real routine watch is canceled during its glob scan; shutdown joins it before a later watch runs. */
export async function runJourney1WatchCancellationPhase(world: HarnessWorld): Promise<void> {
	const createSession = async (label: string) => {
		const agentDir = `${world.agentDir}-watch-cancel-${label}`;
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
		const readsAfterCancel = world.io.operations.length;
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
		const closed = world.io.watcherClosures.filter((record) => record.path === parent && !existing.has(record.id));
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
		// No worker runs for a watch, so no worker claim is judged: the phase holds the intake judgments only.
		world.systemOne.enterPhase("watch-replacement", ICM_INTAKE_JUDGMENTS, {
			expect: (request) =>
				expect(
					"states_tests_pass" in request.questions,
					"a watch's firing starts no worker whose claim is judged",
				).toBe(false),
		});
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
		const healthyOccurrences = () =>
			healthy.session.backgroundLanes.getBotTeamStore().listRoutineOccurrences({ routineId: healthyRoutine });
		// The firing wakes the session that armed the watch with the event itself; no routine worker runs.
		const requestsBeforeFiring = world.provider.requests.length;
		const healthyWake = scriptWatchWake(world, "watch-healthy", {
			routineId: healthyRoutine,
			cause: "A watched folder or file pattern changed: *.txt",
			plan: "Inspect the watched files and report whether they changed.",
			facts: { condition: "file", change: "changed", label: "*.txt", facts: { entries: 1 } },
		});
		const fired = world.io.waitForMutation(() => healthyOccurrences().length === 1);
		world.io.writeFileSync(replacementFile, "changed\n");
		for (let step = 0; step < 8 && healthyOccurrences().length === 0; step++) {
			world.timers.advance("routines", 500);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		await withDeadline(world.trace, "the healthy glob watch fires once after cancellation", fired);
		await settleWatchWake(world, healthy.session, "healthy watch", healthyWake);
		expect(healthyOccurrences(), "the post-cancel watch produced exactly one occurrence").toHaveLength(1);
		expect(
			healthyOccurrences().map((run) => [run.phase, run.result?.outcome, run.result?.delivery]),
			"the firing is one delivered occurrence",
		).toEqual([["terminal", "succeeded", "acknowledged"]]);
		expect(
			world.provider.requests.slice(requestsBeforeFiring).map((request) => request.model.id),
			"the firing cost one turn of the session that armed the watch and started no worker",
		).toEqual(["root"]);
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
