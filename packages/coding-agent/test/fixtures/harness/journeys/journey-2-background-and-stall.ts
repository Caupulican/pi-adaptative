import "../builtin-install.ts";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import {
	type BackgroundToolTaskRecord,
	loadBackgroundToolTaskRecordsNewestFirst,
} from "../../../../src/core/background-tool-task-controller.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "../../../../src/core/default-tool-surface.ts";
import { DEFAULT_GOAL_WORKER_WAIT_MS } from "../../../../src/core/goals/goal-continuation-defaults.ts";
import { buildObjectiveRoutePrompt } from "../../../../src/core/goals/goal-continuation-prompt.ts";
import { editPersistedGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import type { ObjectiveRoute } from "../../../../src/core/objective-execution/objective-route.ts";
import { goalObjectiveId } from "../../../../src/core/orchestration/work-state-projection.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import { calls, createBarrier, HARNESS_PROVIDER, type ScriptedRequest, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { verifyEvaluationOccupancy } from "./journey-2-evaluation-occupancy.ts";

/**
 * The real proper-lockfile runs its exclusion and lease logic; only its filesystem is redirected to the
 * active world's virtual fs through the library's own `fs` option, so no lock directory reaches disk.
 * The library's CJS export object is the one production's default import receives, so its functions
 * are rebound in place rather than through an ESM module mock.
 */
import {
	assertBatchOk,
	backgroundTaskIdOf,
	dynamicCalls,
	handoffFor,
	lastToolResultDetails,
	requestTexts,
} from "./shared.ts";

export async function runJourney2BackgroundAndStallPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	// R18-R20, System One off: a background terminal whose wake-up the session file refuses. An auxiliary root with no goal starts a
	// held echo in the background; once it ends while the root is idle, the wake-up message's append is denied, and that one refused
	// write leaves its outcome unknown and fences the SessionManager: the first attempt reports that unknown outcome, and every later
	// attempt is refused by the fence before any write, which is a changed cause and is reported once. The retries run on the
	// virtual background-tool-task timers until the queue parks; reopening the canonical file clears the fence, and the next
	// background task start re-arms the parked wake-up. With System One on these turns ask questions no reading derives, so the
	// rows declare off only.
	if (!world.systemOne.enabled) {
		const WAKE_OWNER = "background-tool-task";
		const FENCE =
			"Session persistence state is uncertain after a failed write; reopen the session file or start a new session before appending.";
		const UNCERTAIN =
			"Session write outcome is unknown; reconcile the original session history before retrying these messages.";
		const LADDER = [100, 200, 400, 800, 1_600, 3_200, 3_200, 3_200, 3_200];
		const parkAux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
		const parkSession = parkAux.session;
		const taskRecord = (taskId: string | undefined): BackgroundToolTaskRecord | undefined =>
			loadBackgroundToolTaskRecordsNewestFirst(parkAux.sessionManager).find(
				(record): record is BackgroundToolTaskRecord => isRecordObject(record) && record.taskId === taskId,
			);
		// The task ids of every wake-up message the session file holds, in order: a refused append never enters it.
		const wakeTaskIds = (): unknown[][] =>
			parkAux.sessionManager.getEntries().flatMap((entry) => {
				if (entry.type !== "custom_message" || entry.customType !== "background-tool-completion") return [];
				const records = isRecordObject(entry.details) ? entry.details.records : undefined;
				return [
					Array.isArray(records)
						? records.map((record: unknown) => (isRecordObject(record) ? record.taskId : undefined))
						: [],
				];
			});
		const firstGate = createBarrier();
		const secondGate = createBarrier();
		const rearmedWake = createBarrier();
		const secondWake = createBarrier();
		const firstRefusal = createBarrier();
		const parked = createBarrier();
		const ids: { first?: string; second?: string } = {};
		world.systemOne.enterPhase("r18-wake-park", {});
		expect(
			world.timers.armedDelays(WAKE_OWNER),
			"no background-tool-task alarm is armed when the R18 root opens",
		).toEqual([]);
		world.shell.enqueue({
			name: "r18-first",
			command: "echo r18-first",
			output: "r18-first\n",
			exitCode: 0,
			gate: firstGate.promise,
		});
		world.provider.enqueue(
			"root",
			calls("r18-start", [
				{ id: "r18-bg-1", name: "bash", arguments: { command: "echo r18-first", background: true } },
			]),
			{
				name: "r18-started",
				check: (request) => {
					ids.first = backgroundTaskIdOf(request);
				},
				reply: { content: [{ type: "text", text: "The first check runs in the background." }] },
			},
		);
		await withDeadline(trace, "R18 background start", parkSession.prompt("Start the first check in the background."));
		await withDeadline(trace, "R18 start settled", parkSession.waitForForegroundIdle());
		const parkFile = parkAux.sessionManager.getSessionFile();
		if (parkFile === undefined) throw new Error("the R18 root has no session file");
		if (ids.first === undefined) throw new Error("the R18 start result carried no task id");
		const retryingUncertain = `Failed to notify terminal background tool task batch ${ids.first} (retrying): ${UNCERTAIN}`;
		const retrying = `Failed to notify terminal background tool task batch ${ids.first} (retrying): ${FENCE}`;
		const parkedText = `Background tool completion wake-up for ${ids.first} is parked after 10 consecutive failed deliveries (still pending; the session file refused a write and accepts no append until the session is reopened; delivery resumes then; tool_task action=wait collects it now): ${FENCE}`;
		// Every warning this root emits from here on, in order.
		const parkWarnings: string[] = [];
		const unsubscribeParkWarnings = parkSession.subscribe((event) => {
			if (event.type !== "warning") return;
			parkWarnings.push(event.message);
			if (event.message.startsWith("Failed to notify terminal background tool task batch ")) firstRefusal.release();
			if (event.message.startsWith("Background tool completion wake-up for ")) parked.release();
		});
		try {
			// Only the wake-up message's own append is denied: the terminal record before it is persisted pending.
			const denial = world.io.denyUntilCleared({
				name: "r18-wake-append-refused",
				kind: "append",
				code: "EIO",
				matches: (operation, data) =>
					operation.path === parkFile && data?.includes('"customType":"background-tool-completion"') === true,
			});
			firstGate.release();
			await withDeadline(trace, "R18 first wake-up refused", firstRefusal.promise);
			expect(parkWarnings, "the first refused wake-up reports its unknown write outcome as its cause").toEqual([
				retryingUncertain,
			]);
			expect(denial.hits, "the denial refused the wake-up's own append once").toBe(1);
			expect(taskRecord(ids.first)?.status, "the held echo's terminal record is completed").toBe("completed");
			expect(taskRecord(ids.first)?.terminalDelivery, "the refused terminal stays pending on the branch").toBe(
				"pending",
			);
			expect(wakeTaskIds(), "no wake-up message reached the session file").toEqual([]);
			world.faultMatrix.witness("R18", { control: false });
			// The ladder: nine retries at the capped doubling delays, each the only alarm of its owner; the tenth failure parks.
			const delays: number[] = [];
			const fired: number[] = [];
			for (const [index, expected] of LADDER.entries()) {
				delays.push(await withDeadline(trace, `R19 retry ${index + 1} armed`, world.timers.whenArmed(WAKE_OWNER)));
				expect(world.timers.armedDelays(WAKE_OWNER), `retry ${index + 1} is the only armed alarm`).toEqual([
					expected,
				]);
				fired.push(world.timers.advance(WAKE_OWNER, expected));
			}
			await withDeadline(trace, "R19 wake-up parked", parked.promise);
			expect(delays, "the retries climb 100, 200, 400, 800, 1600 ms and hold at 3200 ms").toEqual(LADDER);
			expect(fired, "each advance fires exactly its retry").toEqual(LADDER.map(() => 1));
			expect(
				parkWarnings,
				"one retrying report per distinct cause (unknown outcome, then the fence), then the park",
			).toEqual([retryingUncertain, retrying, parkedText]);
			expect(world.timers.armedDelays(WAKE_OWNER), "a parked queue arms no retry").toEqual([]);
			expect(world.timers.advance(WAKE_OWNER, 5_000), "past the capped delay, a parked queue fires nothing").toBe(0);
			expect(denial.hits, "every retry was refused by the fence before any write").toBe(1);
			expect(taskRecord(ids.first)?.terminalDelivery, "the parked terminal is still pending").toBe("pending");
			world.faultMatrix.witness("R19", { control: false });
			expect(denial.clear(), "the denial refused one append in all").toBe(1);
			// The fence's own recovery: the refused write never reached the file, so its canonical prefix ends at a record boundary.
			parkAux.sessionManager.setSessionFile(parkFile);
			world.shell.enqueue({
				name: "r20-second",
				command: "echo r20-second",
				output: "r20-second\n",
				exitCode: 0,
				gate: secondGate.promise,
			});
			world.provider.enqueue(
				"root",
				calls("r20-start", [
					{ id: "r20-bg-1", name: "bash", arguments: { command: "echo r20-second", background: true } },
				]),
				{
					name: "r20-started",
					check: (request) => {
						ids.second = backgroundTaskIdOf(request);
					},
					reply: { content: [{ type: "text", text: "The second check runs in the background." }] },
				},
				{
					name: "r20-rearmed-wake",
					check: (request) => {
						if (ids.first === undefined || !handoffFor(request, ids.first))
							throw new Error("the re-armed wake-up does not reach the idle root");
						rearmedWake.release();
					},
					reply: { content: [{ type: "text", text: "The first check handed off." }] },
				},
				{
					name: "r20-second-wake",
					check: (request) => {
						if (ids.second === undefined || !handoffFor(request, ids.second))
							throw new Error("the second terminal does not reach the idle root");
						secondWake.release();
					},
					reply: { content: [{ type: "text", text: "The second check handed off." }] },
				},
			);
			// The second task's start is the re-arming event; its own terminal stays held until the parked one is delivered.
			await withDeadline(
				trace,
				"R20 re-arming start",
				parkSession.prompt("Start the second check in the background."),
			);
			await withDeadline(trace, "R20 parked wake-up delivered", rearmedWake.promise);
			await withDeadline(trace, "R20 parked wake-up settled", parkSession.waitForForegroundIdle());
			expect(ids.second, "the re-arming start reported its own task id").toBeDefined();
			expect(taskRecord(ids.first)?.terminalDelivery, "the re-armed terminal is recorded delivered").toBe(
				"delivered",
			);
			expect(wakeTaskIds(), "the session file holds exactly the re-armed wake-up, for the parked task").toEqual([
				[ids.first],
			]);
			world.faultMatrix.witness("R20", { control: false });
			secondGate.release();
			await withDeadline(trace, "R20 second terminal delivered", secondWake.promise);
			await withDeadline(trace, "R20 second terminal settled", parkSession.waitForForegroundIdle());
			expect(taskRecord(ids.second)?.terminalDelivery, "the re-arming task's own terminal is delivered").toBe(
				"delivered",
			);
			expect(wakeTaskIds(), "its wake-up follows the re-armed one").toEqual([[ids.first], [ids.second]]);
			world.faultMatrix.witness("R20", { control: true });
			expect(world.timers.armedDelays(WAKE_OWNER), "a delivery accepted at its first attempt arms no retry").toEqual(
				[],
			);
			expect(parkWarnings, "no refusal follows the reopened file").toEqual([
				retryingUncertain,
				retrying,
				parkedText,
			]);
			world.faultMatrix.witness("R19", { control: true });
		} finally {
			unsubscribeParkWarnings();
		}
		expect(await world.disposeSessionInBody(parkSession), "the R18 auxiliary root disposes cleanly").toBeUndefined();
		trace.mark("root", "r18-wake-park");
	}
	// R40e, System One off: a root whose terminal-task cache holds one task hands off two tool tasks whose output exceeds the inline
	// bound. The second terminal evicts the first from the cache; a wait on the evicted task still returns its saved record, and the
	// artifact that record cites reads back whole. The retained second task's wait, answered from the cache, is the control.
	if (!world.systemOne.enabled) {
		const r40e = await world.createRootSession("root", {
			sessionManager: world.createSessionManager(),
			// The world's allow-list leaves artifact_retrieve out, and a task result names no artifact its model cannot read.
			settings: { defaultTools: [...DEFAULT_ACTIVE_TOOL_NAMES, "worktree_sync", "artifact_retrieve"] },
			maxRetainedTerminalTasks: 1,
		});
		const r40eSession = r40e.session;
		// 1,300 distinct lines of 30 bytes: over the controller's inline caps (32 KiB, 400 lines) and under the bash tool's own
		// (50 KiB, 2,000 lines), so the controller sees the whole output and no reducer finds a repeat to collapse.
		const hex = (value: number): string => ((value * 2654435761) >>> 0).toString(16).padStart(8, "0");
		const bigOutput = (marker: string): string =>
			`${marker}-HEAD\n${Array.from({ length: 1_300 }, (_, line) => `${String(line).padStart(4, "0")} ${hex(line)}${hex(line + 7)}${hex(line + 13)}\n`).join("")}${marker}-TAIL\n`;
		const r40eIds: { first?: string; second?: string } = {};
		const r40eArtifacts: { first?: string; second?: string; retrieved?: string } = {};
		const r40eSeen: { evictedWait?: string; evictedDetails?: unknown; list?: string; retained?: unknown } = {};
		const batchDetails = (request: ScriptedRequest): Array<{ toolName: string; text: string; details: unknown }> => {
			const messages = request.context.messages;
			let start = messages.length;
			while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
			return messages.slice(start).flatMap((message) =>
				message.role === "toolResult"
					? [
							{
								toolName: message.toolName,
								text: message.content
									.map((block) => (block.type === "text" ? block.text : block.type))
									.join("\n"),
								details: message.details,
							},
						]
					: [],
			);
		};
		const detailField = (details: unknown, key: string): string | undefined =>
			isRecordObject(details) && typeof details[key] === "string" ? details[key] : undefined;
		world.shell.enqueue(
			{ name: "r40e-first", command: "echo r40e-first", output: bigOutput("R40E-FIRST"), exitCode: 0 },
			{ name: "r40e-second", command: "echo r40e-second", output: bigOutput("R40E-SECOND"), exitCode: 0 },
		);
		world.provider.enqueue(
			"root",
			calls("r40e-start", [
				{ id: "r40e-bg-1", name: "bash", arguments: { command: "echo r40e-first", background: true } },
				{ id: "r40e-bg-2", name: "bash", arguments: { command: "echo r40e-second", background: true } },
			]),
			dynamicCalls(
				"r40e-wait-both",
				(request) => {
					const [first, second] = batchDetails(request).map((result) => detailField(result.details, "taskId"));
					r40eIds.first = first;
					r40eIds.second = second;
					return [
						{
							id: "r40e-wait-1",
							name: "tool_task",
							arguments: { action: "wait", taskId: first, timeoutMs: 60_000 },
						},
						{
							id: "r40e-wait-2",
							name: "tool_task",
							arguments: { action: "wait", taskId: second, timeoutMs: 60_000 },
						},
					];
				},
				undefined,
			),
			dynamicCalls(
				"r40e-wait-evicted",
				(request) => {
					const [first, second] = batchDetails(request);
					r40eArtifacts.first = detailField(first?.details, "artifactId");
					r40eArtifacts.second = detailField(second?.details, "artifactId");
					return [
						{
							id: "r40e-wait-3",
							name: "tool_task",
							arguments: { action: "wait", taskId: r40eIds.first, timeoutMs: 60_000 },
						},
						{
							id: "r40e-wait-4",
							name: "tool_task",
							arguments: { action: "wait", taskId: r40eIds.second, timeoutMs: 60_000 },
						},
						{ id: "r40e-list-1", name: "tool_task", arguments: { action: "list" } },
					];
				},
				undefined,
			),
			dynamicCalls("r40e-retrieve", (request) => {
				const [evicted, retained, list] = batchDetails(request);
				r40eSeen.evictedWait = evicted?.text;
				r40eSeen.evictedDetails = evicted?.details;
				r40eSeen.retained = retained?.details;
				r40eSeen.list = list?.text;
				return [
					{
						id: "r40e-retrieve-1",
						name: "artifact_retrieve",
						arguments: { artifactId: r40eArtifacts.first, mode: "tail", maxLines: 3 },
					},
				];
			}),
			{
				name: "r40e-done",
				check: (request) => {
					r40eArtifacts.retrieved = batchDetails(request)[0]?.text;
				},
				reply: { content: [{ type: "text", text: "The evicted task's output reads back." }] },
			},
		);
		world.systemOne.enterPhase("r40e", {});
		await withDeadline(
			trace,
			"R40e hands off two oversized tool tasks",
			r40eSession.prompt("Hand off two oversized checks and read the first back after the cache evicts it."),
		);
		await withDeadline(trace, "R40e settled", r40eSession.waitForForegroundIdle());
		expect(
			{
				firstArtifactSet: r40eArtifacts.first !== undefined,
				artifactsDiffer: r40eArtifacts.first !== r40eArtifacts.second,
				evictedStatus: detailField(r40eSeen.evictedDetails, "status"),
				evictedArtifact: detailField(r40eSeen.evictedDetails, "artifactId") === r40eArtifacts.first,
				evictedNamesArtifact: r40eSeen.evictedWait?.includes(`artifact tool-output:${r40eArtifacts.first}`),
				retainedArtifact: detailField(r40eSeen.retained, "artifactId") === r40eArtifacts.second,
				listMentionsRetained: r40eSeen.list?.includes(r40eIds.second ?? "no-second-id"),
				listMentionsEvicted: r40eSeen.list?.includes(r40eIds.first ?? "no-first-id"),
				artifactTail: r40eArtifacts.retrieved?.includes("R40E-FIRST-TAIL")
					? "the tail marker"
					: `no tail marker in: ${r40eArtifacts.retrieved?.slice(0, 400)}`,
			},
			"the evicted task is no longer in the cache, yet its wait returns its saved record and its artifact reads back whole",
		).toEqual({
			firstArtifactSet: true,
			artifactsDiffer: true,
			evictedStatus: "completed",
			evictedArtifact: true,
			evictedNamesArtifact: true,
			retainedArtifact: true,
			listMentionsRetained: true,
			listMentionsEvicted: false,
			artifactTail: "the tail marker",
		});
		world.faultMatrix.witness("R40e", { control: false });
		world.faultMatrix.witness("R40e", { control: true });
		expect(await world.disposeSessionInBody(r40eSession), "the R40e root disposes cleanly").toBeUndefined();
		trace.mark("root", "r40e-retired-task");
	}
	// R50l, System One off: the tool recovery log worker loses its transport while it acknowledges a batch, then a respawned worker
	// acknowledges the next one, and a closing session's flush is bounded past an acknowledgement that never arrives. Each turn is one
	// failed tool call, so one record reaches the logger; the stats the health report prints are read after each step.
	if (!world.systemOne.enabled) {
		const LOG_OWNER = "tool-recovery-log";
		const logAux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
		const logSession = logAux.session;
		const logThreads = world.guard.threads;
		const loggerLine = (): string | undefined =>
			logSession
				.formatToolRepairHealthReport()
				.split("\n")
				.find((line) => line.startsWith("recovery logging:"));
		const failureTurn = (name: string, taskId: string): void => {
			world.provider.enqueue(
				"root",
				calls(`${name}-call`, [{ id: `${name}-1`, name: "tool_task", arguments: { action: "wait", taskId } }]),
				text(`${name}-reply`, "The wait failed."),
			);
		};
		world.systemOne.enterPhase("r50l", {});
		// The first batch is acknowledged by the first worker: the control.
		failureTurn("r50l-ok", "tool-task-901");
		await withDeadline(
			trace,
			"R50l acknowledged failure turn",
			logSession.prompt("Wait on a task that does not exist."),
		);
		await withDeadline(trace, "R50l acknowledged batch", logSession.flushToolRecoveryLogsForTests());
		expect(loggerLine(), "an acknowledged batch leaves one worker, no crash and nothing dropped").toBe(
			"recovery logging: enabled queued=0 inFlight=0 dropped=0 failures=0 workerStarts=1 crashes=0 respawns=0",
		);
		world.faultMatrix.witness("R50l", { control: true });
		// The second batch's acknowledgement cannot be delivered: the worker ends, the batch is dropped, the logger respawns.
		logThreads.replaceNextResult("r50l-lost-ack", "ack", () => true, Symbol("r50l-uncloneable"));
		failureTurn("r50l-lost", "tool-task-902");
		await withDeadline(trace, "R50l lost-ack failure turn", logSession.prompt("Wait on another missing task."));
		await withDeadline(trace, "R50l lost-ack settled", logSession.flushToolRecoveryLogsForTests());
		expect(loggerLine(), "the lost acknowledgement is one crash that drops its batch and allows one respawn").toBe(
			"recovery logging: enabled queued=0 inFlight=0 dropped=1 failures=1 workerStarts=1 crashes=1 respawns=1",
		);
		world.faultMatrix.witness("R50l", { control: false });
		// The next record starts the respawned worker, whose acknowledgement lands.
		failureTurn("r50l-respawn", "tool-task-903");
		await withDeadline(trace, "R50l respawn failure turn", logSession.prompt("Wait on a third missing task."));
		await withDeadline(trace, "R50l respawned batch", logSession.flushToolRecoveryLogsForTests());
		expect(loggerLine(), "the respawned worker acknowledges the next batch").toBe(
			"recovery logging: enabled queued=0 inFlight=0 dropped=1 failures=1 workerStarts=2 crashes=1 respawns=1",
		);
		expect(
			logSession.formatToolRepairHealthReport().includes("execution failures: total=3"),
			"all three failed calls were counted, whatever happened to their batches",
		).toBe(true);
		// A held acknowledgement at the close: the flush waits its 200 ms bound, then the session closes without it.
		const heldAck = logThreads.holdNextResponse("r50l-held-ack", "ack");
		failureTurn("r50l-held", "tool-task-904");
		await withDeadline(trace, "R50l held-ack failure turn", logSession.prompt("Wait on a fourth missing task."));
		await withDeadline(trace, "R50l acknowledgement held", heldAck.reached);
		let closed = false;
		const closing = world.disposeSessionInBody(logSession).finally(() => {
			closed = true;
		});
		const flushDelay = await withDeadline(trace, "R50l close flush armed", world.timers.whenArmed(LOG_OWNER));
		expect(closed, "the close waits for the held acknowledgement inside its bound").toBe(false);
		expect(world.timers.advance(LOG_OWNER, flushDelay), "the bound fires once").toBe(1);
		expect(
			await withDeadline(trace, "R50l close past the bound", closing),
			"the close ends past the bound",
		).toBeUndefined();
		expect(flushDelay, "the close flush is bounded at 200 ms").toBe(200);
		heldAck.release();
		trace.mark("root", "r50l-recovery-log");
	}
	// E9 stall threshold, legacy goal mode: an auxiliary root holds an open requirement and its initial turn is held after admission.
	// The goal loop waits for that turn to settle, then twenty-one text-only continuation turns each record an implicit no_progress.
	if (!world.systemOne.enabled) {
		const e9Aux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
		const e9Session = e9Aux.session;
		const e9InitialReached = createBarrier();
		const e9Gate = createBarrier();
		const e9Seen: { snapshot?: ReturnType<typeof e9Session.getGoalRuntimeSnapshot>; recovery?: boolean } = {};
		world.provider.enqueue(
			"root",
			calls("e9-goal-start", [
				{
					id: "e9-goal-1",
					name: "goal",
					arguments: { action: "start", goalId: "e9-goal", userGoal: "Keep the limit at 5." },
				},
			]),
			calls("e9-requirement", [
				{
					id: "e9-req-1",
					name: "goal",
					arguments: { action: "add_requirement", text: "MAX_RETRIES equals 5" },
				},
			]),
			text("e9-goal-ready", "The goal is ready."),
			{
				name: "e9-initial",
				check: () => e9InitialReached.release(),
				gate: e9Gate.promise,
				reply: { content: [{ type: "text", text: "Working on the goal." }] },
			},
		);
		for (let turn = 1; turn <= 21; turn += 1) {
			world.provider.enqueue(
				"root",
				turn === 21
					? {
							name: "e9-continuation-21",
							check: (request) => {
								e9Seen.snapshot = e9Session.getGoalRuntimeSnapshot({ maxStallTurns: 20 });
								e9Seen.recovery = requestTexts(request).some((value) =>
									value.includes("RECOVERY REQUIRED: 20 turns"),
								);
							},
							reply: { content: [{ type: "text", text: "No change yet." }] },
						}
					: text(`e9-continuation-${turn}`, "No change yet."),
			);
		}
		world.systemOne.enterPhase("e9-goal", {});
		await withDeadline(trace, "E9 goal ready", e9Session.prompt("Set up the goal.", { autoContinueGoal: false }));
		const e9Before = e9Session.getGoalRuntimeSnapshot({ maxStallTurns: 20 });
		expect(e9Before.continuation.openRequirementIds.length, "the setup leaves exactly one open requirement").toBe(1);
		const e9Initial = e9Session.prompt("Work on the goal.", { autoContinueGoal: false });
		await withDeadline(trace, "E9 initial turn admitted", e9InitialReached.promise);
		const e9Loop = e9Session.continueGoalLoop({ maxTurns: 21, maxStallTurns: 20 });
		e9Gate.release();
		await withDeadline(trace, "E9 initial turn", e9Initial);
		const e9Result = await withDeadline(trace, "E9 goal loop", e9Loop, 300_000);
		const e9Snapshot = e9Seen.snapshot;
		expect(e9Snapshot?.goalState?.goalId, "the loop reaches the aux goal's twenty-first request").toBe("e9-goal");
		expect(e9Snapshot?.goalState?.progressRevision, "no progress was recorded, so the revision is unchanged").toBe(
			e9Before.goalState?.progressRevision,
		);
		expect(e9Snapshot?.continuation.action, "the stall threshold continues, it never stops").toBe("continue");
		expect(e9Snapshot?.continuation.reasonCode, "the threshold is named stall_limit_reached").toBe(
			"stall_limit_reached",
		);
		expect(e9Snapshot?.continuation.stallTurns, "twenty unchanged turns have run").toBe(20);
		expect(e9Snapshot?.continuation.maxStallTurns, "the configured threshold is twenty").toBe(20);
		expect(e9Snapshot?.continuation.openRequirementIds, "the open requirement stays open").toEqual(
			e9Before.continuation.openRequirementIds,
		);
		expect(e9Seen.recovery, "the twenty-first continuation carries the recovery instruction").toBe(true);
		expect(e9Result.stopReason, "the host invocation cap ends the loop after twenty-one turns").toBe(
			"max_turns_reached",
		);
		expect(e9Result.turnsSubmitted, "twenty-one continuation turns were submitted").toBe(21);
		expect(
			await world.disposeSessionInBody(e9Session),
			"the E9 auxiliary goal root disposes cleanly",
		).toBeUndefined();
		trace.mark("root", "e9-stall-legacy");
	}
	// E9 ON is host-driven: explicit continueGoalLoop({ maxTurns: 1 }) calls drive each cycle. The setup prompt passes
	// autoContinueGoal:false, so no scheduled auto-continue runs in this block. This qualifies E9 only; the default workflow and
	// global continuation policy are unchanged.
	// E9 stall threshold, objective-primary mode: three one-turn goal cycles on one objective. The first two route to implement with equal
	// reason codes; the third repeats the strategy and replans. Each route is read from the native controller and matched to its ledger row by cycle.
	if (world.systemOne.enabled) {
		const e9Aux = await world.createRootSession("root", { sessionManager: world.createSessionManager() });
		const e9Session = e9Aux.session;
		world.provider.enqueue(
			"root",
			calls("e9-goal-start", [
				{
					id: "e9-goal-1",
					name: "goal",
					arguments: { action: "start", goalId: "e9-goal", userGoal: "Keep the limit at 5." },
				},
			]),
			calls("e9-requirement", [
				{
					id: "e9-req-1",
					name: "goal",
					arguments: { action: "add_requirement", text: "MAX_RETRIES equals 5" },
				},
			]),
			text("e9-goal-ready", "The goal is ready."),
		);
		world.systemOne.enterPhase("e9-goal", {
			capabilities_authorized: { kind: "noul", probability: 0.02 },
			changes_model_pools: { kind: "noul", probability: 0.02 },
			local_commits_only: { kind: "noul", probability: 0.02 },
			lifts_delivery_block: { kind: "noul", probability: 0.02 },
			full_handoff: { kind: "noul", probability: 0.02 },
			optional_tool_0: { kind: "choice", choice: "unchanged", confidence: 0.97 },
			action_accomplished_step: { kind: "noul", probability: 0.02 },
			conclusions_supported: { kind: "noul", probability: 0.97 },
			scope_violation: { kind: "noul", probability: 0.02 },
			unrelated_behavior_change: { kind: "noul", probability: 0.02 },
			replan_required: { kind: "noul", probability: 0.02 },
			next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
		});
		await withDeadline(trace, "E9 goal ready", e9Session.prompt("Set up the goal.", { autoContinueGoal: false }));
		expect(
			e9Session.getGoalRuntimeSnapshot({ maxStallTurns: 20 }).continuation.openRequirementIds.length,
			"the setup leaves exactly one open requirement",
		).toBe(1);
		// The cycle pattern of the orchestration objective cycle, routed to the executable edit path; the third cycle reports a repeated strategy.
		// Judgment groups by cycle. Objective intake is asked once, in the first cycle; the implement turn is checked for its patch and side effects;
		// the replan turn is checked for its repairs. The strategy_repetition answer is the only difference between the implement and replan groups.
		const e9Intake = {
			objective_coherent: { kind: "noul", probability: 0.97 },
			ambiguity_severity: { kind: "score", level: 0, confidence: 1 },
			missing_information: { kind: "noul", probability: 0.02 },
			acceptance_complete: { kind: "noul", probability: 0.97 },
			grounding_sufficient: { kind: "noul", probability: 0.97 },
		} as const;
		const e9Shared = {
			work_remaining: { kind: "noul", probability: 0.97 },
			missing_work_class: { kind: "choice", choice: "implement", confidence: 0.97 },
			evidence_sufficient: { kind: "noul", probability: 0.97 },
			semantic_progress: { kind: "score", level: 1, confidence: 0.97 },
			context_stale: { kind: "noul", probability: 0.02 },
			independent_worker_required: { kind: "noul", probability: 0.02 },
			capability_escalation_required: { kind: "noul", probability: 0.02 },
			capability_gap_suspected: { kind: "noul", probability: 0.02 },
			completion_plausible: { kind: "noul", probability: 0.02 },
			step_relevant: { kind: "noul", probability: 0.97 },
			evidence_sufficient_to_act: { kind: "noul", probability: 0.97 },
			unsupported_assumption_present: { kind: "noul", probability: 0.02 },
			route: { kind: "choice", choice: "edit", confidence: 0.97 },
			claim_supported: { kind: "noul", probability: 0.97 },
			action_accomplished_step: { kind: "noul", probability: 0.02 },
			conclusions_supported: { kind: "noul", probability: 0.97 },
			scope_violation: { kind: "noul", probability: 0.02 },
			unrelated_behavior_change: { kind: "noul", probability: 0.02 },
			replan_required: { kind: "noul", probability: 0.02 },
			next_status: { kind: "choice", choice: "continue", confidence: 0.97 },
		} as const;
		const e9Implement = {
			strategy_repetition: { kind: "noul", probability: 0.02 },
			patch_matches_requirements: { kind: "noul", probability: 0.97 },
			side_effects_acceptable: { kind: "noul", probability: 0.97 },
		} as const;
		const e9Replan = {
			strategy_repetition: { kind: "noul", probability: 0.97 },
			repairs_sufficient: { kind: "noul", probability: 0.97 },
			root_cause_addressed: { kind: "noul", probability: 0.97 },
		} as const;
		const e9CycleJudgments = (cycle: number): Parameters<typeof world.systemOne.enterPhase>[1] => {
			if (cycle === 1) return { ...e9Shared, ...e9Intake, ...e9Implement };
			if (cycle === 2) return { ...e9Shared, ...e9Implement };
			return { ...e9Shared, ...e9Replan };
		};
		// The transport text each cycle's root request actually received, keyed by cycle.
		const e9CycleTexts = new Map<number, string[]>();
		// The E9 intake criteria bound to the native objective, counted before each answer; the cycle-1 callback is their only producer.
		const e9IntakeBinding = { criteria: 0 };
		const e9Routes: ObjectiveRoute[] = [];
		for (const cycle of [1, 2, 3]) {
			world.systemOne.enterPhase(
				`e9-cycle-${cycle}`,
				e9CycleJudgments(cycle),
				cycle === 1
					? {
							expect: (request) => {
								if (!isRecordObject(request.state) || !("acceptanceCriteria" in request.state)) return;
								const record =
									e9Session.backgroundLanes.getTaskRuntimeSnapshot()?.objectives[goalObjectiveId("e9-goal")]
										?.objective;
								if (record === undefined)
									throw new Error("the native runtime holds no objective for the E9 goal at intake");
								const requirements = e9Session.getGoalStateSnapshot()?.requirements ?? [];
								const decoded = request.state.acceptanceCriteria;
								if (!Array.isArray(decoded))
									throw new Error("the E9 intake carries no acceptance criteria list");
								expect(decoded.length, "the intake transports every native acceptance criterion").toBe(
									record.acceptanceCriteria.length,
								);
								for (const [index, native] of record.acceptanceCriteria.entries()) {
									const item: unknown = decoded[index];
									const requirement = requirements.find((candidate) => candidate.id === native.id);
									expect(
										isRecordObject(item) && item.id === native.id && item.description === native.description,
										`intake criterion ${index} is the native objective criterion`,
									).toBe(true);
									expect(
										requirement?.text === native.description,
										`intake criterion ${index} is the goal requirement text`,
									).toBe(true);
									e9IntakeBinding.criteria += 1;
								}
							},
						}
					: undefined,
			);
			world.provider.enqueue("root", {
				name: `e9-cycle-root-${cycle}`,
				check: (request) => {
					e9CycleTexts.set(cycle, requestTexts(request));
				},
				reply: { content: [{ type: "text", text: `Objective cycle ${cycle} reply.` }] },
			});
			const result = await withDeadline(
				trace,
				`E9 cycle ${cycle}`,
				e9Session.continueGoalLoop({ maxTurns: 1, maxStallTurns: 20 }),
				120_000,
			);
			expect(result.stopReason, `cycle ${cycle} submits its one root turn`).toBe("max_turns_reached");
			expect(result.turnsSubmitted, `cycle ${cycle} submits exactly one turn`).toBe(1);
			const route = e9Session.objectiveExecutionController?.getLastRoute();
			if (route === undefined) throw new Error(`E9 cycle ${cycle} recorded no objective route`);
			e9Routes.push(route);
		}
		expect(new Set(e9Routes.map((route) => route.cycle_id)).size, "each cycle has its own route identity").toBe(3);
		expect(e9Routes[0]?.route, "the first cycle routes to implement").toBe("implement");
		expect(e9Routes[0]?.reason_codes, "the first cycle names its implementation reason").toEqual([
			"implementation_required",
		]);
		expect(e9Routes[1]?.route, "the second cycle routes to implement as well").toBe("implement");
		expect(e9Routes[1]?.reason_codes, "the first two routes carry equal reason codes").toEqual(
			e9Routes[0]?.reason_codes,
		);
		expect(e9Routes[2]?.route, "the third cycle replans on the repeated strategy").toBe("replan");
		expect(e9Routes[2]?.reason_codes, "the third route names the repeated strategy").toEqual([
			"strategy_repetition_detected",
		]);
		for (const [index, route] of e9Routes.entries()) {
			const owner = buildObjectiveRoutePrompt(route).text;
			expect(
				e9CycleTexts.get(index + 1)?.some((value) => value.includes(owner)) ?? false,
				`cycle ${index + 1} transport carries the owner route text for ${route.route}`,
			).toBe(true);
		}
		expect(e9IntakeBinding.criteria, "the E9 intake binds the native criteria before its answer").toBeGreaterThan(0);
		const e9Objective = e9Routes[0]?.objective_id;
		if (e9Objective === undefined) throw new Error("E9 has no objective id");
		const e9Ledger = e9Session.getDecisionLedger()?.recentRoutes(e9Session.sessionId, e9Objective, 8) ?? [];
		const e9Matched = e9Routes.map((route) => e9Ledger.filter((row) => row.cycleId === route.cycle_id));
		e9Matched.forEach((rows, index) => {
			const route = e9Routes[index];
			if (route === undefined) throw new Error("E9 route index out of range");
			expect(rows, `cycle ${route.cycle_id} has exactly one ledger row`).toHaveLength(1);
			const [row] = rows;
			expect(row?.route, `the ledger row for cycle ${route.cycle_id} carries the route`).toBe(route.route);
			expect(
				row?.reasonCodes,
				`the ledger row for cycle ${route.cycle_id} carries the route's reason codes`,
			).toEqual(route.reason_codes);
			expect(row?.executor, `cycle ${route.cycle_id} is executed by the root`).toBe("root");
			expect(typeof row?.evidenceMarker, `cycle ${route.cycle_id} row carries a numeric evidence marker`).toBe(
				"number",
			);
		});
		const e9Markers = e9Matched.map((rows) => rows[0]?.evidenceMarker);
		expect(
			e9Markers,
			"the three matched rows share one evidence marker: no new evidence separates the replan from the implement cycles",
		).toEqual([e9Markers[0], e9Markers[0], e9Markers[0]]);
		expect(
			await world.disposeSessionInBody(e9Session),
			"the E9 auxiliary objective root disposes cleanly",
		).toBeUndefined();
		trace.mark("root", "e9-stall-objective");
	}
	await verifyGoalWorkerDeadlineAndQuietHandoff(world);
	await verifyGoalAutoContinueWake(world);
	await verifyWorkerLeaseRenewalFailure(world);
	await verifyEvaluationOccupancy(world);
}

