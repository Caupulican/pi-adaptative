/**
 * Routine progress journey leg: proves `RoutineProgress` / `progressLine` structured status (`position`, `next`,
 * `ownerNote`, `recurring`, `untrusted`), cross-run carryover (`Where this task stood after the last run:` + snag
 * reference promotion to recurring), derived position clearing stale `next` when a run omits `progress`, third-party
 * `reset_progress`, non-owner-turn refusal across both System One modes, and a command watch's firing (a third party's
 * output) waking its armer with the output fenced as untrusted data, with no worker run and no progress of its own.
 * Untrusted progress (`untrusted: true`, `BRIEF_UNTRUSTED`, remedy suppression) needs a run a third party started: an event
 * routine's, covered in `journey-1-github-routine-progress.ts`.
 */

import "../builtin-install.ts";
import { expect } from "vitest";
import { formatSessionAutonomyStatus } from "../../../../src/core/autonomy-status/format.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { scriptRequirementCheckSpawn } from "./journey-9-shared.ts";
import { scriptWatchWake, settleWatchWake } from "./journey-watch-wake.ts";
import { INTAKE_JUDGMENTS_WITHOUT_GRANT, latestBatchResults, OPERATION_PROCEED_JUDGMENTS } from "./shared.ts";

const PROFILE_ID = "progress-worker";
const ROUTINE_ID = "shard-audit";
const WATCH_ROUTINE_ID = "command-alert-watch";
const WATCH_COMMAND = "cat alert-feed.txt";
const WATCH_PLAN = "Summarize alert transitions in alert-feed.txt.";
/**
 * Why the wake of a watch that carried a command's output may not write the routine's progress: the third-party gate's own
 * words. That output is a third party's, so the run is refused before the routine tool's own owner-turn check is reached.
 */
const THIRD_PARTY_NOTE_REFUSAL =
	"Refused: routine note changes state beyond reading, which only the owner's own turn decides. This run carries words from an event written by someone else.";

function extractLatestWorkerTask(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
	const tasks = messages.flatMap((message) =>
		message.role === "user" && typeof message.content === "string" && message.content.startsWith("TASK\n")
			? [message.content]
			: [],
	);
	return tasks.at(-1) ?? "";
}

