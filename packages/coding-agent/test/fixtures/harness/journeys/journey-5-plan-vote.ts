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
/** Both drafts are delivered to the root when the comparison is unavailable. Neither path dispatches a verifier. */
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
		reportStep("j5-vote-short-report", { status: "completed", summary: "The retry limit is 3 (src/limits.ts)." }),
	);
	enqueueStepWorker(
		world,
		"note-long",
		reportStep("j5-vote-long-report", {
			status: "completed",
			summary: "The retry limit is 3; src/limits.ts sets it as MAX_RETRIES.",
		}),
	);
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
	const join = plan.nodes.pick?.join;
	// An outcome written by a newer build is opaque; this build wrote this one.
	const joined = join && "status" in join.outcome ? join.outcome : undefined;
	const result = JSON.parse(String(world.io.readFileSync(join!.artifact, "utf8"))) as {
		kind: string;
		winner?: string;
		members: { nodeId: string; status: string }[];
	};
	expect(
		{
			version: record?.version,
			checks: record?.nodes.filter((node) => node.kind === "verify").map((node) => node.id),
			held: Object.entries(plan.nodes).flatMap(([id, node]) => (node.held ? [id] : [])),
			vote: joined && { status: joined.status, blocker: joined.blocker },
			winner: result.winner,
			members: result.members.map((member) => [member.nodeId, member.status]),
			closed: plan.closed?.status,
		},
		"the vote settled in the original version and returned either the chosen draft or the evidence for the root",
	).toEqual({
		version: 1,
		checks: [],
		held: [],
		vote: { status: judged ? "succeeded" : "partial", blocker: judged ? "none" : "needs_root_answer" },
		winner: judged ? "note-long" : undefined,
		members: (judged ? ["note-long"] : CANDIDATES).map((id) => [id, "succeeded"]),
		closed: "settled",
	});
	const reached = world.provider.reached.slice(mark);
	const seen = updates.flat();
	expect(
		{
			workers: CANDIDATES.map((nodeId) => reached.filter((key) => key.startsWith(`${stepTrack(nodeId)}:`)).length),
			checkResults: seen.filter((line) => line.includes("h PLAN_UPDATE,JOIN_DONE")).length,
			replans: seen.filter((line) => line.includes("h PLAN_UPDATE,REPLAN")).length,
			done: seen.filter((line) => line.includes("h PLAN_UPDATE,PLAN_DONE")),
			result: seen.filter((line) => line.startsWith("Result: ") && line.includes("steps combined")),
		},
		"each draft ran once and the root received the result directly",
	).toEqual({
		workers: [1, 1],
		checkResults: 0,
		replans: 0,
		done: [judged ? "h PLAN_UPDATE,PLAN_DONE,READ_REPORT" : "h PLAN_UPDATE,PLAN_DONE,READ_ALL"],
		result: [
			judged ? "Result: succeeded; winner note-long; 1 steps combined." : "Result: partial; 2 steps combined.",
		],
	});
	if (judged) {
		const comparison = world.systemOne.decoded.find(
			(request) => request.phase === "j5-vote" && request.questions.best_candidate,
		);
		expect(comparison?.state).toMatchObject({
			criteria: ["States the retry limit", "Names the file that sets it"],
			candidates: [
				{ nodeId: "note-short", evidence: expect.stringContaining("The retry limit is 3 (src/limits.ts).") },
				{ nodeId: "note-long", evidence: expect.stringContaining("MAX_RETRIES") },
			],
		});
	} else {
		expect(joined).toMatchObject({
			assurance: "unverified",
			nextAction: { kind: "ask_root", question: "Read the candidate reports and resolve the inconclusive vote." },
		});
		expect(seen).toContain("Gap: The vote received no rubric judgment.");
		for (const id of CANDIDATES) expect(seen.some((line) => line.startsWith(`Candidate ${id}: `))).toBe(true);
	}
	trace.mark("root", "j5.plan-vote");
}
