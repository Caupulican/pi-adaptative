import "../builtin-install.ts";
import { expect } from "vitest";
import { ORCHESTRATION_SCHEMA_VERSION } from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { calls, createBarrier, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import {
	assertWatchWake,
	latestWatchWakeText,
	scriptWatchWake,
	settleWatchWake,
	type WatchWakeExpectation,
} from "./journey-watch-wake.ts";
import { latestBatchResults } from "./shared.ts";

const PROFILE_ID = "watch-reader";
const ROUTINE_ID = "notes-watch";
const PROMPT = "Read notes.txt and say what changed.";

/**
 * A watch routine: the owner asks to be told when a file changes. The host follows the file in code, with no model
 * call while it waits. The file as it was when the watch was armed fires nothing; each change wakes the root that armed
 * the watch, once, with the event itself (the file, what happened, its size then, and the plan it saved) and no routine
 * worker runs; the same content again is no change. A file that appears and a file that goes are watches of their own:
 * each fires once, at its own moment, and never for the other. A firing while the armer works is read by its running
 * turn at the next model step, with no turn of its own; and a worker that armed a watch for its own wait is the one woken,
 * while the root hears only the worker's report.
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

	expect(await world.disposeSessionInBody(session), "the watch session closes").toBeUndefined();
	trace.mark("root", "watch.closed");
}
