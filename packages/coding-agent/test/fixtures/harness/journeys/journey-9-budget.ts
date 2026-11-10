import "../builtin-install.ts";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import { createBarrier, type ScriptStep } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	carriesTask,
	completeHandoff,
	delegateStart,
	J9_ROOT_JUDGMENTS,
	J9_SETTINGS,
	j9Profile,
	recordedOutcome,
	saveJ9Profile,
	taskForInstructions,
} from "./journey-9-shared.ts";
import { LIMITS_PATH, latestBatchResults } from "./shared.ts";

const PROMPT = "Start a read-only worker that inspects the retry limit in the limits file.";
const TASK = "Inspect the retry limit of the limits file and report the value you find.";
/** One response charges 3,000 of the profile's 5,500 tokens: the next request would pass the budget. */
const RESPONSE_USAGE = { ...createEmptyUsage(), input: 1_000, cacheRead: 20_000, totalTokens: 21_000 };

/** One response that reads the limits file and is charged to the worker's budget. */
function readLimits(id: string): ScriptStep["reply"] {
	return {
		content: [{ type: "toolCall", id, name: "read", arguments: { path: LIMITS_PATH } }],
		stopReason: "toolUse",
		usage: RESPONSE_USAGE,
	};
}

/**
 * Leg 3: a spent budget. The worker's profile bounds it to 5,500 tokens; its first response charges 3,000 and the host
 * refuses the call the second response carries, so the attempt ends with the budget as its blocker and the ladder asks the
 * owner to raise it or accept the partial result.
 */
export async function runJourney9BudgetPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const reported = createBarrier();
	saveJ9Profile(world, j9Profile("j9-budget", "worker-a", 5_500));
	world.provider.enqueue(
		"root",
		{
			name: "j9-l3-start",
			reply: {
				content: [delegateStart("j9-l3-call", { profileId: "j9-budget", instructions: TASK })],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l3-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the worker did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
		{
			name: "j9-l3-handoff",
			maxRequests: 8,
			until: (request) => {
				if (!completeHandoff(request)) return false;
				reported.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	world.provider.enqueueTrack(
		"j9-l3-budget",
		"worker-a",
		carriesTask(TASK),
		{ name: "j9-l3-read", reply: readLimits("j9-l3-read-call") },
		{ name: "j9-l3-read-again", reply: readLimits("j9-l3-read-again-call") },
	);
	world.systemOne.enterPhase("j9-l3", J9_ROOT_JUDGMENTS);
	const created = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: J9_SETTINGS,
	});
	const session = created.session;
	const reachedBefore = world.provider.reached.length;
	await withDeadline(trace, "J9 leg 3 turn", session.prompt(PROMPT));
	await withDeadline(trace, "J9 leg 3 handoff", reported.promise, 120_000);
	await withDeadline(trace, "J9 leg 3 root idle", session.waitForForegroundIdle());

	// The second response spends the budget: the call it carries is refused before it reaches the tool, and no third
	// provider request is made.
	expect(
		world.provider.reached.slice(reachedBefore).filter((key) => key.startsWith("j9-l3-budget:")),
		"the budgeted worker reaches exactly two provider requests",
	).toEqual(["j9-l3-budget:j9-l3-read", "j9-l3-budget:j9-l3-read-again"]);
	const taskId = taskForInstructions(session, TASK);
	const outcome = recordedOutcome(session, taskId);
	expect(
		{
			blocker: outcome.blocker,
			next: outcome.nextAction.kind,
			question: outcome.nextAction.kind === "ask_owner" ? outcome.nextAction.question : undefined,
			exit: outcome.ladder.exit,
		},
		"a spent budget is the attempt's blocker and the ladder asks the owner to raise it or accept the partial result",
	).toEqual({
		blocker: "budget_exhausted",
		next: "ask_owner",
		question: "the task's budget is spent; raise it or accept the partial result",
		exit: "E10",
	});
	expect(await world.disposeSessionInBody(session), "the leg 3 owner disposes cleanly").toBeUndefined();
	trace.mark("root", "j9.budget");
}
