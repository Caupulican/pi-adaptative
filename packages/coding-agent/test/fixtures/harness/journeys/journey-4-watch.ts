import "../builtin-install.ts";
import { expect } from "vitest";
import { ORCHESTRATION_SCHEMA_VERSION } from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import type { ShellRequest } from "../virtual-shell.ts";
import {
	assertWatchWake,
	latestWatchWakeText,
	scriptWatchWake,
	settleWatchWake,
	type WatchWakeExpectation,
} from "./journey-watch-wake.ts";
import { latestBatchResults } from "./shared.ts";

const PROFILE_ID = "watch-reader";
const SHELL_PROFILE_ID = "watch-shell";
const ROUTINE_ID = "notes-watch";
const PROMPT = "Read notes.txt and say what changed.";

/**
 * A watch routine: the owner asks to be told when a file changes. The host follows the file in code, with no model
 * call while it waits. The file as it was when the watch was armed fires nothing; each change wakes the root that armed
 * the watch, once, with the event itself (the file, what happened, its size then, and the plan it saved) and no routine
 * worker runs; the same content again is no change. A file that appears and a file that goes are watches of their own:
 * each fires once, at its own moment, and never for the other. A firing while the armer works is read by its running
 * turn at the next model step, with no turn of its own; and a worker that armed a watch for its own wait is the one woken,
 * while the root hears only the worker's report. A read-only worker with a shell arms a command watch: the command passes
 * the worker's own gate, runs in the worker's directory with its offline, read-only environment, and the worker is woken
 * with the command's output fenced as untrusted data. Under an envelope that grants planning and not delegation, a paused
 * watch resumes and a paused routine that runs workers stays refused at the gate.
 */
