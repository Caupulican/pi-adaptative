import "../builtin-install.ts";
import { expect } from "vitest";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	carriesTask,
	completeHandoff,
	delegateStart,
	type HandoffBlock,
	handoffBlocks,
	J9_ROOT_JUDGMENTS,
	J9_SETTINGS,
	j9Profile,
	recordedOutcome,
	saveJ9Profile,
	taskForInstructions,
	workerReport,
} from "./journey-9-shared.ts";
import { latestBatchResults } from "./shared.ts";

const WORDS_PROMPT = "Start a read-only worker that inspects the retry limit in the limits file.";
const WORDS_TASK = "Inspect the retry limit of the limits file and report whether it can be decided.";
const UNCOVERED_PROMPT = "Start a read-only worker that covers the retry limit requirement of the limits file.";
const UNCOVERED_TASK = "Inspect the retry limit of the limits file and cover the requirement it names.";
const REQUIREMENT_ID = "j9-left";
/** What the worker says about the one requirement, in words no claim check reacts to. */
const LEFT_NOTE = "Only the value was read, and nothing more was done with it.";

/**
 * Leg 2: a worker's own blocker words and an attempt with nothing left to try. The first worker reports a blocker without a
 * declared code, so no exit names a cause of its own and the table falls through to the owner. The second worker answers for
 * one requirement of its task as partial, which no host check can settle, and the rerun rungs are switched off: the
 * fall-through names the uncovered requirement. The host does not accept a report that leaves its one requirement partial,
 * so with nothing covered the outcome reads blocked, not partial: partial is for a task with some requirements covered.
 */
export async function runJourney9OwnWordsPhase(world: HarnessWorld): Promise<void> {
	await runWordsBlockerLeg(world);
	await runUncoveredRequirementLeg(world);
}

