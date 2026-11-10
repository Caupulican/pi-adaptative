import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	deliveredLines,
	enqueueRoot,
	enqueueStepWorker,
	PLAN_CALL_JUDGMENTS,
	planCallSteps,
	planTitled,
	planUpdateStep,
	reportStep,
	stepTrack,
} from "./journey-5-shared.ts";

const TITLE = "Draft the retry limit note twice and keep the better draft";
const CANDIDATES = ["note-short", "note-long"] as const;
/** The checks the host adds for a vote it could not judge: one verify step per candidate, named after the vote and it. */
const CHECKS = CANDIDATES.map((candidate) => `pick-check-${candidate}`);

/**
 * Vote: two steps draft the same note and a vote step keeps one. With System One on, each draft is judged on the vote's
 * criteria; both meet them, so System One names the better one and the vote settles on it. With System One off nothing
 * judges the drafts: the host adds an independent check of each, one check accepts and the other rejects, and the vote
 * settles on the accepted draft. A rejected check of a vote is the vote's answer, so nothing is held for re-planning.
 */
export async function runJourney5PlanVotePhase(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const judged = world.systemOne.enabled;
	const started = createBarrier();
	const done = createBarrier();
	const updates: string[][] = [];
	const mark = world.provider.reached.length;
	enqueueStepWorker(
		world,
		"note-short",
		reportStep("j5-vote-short-report", { status: "completed", summary: "The retry limit is 3." }),
	);
	enqueueStepWorker(
		world,
		"note-long",
		reportStep("j5-vote-long-report", {
			status: "completed",
			summary: "The retry limit is 3; src/limits.ts sets it as MAX_RETRIES.",
		}),
	);
	if (!judged) {
		enqueueStepWorker(
			world,
			"pick-check-note-short",
			reportStep("j5-vote-check-short", {
				status: "completed",
				summary: "The draft states the limit and does not name the file.",
				verdict: "rejected",
				reasonCodes: ["file_not_named"],
			}),
		);
		enqueueStepWorker(
			world,
			"pick-check-note-long",
			reportStep("j5-vote-check-long", {
				status: "completed",
				summary: "The draft states the limit and names the file.",
				verdict: "accepted",
				reasonCodes: ["limit_and_file_named"],
			}),
		);
	}
	enqueueRoot(
		world,
		...planCallSteps(
			"j5-vote",
			{
				action: "start",
				title: TITLE,
				steps: [
					{
						id: "note-short",
						do: "Write a one-line note that states the retry limit in src/limits.ts. Change no file.",
					},
					{
						id: "note-long",
						do: "Write a two-line note that states the retry limit and names the file that sets it. Change no file.",
					},
					{
						id: "pick",
						do: "Keep the better note.",
						join: "vote",
						uses: [...CANDIDATES],
						criteria: ["States the retry limit", "Names the file that sets it"],
					},
				],
			},
			"PLAN_STARTED",
			() => started.release(),
		),
		// The root is woken for each combined result; every wake before the plan's own is read and answered in words.
		{
			...planUpdateStep("j5-vote-wake", "PLAN_DONE", () => done.release()),
			check: (request) => {
				updates.push(deliveredLines(request));
			},
		},
	);
	world.systemOne.enterPhase("j5-vote", {
		...PLAN_CALL_JUDGMENTS,
		// Both drafts meet both criteria on evidence that is enough to judge them; the longer one is the better note.
		criterion_0: { kind: "score", level: 3, confidence: 0.97 },
		criterion_1: { kind: "score", level: 3, confidence: 0.97 },
		candidate_evidence_sufficient: { kind: "noul", probability: 0.97 },
		best_candidate: { kind: "choice", choice: "note-long", confidence: 0.97 },
	});
	await withDeadline(
		trace,
		"J5 vote turn",
		session.prompt("Draft the retry limit note twice and keep the better draft."),
	);
	await withDeadline(trace, "J5 vote: the plan started", started.promise);
	await withDeadline(trace, "J5 vote: the plan's result woke the root", done.promise, 60_000);
	await withDeadline(trace, "J5 vote: root idle", session.waitForForegroundIdle());
	const plan = planTitled(session, TITLE);
	const record = "title" in plan.record ? plan.record : undefined;
	const join = plan.nodes["pick"]?.join;
	// An outcome written by a newer build is opaque; this build wrote this one.
	const joined = join && "status" in join.outcome ? join.outcome : undefined;
	const result = JSON.parse(String(world.io.readFileSync(join!.artifact, "utf8"))) as {
		kind: string;
		winner?: string;
		members: { nodeId: string; status: string }[];
	};
	const checkStatus = (id: string) => {
		const check = plan.nodes[id]?.join;
		return check && "status" in check.outcome ? check.outcome.status : undefined;
	};
	expect(
		{
			version: record?.version,
			checks: record?.nodes.filter((node) => node.kind === "verify").map((node) => node.id),
			checkResults: CHECKS.map(checkStatus),
			held: Object.entries(plan.nodes).flatMap(([id, node]) => (node.held ? [id] : [])),
			vote: joined && { status: joined.status, blocker: joined.blocker },
			winner: result.winner,
			members: result.members.map((member) => [member.nodeId, member.status]),
			closed: plan.closed?.status,
		},
		"the vote settled on one draft: named by System One, or by the one accepted check when nothing judged the drafts",
	).toEqual({
		version: judged ? 1 : 2,
		checks: judged ? [] : CHECKS,
		checkResults: judged ? [undefined, undefined] : ["failed", "succeeded"],
		held: [],
		vote: { status: "succeeded", blocker: "none" },
		winner: "note-long",
		members: [["note-long", "succeeded"]],
		closed: "settled",
	});
	const reached = world.provider.reached.slice(mark);
	const seen = updates.flat();
	expect(
		{
			workers: [...CANDIDATES, ...CHECKS].map(
				(nodeId) => reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`)).length,
			),
			checkResults: seen.filter((line) => line.includes("h PLAN_UPDATE,JOIN_DONE")).length,
			replans: seen.filter((line) => line.includes("h PLAN_UPDATE,REPLAN")).length,
			done: seen.filter((line) => line.includes("h PLAN_UPDATE,PLAN_DONE")),
			result: seen.filter((line) => line.startsWith("Result: ") && line.includes("winner")),
		},
		"each draft and each check ran once, the root was told each check's result and the winner, and was never asked to re-plan",
	).toEqual({
		workers: judged ? [1, 1, 0, 0] : [1, 1, 1, 1],
		checkResults: judged ? 0 : 2,
		replans: 0,
		done: ["h PLAN_UPDATE,PLAN_DONE,READ_REPORT"],
		result: ["Result: succeeded; winner note-long; 1 steps combined."],
	});
	trace.mark("root", "j5.plan-vote");
}