export async function runJourney4RoutineProgressPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-routine-progress`;
	new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false }).save(
		{
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			profileId: PROFILE_ID,
			description: "Read-only routine progress worker.",
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

	const manager = world.createSessionManager(agentDir);
	const { session } = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: {
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			orchestrator: { delegationGate: false },
			routines: { automaticIntake: false },
		},
	});
	const store = () => session.backgroundLanes.getBotTeamStore();
	const occurrencesOf = (routineId: string) => store().listRoutineOccurrences({ routineId });

	const waitForAcknowledgedCount = (routineId: string, count: number): Promise<void> =>
		new Promise((resolve) => {
			const check = () => {
				const runs = occurrencesOf(routineId);
				if (runs.length >= count && runs.slice(0, count).every((run) => run.result?.delivery === "acknowledged")) {
					unsubscribe();
					resolve();
				}
			};
			const unsubscribe = store().subscribe(check);
			check();
		});

	const scriptedWatch = scriptRequirementCheckSpawn(world, WATCH_COMMAND);

	try {
		// 1. Owner creates an interval routine, attaches an owner note (preserving revision), and triggers Run 1.
		const run1Gate = createBarrier();
		let run1Task = "";
		world.provider.enqueue("worker-a", {
			...calls("j4-rp-run1-report", [
				{
					id: "j4-rp-run1-submit",
					name: "submit_report",
					arguments: {
						status: "completed",
						summary: "Shard A baseline recorded.",
						progress: {
							position: "Shard A inspected",
							done: ["Baseline metrics recorded"],
							next: "Inspect shard B",
							snag: {
								what: "Cache warmup timed out once",
								remedy: "Retry warmup after five seconds",
							},
						},
					},
				},
			]),
			gate: run1Gate.promise,
			check: (request) => {
				run1Task = extractLatestWorkerTask(request.context.messages);
			},
		});

		let createdRevision = -1;
		let notedRevision = -1;
		const setupDone = createBarrier();
		world.provider.enqueue(
			"root",
			calls("j4-rp-create-call", [
				{
					id: "j4-rp-create",
					name: "routine",
					arguments: {
						action: "create",
						routineId: ROUTINE_ID,
						prompt: "Audit cache shards in order and record progress.",
						schedule: { kind: "interval", intervalMs: 60_000 },
						profileId: PROFILE_ID,
					},
				},
			]),
			{
				...calls("j4-rp-note-call", [
					{
						id: "j4-rp-note",
						name: "routine",
						arguments: {
							action: "note",
							routineId: ROUTINE_ID,
							text: "Keep watching flaky cache warmups",
						},
					},
				]),
				check: (request) => {
					const res = latestBatchResults(request).find((entry) => entry.toolName === "routine");
					expect(res?.isError, res?.text).toBe(false);
					createdRevision =
						(JSON.parse(res?.text ?? "{}") as { routine?: { revision?: number } }).routine?.revision ?? -1;
				},
			},
			{
				name: "j4-rp-run1-trigger-call",
				check: (request) => {
					const res = latestBatchResults(request).find((entry) => entry.toolName === "routine");
					expect(res?.isError, res?.text).toBe(false);
					notedRevision =
						(JSON.parse(res?.text ?? "{}") as { routine?: { revision?: number } }).routine?.revision ?? -1;
				},
				reply: () => ({
					content: [
						{
							type: "toolCall" as const,
							id: "j4-rp-run1-trigger",
							name: "routine",
							arguments: {
								action: "run",
								routineId: ROUTINE_ID,
								expectedRevision: notedRevision,
							},
						},
					],
					stopReason: "toolUse" as const,
				}),
			},
			{
				name: "j4-rp-setup-answer",
				check: (request) => {
					const res = latestBatchResults(request).find((entry) => entry.toolName === "routine");
					expect(res?.isError, res?.text).toBe(false);
					setupDone.release();
				},
				reply: { content: [{ type: "text", text: "Routine and note saved." }] },
			},
		);

		world.systemOne.enterPhase("j4-rp-setup", INTAKE_JUDGMENTS_WITHOUT_GRANT);
		await withDeadline(
			trace,
			"the owner sets up the routine and note",
			session.prompt("Set up the shard audit routine, note flaky cache warmups, and run it once."),
		);
		await withDeadline(trace, "setup turn finished", setupDone.promise);
		await withDeadline(trace, "session idle before run 1 wake", session.waitForForegroundIdle());
		expect(notedRevision, "an owner note does not bump the routine revision").toBe(createdRevision);

		// 2. Run 1 finishes and wakes the root (`routine-completion` non-owner turn). On that wake turn, `note` and
		// `reset_progress` are refused because the owner did not speak in this turn.
		let nonOwnerNoteRefusal: { isError: boolean; text: string } | undefined;
		let nonOwnerResetRefusal: { isError: boolean; text: string } | undefined;
		const wakeSettled = createBarrier();
		world.provider.enqueue(
			"root",
			calls("j4-rp-wake-attempt", [
				{
					id: "j4-rp-wake-note",
					name: "routine",
					arguments: { action: "note", routineId: ROUTINE_ID, text: "Unsolicited wake note" },
				},
				{
					id: "j4-rp-wake-reset",
					name: "routine",
					arguments: { action: "reset_progress", routineId: ROUTINE_ID },
				},
			]),
			{
				name: "j4-rp-wake-done",
				check: (request) => {
					const results = latestBatchResults(request).filter((entry) => entry.toolName === "routine");
					nonOwnerNoteRefusal = results[0] ? { isError: results[0].isError, text: results[0].text } : undefined;
					nonOwnerResetRefusal = results[1] ? { isError: results[1].isError, text: results[1].text } : undefined;
					wakeSettled.release();
				},
				reply: { content: [{ type: "text", text: "Awaiting owner direction." }] },
			},
		);

		world.systemOne.enterPhase("j4-rp-non-owner-wake", {});
		const run1Ack = waitForAcknowledgedCount(ROUTINE_ID, 1);
		run1Gate.release();
		await withDeadline(trace, "run 1 result acknowledged", run1Ack);
		await withDeadline(trace, "non-owner wake turn settled", wakeSettled.promise);
		await withDeadline(trace, "agent idle after wake turn", session.agent.waitForIdle());
		await withDeadline(trace, "foreground idle after wake turn", session.waitForForegroundIdle());

		expect(
			{
				run1CarriedOwnerNote:
					run1Task.includes("Where this task stood after the last run:") &&
					run1Task.includes("Owner's note: Keep watching flaky cache warmups"),
				noteError: nonOwnerNoteRefusal?.isError,
				noteRefusalText: nonOwnerNoteRefusal?.text.includes("The owner has not spoken in this turn"),
				resetError: nonOwnerResetRefusal?.isError,
				resetRefusalText: nonOwnerResetRefusal?.text.includes("The owner has not spoken in this turn"),
			},
			"run 1 receives the owner's note and a routine-woken parent turn cannot rewrite or reset progress",
		).toEqual({
			run1CarriedOwnerNote: true,
			noteError: true,
			noteRefusalText: true,
			resetError: true,
			resetRefusalText: true,
		});

		// 3. Scheduled Run 2 receives the full carryover brief (position, next, done, owner note, and snag ref),
		// cites the 8-hex snag ref so `seenCount` reaches 2 (`recurring`), and updates `progressLine`.
		let run2Task = "";
		let capturedSnagRef = "";
		world.provider.enqueue("worker-a", {
			name: "j4-rp-run2-report",
			check: (request) => {
				run2Task = extractLatestWorkerTask(request.context.messages);
				const match = /Snag ([0-9a-f]{8}), seen once: Cache warmup timed out once/.exec(run2Task);
				capturedSnagRef = match?.[1] ?? "";
			},
			reply: () => ({
				content: [
					{
						type: "toolCall" as const,
						id: "j4-rp-run2-submit",
						name: "submit_report",
						arguments: {
							status: "completed",
							summary: "Shard B recorded.",
							ownerUpdate: "none",
							progress: {
								position: "Shard B inspected",
								done: ["Shard B latency sampled"],
								next: "Inspect shard C",
								snag: {
									what: "Cache warmup timed out once",
									remedy: "Retry warmup after five seconds",
									ref: capturedSnagRef,
								},
							},
						},
					},
				],
				stopReason: "toolUse" as const,
			}),
		});

		const run2Ack = waitForAcknowledgedCount(ROUTINE_ID, 2);
		world.timers.advance("routines", 60_000);
		await session.backgroundLanes.tickPersistentRoutines();
		await withDeadline(trace, "scheduled run 2 acknowledged", run2Ack);

		const statusAfterRun2 = await session.autonomyStatus();
		const formattedAfterRun2 = formatSessionAutonomyStatus(statusAfterRun2);
		const itemAfterRun2 =
			statusAfterRun2.routines.status === "available"
				? statusAfterRun2.routines.value.routines.items.find((item) => item.routineId === ROUTINE_ID)
				: undefined;

		expect(
			{
				briefTitle: run2Task.includes("Where this task stood after the last run:"),
				briefOwnerNote: run2Task.includes("Owner's note: Keep watching flaky cache warmups"),
				briefPosition: run2Task.includes("Position: Shard A inspected"),
				briefNext: run2Task.includes("Next: Inspect shard B"),
				briefDone: run2Task.includes("Done recently: Baseline metrics recorded"),
				snagRefValid: /^[0-9a-f]{8}$/.test(capturedSnagRef),
				progressLine: itemAfterRun2?.progressLine,
				formattedIncludesRecurring:
					formattedAfterRun2.includes("Shard B inspected") &&
					formattedAfterRun2.includes("Inspect shard C") &&
					formattedAfterRun2.includes("Keep watching flaky cache warmups") &&
					formattedAfterRun2.includes("Cache warmup timed out once"),
			},
			"scheduled run 2 carries prior progress forward and promotes the matched snag to recurring in autonomyStatus()",
		).toEqual({
			briefTitle: true,
			briefOwnerNote: true,
			briefPosition: true,
			briefNext: true,
			briefDone: true,
			snagRefValid: true,
			progressLine: {
				position: "Shard B inspected",
				next: "Inspect shard C",
				ownerNote: "Keep watching flaky cache warmups",
				recurring: [
					{
						seenCount: 2,
						what: "Cache warmup timed out once",
						remedy: "Retry warmup after five seconds",
					},
				],
			},
			formattedIncludesRecurring: true,
		});

		// 4. Scheduled Run 3 submits no `progress`: host derives position from summary and clears stale `next`.
		let run3Task = "";
		world.provider.enqueue("worker-a", {
			...calls("j4-rp-run3-report", [
				{
					id: "j4-rp-run3-submit",
					name: "submit_report",
					arguments: {
						status: "completed",
						summary: "Shard C nominal.",
						ownerUpdate: "none",
					},
				},
			]),
			check: (request) => {
				run3Task = extractLatestWorkerTask(request.context.messages);
			},
		});

		const run3Ack = waitForAcknowledgedCount(ROUTINE_ID, 3);
		world.timers.advance("routines", 60_000);
		await session.backgroundLanes.tickPersistentRoutines();
		await withDeadline(trace, "scheduled run 3 acknowledged", run3Ack);

		const statusAfterRun3 = await session.autonomyStatus();
		const itemAfterRun3 =
			statusAfterRun3.routines.status === "available"
				? statusAfterRun3.routines.value.routines.items.find((item) => item.routineId === ROUTINE_ID)
				: undefined;

		expect(
			{
				run3SawRecurringCount: run3Task.includes(
					`Snag ${capturedSnagRef}, seen 2 times: Cache warmup timed out once`,
				),
				progressLine: itemAfterRun3?.progressLine,
			},
			"a run omitting progress replaces position from its summary and clears stale next while preserving ownerNote and recurring snags",
		).toEqual({
			run3SawRecurringCount: true,
			progressLine: {
				position: "Last run succeeded: Shard C nominal.",
				ownerNote: "Keep watching flaky cache warmups",
				recurring: [
					{
						seenCount: 2,
						what: "Cache warmup timed out once",
						remedy: "Retry warmup after five seconds",
					},
				],
			},
		});

		// 5. A command watch's firing carries a third party's words (the command's output). No routine worker runs: the armer
		// is woken with the event itself, the output fenced as untrusted data, and that wake is a third party's run, so the
		// owner-only routine actions stay refused in it. The watch keeps no progress of its own.
		const watchWorkersBefore = world.provider.requests.filter((request) => request.model.id === "worker-a").length;
		const flushWatchTurn = async (): Promise<void> => {
			for (let step = 0; step < 4; step++) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		};
		const baselineSampled = createBarrier();
		world.shell.enqueue({
			name: "j4-rp-watch-baseline",
			command: WATCH_COMMAND,
			output: "status: OK\n",
			exitCode: 0,
			effect: () => baselineSampled.release(),
		});

		const watchSaved = createBarrier();
		world.provider.enqueue(
			"root",
			calls("j4-rp-watch-create-call", [
				{
					id: "j4-rp-watch-create",
					name: "routine",
					arguments: {
						action: "create",
						routineId: WATCH_ROUTINE_ID,
						prompt: WATCH_PLAN,
						schedule: {
							kind: "event",
							source: "watch",
							condition: {
								type: "command",
								command: WATCH_COMMAND,
								everyMs: 1_000,
								expect: { outputContains: "ALERT" },
							},
						},
						profileId: PROFILE_ID,
					},
				},
			]),
			{
				name: "j4-rp-watch-create-answer",
				check: (request) => {
					const res = latestBatchResults(request).find((entry) => entry.toolName === "routine");
					expect(res?.isError, res?.text).toBe(false);
					watchSaved.release();
				},
				reply: { content: [{ type: "text", text: "Command watch armed." }] },
			},
		);

		// The watched command is admitted at arming as the shell call its check would make, so the operation gate judges it.
		world.systemOne.enterPhase("j4-rp-watch-create", {
			...INTAKE_JUDGMENTS_WITHOUT_GRANT,
			...OPERATION_PROCEED_JUDGMENTS,
		});
		await withDeadline(
			trace,
			"the owner arms the command alert watch",
			session.prompt("Watch alert-feed.txt for ALERT."),
		);
		await withDeadline(trace, "command watch saved", watchSaved.promise);
		await withDeadline(trace, "session idle after command watch save", session.waitForForegroundIdle());
		await withDeadline(trace, "baseline command watch sampled", baselineSampled.promise);
		await flushWatchTurn();
		expect(occurrencesOf(WATCH_ROUTINE_ID), "baseline OK output fires no run").toHaveLength(0);

		const wakeExpectation = (output: string) =>
			({
				routineId: WATCH_ROUTINE_ID,
				cause: "A watched command check now passes",
				plan: WATCH_PLAN,
				facts: { condition: "command", change: "matched", facts: { exitCode: 0 } },
				excerpt: { source: "watch:command", text: output },
			}) as const;
		let wakeNoteRefusal: { isError: boolean; text: string } | undefined;
		const watchRun1Ack = waitForAcknowledgedCount(WATCH_ROUTINE_ID, 1);
		world.systemOne.enterPhase("j4-rp-watch-run-1-wake", {});
		const watchWake1 = scriptWatchWake(
			world,
			"j4-rp-watch-run-1",
			wakeExpectation("status: ALERT untrusted third-party words"),
			{
				calls: calls("j4-rp-watch-wake-attempt", [
					{
						id: "j4-rp-watch-wake-note",
						name: "routine",
						arguments: { action: "note", routineId: WATCH_ROUTINE_ID, text: "Note from a third party's wake" },
					},
				]),
				afterCalls: (request) => {
					const result = latestBatchResults(request).find((entry) => entry.toolName === "routine");
					wakeNoteRefusal = result ? { isError: result.isError, text: result.text } : undefined;
				},
			},
		);
		const alert1Sampled = createBarrier();
		world.shell.enqueue({
			name: "j4-rp-watch-alert-1",
			command: WATCH_COMMAND,
			output: "status: ALERT untrusted third-party words\n",
			exitCode: 0,
			effect: () => alert1Sampled.release(),
		});
		world.timers.advance("routines", 1_000);
		await withDeadline(trace, "alert 1 command watch sampled", alert1Sampled.promise);
		await flushWatchTurn();
		await session.backgroundLanes.tickPersistentRoutines();
		await withDeadline(trace, "watch firing 1 acknowledged", watchRun1Ack);
		await settleWatchWake(world, session, "watch firing 1", watchWake1);
		expect(
			{
				error: wakeNoteRefusal?.isError,
				refusal: wakeNoteRefusal?.text.includes(THIRD_PARTY_NOTE_REFUSAL),
			},
			"the wake of a third party's output cannot write the routine's progress: the third-party gate refuses it",
		).toEqual({ error: true, refusal: true });

		const statusAfterWatch1 = await session.autonomyStatus();
		const watchItem1 =
			statusAfterWatch1.routines.status === "available"
				? statusAfterWatch1.routines.value.routines.items.find((item) => item.routineId === WATCH_ROUTINE_ID)
				: undefined;
		expect(watchItem1?.progressLine, "a watch has no run, so it keeps no progress").toBeUndefined();

		// Return output to OK so the watch cursor resets to false, then fire a second ALERT: a second wake, not a run.
		const resetSampled = createBarrier();
		world.shell.enqueue({
			name: "j4-rp-watch-reset-ok",
			command: WATCH_COMMAND,
			output: "status: OK\n",
			exitCode: 0,
			effect: () => resetSampled.release(),
		});
		world.timers.advance("routines", 1_000);
		await withDeadline(trace, "command watch cursor reset sampled", resetSampled.promise);
		await flushWatchTurn();

		const watchRun2Ack = waitForAcknowledgedCount(WATCH_ROUTINE_ID, 2);
		world.systemOne.enterPhase("j4-rp-watch-run-2-wake", {});
		const watchWake2 = scriptWatchWake(
			world,
			"j4-rp-watch-run-2",
			wakeExpectation("status: ALERT second untrusted wave"),
		);
		const alert2Sampled = createBarrier();
		world.shell.enqueue({
			name: "j4-rp-watch-alert-2",
			command: WATCH_COMMAND,
			output: "status: ALERT second untrusted wave\n",
			exitCode: 0,
			effect: () => alert2Sampled.release(),
		});
		world.timers.advance("routines", 1_000);
		await withDeadline(trace, "alert 2 command watch sampled", alert2Sampled.promise);
		await flushWatchTurn();
		await session.backgroundLanes.tickPersistentRoutines();
		await withDeadline(trace, "watch firing 2 acknowledged", watchRun2Ack);
		await settleWatchWake(world, session, "watch firing 2", watchWake2);

		expect(
			{
				firings: occurrencesOf(WATCH_ROUTINE_ID).map((run) => [
					run.phase,
					run.result?.outcome,
					run.result?.delivery,
				]),
				workers:
					world.provider.requests.filter((request) => request.model.id === "worker-a").length - watchWorkersBefore,
			},
			"each of the two firings is one delivered occurrence, and no routine worker ran for either",
		).toEqual({
			firings: [
				["terminal", "succeeded", "acknowledged"],
				["terminal", "succeeded", "acknowledged"],
			],
			workers: 0,
		});

		// 6. Owner resets progress on both routines -> `progressLine` clears to undefined.
		const resetDone = createBarrier();
		world.provider.enqueue(
			"root",
			calls("j4-rp-reset-call", [
				{ id: "j4-rp-reset-1", name: "routine", arguments: { action: "reset_progress", routineId: ROUTINE_ID } },
				{
					id: "j4-rp-reset-2",
					name: "routine",
					arguments: { action: "reset_progress", routineId: WATCH_ROUTINE_ID },
				},
			]),
			{
				name: "j4-rp-reset-answer",
				check: (request) => {
					const results = latestBatchResults(request).filter((entry) => entry.toolName === "routine");
					expect(
						results.map((entry) => entry.isError),
						results.map((entry) => entry.text).join(" | "),
					).toEqual([false, false]);
					resetDone.release();
				},
				reply: { content: [{ type: "text", text: "Progress cleared." }] },
			},
		);

		world.systemOne.enterPhase("j4-rp-reset", INTAKE_JUDGMENTS_WITHOUT_GRANT);
		await withDeadline(
			trace,
			"the owner resets progress on both routines",
			session.prompt("Clear the progress notes on both routines."),
		);
		await withDeadline(trace, "reset turn finished", resetDone.promise);
		await withDeadline(trace, "session idle after reset", session.waitForForegroundIdle());

		const statusAfterReset = await session.autonomyStatus();
		const resetItems =
			statusAfterReset.routines.status === "available" ? statusAfterReset.routines.value.routines.items : [];
		expect(
			resetItems
				.filter((item) => item.routineId === ROUTINE_ID || item.routineId === WATCH_ROUTINE_ID)
				.map((item) => [item.routineId, item.progressLine]),
			"reset_progress clears progressLine on both routines",
		).toEqual(
			expect.arrayContaining([
				[ROUTINE_ID, undefined],
				[WATCH_ROUTINE_ID, undefined],
			]),
		);
	} finally {
		scriptedWatch.restore();
	}

	expect(await world.disposeSessionInBody(session), "the routine progress session closes").toBeUndefined();
	trace.mark("root", "routine-progress.closed");
}