/** A worker that reports a blocker in its own words, with no declared blocker code. */
async function runWordsBlockerLeg(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const reported = createBarrier();
	let handoffs: readonly HandoffBlock[] = [];
	saveJ9Profile(world, j9Profile("j9-words", "worker-a"));
	// The worker's words name no declarable blocker, so the host classifies the attempt from the report's blocked status.
	const workers = world.provider;
	workers.enqueue(
		"root",
		{
			name: "j9-l2-words-start",
			reply: {
				content: [delegateStart("j9-l2-words-call", { profileId: "j9-words", instructions: WORDS_TASK })],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l2-words-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the worker did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
		{
			name: "j9-l2-words-handoff",
			maxRequests: 8,
			until: (request) => {
				const blocks = handoffBlocks(request).filter((block) => block.outcome !== "" && block.next !== "");
				if (blocks.length !== 1) return false;
				handoffs = blocks;
				reported.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	world.provider.enqueueTrack(
		"j9-l2-words",
		"worker-a",
		carriesTask(WORDS_TASK),
		workerReport("j9-l2-words-report", {
			status: "blocked",
			summary: "I cannot tell which retry limit the project should carry.",
			blockers: ["I cannot tell whether the retry limit should stay at 3 or become 5."],
		}),
	);
	world.systemOne.enterPhase("j9-l2-words", J9_ROOT_JUDGMENTS);
	const created = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: J9_SETTINGS,
	});
	const session = created.session;
	await withDeadline(trace, "J9 leg 2 words turn", session.prompt(WORDS_PROMPT));
	await withDeadline(trace, "J9 leg 2 words handoff", reported.promise, 120_000);
	await withDeadline(trace, "J9 leg 2 words root idle", session.waitForForegroundIdle());

	const taskId = taskForInstructions(session, WORDS_TASK);
	const outcome = recordedOutcome(session, taskId);
	expect(
		{
			status: outcome.status,
			blocker: outcome.blocker,
			next: outcome.nextAction.kind,
			question: outcome.nextAction.kind === "ask_owner" ? outcome.nextAction.question : undefined,
			required: outcome.coverage.required,
			exit: outcome.ladder.exit,
		},
		"a blocker the worker stated in its own words reaches the fall-through exit: the owner-only pair was never asked, and no rerun rung has room",
	).toEqual({
		status: "blocked",
		blocker: "worker_reported_blocker",
		next: "ask_owner",
		question: "the worker stopped on a blocker it reported (worker_reported_blocker); decide how to continue",
		required: [],
		exit: "E18",
	});
	expect(
		{
			header: handoffs[0]?.header,
			outcome: handoffs[0]?.outcome,
			next: handoffs[0]?.next,
		},
		"the handoff of a blocked worker names the owner as the next step, as the ladder's answer does",
	).toEqual({
		header: `- ${taskId}: blocked reason=worker_blocked`,
		outcome: "Outcome: blocked (blocker: worker_reported_blocker; requirements met: 0 of 0; assurance: unverified)",
		next: "Next: your decision is needed; leave it idle; a delegate start with its agentId gives it the next task (a follow_up continues the same task). Host verdict blocked: the worker reported a blocker.",
	});
	expect(await world.disposeSessionInBody(session), "the leg 2 words owner disposes cleanly").toBeUndefined();
	trace.mark("root", "j9.own-words");
}

/** A worker that answers for one requirement of its task as partial, with no host check to settle it. */
async function runUncoveredRequirementLeg(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const reported = createBarrier();
	saveJ9Profile(world, j9Profile("j9-uncovered", "worker-b"));
	world.provider.enqueue(
		"root",
		{
			name: "j9-l2-uncovered-start",
			reply: {
				content: [
					delegateStart("j9-l2-uncovered-call", {
						profileId: "j9-uncovered",
						instructions: UNCOVERED_TASK,
						requirementIds: [REQUIREMENT_ID],
					}),
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l2-uncovered-reply",
			check: (request) => {
				const started = latestBatchResults(request).find((result) => result.toolName === "delegate");
				if (started?.isError || !started?.text.includes("delegate started (running)")) {
					throw new Error(`the worker did not start: ${started?.text ?? "no result"}`);
				}
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
		{
			name: "j9-l2-uncovered-handoff",
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
		"j9-l2-uncovered",
		"worker-b",
		carriesTask(UNCOVERED_TASK),
		workerReport("j9-l2-uncovered-report", {
			status: "completed",
			summary: "The retry limit of the limits file is 3, and I stopped there.",
			requirements: [{ id: REQUIREMENT_ID, status: "partial", note: LEFT_NOTE }],
		}),
	);
	world.systemOne.enterPhase("j9-l2-uncovered", J9_ROOT_JUDGMENTS);
	const created = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: J9_SETTINGS,
	});
	const session = created.session;
	await withDeadline(trace, "J9 leg 2 uncovered turn", session.prompt(UNCOVERED_PROMPT));
	await withDeadline(trace, "J9 leg 2 uncovered handoff", reported.promise, 120_000);
	await withDeadline(trace, "J9 leg 2 uncovered root idle", session.waitForForegroundIdle());

	const taskId = taskForInstructions(session, UNCOVERED_TASK);
	const outcome = recordedOutcome(session, taskId);
	expect(
		{
			status: outcome.status,
			blocker: outcome.blocker,
			next: outcome.nextAction.kind,
			question: outcome.nextAction.kind === "ask_owner" ? outcome.nextAction.question : undefined,
			required: outcome.coverage.required,
			uncovered: outcome.coverage.uncovered,
			exit: outcome.ladder.exit,
		},
		"an uncovered requirement with no host check and no rerun rung is blocked with nothing covered and asks the owner, naming the one requirement still not met",
	).toEqual({
		status: "blocked",
		blocker: "requirement_uncovered",
		next: "ask_owner",
		question: `1 requirement still not met (requirement_uncovered); decide how to continue`,
		required: [REQUIREMENT_ID],
		uncovered: [{ id: REQUIREMENT_ID, reason: "partial" }],
		exit: "E18",
	});
	expect(await world.disposeSessionInBody(session), "the leg 2 uncovered owner disposes cleanly").toBeUndefined();
	trace.mark("root", "j9.uncovered");
}