export async function runJourney4WatchPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-watch`;
	new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(
		{
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: PROFILE_ID,
			description: "Read-only watch worker.",
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
	new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(
		{
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: SHELL_PROFILE_ID,
			description: "Read-only watch worker with a shell.",
			role: "explorer",
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: "harness-script", modelId: "worker-a", thinkingLevel: "off" }],
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
			createdAt: "2026-11-13T00:00:00.000Z",
			updatedAt: "2026-11-13T00:00:00.000Z",
		},
		"global",
	);
	const notes = projectPath("notes.txt");
	world.io.writeFileSync(notes, "first line\n");
	const manager = world.createSessionManager(agentDir);
	const { session } = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		systemOneEnabled: false,
		settings: {
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			orchestrator: { delegationGate: false },
		},
	});
	const store = () => session.backgroundLanes.getBotTeamStore();
	const occurrences = () => store().listRoutineOccurrences({ routineId: ROUTINE_ID });
	const saved = createBarrier();
	let created = "";
	world.provider.enqueue(
		"root",
		calls("j4-watch-create-call", [
			{
				id: "j4-watch-create",
				name: "routine",
				arguments: {
					action: "create",
					routineId: ROUTINE_ID,
					prompt: PROMPT,
					schedule: { kind: "event", source: "watch", condition: { type: "file", path: notes, on: "changed" } },
					profileId: PROFILE_ID,
				},
			},
		]),
		{
			name: "j4-watch-create-answer",
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
				created = `${result?.isError} ${result?.text}`;
				saved.release();
			},
			reply: { content: [{ type: "text", text: "The watch is saved." }] },
		},
	);
	await withDeadline(trace, "the owner's watch turn", session.prompt("Tell me when notes.txt changes."));
	await withDeadline(trace, "the watch is saved", saved.promise);
	await withDeadline(trace, "the session is at rest", session.waitForForegroundIdle());
	expect(created, "the watch is saved in the owner's words").toContain(
		'"scheduleText":"watching notes.txt for changes"',
	);
	/** Lets the watch's debounce and its observation pass until `count` runs of the routine exist. */
	const untilFired = async (count: number): Promise<void> => {
		for (let step = 0; step < 8 && occurrences().length < count; step++) {
			world.timers.advance("routines", 500);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	};
	/**
	 * What one firing of a watch does to its armer: a turn of the root starts with the event as its input (the session is
	 * at rest). `settled` waits for that turn to answer and for the session to be at rest after it.
	 */
	const wakes = (label: string, expected: WatchWakeExpectation): { readonly settled: () => Promise<void> } => {
		const woke = scriptWatchWake(world, label, expected);
		return { settled: () => settleWatchWake(world, session, label, woke) };
	};
	/** No firing of a watch starts a routine worker; each leaves one occurrence whose delivery was acknowledged. */
	const expectDelivered = (routineId: string, count: number): void => {
		const runs = store().listRoutineOccurrences({ routineId });
		expect(
			runs.map((run) => [run.phase, run.result?.outcome, run.result?.delivery]),
			`${routineId}: each firing is one delivered occurrence`,
		).toEqual(Array.from({ length: count }, () => ["terminal", "succeeded", "acknowledged"]));
	};
	const workerRequests = () => world.provider.requests.filter((request) => request.model.id === "worker-a").length;
	const rootRequests = () => world.provider.requests.filter((request) => request.model.id === "root").length;
	const rootBefore = rootRequests();
	const workersBeforeWatch = workerRequests();

	// The file as it was when the watch was armed is the starting state: nothing fires for it.
	await untilFired(1);
	expect(occurrences(), "an unchanged file fires nothing").toHaveLength(0);

	// A change wakes the root that armed the watch with the event: the file, what happened, its size and the saved plan.
	const first = wakes("j4-watch-first", {
		routineId: ROUTINE_ID,
		cause: "A watched file changed: notes.txt",
		plan: PROMPT,
		facts: { condition: "file", change: "changed", label: "notes.txt", facts: { sizeBytes: 23 } },
	});
	world.io.writeFileSync(notes, "first line\nsecond line\n");
	await untilFired(1);
	await first.settled();
	expect(occurrences().length, "the change is one occurrence").toBe(1);
	expectDelivered(ROUTINE_ID, 1);

	// The same content again is no change, and the one firing woke the root once, not again.
	await untilFired(2);
	expect(
		{
			runs: occurrences().length,
			rootTurns: rootRequests() - rootBefore,
			workers: workerRequests() - workersBeforeWatch,
		},
		"one change is one wake of the root that armed the watch, and no routine worker ran",
	).toEqual({ runs: 1, rootTurns: 1, workers: 0 });

	// A second change is a second wake, told with the file as it is then.
	const second = wakes("j4-watch-second", {
		routineId: ROUTINE_ID,
		cause: "A watched file changed: notes.txt",
		plan: PROMPT,
		facts: { condition: "file", change: "changed", label: "notes.txt", facts: { sizeBytes: 12 } },
	});
	world.io.writeFileSync(notes, "second line\n");
	await untilFired(2);
	await second.settled();
	expect(occurrences().length, "each change is its own occurrence").toBe(2);
	expectDelivered(ROUTINE_ID, 2);
	// A file that appears and a file that goes: each is its own watch, and each fires once, at its own moment.
	const flag = projectPath("release.flag");
	const runsOf = (routineId: string) => store().listRoutineOccurrences({ routineId }).length;
	const flagsSaved = createBarrier();
	world.provider.enqueue(
		"root",
		calls(
			"j4-watch-flags-call",
			(["created", "deleted"] as const).map((on) => ({
				id: `j4-watch-flag-${on}`,
				name: "routine",
				arguments: {
					action: "create",
					routineId: `flag-${on}`,
					prompt: `Say that release.flag was ${on}.`,
					schedule: { kind: "event", source: "watch", condition: { type: "file", path: flag, on } },
					profileId: PROFILE_ID,
				},
			})),
		),
		{
			name: "j4-watch-flags-answer",
			check: (request) => {
				const results = latestBatchResults(request).filter((entry) => entry.toolName === "routine");
				expect(
					results.map((result) => result.isError),
					results.map((result) => result.text).join(" | "),
				).toEqual([false, false]);
				flagsSaved.release();
			},
			reply: { content: [{ type: "text", text: "Both watches are saved." }] },
		},
	);
	await withDeadline(
		trace,
		"the owner's second watch turn",
		session.prompt("Tell me when release.flag appears and when it goes."),
	);
	await withDeadline(trace, "both flag watches are saved", flagsSaved.promise);
	await withDeadline(trace, "the session is at rest", session.waitForForegroundIdle());
	const untilRuns = async (routineId: string, count: number): Promise<void> => {
		for (let step = 0; step < 8 && runsOf(routineId) < count; step++) {
			world.timers.advance("routines", 500);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	};
	const appeared = wakes("j4-watch-flag-created", {
		routineId: "flag-created",
		cause: "A watched file appeared: release.flag",
		plan: "Say that release.flag was created.",
		facts: { condition: "file", change: "created", label: "release.flag", facts: { sizeBytes: 6 } },
	});
	world.io.writeFileSync(flag, "ready\n");
	await untilRuns("flag-created", 1);
	await appeared.settled();
	expect(
		{ created: runsOf("flag-created"), deleted: runsOf("flag-deleted") },
		"a file that appears fires the created watch only",
	).toEqual({ created: 1, deleted: 0 });
	const gone = wakes("j4-watch-flag-deleted", {
		routineId: "flag-deleted",
		cause: "A watched file was removed: release.flag",
		plan: "Say that release.flag was deleted.",
		facts: { condition: "file", change: "deleted", label: "release.flag", facts: {} },
	});
	world.io.unlinkSync(flag);
	await untilRuns("flag-deleted", 1);
	await gone.settled();
	expect(
		{
			created: runsOf("flag-created"),
			deleted: runsOf("flag-deleted"),
			workers: workerRequests() - workersBeforeWatch,
		},
		"a file that goes fires the deleted watch only, and no routine worker ran for any of the watches",
	).toEqual({ created: 1, deleted: 1, workers: 0 });
	expectDelivered("flag-created", 1);
	expectDelivered("flag-deleted", 1);

	// A firing while the armer works: its running turn reads the event at the next model step, and no turn of its own starts.
	const steerFile = projectPath("steer.txt");
	const steerPlan = "Compare steer.txt with what the turn is reading.";
	world.io.writeFileSync(steerFile, "one\n");
	const steerSaved = createBarrier();
	world.provider.enqueue(
		"root",
		calls("j4-watch-steer-create-call", [
			{
				id: "j4-watch-steer-create",
				name: "routine",
				arguments: {
					action: "create",
					routineId: "steer-watch",
					prompt: steerPlan,
					schedule: {
						kind: "event",
						source: "watch",
						condition: { type: "file", path: steerFile, on: "changed" },
					},
					profileId: PROFILE_ID,
				},
			},
		]),
		{
			name: "j4-watch-steer-create-answer",
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
				expect(result?.isError, result?.text).toBe(false);
				steerSaved.release();
			},
			reply: { content: [{ type: "text", text: "The steer watch is saved." }] },
		},
	);
	await withDeadline(trace, "the owner's steer watch turn", session.prompt("Tell me when steer.txt changes."));
	await withDeadline(trace, "the steer watch is saved", steerSaved.promise);
	await withDeadline(trace, "the session is at rest", session.waitForForegroundIdle());
	await untilRuns("steer-watch", 1);
	expect(runsOf("steer-watch"), "the file as it was when the watch was armed fires nothing").toBe(0);
	const turnRunning = createBarrier();
	const holdTurn = createBarrier();
	const steerRead = createBarrier();
	const rootBeforeSteer = rootRequests();
	const workersBeforeSteer = workerRequests();
	world.provider.enqueue(
		"root",
		{
			...calls("j4-watch-steer-read-call", [
				{ id: "j4-watch-steer-read", name: "read", arguments: { path: notes } },
			]),
			gate: holdTurn.promise,
			check: () => turnRunning.release(),
		},
		{
			name: "j4-watch-steer-answer",
			check: (request) => {
				assertWatchWake(latestWatchWakeText(request, "steer-watch"), {
					routineId: "steer-watch",
					cause: "A watched file changed: steer.txt",
					plan: steerPlan,
					facts: { condition: "file", change: "changed", label: "steer.txt", facts: { sizeBytes: 8 } },
				});
				steerRead.release();
			},
			reply: { content: [{ type: "text", text: "Noticed the change while reading." }] },
		},
	);
	const steerTurn = session.prompt("Read notes.txt for me.");
	await withDeadline(trace, "the owner's turn is running when the file changes", turnRunning.promise);
	world.io.writeFileSync(steerFile, "one\ntwo\n");
	await untilRuns("steer-watch", 1);
	expect(
		store()
			.listRoutineOccurrences({ routineId: "steer-watch" })
			.map((run) => run.result?.delivery),
		"the firing waits for the running turn's next model step: it is not delivered while the turn holds the model",
	).not.toContain("acknowledged");
	holdTurn.release();
	await withDeadline(trace, "the running turn reads the firing at its next model step", steerRead.promise);
	await withDeadline(trace, "the owner's turn ends", steerTurn);
	await withDeadline(trace, "the session is at rest after the steered turn", session.waitForForegroundIdle());
	expect(
		{ rootRequests: rootRequests() - rootBeforeSteer, workers: workerRequests() - workersBeforeSteer },
		"the firing joined the running turn (two model steps) and started no turn and no worker of its own",
	).toEqual({ rootRequests: 2, workers: 0 });
	expectDelivered("steer-watch", 1);

	// A worker that arms a watch for its own wait is the one woken: running, it is steered with the event; the root hears
	// only what the worker reports.
	const workerFlag = projectPath("worker.flag");
	const workerPlan = "Report the size of worker.flag when it appears.";
	const workerRunning = createBarrier();
	const holdWorker = createBarrier();
	const workerWoken = createBarrier();
	const rootHeardWorker = createBarrier();
	world.provider.enqueue(
		"root",
		calls("j4-watch-worker-start-call", [
			{
				id: "j4-watch-worker-start",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: PROFILE_ID,
					instructions: "Wait for worker.flag with a watch, then report its size.",
				},
			},
		]),
		{
			name: "j4-watch-worker-start-answer",
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
				expect(result?.isError, result?.text).toBe(false);
			},
			reply: { content: [{ type: "text", text: "A worker waits for worker.flag." }] },
		},
		{
			...text("j4-watch-worker-report-wake", "The worker reported."),
			check: (request) => {
				const heard = JSON.stringify(request.context.messages);
				expect(heard, "the root hears the worker's own report").toContain("Background worker terminal handoff:");
				expect(heard, "the root is not told of the watch the worker armed").not.toContain(
					"Watch worker-wait fired:",
				);
				rootHeardWorker.release();
			},
		},
	);
	const toolNames = (request: { readonly context: { readonly tools?: readonly { readonly name: string }[] } }) =>
		request.context.tools?.map((tool) => tool.name) ?? [];
	world.provider.enqueue(
		"worker-a",
		{
			name: "j4-watch-worker-arm",
			check: (request) => {
				expect(toolNames(request), "a worker holds the watch tool, not the routine tool").toContain("task_watch");
				expect(toolNames(request)).not.toContain("routine");
			},
			reply: calls("j4-watch-worker-arm-call", [
				{
					id: "j4-watch-worker-arm",
					name: "task_watch",
					arguments: {
						routineId: "worker-wait",
						prompt: workerPlan,
						condition: { type: "file", path: workerFlag, on: "created" },
						expiresAt: world.timers.port("routines").now() + 3_600_000,
					},
				},
			]).reply,
		},
		{
			name: "j4-watch-worker-hold",
			gate: holdWorker.promise,
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "task_watch");
				expect(result?.isError, result?.text).toBe(false);
				expect(result?.text).toContain('"armed":true');
				workerRunning.release();
			},
			reply: calls("j4-watch-worker-read-call", [
				{ id: "j4-watch-worker-read", name: "read", arguments: { path: notes } },
			]).reply,
		},
		{
			name: "j4-watch-worker-woken",
			check: (request) => {
				assertWatchWake(latestWatchWakeText(request, "worker-wait"), {
					routineId: "worker-wait",
					cause: "A watched file appeared: worker.flag",
					plan: workerPlan,
					planFenced: true,
					facts: { condition: "file", change: "created", label: "worker.flag", facts: { sizeBytes: 6 } },
				});
				workerWoken.release();
			},
			reply: calls("j4-watch-worker-report", [
				{
					id: "j4-watch-worker-report",
					name: "submit_report",
					arguments: { status: "completed", summary: "worker.flag appeared with 6 bytes." },
				},
			]).reply,
		},
	);
	const workersBefore = workerRequests();
	await withDeadline(
		trace,
		"the owner's worker turn",
		session.prompt("Have a worker wait for worker.flag and report its size."),
	);
	await withDeadline(trace, "the worker armed its watch and is running", workerRunning.promise);
	await untilRuns("worker-wait", 1);
	expect(runsOf("worker-wait"), "the worker's watch fires nothing for the file as it was").toBe(0);
	world.io.writeFileSync(workerFlag, "ready\n");
	await untilRuns("worker-wait", 1);
	holdWorker.release();
	await withDeadline(trace, "the running worker is steered with the event", workerWoken.promise);
	await withDeadline(trace, "the root hears the worker's report", rootHeardWorker.promise);
	await withDeadline(trace, "agent idle after the worker's report", session.agent.waitForIdle());
	await withDeadline(trace, "the session is at rest after the worker's report", session.waitForForegroundIdle());
	expect(
		{ workerSteps: workerRequests() - workersBefore, firings: runsOf("worker-wait") },
		"the worker took three model steps (arm, read, report) and its watch fired once",
	).toEqual({ workerSteps: 3, firings: 1 });
	expectDelivered("worker-wait", 1);

	// A read-only worker with a shell arms a command watch: its own gate admits the command, every check runs in the
	// worker's directory with its offline, read-only environment, and the worker is woken with the output fenced as data.
	const commandPlan = "Report the build status once it reads done.";
	const statusCommand = "cat build-status.txt";
	/** The scope the worker armed its watch under, as stored with it. */
	const storedScope = () => store().getRoutine("build-wait")?.workerScope;
	/** Each check runs in the stored worker directory, with the worker's offline and read-only command environment. */
	const checkWorkerShell = (request: ShellRequest): void => {
		expect(request.cwd, "the watched command runs in the worker's directory").toBe(storedScope()?.cwd);
		expect(request.environmentNames, "the watched command runs offline and read-only, as the worker's own").toEqual(
			expect.arrayContaining(["GIT_NO_LAZY_FETCH", "GIT_TERMINAL_PROMPT", "npm_config_update_notifier"]),
		);
	};
	const baselineSampled = createBarrier();
	world.shell.enqueue({
		name: "j4-watch-cmd-baseline",
		command: statusCommand,
		output: "status: building\n",
		exitCode: 0,
		check: checkWorkerShell,
		effect: () => baselineSampled.release(),
	});
	const commandRunning = createBarrier();
	const holdCommandWorker = createBarrier();
	const commandWoken = createBarrier();
	const rootHeardCommandWorker = createBarrier();
	world.provider.enqueue(
		"root",
		calls("j4-watch-cmd-start-call", [
			{
				id: "j4-watch-cmd-start",
				name: "delegate",
				arguments: {
					action: "start",
					profileId: SHELL_PROFILE_ID,
					instructions: "Wait until build-status.txt reads done with a command watch, then report it.",
				},
			},
		]),
		{
			name: "j4-watch-cmd-start-answer",
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "delegate");
				expect(result?.isError, result?.text).toBe(false);
			},
			reply: { content: [{ type: "text", text: "A worker waits for the build." }] },
		},
		{
			...text("j4-watch-cmd-report-wake", "The build worker reported."),
			check: (request) => {
				const heard = JSON.stringify(request.context.messages);
				expect(heard, "the root hears the worker's own report").toContain("Background worker terminal handoff:");
				expect(heard, "the root is not told of the watch the worker armed").not.toContain(
					"Watch build-wait fired:",
				);
				rootHeardCommandWorker.release();
			},
		},
	);
	world.provider.enqueue(
		"worker-a",
		{
			name: "j4-watch-cmd-arm",
			check: (request) => {
				expect(toolNames(request), "the worker holds its shell and the watch tool").toEqual(
					expect.arrayContaining(["bash", "task_watch"]),
				);
			},
			reply: calls("j4-watch-cmd-arm-call", [
				{
					id: "j4-watch-cmd-arm",
					name: "task_watch",
					arguments: {
						routineId: "build-wait",
						prompt: commandPlan,
						condition: {
							type: "command",
							command: statusCommand,
							everyMs: 1_000,
							expect: { outputContains: "done" },
						},
						expiresAt: world.timers.port("routines").now() + 3_600_000,
					},
				},
			]).reply,
		},
		{
			name: "j4-watch-cmd-hold",
			gate: holdCommandWorker.promise,
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "task_watch");
				expect(result?.isError, result?.text).toBe(false);
				expect(result?.text).toContain('"armed":true');
				commandRunning.release();
			},
			reply: calls("j4-watch-cmd-read-call", [{ id: "j4-watch-cmd-read", name: "read", arguments: { path: notes } }])
				.reply,
		},
		{
			name: "j4-watch-cmd-woken",
			check: (request) => {
				assertWatchWake(latestWatchWakeText(request, "build-wait"), {
					routineId: "build-wait",
					cause: "A watched command check now passes",
					plan: commandPlan,
					planFenced: true,
					facts: { condition: "command", change: "matched", facts: { exitCode: 0 } },
					excerpt: { source: "watch:command", text: "status: done" },
				});
				commandWoken.release();
			},
			reply: calls("j4-watch-cmd-report", [
				{
					id: "j4-watch-cmd-report",
					name: "submit_report",
					arguments: { status: "completed", summary: "The build status reads done." },
				},
			]).reply,
		},
	);
	const commandWorkersBefore = workerRequests();
	await withDeadline(
		trace,
		"the owner's build worker turn",
		session.prompt("Have a worker wait for the build to be done and report it."),
	);
	await withDeadline(trace, "the worker armed its command watch and is running", commandRunning.promise);
	await withDeadline(trace, "the command watch took its starting state", baselineSampled.promise);
	expect(
		{ firings: runsOf("build-wait"), scope: storedScope() },
		"the watch stores the worker's read-only, offline scope, and the starting state fires nothing",
	).toEqual({
		firings: 0,
		scope: expect.objectContaining({ shellReadOnly: true, readOnly: true, network: false }),
	});
	const doneSampled = createBarrier();
	world.shell.enqueue({
		name: "j4-watch-cmd-done",
		command: statusCommand,
		output: "status: done\n",
		exitCode: 0,
		check: checkWorkerShell,
		effect: () => doneSampled.release(),
	});
	world.timers.advance("routines", 1_000);
	await withDeadline(trace, "the command watch checked again", doneSampled.promise);
	await untilRuns("build-wait", 1);
	holdCommandWorker.release();
	await withDeadline(trace, "the running worker is steered with the command's output", commandWoken.promise);
	await withDeadline(trace, "the root hears the build worker's report", rootHeardCommandWorker.promise);
	await withDeadline(trace, "agent idle after the build worker's report", session.agent.waitForIdle());
	await withDeadline(trace, "the session is at rest after the build worker's report", session.waitForForegroundIdle());
	expect(
		{ workerSteps: workerRequests() - commandWorkersBefore, firings: runsOf("build-wait") },
		"the worker took three model steps (arm, read, report) and its command watch fired once",
	).toEqual({ workerSteps: 3, firings: 1 });
	expectDelivered("build-wait", 1);

	// Resuming a watch is planning, as arming one is: under an envelope that grants workflow.plan and not workflow.delegate
	// (a session launched with such a profile), the routine store tells the gate the paused watch runs no worker, so it
	// resumes; a paused routine that runs workers stays refused at the gate, which names the delegate requirement.
	const routineCall = async (label: string, args: Record<string, unknown>) => {
		let outcome = { isError: true, text: "" };
		world.provider.enqueue("root", calls(`${label}-call`, [{ id: label, name: "routine", arguments: args }]), {
			...text(`${label}-answer`, "The routine command is recorded."),
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
				outcome = { isError: result?.isError ?? true, text: result?.text ?? "" };
			},
		});
		await withDeadline(trace, label, session.prompt(`Apply the ${label} routine command.`));
		await withDeadline(trace, `the session is at rest after ${label}`, session.waitForForegroundIdle());
		return outcome;
	};
	const revisionOf = (routineId: string) => store().getRoutine(routineId)!.revision;
	const INTERVAL_ID = "daily-review";
	for (const [label, args] of [
		["j4-plan-pause-watch", { action: "pause", routineId: ROUTINE_ID, expectedRevision: revisionOf(ROUTINE_ID) }],
		[
			"j4-plan-interval-create",
			{
				action: "create",
				routineId: INTERVAL_ID,
				prompt: "Review the notes once a day.",
				schedule: { kind: "interval", intervalMs: 86_400_000 },
				profileId: PROFILE_ID,
			},
		],
	] as const) {
		const outcome = await routineCall(label, args);
		expect(outcome.isError, outcome.text).toBe(false);
	}
	const paused = await routineCall("j4-plan-pause-interval", {
		action: "pause",
		routineId: INTERVAL_ID,
		expectedRevision: revisionOf(INTERVAL_ID),
	});
	expect(paused.isError, paused.text).toBe(false);
	session.capabilityEnvelope = { id: "j4-plan-only", capabilities: ["workflow.plan"] };
	const watchResumed = await routineCall("j4-plan-resume-watch", {
		action: "resume",
		routineId: ROUTINE_ID,
		expectedRevision: revisionOf(ROUTINE_ID),
	});
	expect(watchResumed.isError, watchResumed.text).toBe(false);
	expect(store().getRoutine(ROUTINE_ID)!.enabled, "the paused watch resumes under workflow.plan alone").toBe(true);
	const intervalResumed = await routineCall("j4-plan-resume-interval", {
		action: "resume",
		routineId: INTERVAL_ID,
		expectedRevision: revisionOf(INTERVAL_ID),
	});
	expect(intervalResumed.isError, "a routine that runs workers stays refused without workflow.delegate").toBe(true);
	expect(intervalResumed.text).toContain(
		"Tool execution blocked by autonomy gate [tool_gate]: Tool 'routine' requires workflow.plan and workflow.delegate, which is missing from the active envelope. (missing_capability)",
	);
	expect(store().getRoutine(INTERVAL_ID)!.enabled, "the refused resume leaves the routine paused").toBe(false);
	session.capabilityEnvelope = undefined;
	const removed = await routineCall("j4-plan-interval-delete", {
		action: "delete",
		routineId: INTERVAL_ID,
		expectedRevision: revisionOf(INTERVAL_ID),
	});
	expect(removed.isError, removed.text).toBe(false);

	expect(await world.disposeSessionInBody(session), "the watch session closes").toBeUndefined();
	trace.mark("root", "watch.closed");
}
