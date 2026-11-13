import "../builtin-install.ts";
import { expect } from "vitest";
import { ORCHESTRATION_SCHEMA_VERSION } from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { calls, createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, projectPath, withDeadline } from "../session-fixture.ts";
import { scriptWatchWake, settleWatchWake } from "./journey-watch-wake.ts";
import { latestBatchResults } from "./shared.ts";

const PROFILE_ID = "watch-reader";
const ROUTINE_ID = "notes-watch";
const PROMPT = "Read notes.txt and say what changed.";

/** The facts a watch run was started with: the one line of data in its task, without the time it was seen. */
function watchFacts(task: string): unknown {
	const line = /^\{"condition".*\}$/m.exec(task)?.[0];
	if (!line) return undefined;
	const { observedAt: _observedAt, ...facts } = JSON.parse(line) as Record<string, unknown>;
	return facts;
}

/**
 * A watch routine: the owner asks to be told when a file changes. The host follows the file in code, with no model
 * call while it waits. The file as it was when the watch was armed fires nothing; each change starts one run of the
 * routine, which is told what was seen as data (the file, what happened, its size then); the same content again is no
 * change; and a run that reports nothing for the owner still wakes the root that armed the watch, once, because its own
 * work waits on the change. A file that appears and a file that goes are watches of their own: each fires once, at its
 * own moment, and never for the other.
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
	 * One run of the routine: its worker reports quietly. `task` resolves with the task text the run was given; `settled`
	 * waits for the root's wake turn that the quiet result of a watch starts, and for the session to be at rest after it.
	 */
	const quietRun = (
		label: string,
		summary: string,
		routineId = ROUTINE_ID,
	): { readonly task: Promise<string>; readonly settled: () => Promise<void> } => {
		const ran = createBarrier();
		const woke = scriptWatchWake(world, label, routineId);
		let task = "";
		world.provider.enqueue("worker-a", {
			...calls(`${label}-report`, [
				{
					id: `${label}-report`,
					name: "submit_report",
					arguments: { status: "completed", summary, ownerUpdate: "none" },
				},
			]),
			check: (request) => {
				// A routine's runs continue one worker conversation: the run's own task is the latest one in it.
				const tasks = request.context.messages.flatMap((message) =>
					message.role === "user" && typeof message.content === "string" && message.content.startsWith("TASK\n")
						? [message.content]
						: [],
				);
				task = tasks.at(-1) ?? "";
				ran.release();
			},
		});
		return { task: ran.promise.then(() => task), settled: () => settleWatchWake(world, session, label, woke) };
	};
	const rootRequests = () => world.provider.requests.filter((request) => request.model.id === "root").length;
	const rootBefore = rootRequests();

	// The file as it was when the watch was armed is the starting state: nothing fires for it.
	await untilFired(1);
	expect(occurrences(), "an unchanged file fires nothing").toHaveLength(0);

	// A change starts one run, which is told what was seen as data.
	const first = quietRun("j4-watch-first", "notes.txt gained a line.");
	world.io.writeFileSync(notes, "first line\nsecond line\n");
	await untilFired(1);
	const firstTask = await withDeadline(trace, "the change starts one run of the routine", first.task);
	await first.settled();
	expect(
		{
			prompt: firstTask.includes(PROMPT),
			why: firstTask.includes("a condition the host was watching became true"),
			facts: watchFacts(firstTask),
			runs: occurrences().length,
		},
		"the run carries the routine's prompt and the facts of the change: the file, what happened and its size",
	).toEqual({
		prompt: true,
		why: true,
		facts: { condition: "file", change: "changed", label: "notes.txt", facts: { sizeBytes: 23 } },
		runs: 1,
	});

	// The same content again is no change, and the one run's quiet result woke the root once, not again.
	await untilFired(2);
	expect(
		{ runs: occurrences().length, rootTurns: rootRequests() - rootBefore },
		"one change is one run, and its quiet result starts one turn of the root that armed the watch",
	).toEqual({ runs: 1, rootTurns: 1 });

	// A second change is a second run.
	const second = quietRun("j4-watch-second", "notes.txt lost a line.");
	world.io.writeFileSync(notes, "second line\n");
	await untilFired(2);
	const secondTask = await withDeadline(trace, "the second change starts a second run", second.task);
	await second.settled();
	expect(
		{ facts: watchFacts(secondTask), runs: occurrences().length },
		"each change is told with the file as it is then",
	).toEqual({
		facts: { condition: "file", change: "changed", label: "notes.txt", facts: { sizeBytes: 12 } },
		runs: 2,
	});
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
	const appeared = quietRun("j4-watch-flag-created", "release.flag appeared.", "flag-created");
	world.io.writeFileSync(flag, "ready\n");
	await untilRuns("flag-created", 1);
	const appearedTask = await withDeadline(trace, "the file's appearance starts one run", appeared.task);
	await appeared.settled();
	expect(
		{ facts: watchFacts(appearedTask), created: runsOf("flag-created"), deleted: runsOf("flag-deleted") },
		"a file that appears fires the created watch only",
	).toEqual({
		facts: { condition: "file", change: "created", label: "release.flag", facts: { sizeBytes: 6 } },
		created: 1,
		deleted: 0,
	});
	const gone = quietRun("j4-watch-flag-deleted", "release.flag is gone.", "flag-deleted");
	world.io.unlinkSync(flag);
	await untilRuns("flag-deleted", 1);
	const goneTask = await withDeadline(trace, "the file's removal starts one run", gone.task);
	await gone.settled();
	expect(
		{ facts: watchFacts(goneTask), created: runsOf("flag-created"), deleted: runsOf("flag-deleted") },
		"a file that goes fires the deleted watch only",
	).toEqual({
		facts: { condition: "file", change: "deleted", label: "release.flag", facts: {} },
		created: 1,
		deleted: 1,
	});

	expect(await world.disposeSessionInBody(session), "the watch session closes").toBeUndefined();
	trace.mark("root", "watch.closed");
}
