import type { Context } from "@caupulican/pi-ai";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { calls, createBarrier, type ScriptStep, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

const NOTE_TEXT = "The changelog entry you asked for is still not written.";
const NOTE_MARKER = "[proactive note]";

/**
 * Proactivity: an idle review of the conversation may raise a note the owner did not ask for. One owner turn ends and the
 * review is armed on the proactivity timer; the review sees the owner's standing preferences and the conversation, offers
 * exactly one tool, and raises a note that reaches the owner's next turn once; a review that raises the same note again, and
 * a review that raises nothing, deliver nothing; the per-session cap stops further reviews; and a session with the feature
 * off arms no timer and sends no review request.
 */
export async function runJourney1ProactivityPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-proactivity`;
	const preferences = "Raise only work I asked for that is still undone.";
	const created = await world.createRootSession("root", {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
		settings: {
			memorySystem: "okf",
			autoLearn: { enabled: false },
			proactivity: {
				enabled: true,
				idleDelayMs: 1_000,
				minOwnerTurnsBetweenRuns: 1,
				maxRunsPerSession: 3,
				maxNotesPerRun: 2,
				delivery: "note",
				preferences,
			},
		},
	});
	const session: AgentSession = created.session;
	const lanes = session.backgroundLanes;

	/** The session has no armed or running idle work: the review, if one was due, has ended. */
	const lanesQuiet = (label: string): Promise<void> =>
		withDeadline(
			trace,
			label,
			new Promise<void>((resolve) => {
				const settle = (): void => {
					if (lanes.hasPendingIdleContinuation()) return;
					off();
					resolve();
				};
				const off = lanes.subscribeIdleContinuationActivity(settle);
				settle();
			}),
		);

	const ownerRequests: string[] = [];
	const ownerTurn = async (label: string, prompt: string): Promise<void> => {
		world.provider.enqueue("root", {
			name: `${label}-reply`,
			check: (request) => {
				ownerRequests.push(JSON.stringify(request.context.messages));
			},
			reply: { content: [{ type: "text", text: "Understood." }] },
		});
		world.systemOne.enterPhase(label, {});
		await withDeadline(trace, `${label} owner turn`, session.prompt(prompt));
	};

	/** One review: arm, script what the model answers, fire the timer, and wait until the review has ended. */
	const review = async (
		label: string,
		answer: readonly ScriptStep[],
		inspect?: (context: Context) => void,
	): Promise<void> => {
		await withDeadline(trace, `${label} armed`, world.timers.whenArmed("proactivity"));
		const reached = createBarrier();
		const [first, ...rest] = answer;
		if (first === undefined) throw new Error(`${label}: the review needs an answer`);
		world.provider.enqueue(
			"root",
			{
				...first,
				check: (request) => {
					inspect?.(request.context);
					reached.release();
				},
			},
			...rest,
		);
		expect(world.timers.advance("proactivity", 1_000), `${label}: the idle delay fires the review once`).toBe(1);
		await withDeadline(trace, `${label} reached the model`, reached.promise);
		await lanesQuiet(`${label} ended`);
	};

	const noteCount = (request: string): number => request.split(NOTE_MARKER).length - 1;

	// Review 1: the review reads the preferences and the conversation, has one tool, and raises one note.
	const seen: { systemPrompt: string; tools: string[]; messages: string }[] = [];
	await ownerTurn(
		"proactivity-1",
		"Finish the migration and update the changelog. I will ask about the changelog later.",
	);
	await review(
		"proactivity-review-1",
		[
			calls("proactivity-review-1-raise", [
				{
					id: "raise-1",
					name: "raise_note",
					arguments: {
						kind: "reminder",
						text: NOTE_TEXT,
						why: "The owner asked for a changelog update and none was written.",
					},
				},
			]),
			text("proactivity-review-1-done", "none"),
		],
		(context) => {
			seen.push({
				systemPrompt: String(context.systemPrompt ?? ""),
				tools: (context.tools ?? []).map((tool) => tool.name),
				messages: JSON.stringify(context.messages),
			});
		},
	);
	expect(seen[0]?.tools, "the review can only record a note").toEqual(["raise_note"]);
	expect(seen[0]?.systemPrompt, "the review is told to stay quiet by default").toContain("Stay quiet by default");
	expect(seen[0]?.messages, "the review reads the owner's standing preferences").toContain(preferences);
	expect(seen[0]?.messages, "the review reads the conversation").toContain("Finish the migration");

	// The note reaches the owner's next turn, once.
	await ownerTurn("proactivity-2", "Thanks.");
	const second = ownerRequests.at(-1) ?? "";
	expect(second, "the raised note is carried with the owner's next turn").toContain(NOTE_TEXT);
	expect(noteCount(second), "the note is delivered once").toBe(1);

	// Review 2 raises the same note again: it is a repeat, so nothing more is delivered.
	await review("proactivity-review-2", [
		calls("proactivity-review-2-raise", [
			{
				id: "raise-2",
				name: "raise_note",
				arguments: { kind: "reminder", text: NOTE_TEXT, why: "Still not written." },
			},
		]),
		text("proactivity-review-2-done", "none"),
	]);
	await ownerTurn("proactivity-3", "Still thinking.");
	expect(noteCount(ownerRequests.at(-1) ?? ""), "a repeated note is not delivered again").toBe(1);

	// Review 3 raises nothing: the default is quiet.
	await review("proactivity-review-3", [text("proactivity-review-3-none", "none")]);
	await ownerTurn("proactivity-4", "Carry on.");
	expect(noteCount(ownerRequests.at(-1) ?? ""), "a review with nothing to raise delivers nothing").toBe(1);

	// The per-session cap is spent: the next idle arms no review.
	expect(world.timers.armedDelays("proactivity"), "no review is armed past the cap").toEqual([]);
	expect(lanes.getLastProactivitySkipReason(), "the cap names itself as the reason").toBe("max_runs_reached");
	expect(await world.disposeSessionInBody(session), "the proactivity session closes cleanly").toBeUndefined();

	// The feature is off by default: no timer, no review request.
	const offDir = `${world.agentDir}-proactivity-off`;
	const off = await world.createRootSession("root", {
		agentDir: offDir,
		sessionManager: world.createSessionManager(offDir),
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
	});
	const requestsBefore = world.provider.requests.length;
	world.provider.enqueue("root", text("proactivity-off-reply", "Understood."));
	world.systemOne.enterPhase("proactivity-off", {});
	await withDeadline(trace, "proactivity-off owner turn", off.session.prompt("Hello."));
	expect(world.timers.armedDelays("proactivity"), "a session without the feature arms no review").toEqual([]);
	expect(
		off.session.backgroundLanes.getLastProactivitySkipReason(),
		"the feature is off unless the owner turns it on",
	).toBe("proactivity_disabled");
	expect(world.provider.requests.length - requestsBefore, "only the owner's own turn reached the provider").toBe(1);
	expect(await world.disposeSessionInBody(off.session), "the off session closes cleanly").toBeUndefined();
	trace.mark("root", "proactivity.done");
}
