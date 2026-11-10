import "../builtin-install.ts";
import { expect } from "vitest";
import { createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	blockWithBlocker,
	carriesTask,
	delegateStart,
	type HandoffBlock,
	handoffBlocks,
	J9_ROOT_JUDGMENTS,
	J9_SETTINGS,
	j9Profile,
	queueWords,
	recordedOutcome,
	saveJ9Profile,
	taskForInstructions,
	workerReport,
} from "./journey-9-shared.ts";
import { latestBatchResults } from "./shared.ts";

const PROMPT = "Start two read-only workers that inspect the retry limit in the limits file.";
const SCOPE_TASK = "Inspect the retry limit of the limits file and report what your granted scope allows.";
const OWNER_TASK = "Inspect the limits file and report which retry limit the owner wants.";

/**
 * Leg 1: the two blockers only a parent or only the owner can answer. One worker reports that its work reached outside its
 * granted scope (exit E2, a fix request the parent can carry out); a second reports that only the owner can decide (exit
 * E3, the owner is asked). The root reads both in its terminal handoffs, and the owner decision queue holds the question.
 */
export async function runJourney9FixAndOwnerPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const reported = createBarrier();
	let blocks: readonly HandoffBlock[] = [];
	saveJ9Profile(world, j9Profile("j9-scope", "worker-a"));
	saveJ9Profile(world, j9Profile("j9-owner", "worker-b"));
	world.provider.enqueue(
		"root",
		{
			name: "j9-l1-start",
			reply: {
				content: [
					delegateStart("j9-l1-a", { profileId: "j9-scope", instructions: SCOPE_TASK }),
					delegateStart("j9-l1-b", { profileId: "j9-owner", instructions: OWNER_TASK }),
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j9-l1-reply",
			check: (request) => {
				const started = latestBatchResults(request).filter((result) => result.toolName === "delegate");
				if (started.length !== 2 || started.some((result) => result.isError)) {
					throw new Error(`both workers did not start: ${JSON.stringify(started)}`);
				}
				if (started.some((result) => !result.text.includes("delegate started (running)"))) {
					throw new Error(`a worker was not admitted as running: ${started.map((e) => e.text).join(" | ")}`);
				}
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
		{
			name: "j9-l1-handoffs",
			maxRequests: 8,
			until: (request) => {
				const ready = completeHandoffs(request);
				if (!ready) return false;
				blocks = ready;
				reported.release();
				return true;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	world.provider.enqueueTrack(
		"j9-l1-scope",
		"worker-a",
		carriesTask(SCOPE_TASK),
		workerReport("j9-l1-scope-report", {
			status: "blocked",
			summary: "The limits file lies outside the paths I may read.",
			blockers: ["I need to read the limits file, which is outside my granted scope."],
			blockerCode: "scope_denied",
		}),
	);
	world.provider.enqueueTrack(
		"j9-l1-owner",
		"worker-b",
		carriesTask(OWNER_TASK),
		workerReport("j9-l1-owner-report", {
			status: "blocked",
			summary: "Which retry limit to keep is the owner's choice.",
			blockers: ["Only the owner can decide which retry limit the project should carry."],
			blockerCode: "needs_owner_decision",
		}),
	);
	world.systemOne.enterPhase("j9-l1", J9_ROOT_JUDGMENTS);
	const created = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: J9_SETTINGS,
	});
	const session = created.session;
	await withDeadline(trace, "J9 leg 1 turn", session.prompt(PROMPT));
	await withDeadline(trace, "J9 leg 1 handoffs", reported.promise, 120_000);
	await withDeadline(trace, "J9 leg 1 root idle", session.waitForForegroundIdle());

	const scopeTask = taskForInstructions(session, SCOPE_TASK);
	const ownerTask = taskForInstructions(session, OWNER_TASK);
	const scope = recordedOutcome(session, scopeTask);
	const owner = recordedOutcome(session, ownerTask);
	expect(
		{
			scope: {
				status: scope.status,
				blocker: scope.blocker,
				next: scope.nextAction.kind,
				remedy: scope.nextAction.kind === "fix_request" ? scope.nextAction.remedy : undefined,
				required: scope.coverage.required,
				exit: scope.ladder.exit,
			},
			owner: {
				status: owner.status,
				blocker: owner.blocker,
				next: owner.nextAction.kind,
				question: owner.nextAction.kind === "ask_owner" ? owner.nextAction.question : undefined,
				required: owner.coverage.required,
				exit: owner.ladder.exit,
			},
		},
		"a blocker the parent can fix is a fix request and a blocker only the owner can answer asks the owner",
	).toEqual({
		scope: {
			status: "blocked",
			blocker: "scope_denied",
			next: "fix_request",
			remedy: "widen the worker's path or tool grant, or narrow the task to the granted scope",
			required: [],
			exit: "E2",
		},
		owner: {
			status: "blocked",
			blocker: "needs_owner_decision",
			next: "ask_owner",
			question: "the worker needs an authority or a decision only you can give",
			required: [],
			exit: "E3",
		},
	});

	// The root reads each outcome from the worker's terminal handoff: the block names the lane and the reason code, and its
	// Next line is the ladder's own next step for that outcome.
	const scopeBlock = blockWithBlocker(blocks, "scope_denied");
	const ownerBlock = blockWithBlocker(blocks, "needs_owner_decision");
	expect(
		{
			scope: { header: scopeBlock.header, outcome: scopeBlock.outcome, next: scopeBlock.next },
			owner: { header: ownerBlock.header, outcome: ownerBlock.outcome, next: ownerBlock.next },
		},
		"the handoff of each blocked worker names the lane, its blocker and the next step the ladder decided",
	).toEqual({
		scope: {
			header: `- ${scopeTask}: blocked reason=worker_blocked`,
			outcome: "Outcome: blocked (blocker: scope_denied; requirements met: 0 of 0; assurance: unverified)",
			next: "Next: fix the request and start again; leave it idle; a delegate start with its agentId gives it the next task (a follow_up continues the same task). Host verdict blocked: the work reached outside its allowed area.",
		},
		owner: {
			header: `- ${ownerTask}: blocked reason=worker_blocked`,
			outcome: "Outcome: blocked (blocker: needs_owner_decision; requirements met: 0 of 0; assurance: unverified)",
			next: "Next: your decision is needed; leave it idle; a delegate start with its agentId gives it the next task (a follow_up continues the same task). Host verdict blocked: your decision is needed.",
		},
	});

	// The question the ladder asked reaches the owner through the owner decision queue, under the same words.
	const status = await session.autonomyStatus();
	if (status.ownerDecisions?.status !== "available") {
		throw new Error(`the owner decisions are unreadable: ${JSON.stringify(status.ownerDecisions)}`);
	}
	expect(
		{
			waiting: status.ownerDecisions.value.waiting,
			items: status.ownerDecisions.value.items.items.map((item) => ({
				source: item.source,
				id: item.id,
				what: item.what,
			})),
		},
		"the one outcome that asks the owner puts one worker question in the owner decision queue",
	).toEqual({
		waiting: 1,
		items: [
			{
				source: "worker_question",
				id: owner.outcomeId,
				what: queueWords("the worker needs an authority or a decision only you can give"),
			},
		],
	});
	expect(await world.disposeSessionInBody(session), "the leg 1 owner disposes cleanly").toBeUndefined();
	trace.mark("root", "j9.fix-and-owner");
}

/** Both workers' handoff blocks, once each carries its outcome line and its next step. */
function completeHandoffs(request: ScriptedRequest): readonly HandoffBlock[] | undefined {
	const blocks = handoffBlocks(request);
	return blocks.length === 2 && blocks.every((block) => block.outcome !== "" && block.next !== "")
		? blocks
		: undefined;
}