/**
 * R39, both modes. An auxiliary root with System One off and the owner's continuation delay at its 60 s maximum starts a goal with
 * no requirement and goes idle: the goal is active, so the idle scheduler arms its one continuation wake on the `goal-continuation`
 * port at that delay, and the port's wall timer is far beyond the witness. The armed wake is foreground occupancy, so the witness
 * waits for the arm, never for foreground idle, until the wake has fired and its pass has run. Advancing the port by one
 * millisecond less than the delay fires nothing and submits nothing (the control). The owner's budget leaves room for exactly one turn; advancing the last
 * millisecond fires the wake, its pass reads the active goal, and its one turn's charge stops the goal as budget_limited with
 * nothing armed and no warning (the fault).
 */
async function verifyGoalAutoContinueWake(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const label = "r39-goal-auto-continue";
	const WAKE_OWNER = "goal-continuation";
	const GOAL = "Keep the retry limit documented.";
	const DELAY_MS = 60_000;
	const PASS_TOKENS = 2_000;
	const agentDir = `${world.agentDir}-${label}`;
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		systemOneEnabled: false,
		settings: { memorySystem: "okf", autoLearn: { enabled: false }, autonomy: { goalAutoContinueDelayMs: DELAY_MS } },
	});
	const session = created.session;
	world.systemOne.enterPhase(label, {});
	const maxStallTurns = created.settingsManager.getAutonomySettings().maxStallTurns;
	expect(
		world.timers.armedDelays(WAKE_OWNER),
		`${label}: no goal-continuation alarm is armed before the goal starts`,
	).toEqual([]);
	world.provider.enqueue(
		"root",
		calls(`${label}-start`, [
			{ id: `${label}-goal-1`, name: "goal", arguments: { action: "start", goalId: "r39-goal", userGoal: GOAL } },
		]),
		{
			name: `${label}-started`,
			check: (request) => assertBatchOk(request, `${label}: the goal start`),
			reply: { content: [{ type: "text", text: "The goal is started." }] },
		},
	);
	const warningMark = world.warnings.length;
	await withDeadline(trace, `${label} start turn`, session.prompt("Start the retry limit goal."), 90_000);
	// The prompt's own tail arms the wake (its idle scheduling runs before prompt() resolves). A foreground-idle wait here
	// would block on that armed continuation, which is foreground occupancy, until the port's wall timer fired it with no
	// pass scripted: the witness waits for the arm itself.
	await withDeadline(trace, `${label} wake armed`, world.timers.whenArmed(WAKE_OWNER), 90_000);
	// The owner's budget leaves room for exactly one continuation turn: the pass stops at its own charge.
	const tokensUsed = session.getGoalStateSnapshot()?.tokensUsed ?? 0;
	const edited = editPersistedGoal(session, { userGoal: GOAL, tokenBudget: tokensUsed + PASS_TOKENS });
	expect(edited.ok, `${label}: the owner's budget edit is applied`).toBe(true);
	expect(
		{
			continuation: session.getGoalRuntimeSnapshot({ maxStallTurns }).continuation.action,
			armed: world.timers.armedDelays(WAKE_OWNER),
		},
		`${label}: the idle root holds one continuation wake at the owner's delay`,
	).toEqual({ continuation: "continue", armed: [DELAY_MS] });
	const passReached = createBarrier();
	const seen: { action?: string; reasonCode?: string } = {};
	world.provider.enqueue("root", {
		name: `${label}-pass`,
		check: () => {
			const decision = session.getGoalRuntimeSnapshot({ maxStallTurns }).continuation;
			seen.action = decision.action;
			seen.reasonCode = decision.reasonCode;
			passReached.release();
		},
		reply: {
			content: [{ type: "text", text: "The retry limit stays documented." }],
			usage: { ...createEmptyUsage(), output: PASS_TOKENS, totalTokens: PASS_TOKENS },
		},
	});
	const passes = () => world.provider.reached.filter((name) => name === `root:${label}-pass`).length;
	expect(
		{ fired: world.timers.advance(WAKE_OWNER, DELAY_MS - 1), passes: passes() },
		`${label}: the wake does not fire before its delay and no pass is submitted`,
	).toEqual({ fired: 0, passes: 0 });
	world.faultMatrix.witness("R39", { control: true });
	expect(world.timers.advance(WAKE_OWNER, 1), `${label}: the last millisecond of the delay fires the wake`).toBe(1);
	await withDeadline(trace, `${label} pass reached`, passReached.promise, 90_000);
	await withDeadline(trace, `${label} pass settled`, session.waitForForegroundIdle(), 90_000);
	expect(
		{
			seen,
			passes: passes(),
			status: session.getGoalStateSnapshot()?.status,
			armed: world.timers.armedDelays(WAKE_OWNER),
			warnings: world.warnings.slice(warningMark),
		},
		`${label}: the fired wake runs one pass on the active goal, whose charge stops the goal with nothing armed`,
	).toEqual({
		seen: { action: "continue", reasonCode: "goal_active" },
		passes: 1,
		status: "budget_limited",
		armed: [],
		warnings: [],
	});
	world.faultMatrix.witness("R39", { control: false });
	expect(await world.disposeSessionInBody(session), `${label}: the auxiliary root disposes cleanly`).toBeUndefined();
	trace.mark("root", label);
}

