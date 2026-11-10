import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import { HARNESS_PROVIDER } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { deliveredLines } from "./journey-5-shared.ts";
import {
	acceptedJson,
	carries,
	delegationsOf,
	enqueueBot,
	enqueueRoot,
	GOAL_LEADER_OPENING,
	loadBotToolStep,
	MODEL_ID,
	offeredActions,
	PHASE_JUDGMENTS,
	reached,
	TRACK,
} from "./journey-7-shared.ts";

const LEADER = "chief";
const LEADER_SOUL = "You lead a goal for the orchestrator, split it into parts, and report once at the end.";
const LEADER_FRAGMENT = "split it into parts, and report once at the end";
const GOAL = "Report how many days a week holds.";
const PART_GOAL = "Count the days in one week.";
const CHIEF_REPORT = "The part is in: seven.";
const PART_REPORT = "The count is seven.";

/**
 * Leg 5, second half: with `leaders.maxDepth` raised to two, a leader's goal may hand a part to a leader of its own. The
 * second objective names the first as its parent, the part's leader reports to the leader that handed it on, and the first
 * closes only after the second.
 */
export async function runJourney7DepthPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const { session } = await world.createRootSession(MODEL_ID.root, {
		sessionManager: world.createSessionManager(),
		settings: { leaders: { maxDepth: 2 } },
	});
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the deeper session disposes cleanly").toBeUndefined();
	}
	trace.mark("root", "j7.depth");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	// The same standing leader the owner made: the setting, not the leader, decides how deep a goal may nest.
	session.upsertPersistentBot({
		agentId: LEADER,
		displayName: displayNameFor(LEADER),
		provider: HARNESS_PROVIDER,
		modelId: MODEL_ID.leader,
		soul: LEADER_SOUL,
		createdBy: "owner",
	});
	session.upsertPersistentBot({ agentId: LEADER, leader: true });

	const seen = {
		leadResult: {} as Record<string, unknown>,
		briefOffersDelegation: false,
		actionNames: [] as string[],
		partResult: {} as Record<string, unknown>,
		partHeardPartGoal: false,
		handedOnLine: false,
		wakeLines: [] as string[],
	};

	enqueueBot(
		world,
		TRACK.leaderDepth,
		MODEL_ID.leader,
		LEADER_FRAGMENT,
		{
			name: "j7-depth-brief",
			check: (request) => {
				const brief = request.context.messages.map((message) => JSON.stringify(message)).join("\n");
				seen.actionNames = offeredActions(request, "bot_message");
				seen.briefOffersDelegation = brief.includes(
					"You may hand a part of the goal to a leader of your own with bot_message action lead",
				);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-depth-lead-1",
						name: "bot_message",
						arguments: { action: "lead", goal: PART_GOAL },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-depth-part-result",
			check: (request) => {
				seen.partResult = acceptedJson(request, "bot_message");
			},
			reply: { content: [{ type: "text", text: "Waiting." }] },
		},
		{
			name: "j7-depth-report",
			maxRequests: 8,
			until: (request) => carries(request, "you handed on"),
			reply: (request) => {
				if (!carries(request, "you handed on")) return { content: [{ type: "text", text: "Waiting." }] };
				seen.handedOnLine = true;
				return { content: [{ type: "text", text: CHIEF_REPORT }] };
			},
		},
	);
	// A goal leader appointed by a leader runs on the session's model, so it is told apart by the soul it was created with.
	enqueueBot(world, TRACK.goalLeader, MODEL_ID.goalLeader, GOAL_LEADER_OPENING, {
		name: "j7-part-brief",
		check: (request) => {
			seen.partHeardPartGoal = carries(request, PART_GOAL);
		},
		reply: { content: [{ type: "text", text: PART_REPORT }] },
	});
	enqueueRoot(
		world,
		loadBotToolStep("j7-depth-load"),
		{
			name: "j7-depth-call",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-depth-call-1",
						name: "bot",
						arguments: { action: "lead", goal: GOAL, agentId: LEADER },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-depth-lead-result",
			check: (request) => {
				seen.leadResult = acceptedJson(request, "bot");
			},
			reply: { content: [{ type: "text", text: "The goal is running." }] },
		},
		{
			name: "j7-depth-outcome",
			maxRequests: 8,
			until: (request) => deliveredLines(request).some((line) => line.startsWith("Leader ")),
			reply: (request) => {
				const lines = deliveredLines(request);
				if (!lines.some((line) => line.startsWith("Leader "))) {
					return { content: [{ type: "text", text: "Nothing to read yet." }] };
				}
				seen.wakeLines = lines;
				return { content: [{ type: "text", text: "Noted." }] };
			},
		},
	);
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-depth", PHASE_JUDGMENTS);

	await withDeadline(trace, "J7 leg 5: the root hands a goal to the leader", session.prompt(GOAL));
	await withDeadline(
		trace,
		"J7 leg 5: the goal's outcome reached the root",
		world.provider.whenReached(reached(TRACK.root, "j7-depth-outcome")),
	);
	await withDeadline(trace, "J7 leg 5: the root is idle", session.waitForForegroundIdle());

	const rootEnvelope = seen.leadResult.envelope as Record<string, unknown> | undefined;
	const partEnvelope = seen.partResult.envelope as Record<string, unknown> | undefined;
	expect(
		{
			rootDepth: rootEnvelope?.remainingDepth,
			rootCapabilities: rootEnvelope?.capabilities,
			// The leader's own goal may hand a part on, and its tool says so.
			briefOffersDelegation: seen.briefOffersDelegation,
			offersLeadAction: seen.actionNames.includes("lead"),
			partDelegated: seen.partResult.delegated,
			partGoalLeader: seen.partResult.goalLeader,
			partDepth: partEnvelope?.remainingDepth,
			partCapabilities: partEnvelope?.capabilities,
			partHeardPartGoal: seen.partHeardPartGoal,
		},
		"at depth two the root's leader may hand a part on, appoints a goal leader for it that is read-only, and that leader reads the part's goal",
	).toEqual({
		rootDepth: 1,
		rootCapabilities: ["read", "create_bots", "delegate"],
		briefOffersDelegation: true,
		offersLeadAction: true,
		partDelegated: true,
		partGoalLeader: true,
		partDepth: 0,
		partCapabilities: ["read", "create_bots"],
		partHeardPartGoal: true,
	});

	const records = delegationsOf(session);
	const first = records.find((record) => record.charter.leader === LEADER);
	if (first === undefined) throw new Error(`no delegation was led by ${LEADER}`);
	const part = records.find((record) => record.charter.parentObjectiveId === first.objectiveId);
	if (part === undefined) throw new Error("no delegation names the first as its parent");
	const outcomeLine = seen.wakeLines.find((line) => line.startsWith("Leader "));
	expect(
		{
			parent: part.charter.parentObjectiveId === first.objectiveId,
			partLeader: part.charter.leader !== LEADER,
			partAppointedBy: part.charter.appointedBy,
			chain: part.charter.envelope.chain.map((hop) => hop.objectiveId),
			partSettled: [part.state, part.closeReason],
			firstSettled: [first.state, first.closeReason],
			// The first closes only after the goal it handed on: its own Outcome carries the part's.
			firstClosedAfterPart:
				first.closedAt !== undefined && part.closedAt !== undefined && first.closedAt >= part.closedAt,
			handedOnLine: seen.handedOnLine,
			toldOnce: seen.wakeLines.filter((line) => /^Leader \S+ finished /.test(line)).length,
			goalInOutcome: outcomeLine?.includes(`the goal "${GOAL}"`),
			reportsChief: seen.wakeLines.join("\n").includes(CHIEF_REPORT),
		},
		"the second objective names the first as its parent and closes first, and the root is told once, of the first, with its leader's report",
	).toEqual({
		parent: true,
		partLeader: true,
		partAppointedBy: "root",
		chain: [first.objectiveId, part.objectiveId],
		partSettled: ["closed", "settled"],
		firstSettled: ["closed", "settled"],
		firstClosedAfterPart: true,
		handedOnLine: true,
		toldOnce: 1,
		goalInOutcome: true,
		reportsChief: true,
	});
}
