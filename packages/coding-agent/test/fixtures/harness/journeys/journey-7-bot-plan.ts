import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { botOrchestrationHome } from "../../../../src/core/bots/bot-home.ts";
import { OrchestrationEventStore } from "../../../../src/core/orchestration/event-store.ts";
import { readTaskRuntimeProjection } from "../../../../src/core/orchestration/task-runtime-reader.ts";
import { createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { planCallSteps, planStepOf, planUpdateStep, reportStep, writeAuthorityIn } from "./journey-5-shared.ts";
import {
	BOT_DELEGATION_JUDGMENTS,
	botSessionIds,
	createChargedRoot,
	createOwnerBot,
	lastResult,
	MODEL_ID,
	offeredTools,
	reached,
	TRACK,
	waitForBotRosterState,
} from "./journey-7-shared.ts";

const PLANNER = "pool-planner";
const PLANNER_SOUL =
	"You plan read-only workers over the connection pool settings and answer the owner in one sentence.";
/** The question asks what something is, and every answer states a fact that names no test, check, commit or change. */
const QUESTION = "How many connections and idle connections does the pool keep? Plan workers to read the settings.";
const TITLE = "Read the pool's connection counts";
const WRITE_STEP = "bot-pool-tune";
const SIZE_STEP = "bot-pool-size";
const IDLE_STEP = "bot-pool-idle";
const JOIN_STEP = "bot-pool-counts";
const SIZE_REPORT = "The pool holds eight connections.";
const IDLE_REPORT = "The pool keeps two idle connections.";
const ANSWER = "The pool holds eight connections and keeps two of them idle.";
/** The refusal of a step that names files in a session that lends its workers no writes (`plan-write-facts.ts`, F11). */
const UNLENT_FIX = `step "${WRITE_STEP}" names files, but this session changes no files and neither do its workers; leave out files`;
/** The note of a plan recorded on code facts alone (`plan-acceptance.ts`). */
const UNJUDGED_NOTE = "Checked on code facts alone: System One was unavailable.";
/** The director role's plan line for a session whose workers change no files: it asks for no files. */
const READ_ONLY_PLAN_LINE = "call plan once with every step and what it uses;";

/**
 * What the owner's words and the plan call's review ask with System One on: the owner-policy questions of a bot's own
 * session, whether the plan misses part of the request, the one pair the plan leaves unordered (the idle step names the
 * size step, so the review asks whether it needs its result, answered no, and whether the two steps say enough to tell,
 * answered yes, so both start at once), and whether each short step can be done from its own words.
 */
const BOT_PLAN_JUDGMENTS = {
	...BOT_DELEGATION_JUDGMENTS,
	misses_request_part: { kind: "noul", probability: 0.02 },
	needs_output_of: { kind: "noul", probability: 0.02 },
	pair_evidence_sufficient: { kind: "noul", probability: 0.97 },
	brief_self_contained: { kind: "noul", probability: 0.97 },
} as const;

/** The planner's own requests: its soul opens its system prompt, and its task carries no plan step's header. */
function isPlanner(request: ScriptedRequest): boolean {
	return (request.context.systemPrompt ?? "").includes(PLANNER_SOUL) && planStepOf(request) === undefined;
}

/** The planner's `plan start` with the steps given. */
function planStart(steps: readonly Record<string, unknown>[]): Record<string, unknown> {
	return { action: "start", title: TITLE, steps };
}

/**
 * Leg: a bot plans. A read-only bot's own session holds `plan`, and its director role asks for every step and what it
 * uses with no files. Its plan with a step that names files is refused with fact F11 (its workers would run read-only
 * under a plan that treats the step as a writer), and nothing is recorded. Its plan of two read-only steps and a collect
 * join is reviewed by System One when it is on (the request's coverage, the one unordered pair, each short step) and
 * recorded on code facts alone, with the note that says so, when it is off. Each step runs a read-only worker of the
 * bot's, recorded in the bot's bundle; the join settles in code, the plan closes settled, and its one result opens the
 * bot's answering turn.
 */
export async function runJourney7BotPlanPhase(world: HarnessWorld): Promise<void> {
	const { session } = await createChargedRoot(world, "bot-plan");
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the owner's session disposes cleanly").toBeUndefined();
	}
	world.trace.mark("root", "j7.bot-plan");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const { trace } = world;
	createOwnerBot(session, PLANNER, MODEL_ID.planner, PLANNER_SOUL);
	const done = createBarrier();
	const seen = { offered: [] as string[], systemPrompt: "", refusal: undefined as string | undefined, started: "" };
	const [planCall, planResult] = planCallSteps(
		"j7-planner-start",
		planStart([
			{
				id: SIZE_STEP,
				do: "Read the pool settings and report how many connections the pool holds. Change no file.",
			},
			{
				id: IDLE_STEP,
				do: `Read the pool settings and report how many idle connections the pool keeps, beside ${SIZE_STEP}. Change no file.`,
			},
			{ id: JOIN_STEP, do: "Combine both counts into one answer.", join: "collect", uses: [SIZE_STEP, IDLE_STEP] },
		]),
		"PLAN_STARTED",
		(text) => {
			seen.started = text;
		},
	);
	if (planCall === undefined || planResult === undefined) throw new Error("the plan call's steps are missing");
	world.provider.enqueueTrack(
		TRACK.planner,
		MODEL_ID.planner,
		isPlanner,
		{
			name: "j7-planner-unlent",
			check: (request) => {
				seen.offered = offeredTools(request);
				seen.systemPrompt = request.context.systemPrompt ?? "";
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-planner-unlent-1",
						name: "plan",
						arguments: planStart([
							{
								id: WRITE_STEP,
								do: "Raise the pool's connection limit to twelve in src/pool.ts.",
								files: ["src/pool.ts"],
								proof: "diff",
							},
						]),
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			...planCall,
			check: (request) => {
				const result = lastResult(request, "plan");
				seen.refusal = result?.isError ? result.text : undefined;
				planCall.check?.(request);
			},
		},
		planResult,
		{
			...planUpdateStep("j7-planner-done", "PLAN_DONE", () => done.release()),
			reply: { content: [{ type: "text", text: ANSWER }] },
		},
	);
	for (const [nodeId, report] of [
		[SIZE_STEP, SIZE_REPORT],
		[IDLE_STEP, IDLE_REPORT],
	] as const) {
		world.provider.enqueueTrack(
			`j7-plan-${nodeId}`,
			MODEL_ID.planner,
			(request) => planStepOf(request) === nodeId,
			reportStep(`j7-plan-${nodeId}-report`, { status: "completed", summary: report }),
		);
	}

	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-plan", BOT_PLAN_JUDGMENTS);
	const sent = await session.sendOperatorMessageToBot(PLANNER, QUESTION);
	await withDeadline(trace, "J7 bot plan: the plan's result woke the bot", done.promise, 60_000);
	await withDeadline(
		trace,
		"J7 bot plan: the bot answered the plan's result",
		world.provider.whenReached(reached(TRACK.planner, "j7-planner-done")),
	);
	await waitForBotRosterState(world, session, PLANNER, "idle");
	const [botSessionId] = botSessionIds(world, PLANNER);
	if (botSessionId === undefined) throw new Error("the planning bot opened no session file");
	const projection = readTaskRuntimeProjection(
		new OrchestrationEventStore({
			orchestrationHome: botOrchestrationHome(world.agentDir, PLANNER),
			sessionId: botSessionId,
		}),
	);
	const plans = Object.values(projection.plans);
	const plan = plans.find((candidate) => "title" in candidate.record && candidate.record.title === TITLE);
	const record = plan && "unjudged" in plan.record ? plan.record : undefined;
	const join = plan?.nodes[JOIN_STEP]?.join;
	const joined = join && "status" in join.outcome ? join.outcome : undefined;
	const judged = world.systemOne.enabled;
	expect(
		{
			sent: sent.mode,
			holdsPlan: seen.offered.includes("plan"),
			readOnlyPlanLine: seen.systemPrompt.includes(READ_ONLY_PLAN_LINE),
			asksForFiles: seen.systemPrompt.includes("every step, its files"),
			refused: seen.refusal?.includes(UNLENT_FIX),
			plans: plans.length,
			unjudged: record?.unjudged,
			unjudgedNote: seen.started.includes(UNJUDGED_NOTE),
			workers: [SIZE_STEP, IDLE_STEP].map((nodeId) =>
				writeAuthorityIn(projection, plan?.nodes[nodeId]?.release?.taskId),
			),
			join: joined?.status,
			closed: plan?.closed?.status,
		},
		judged
			? "a read-only bot holds plan with no files asked, its plan that names files is refused with F11, and its read-only plan is reviewed by System One, runs read-only workers of its own and closes settled"
			: "a read-only bot holds plan with no files asked, its plan that names files is refused with F11, and its read-only plan is recorded on code facts alone, runs read-only workers of its own and closes settled",
	).toEqual({
		sent: "started",
		holdsPlan: true,
		readOnlyPlanLine: true,
		asksForFiles: false,
		refused: true,
		// The refused plan recorded nothing.
		plans: 1,
		unjudged: !judged,
		unjudgedNote: !judged,
		workers: [
			{ readOnly: true, writePaths: [], editTools: [] },
			{ readOnly: true, writePaths: [], editTools: [] },
		],
		join: "succeeded",
		closed: "settled",
	});
}