/**
 * R28, both modes. An auxiliary root with System One off starts one read-only worker and holds it at its first provider
 * request. Its lease heartbeat is the only alarm on the `worker-lease` port, at a third of the lease TTL, and nothing is armed
 * on `orchestration`, the clock the lease deadline is checked on. Advancing worker-lease by the interval renews the lease,
 * warns nothing and keeps the worker running (the control). Advancing orchestration past the renewed deadline, then
 * worker-lease by the interval, fails the renewal: the heartbeat warns and aborts the lane, the expired lease refuses the
 * attempt's final usage checkpoint and its failure record, and the lane is cancelled as worker_delegation_error. Its terminal
 * handoff wakes the idle root once, with nothing left armed on either port, and the worker is idle again (the fault).
 */
async function verifyWorkerLeaseRenewalFailure(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const label = "r28-lease-renewal";
	const LEASE_OWNER = "worker-lease";
	const CLOCK_OWNER = "orchestration";
	const agentDir = `${world.agentDir}-${label}`;
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		systemOneEnabled: false,
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
	});
	const session = created.session;
	world.systemOne.enterPhase(label, {});
	expect(
		{ root: world.provider.getPendingStepNames("root"), worker: world.provider.getPendingStepNames("worker-c") },
		`${label}: no earlier root or worker-c step is left pending`,
	).toEqual({ root: [], worker: [] });
	const workerHeld = createBarrier();
	const workerGate = createBarrier();
	world.provider.enqueue("worker-c", {
		name: `${label}-held-request`,
		check: () => workerHeld.release(),
		gate: workerGate.promise,
		reply: { content: [{ type: "text", text: "The held request is never answered." }] },
	});
	const started: { agentId?: string; laneId?: string } = {};
	world.provider.enqueue(
		"root",
		calls(`${label}-start`, [
			{
				id: `${label}-start-1`,
				name: "delegate",
				arguments: {
					action: "start",
					model: { provider: HARNESS_PROVIDER, modelId: "worker-c" },
					instructions: "Read the retry limit and report.",
					readOnly: true,
				},
			},
		]),
		{
			name: `${label}-started`,
			check: (request) => {
				assertBatchOk(request, `${label}: the worker start`);
				const details = lastToolResultDetails(session, "delegate");
				if (isRecordObject(details) && typeof details.agentId === "string") started.agentId = details.agentId;
				if (isRecordObject(details) && typeof details.laneId === "string") started.laneId = details.laneId;
			},
			reply: { content: [{ type: "text", text: "The reader is started." }] },
		},
	);
	await withDeadline(trace, `${label} start turn`, session.prompt("Start the retry limit reader."), 90_000);
	await withDeadline(trace, `${label} worker held`, workerHeld.promise, 90_000);
	const { agentId, laneId } = started;
	if (agentId === undefined || laneId === undefined) throw new Error(`${label}: no agent or lane id`);
	const runningAttempts = () =>
		Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).filter(
			(attempt) => attempt.taskId === laneId && attempt.status === "running",
		);
	const heldAttempt = runningAttempts()[0];
	const leaseTtlMs = heldAttempt?.dispatch.executionContract?.worker.profile.leaseTtlMs;
	const issuedExpiresAt = heldAttempt?.lease?.expiresAt;
	if (heldAttempt === undefined || leaseTtlMs === undefined || issuedExpiresAt === undefined) {
		throw new Error(`${label}: the held worker has no running attempt with a lease TTL and a lease`);
	}
	const attemptId = heldAttempt.attemptId;
	const leaseExpiresAt = () =>
		session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[attemptId]?.lease?.expiresAt ?? issuedExpiresAt;
	const laneRecord = () => session.getLaneRecords().find((record) => record.laneId === laneId);
	const heartbeatMs = Math.floor(leaseTtlMs / 3);
	expect(
		{ heartbeats: world.timers.armedDelays(LEASE_OWNER), clock: world.timers.armedDelays(CLOCK_OWNER) },
		`${label}: the held worker's heartbeat is the only worker-lease alarm and nothing is armed on orchestration`,
	).toEqual({ heartbeats: [heartbeatMs], clock: [] });
	const warningMark = world.warnings.length;
	expect(
		world.timers.advance(LEASE_OWNER, heartbeatMs),
		`${label}: advancing worker-lease by its interval fires the heartbeat`,
	).toBe(1);
	const renewedExpiresAt = leaseExpiresAt();
	expect(
		{
			renewed: Date.parse(renewedExpiresAt) > Date.parse(issuedExpiresAt),
			heartbeats: world.timers.armedDelays(LEASE_OWNER),
			lane: laneRecord()?.status,
			running: runningAttempts().length,
			warnings: world.warnings.slice(warningMark),
		},
		`${label}: a heartbeat inside the lease renews it, re-arms, warns nothing and keeps the worker running`,
	).toEqual({ renewed: true, heartbeats: [heartbeatMs], lane: "running", running: 1, warnings: [] });
	world.faultMatrix.witness("R28", { control: true });
	const wakeReached = createBarrier();
	const wake: { tailIsUser?: boolean; carried?: boolean; status?: string; reasonCode?: string } = {};
	world.provider.enqueue("root", {
		name: `${label}-wake`,
		check: (request) => {
			const tail = request.context.messages.at(-1);
			const record = laneRecord();
			wake.tailIsUser = tail?.role === "user";
			wake.status = record?.status;
			wake.reasonCode = record?.reasonCode;
			wake.carried = JSON.stringify(tail ?? null).includes(
				`- ${laneId}: ${record?.status} reason=${record?.reasonCode}`,
			);
			wakeReached.release();
		},
		reply: { content: [{ type: "text", text: "The reader's lease ended its run." }] },
	});
	// The lease deadline is read on the orchestration clock: moving it one millisecond past the renewed deadline expires the lease.
	const clockShiftMs = Date.parse(renewedExpiresAt) - world.timers.port(CLOCK_OWNER).now() + 1;
	expect(world.timers.advance(CLOCK_OWNER, clockShiftMs), `${label}: the orchestration shift fires nothing`).toBe(0);
	expect(
		world.timers.advance(LEASE_OWNER, heartbeatMs),
		`${label}: the next interval fires the heartbeat on the expired lease`,
	).toBe(1);
	await withDeadline(trace, `${label} wake reached`, wakeReached.promise, 90_000);
	await withDeadline(trace, `${label} wake settled`, session.waitForForegroundIdle(), 90_000);
	const expired = `Attempt '${attemptId}' lease expired.`;
	expect(
		{
			wake,
			wakes: world.provider.reached.filter((name) => name === `root:${label}-wake`).length,
			running: runningAttempts().length,
			heartbeats: world.timers.armedDelays(LEASE_OWNER),
			clock: world.timers.armedDelays(CLOCK_OWNER),
			warnings: world.warnings.slice(warningMark),
		},
		`${label}: the failed renewal aborts the lane, cancelled as worker_delegation_error, and wakes the root once`,
	).toEqual({
		wake: { tailIsUser: true, carried: true, status: "canceled", reasonCode: "worker_delegation_error" },
		wakes: 1,
		running: 0,
		heartbeats: [],
		clock: [],
		warnings: [
			`Worker ${laneId} lease renewal failed: ${expired}`,
			`Failed to persist durable worker failure ${laneId}: ${expired}`,
			`Worker delegation failed: ${expired}`,
		],
	});
	world.faultMatrix.witness("R28", { control: false });
	workerGate.release();
	const ready = await withDeadline(
		trace,
		`${label} worker idle after its cancellation`,
		session.backgroundLanes.waitForWorkerAgent(agentId, 60_000),
		70_000,
	);
	expect(
		{ timedOut: ready.timedOut, status: ready.status },
		`${label}: the worker is idle once its resources are released`,
	).toEqual({ timedOut: false, status: "idle" });
	expect(await world.disposeSessionInBody(session), `${label}: the auxiliary root disposes cleanly`).toBeUndefined();
	trace.mark("root", label);
}

