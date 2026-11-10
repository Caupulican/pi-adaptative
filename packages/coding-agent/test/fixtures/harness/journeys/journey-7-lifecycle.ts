import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import { createBarrier, HARNESS_PROVIDER, type ScriptedReply, type ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { deliveredLines } from "./journey-5-shared.ts";
import {
	acceptedJson,
	agentsOn,
	botRecord,
	carries,
	delegationOf,
	enqueueBot,
	enqueueRoot,
	loadBotToolStep,
	MODEL_ID,
	modelOf,
	offeredTools,
	onlyAgentOn,
	PHASE_JUDGMENTS,
	reached,
	requestJson,
	TRACK,
} from "./journey-7-shared.ts";

const STOP_LEADER = "stop-leader";
const STOP_LEADER_SOUL = "You lead a goal for the orchestrator and hand its parts to your bots.";
const STOP_LEADER_FRAGMENT = "hand its parts to your bots";
const STOP_GOAL = "Report the sum of two numbers.";
const STOP_HELPER = "answers-sums-leader";
const STOP_HELPER_SOUL = "You answer sums for your leader with one short sentence.";
const STOP_HELPER_DESCRIPTION = "Answers sums for its leader";
const STOP_TASK = "Add two and five.";
const STOPPED_LEADER_REPORT = "The goal is dropped.";
const STOPPED_GOAL_REPORT = "The goal ended with its bot stopped.";
const STOPPED_HELPER_REPORT = "Stopped.";

const TAB = "tab-notes";
const TAB_SOUL = "You answer owner questions about the tab width with one short sentence.";
const TAB_QUESTION = "How wide is the tab?";
const TAB_ANSWER = "The tab is three.";
const TAB_SECOND_QUESTION = "Say the tab width once more.";
const TAB_SECOND_ANSWER = "The tab is still three.";

/** A worker in the middle of its work: one more tool call, whose result its next request would carry. */
function listPeersCall(id: string): ScriptedReply {
	return {
		content: [{ type: "toolCall", id, name: "bot_message", arguments: { action: "list" } }],
		stopReason: "toolUse",
	};
}

/** Retiring a leader that leads an open goal is refused in the product's words: its goal would be orphaned. */
const OPEN_GOAL = `Bot ${STOP_LEADER} leads an open goal; cancel it first (/lead cancel ${STOP_LEADER}).`;

/**
 * Leg 6: retire and stop. A leader with an open goal cannot be retired; an idle bot is retired with its worker and comes
 * back when the owner writes to it again; stopping a working leader interrupts it and the bots it made, and retires none.
 */
export async function runJourney7LifecyclePhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the lifecycle session disposes cleanly").toBeUndefined();
	}
	trace.mark("root", "j7.lifecycle");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	session.upsertPersistentBot({
		agentId: STOP_LEADER,
		displayName: displayNameFor(STOP_LEADER),
		provider: HARNESS_PROVIDER,
		modelId: MODEL_ID.stopLeader,
		soul: STOP_LEADER_SOUL,
		createdBy: "owner",
	});
	session.upsertPersistentBot({ agentId: STOP_LEADER, leader: true });
	session.upsertPersistentBot({
		agentId: TAB,
		displayName: displayNameFor(TAB),
		provider: HARNESS_PROVIDER,
		modelId: MODEL_ID.idle,
		soul: TAB_SOUL,
		createdBy: "owner",
	});

	const seen = {
		stopNotice: [] as string[],
		leaderHeard: {} as Record<string, unknown>,
		leaderLast: {} as Record<string, unknown>,
		helperLast: {} as Record<string, unknown>,
	};
	/** What a halted worker's one closing request is: the parent's stop in its conversation, and no tool to call. */
	const closingRequest = (request: ScriptedRequest) => ({
		toldToStop: carries(request, "[Worker control halt]"),
		tools: offeredTools(request).length,
	});
	const leaderHeld = createBarrier();
	const helperHeld = createBarrier();

	enqueueBot(
		world,
		TRACK.stopLeader,
		MODEL_ID.stopLeader,
		STOP_LEADER_FRAGMENT,
		{
			name: "j7-stop-create",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-stop-create-1",
						name: "bot_message",
						arguments: {
							action: "create",
							description: STOP_HELPER_DESCRIPTION,
							soul: STOP_HELPER_SOUL,
							// A bot made without a model runs on the default worker model; this one is told apart by its own.
							model: modelOf(MODEL_ID.stopHelper),
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-stop-send",
			check: (request) => {
				acceptedJson(request, "bot_message");
			},
			reply: (request) => {
				const created = acceptedJson(request, "bot_message");
				return {
					content: [
						{
							type: "toolCall" as const,
							id: "j7-stop-send-1",
							name: "bot_message",
							arguments: { action: "send", agentId: String(created.agentId), message: STOP_TASK },
						},
					],
					stopReason: "toolUse" as const,
				};
			},
		},
		{
			name: "j7-stop-held",
			gate: leaderHeld.promise,
			// Still working when the stop arrives: a call is under way, so the run has a next request for the stop to take.
			reply: listPeersCall("j7-stop-held-1"),
		},
		{
			name: "j7-stop-report",
			check: (request) => {
				seen.leaderLast = closingRequest(request);
			},
			reply: { content: [{ type: "text", text: STOPPED_LEADER_REPORT }] },
		},
		{
			// The stop interrupted the goal's work and left the goal open: the stopped bot's report still reaches its leader,
			// and that is the leader's next turn.
			name: "j7-stop-hears-helper",
			check: (request) => {
				const handoff = requestJson(request).match(/status=([a-z_]+)\\nreasonCode=([A-Za-z0-9_:.-]+)/);
				seen.leaderHeard = {
					handoff: carries(request, "Worker terminal handoff"),
					status: handoff?.[1],
					reason: handoff?.[2],
					carriesBotReport: carries(request, STOPPED_HELPER_REPORT),
				};
			},
			reply: { content: [{ type: "text", text: STOPPED_GOAL_REPORT }] },
		},
	);
	enqueueBot(
		world,
		TRACK.stopHelper,
		MODEL_ID.stopHelper,
		STOP_HELPER_SOUL,
		{
			name: "j7-stop-helper-held",
			gate: helperHeld.promise,
			reply: listPeersCall("j7-stop-helper-held-1"),
		},
		{
			name: "j7-stop-helper-report",
			check: (request) => {
				seen.helperLast = closingRequest(request);
			},
			reply: { content: [{ type: "text", text: STOPPED_HELPER_REPORT }] },
		},
	);
	enqueueBot(
		world,
		TRACK.idle,
		MODEL_ID.idle,
		TAB_SOUL,
		{
			name: "j7-idle-first",
			check: (request) => {
				if (!carries(request, TAB_QUESTION)) throw new Error("the idle bot's first owner message is missing");
			},
			reply: { content: [{ type: "text", text: TAB_ANSWER }] },
		},
		{
			name: "j7-idle-second",
			check: (request) => {
				if (!carries(request, TAB_SECOND_QUESTION))
					throw new Error("the idle bot's second owner message is missing");
			},
			reply: { content: [{ type: "text", text: TAB_SECOND_ANSWER }] },
		},
	);
	enqueueRoot(
		world,
		loadBotToolStep("j7-lifecycle-load"),
		{
			name: "j7-stop-lead-call",
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-stop-lead-call-1",
						name: "bot",
						arguments: { action: "lead", goal: STOP_GOAL, agentId: STOP_LEADER },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-stop-lead-result",
			check: (request) => {
				const result = acceptedJson(request, "bot");
				if (result.delegated !== true) throw new Error(`the goal was not delegated: ${JSON.stringify(result)}`);
			},
			reply: { content: [{ type: "text", text: "The goal is running." }] },
		},
		{
			name: "j7-stop-outcome",
			check: (request) => {
				seen.stopNotice = deliveredLines(request);
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-lifecycle", PHASE_JUDGMENTS);

	await withDeadline(trace, "J7 leg 6: the root hands a goal to the leader", session.prompt(STOP_GOAL));
	await withDeadline(
		trace,
		"J7 leg 6: the leader reached its held request",
		world.provider.whenReached(reached(TRACK.stopLeader, "j7-stop-held")),
	);
	await withDeadline(
		trace,
		"J7 leg 6: the bot the leader made is working",
		world.provider.whenReached(reached(TRACK.stopHelper, "j7-stop-helper-held")),
	);

	const leaderAgent = onlyAgentOn(session, MODEL_ID.stopLeader).agentId;
	const helperAgent = onlyAgentOn(session, MODEL_ID.stopHelper).agentId;

	// A leader whose goal is open cannot be retired: the goal and the bots under it would be orphaned.
	const refusedRetire = session.retirePersistentBot(STOP_LEADER);
	expect(
		{ refusedRetire, stillStored: botRecord(session, STOP_LEADER).retired === true },
		"retiring the leader of an open goal is refused in the product's words, and its record stays as it was",
	).toEqual({ refusedRetire: { retired: false, detail: OPEN_GOAL }, stillStored: false });

	// Stopping it interrupts the leader and the bot it made, and retires neither.
	const stopped = session.stopPersistentBot(STOP_LEADER);
	const statusOf = (modelId: string, agentId: string): string | undefined =>
		agentsOn(session, modelId).find((agent) => agent.agentId === agentId)?.status;
	const liveAfterStop = [
		statusOf(MODEL_ID.stopLeader, leaderAgent) !== "retired",
		statusOf(MODEL_ID.stopHelper, helperAgent) !== "retired",
	];
	const afterStop = {
		stopped,
		leaderRetired: botRecord(session, STOP_LEADER).retired === true,
		helperRetired: botRecord(session, STOP_HELPER).retired === true,
		// The halt lands at the request boundary: right after the call both workers are still the live ones.
		stillLive: liveAfterStop,
	};
	expect(afterStop, "stopping the working leader halts it and the bot it made, and retires neither").toEqual({
		stopped: { stopped: true, detail: `Stopped ${STOP_LEADER} and its bot ${STOP_HELPER} (halt).` },
		leaderRetired: false,
		helperRetired: false,
		stillLive: [true, true],
	});

	// Each interrupted worker spends one tool-free request on its own report, and the goal ends.
	leaderHeld.release();
	helperHeld.release();
	await withDeadline(
		trace,
		"J7 leg 6: the stopped leader reported",
		world.provider.whenReached(reached(TRACK.stopLeader, "j7-stop-report")),
	);
	await withDeadline(
		trace,
		"J7 leg 6: the stopped bot reported",
		world.provider.whenReached(reached(TRACK.stopHelper, "j7-stop-helper-report")),
	);
	await withDeadline(
		trace,
		"J7 leg 6: the stopped goal's outcome reached the root",
		world.provider.whenReached(reached(TRACK.root, "j7-stop-outcome")),
	);
	await withDeadline(trace, "J7 leg 6: the root is idle", session.waitForForegroundIdle());
	expect(
		{ leader: seen.leaderLast, helper: seen.helperLast },
		"each stopped worker gets one closing request: it is told the parent stopped it, and it is offered no tool",
	).toEqual({ leader: { toldToStop: true, tools: 0 }, helper: { toldToStop: true, tools: 0 } });
	const stopOutcome = seen.stopNotice.find((line) => line.startsWith("Leader "));
	expect(
		{
			leaderHeard: seen.leaderHeard,
			outcome: stopOutcome,
			reportQuoted: seen.stopNotice.includes(STOPPED_GOAL_REPORT),
			goal: delegationOf(session, STOP_LEADER).state,
		},
		"a stop interrupts the work and leaves the goal open: the stopped bot's report reaches its leader, whose next turn ends the goal, and the root is told once",
	).toEqual({
		leaderHeard: { handoff: true, status: "blocked", reason: "worker_interrupted", carriesBotReport: true },
		// The goal's outcome combines its turns as they ended. The bot's last turn was interrupted, and an interrupted turn
		// is worded as one that waits to run again, also when a stop ended it.
		outcome: `Leader ${displayNameFor(STOP_LEADER)} finished the goal "${STOP_GOAL}": Blocked: it was interrupted. Next: waiting for room to run.`,
		reportQuoted: true,
		goal: "closed",
	});

	// An idle bot: retiring it marks the record and retires its worker; a later message brings it back.
	const firstSend = await session.sendOperatorMessageToBot(TAB, TAB_QUESTION);
	await withDeadline(
		trace,
		"J7 leg 6: the idle bot answered",
		session.backgroundLanes.waitForWorkerAgent(onlyAgentOn(session, MODEL_ID.idle).agentId, 60_000),
	);
	const retiredIdle = session.retirePersistentBot(TAB);
	expect(
		{
			firstSend: firstSend.mode,
			retiredIdle,
			recordRetired: botRecord(session, TAB).retired === true,
			workerStatuses: agentsOn(session, MODEL_ID.idle).map((agent) => agent.status),
		},
		"retiring an idle bot marks its record retired and retires its worker",
	).toEqual({
		firstSend: "started",
		retiredIdle: { retired: true, detail: `Bot ${TAB} retired.` },
		recordRetired: true,
		workerStatuses: ["retired"],
	});

	const secondSend = await session.sendOperatorMessageToBot(TAB, TAB_SECOND_QUESTION);
	expect(
		{ secondSend: secondSend.mode, recordRetired: botRecord(session, TAB).retired === true },
		"a message to a retired bot brings it back: the record is no longer retired",
	).toEqual({ secondSend: "started", recordRetired: false });
	await withDeadline(
		trace,
		"J7 leg 6: the brought-back bot answered",
		world.provider.whenReached(reached(TRACK.idle, "j7-idle-second")),
	);
}