/**
 * R29 + R35, both modes. An auxiliary root with System One off (its unsettled ladder has no judge) and the default worker pinned to
 * worker-c starts a goal, adds one requirement and binds it to a worker through goal dispatch_worker; the worker is held at its
 * first provider request. The goal tool stamps `boundAt`, the runtime snapshot decides on, and the auto-continue wake is armed on
 * the one `goal-continuation` port, so the idle root's only alarm on it is the bound worker's deadline (R29 control). Advancing the
 * port by DEFAULT_GOAL_WORKER_WAIT_MS fires that wake: the continuation pass reads `worker_wait_timeout`, and its one turn spends
 * the token budget the owner set (`editPersistedGoal`), so the goal stops as budget_limited with nothing armed and no warning
 * (R29 fault). The worker then reports with one inconclusive item: the ladder leaves it unsettled and buffers it for the owner.
 * The goal no longer executes, so the terminal handoff wakes no turn: it posts its follow-up, which carries the unsettled item as a
 * parent-owned inconclusive finding, and posts no owner items message because no judge reserved the item for the owner, with no root
 * request (R35 fault); nothing reached the owner before the worker ended (R35 control).
 */
async function verifyGoalWorkerDeadlineAndQuietHandoff(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const label = "r29-goal-worker-deadline";
	const WAKE_OWNER = "goal-continuation";
	const GOAL = "Keep the retry limit at 5.";
	const REQUIREMENT_ID = "r29-limit-req";
	const ITEM = "Whether another module reads the retry limit was not checked";
	const UNSETTLED = `${ITEM} (missing: System One is not bound)`;
	const TIMEOUT_TURN_TOKENS = 2_000;
	const agentDir = `${world.agentDir}-${label}`;
	const sessionManager = world.createSessionManager(agentDir);
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager,
		systemOneEnabled: false,
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			workerDelegation: {
				modelPins: { default: { provider: HARNESS_PROVIDER, modelId: "worker-c", thinkingLevel: "off" } },
			},
		},
	});
	const session = created.session;
	world.systemOne.enterPhase(label, {});
	const maxStallTurns = created.settingsManager.getAutonomySettings().maxStallTurns;
	expect(
		world.timers.armedDelays(WAKE_OWNER),
		`${label}: no goal-continuation alarm is armed before the dispatch`,
	).toEqual([]);
	expect(world.provider.getPendingStepNames("worker-c"), `${label}: no earlier worker-c step is left pending`).toEqual(
		[],
	);
	const workerHeld = createBarrier();
	const workerRelease = createBarrier();
	world.provider.enqueue("worker-c", {
		name: `${label}-held-report`,
		check: () => workerHeld.release(),
		gate: workerRelease.promise,
		reply: {
			content: [
				{
					type: "toolCall",
					id: `${label}-report-1`,
					name: "submit_report",
					arguments: {
						status: "completed",
						summary: "The retry limit needs no change from this worker.",
						requirements: [{ id: REQUIREMENT_ID, status: "not_applicable", note: "Nothing to change." }],
						inconclusive: [ITEM],
					},
				},
			],
			stopReason: "toolUse",
		},
	});
	world.provider.enqueue(
		"root",
		calls(`${label}-start`, [
			{ id: `${label}-goal-1`, name: "goal", arguments: { action: "start", goalId: "r29-goal", userGoal: GOAL } },
		]),
		{
			...calls(`${label}-requirement`, [
				{
					id: `${label}-goal-2`,
					name: "goal",
					arguments: { action: "add_requirement", requirementId: REQUIREMENT_ID, text: "MAX_RETRIES equals 5" },
				},
			]),
			check: (request) => assertBatchOk(request, `${label}: the goal start`),
		},
		{
			...calls(`${label}-dispatch`, [
				{
					id: `${label}-goal-3`,
					name: "goal",
					arguments: {
						action: "dispatch_worker",
						requirementId: REQUIREMENT_ID,
						instructions: "Check the retry limit and report.",
					},
				},
			]),
			check: (request) => assertBatchOk(request, `${label}: the requirement`),
		},
		{
			name: `${label}-dispatched`,
			check: (request) => assertBatchOk(request, `${label}: the goal dispatch`),
			reply: { content: [{ type: "text", text: "The worker is checking the limit." }] },
		},
	);
	const warningMark = world.warnings.length;
	await withDeadline(
		trace,
		`${label} dispatch turn`,
		session.prompt("Set up the retry limit goal and dispatch its worker."),
		90_000,
	);
	await withDeadline(trace, `${label} worker held`, workerHeld.promise, 90_000);
	// R29 control: the idle root waits on the bound worker, and its one goal-continuation alarm is that worker's deadline.
	const waiting = session.getGoalRuntimeSnapshot({ maxStallTurns });
	const requirement = waiting.goalState?.requirements.find((entry) => entry.id === REQUIREMENT_ID);
	const laneId = requirement?.boundLaneId;
	const boundAt = requirement?.boundAt;
	if (laneId === undefined || boundAt === undefined) {
		throw new Error(`${label}: the dispatch bound no worker lane: ${JSON.stringify(requirement)}`);
	}
	const deadlineMs = Date.parse(boundAt) + DEFAULT_GOAL_WORKER_WAIT_MS;
	expect(
		{
			action: waiting.continuation.action,
			reasonCode: waiting.continuation.reasonCode,
			resumeAt: waiting.continuation.resumeAt,
		},
		`${label}: the goal waits on its bound worker until boundAt plus the maximum wait`,
	).toEqual({ action: "waiting", reasonCode: "worker_in_flight", resumeAt: new Date(deadlineMs).toISOString() });
	const laneRecord = () => session.getLaneRecords().find((record) => record.laneId === laneId);
	expect(
		{ status: laneRecord()?.status, goalId: laneRecord()?.goalId },
		`${label}: the bound lane runs for the goal`,
	).toEqual({ status: "running", goalId: "r29-goal" });
	const armed = world.timers.armedDelays(WAKE_OWNER);
	const readAtMs = world.timers.port(WAKE_OWNER).now();
	expect(armed.length, `${label}: the idle root holds exactly one goal-continuation alarm`).toBe(1);
	expect(armed[0], `${label}: the alarm was armed after boundAt, at most the maximum wait`).toBeLessThanOrEqual(
		DEFAULT_GOAL_WORKER_WAIT_MS,
	);
	expect(armed[0], `${label}: the alarm reaches the deadline`).toBeGreaterThanOrEqual(deadlineMs - readAtMs);
	world.faultMatrix.witness("R29", { control: true });
	// The owner's budget leaves room for exactly one timeout turn: the pass that turn belongs to stops at its own charge.
	const tokensUsed = session.getGoalStateSnapshot()?.tokensUsed ?? 0;
	const edited = editPersistedGoal(session, { userGoal: GOAL, tokenBudget: tokensUsed + TIMEOUT_TURN_TOKENS });
	expect(edited.ok, `${label}: the owner's budget edit is applied`).toBe(true);
	expect(
		world.timers.armedDelays(WAKE_OWNER),
		`${label}: the budget edit leaves the deadline alarm as it was`,
	).toEqual(armed);
	const timeoutRead = createBarrier();
	const seen: { action?: string; reasonCode?: string } = {};
	world.provider.enqueue("root", {
		name: `${label}-timeout-pass`,
		check: () => {
			const decision = session.getGoalRuntimeSnapshot({ maxStallTurns }).continuation;
			seen.action = decision.action;
			seen.reasonCode = decision.reasonCode;
			timeoutRead.release();
		},
		reply: {
			content: [{ type: "text", text: "The worker is past its wait." }],
			usage: { ...createEmptyUsage(), output: TIMEOUT_TURN_TOKENS, totalTokens: TIMEOUT_TURN_TOKENS },
		},
	});
	const passMark = world.warnings.length;
	expect(
		world.timers.advance(WAKE_OWNER, DEFAULT_GOAL_WORKER_WAIT_MS),
		`${label}: advancing the port by the maximum wait fires the deadline wake`,
	).toBe(1);
	await withDeadline(trace, `${label} timeout pass reached`, timeoutRead.promise, 90_000);
	await withDeadline(trace, `${label} timeout pass settled`, session.waitForForegroundIdle(), 90_000);
	expect(seen, `${label}: the woken pass runs on the worker wait timeout`).toEqual({
		action: "continue",
		reasonCode: "worker_wait_timeout",
	});
	expect(
		world.provider.reached.filter((name) => name.startsWith(`root:${label}-timeout`)),
		`${label}: the timeout pass submits one turn`,
	).toEqual([`root:${label}-timeout-pass`]);
	expect(session.getGoalStateSnapshot()?.status, `${label}: the turn's charge stops the goal`).toBe("budget_limited");
	expect(world.timers.armedDelays(WAKE_OWNER), `${label}: the stopped goal arms nothing`).toEqual([]);
	expect(world.warnings.slice(passMark), `${label}: the timeout pass warns nothing`).toEqual([]);
	expect(laneRecord()?.status, `${label}: the held worker still runs after the goal stopped`).toBe("running");
	world.faultMatrix.witness("R29", { control: false });
	// The stop paused the goal's objective; the running worker's next lease heartbeat still renews its lease, so it keeps running
	// and later finishes instead of being aborted by a lease renewal failure.
	const runningAttempts = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).filter(
		(attempt) => attempt.taskId === laneId && attempt.status === "running",
	);
	expect(runningAttempts.length, `${label}: the bound lane holds one running attempt`).toBe(1);
	const heldAttempt = runningAttempts[0];
	const runtimeAttempt = () =>
		heldAttempt === undefined
			? undefined
			: session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[heldAttempt.attemptId];
	const heldObjectiveId = session.backgroundLanes.getTaskRuntimeSnapshot()?.tasks[laneId]?.task.objectiveId;
	expect(
		{
			attempt: heldAttempt?.status,
			objectiveId: heldObjectiveId,
			objective:
				heldObjectiveId === undefined
					? undefined
					: session.backgroundLanes.getTaskRuntimeSnapshot()?.objectives[heldObjectiveId]?.objective.status,
		},
		`${label}: the held attempt runs under the goal's paused objective`,
	).toEqual({ attempt: "running", objectiveId: goalObjectiveId("r29-goal"), objective: "paused" });
	const leaseTtlMs = heldAttempt?.dispatch.executionContract?.worker.profile.leaseTtlMs;
	const leaseExpiresAt = heldAttempt?.lease?.expiresAt;
	if (leaseTtlMs === undefined || leaseExpiresAt === undefined) {
		throw new Error(`${label}: the held attempt carries no lease TTL or lease: ${JSON.stringify(heldAttempt)}`);
	}
	const heartbeatMs = Math.floor(leaseTtlMs / 3);
	const heartbeatsArmed = world.timers.armedDelays("worker-lease").sort((left, right) => left - right);
	expect(heartbeatsArmed, `${label}: the held worker's lease heartbeat is armed at a third of its TTL`).toContain(
		heartbeatMs,
	);
	const heartbeatMark = world.warnings.length;
	expect(
		world.timers.advance("worker-lease", heartbeatMs),
		`${label}: advancing worker-lease by its interval fires the heartbeat`,
	).toBeGreaterThanOrEqual(1);
	const renewedExpiresAt = runtimeAttempt()?.lease?.expiresAt;
	expect(
		renewedExpiresAt !== undefined && Date.parse(renewedExpiresAt) > Date.parse(leaseExpiresAt),
		`${label}: the heartbeat renews the running attempt's lease under the paused objective`,
	).toBe(true);
	expect(
		world.timers.armedDelays("worker-lease").sort((left, right) => left - right),
		`${label}: every heartbeat re-arms at its interval, the held worker's included`,
	).toEqual(heartbeatsArmed);
	expect(
		{ lane: laneRecord()?.status, attempt: runtimeAttempt()?.status },
		`${label}: the worker keeps running after the heartbeat`,
	).toEqual({ lane: "running", attempt: "running" });
	expect(world.warnings.slice(heartbeatMark), `${label}: the heartbeat warns nothing`).toEqual([]);
	// R35: the worker ends under a goal that no longer executes.
	const ownerPosts = () =>
		sessionManager.getBranch().flatMap((entry) =>
			entry.type === "custom_message" &&
			(entry.customType === "background-worker-completion" || entry.customType === "owner_items")
				? [
						{
							customType: entry.customType,
							content: typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content),
						},
					]
				: [],
		);
	expect(ownerPosts(), `${label}: nothing reached the owner before the worker ended`).toEqual([]);
	world.faultMatrix.witness("R35", { control: true });
	const handoffPosted = createBarrier();
	const unsubscribe = session.subscribe((event) => {
		if (
			event.type === "message_end" &&
			event.message.role === "custom" &&
			event.message.customType === "background-worker-completion"
		) {
			handoffPosted.release();
		}
	});
	const rootRequests = () => world.provider.requests.filter((request) => request.model.id === "root").length;
	const rootRequestsBefore = rootRequests();
	try {
		workerRelease.release();
		await withDeadline(trace, `${label} handoff posted`, handoffPosted.promise, 90_000);
		// The handoff's delivery lease also covers the owner-item flush; idle means that flush has run.
		await withDeadline(trace, `${label} foreground idle after the handoff`, session.waitForForegroundIdle(), 30_000);
	} finally {
		unsubscribe();
	}
	const posted = ownerPosts();
	// With no judge bound, an unsettled worker item is a technical unknown the parent owns, never an owner question.
	expect(
		posted.map((entry) => entry.customType),
		`${label}: the handoff's follow-up is the only post; nothing is posted to the owner`,
	).toEqual(["background-worker-completion"]);
	expect(posted[0]?.content, `${label}: the handoff wakes no turn`).toContain(
		"Parent was not woken. Wait for explicit user input before reading a lane or starting more work.",
	);
	expect(posted[0]?.content, `${label}: the handoff leaves the unsettled item with the parent`).toContain(
		"Inconclusive, never treat as confirmed. The parent must investigate the missing evidence or follow up with the worker.",
	);
	expect(posted[0]?.content, `${label}: the parent-owned block names the item`).toContain(ITEM);
	expect(rootRequests(), `${label}: no root request follows the quiet handoff`).toBe(rootRequestsBefore);
	const agentId = laneRecord()?.agentId;
	if (agentId === undefined) throw new Error(`${label}: the bound lane carries no worker agent`);
	expect(world.warnings.slice(warningMark), `${label}: the ladder's one unsettled item is the only warning`).toEqual([
		`Worker ${agentId} could not settle: ${UNSETTLED}`,
	]);
	world.faultMatrix.witness("R35", { control: false });
	const ready = await withDeadline(
		trace,
		`${label} worker idle after its report`,
		session.backgroundLanes.waitForWorkerAgent(agentId, 60_000),
		70_000,
	);
	expect(ready.timedOut, `${label}: the worker settles inside its wait`).toBe(false);
	expect(ready.status, `${label}: the worker is idle once its resources are released`).toBe("idle");
	expect(
		world.timers.armedDelays(WAKE_OWNER),
		`${label}: nothing is left armed on the goal-continuation port`,
	).toEqual([]);
	expect(await world.disposeSessionInBody(session), `${label}: the auxiliary root disposes cleanly`).toBeUndefined();
	trace.mark("root", label);
}
