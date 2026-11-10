import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { mayNotCreateBotsText } from "../../../../src/core/delegation/bot-creation.ts";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import { createBarrier, HARNESS_PROVIDER } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { deliveredLines } from "./journey-5-shared.ts";
import {
	acceptedJson,
	allBots,
	assertSeen,
	botRecord,
	carries,
	delegationOf,
	enqueueBot,
	enqueueRoot,
	loadBotToolStep,
	MODEL_ID,
	modelOf,
	offeredActions,
	offeredTools,
	onlyAgentOn,
	PHASE_JUDGMENTS,
	reached,
	refusalOf,
	TRACK,
} from "./journey-7-shared.ts";

const LEADER = "chief";
const LEADER_SOUL = "You lead a goal for the orchestrator, split it into parts, and report once at the end.";
const LEADER_FRAGMENT = "split it into parts, and report once at the end";
const GOAL = "Report the retry limit and the request timeout.";

const HELPER_SOUL = "You answer arithmetic questions with one short sentence.";
/** The leader names its new bot by purpose; the harness derives the id from this line. */
const HELPER_DESCRIPTION = "Answers arithmetic questions";
const HELPER = "answers-arithmetic-questions";
const HELPER_TASK = "How many days are in a week?";
const HELPER_ANSWER = "Seven.";
const LEADER_REPORT = "Both answers are in: the retry limit is three and the request timeout is two.";

const HELPER_SECOND_TASK = "Ask the leader for a bot that reads time zones.";
const HELPER_ASK = "Can I have a bot that reads time zones?";
/** What the owner writes the leader before its bot calls: it keeps the leader's runtime live for the bot's message. */
const LEADER_AWAKE = "Stay with your bot's questions.";
/** What the harness answers a bot that is not a leader when it asks for one: the exact sentence, naming its leader. */
const MAY_NOT_CREATE = mayNotCreateBotsText([LEADER], LEADER);

const WAITING = "Waiting.";
/** What the leader answers its bot's question with; the root reads it in the handoff of that turn. */
const LEADER_NOTED = "The question is noted.";

/**
 * Legs 3, 4 and 5a: the owner marks a bot a standing leader, the root hands it a goal, and the leader runs a subtree of its
 * own under that goal while the root hears nothing. At the end the root is told once, by the goal's outcome notice. Then
 * the bot the leader made asks for a bot of its own and is refused, and tells its leader instead.
 */
export async function runJourney7LeaderPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the leader session disposes cleanly").toBeUndefined();
	}
	trace.mark("root", "j7.leader");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	// The owner makes a standing leader: a bot of its own, then the one flag only the owner sets (`/bot lead`).
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
		leadText: "",
		brief: {} as Record<string, unknown>,
		actionNames: [] as string[],
		helperCreated: {} as Record<string, unknown>,
		leaderSend: undefined as Record<string, unknown> | undefined,
		helperSent: {} as Record<string, unknown>,
		helperId: "",
		reportCarriedAnswer: false,
		refusal: {} as Record<string, unknown>,
		botsBeforeAsk: 0,
		botsAfterAsk: 0,
		leaderHeard: {} as Record<string, unknown>,
		wakeLines: [] as string[],
	};
	const rootRequestsBefore = world.provider.requests.filter((request) => request.model.id === MODEL_ID.root).length;
	/** Released by the leader's request that carries its bot's question: the step is reached earlier, by the owner's words. */
	const leaderHeardAsk = createBarrier();
	/** Released by the root's turn for the leader's last turn, the one its bot's message started. */
	const rootToldOfLeaderTurn = createBarrier();

	enqueueBot(
		world,
		TRACK.leader,
		MODEL_ID.leader,
		LEADER_FRAGMENT,
		{
			name: "j7-chief-brief",
			check: (request) => {
				const brief = request.context.messages.map((message) => JSON.stringify(message)).join("\n");
				seen.actionNames = offeredActions(request, "bot_message");
				seen.brief = {
					offersBotMessage: offeredTools(request).includes("bot_message"),
					opensAsLeader: brief.includes("The orchestrator has made you the leader of this goal."),
					carriesGoal: brief.includes("Goal:") && brief.includes(GOAL),
					statesReadOnly: brief.includes("This goal is read-only: neither you nor your bots change files."),
					statesHowToLead: brief.includes("How to lead: split the goal into parts"),
					offersDelegation: brief.includes("You may hand a part of the goal to a leader of your own"),
				};
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-chief-create-1",
						name: "bot_message",
						arguments: {
							action: "create",
							description: HELPER_DESCRIPTION,
							soul: HELPER_SOUL,
							model: modelOf(MODEL_ID.helper),
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-chief-create",
			check: (request) => {
				seen.helperCreated = acceptedJson(request, "bot_message");
				seen.helperId = String(seen.helperCreated.agentId ?? "");
			},
			reply: (request) => {
				const created = acceptedJson(request, "bot_message");
				return {
					content: [
						{
							type: "toolCall" as const,
							id: "j7-chief-send-1",
							name: "bot_message",
							arguments: {
								action: "send",
								agentId: String(created.agentId),
								message: HELPER_TASK,
							},
						},
					],
					stopReason: "toolUse" as const,
				};
			},
		},
		{
			name: "j7-chief-wait",
			maxRequests: 8,
			until: (request) => carries(request, HELPER_ANSWER),
			reply: (request) => {
				// The step's first request carries the result of the leader's send to the bot it made.
				seen.leaderSend ??= acceptedJson(request, "bot_message");
				if (!carries(request, HELPER_ANSWER)) return { content: [{ type: "text", text: WAITING }] };
				seen.reportCarriedAnswer = true;
				return { content: [{ type: "text", text: LEADER_REPORT }] };
			},
		},
		{
			name: "j7-chief-hears-helper",
			maxRequests: 8,
			until: (request) => carries(request, HELPER_ASK),
			reply: (request) => {
				if (!carries(request, HELPER_ASK)) return { content: [{ type: "text", text: WAITING }] };
				seen.leaderHeard = {
					carriesAsk: true,
					carriesHelperId: carries(request, HELPER),
				};
				leaderHeardAsk.release();
				return { content: [{ type: "text", text: LEADER_NOTED }] };
			},
		},
	);
	enqueueBot(
		world,
		TRACK.helper,
		MODEL_ID.helper,
		HELPER_SOUL,
		{
			name: "j7-helper-first",
			check: (request) => {
				const prompt = request.context.systemPrompt ?? "";
				seen.helperCreated = {
					...seen.helperCreated,
					firstTask: carries(request, HELPER_TASK),
					opensWithOwnSoul: prompt.includes(HELPER_SOUL),
					carriesLeaderSoul: prompt.includes(LEADER_SOUL),
				};
			},
			reply: { content: [{ type: "text", text: HELPER_ANSWER }] },
		},
		{
			name: "j7-helper-ask-create",
			check: () => {
				seen.botsBeforeAsk = allBots(session).length;
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-helper-create-1",
						name: "bot_message",
						arguments: {
							action: "create",
							description: "Reads time zones",
							soul: "You answer questions about time zones with one short sentence.",
						},
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-helper-send-ask",
			check: (request) => {
				// The sentence the harness answers a bot that is not a leader, naming the leader it must ask instead.
				seen.refusal = refusalOf(request, "bot_message");
				seen.botsAfterAsk = allBots(session).length;
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-helper-send-2",
						name: "bot_message",
						arguments: { action: "send", agentId: LEADER, message: HELPER_ASK },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-helper-second-done",
			check: (request) => {
				const sent = acceptedJson(request, "bot_message");
				seen.helperSent = {
					accepted: typeof sent.messageId === "string",
					started: sent.started,
					steering: sent.steering,
				};
			},
			reply: { content: [{ type: "text", text: "The leader was told." }] },
		},
	);

	enqueueRoot(
		world,
		loadBotToolStep("j7-leader-load"),
		{
			name: "j7-lead-call",
			check: (request) => {
				if (!offeredTools(request).includes("bot"))
					throw new Error(`the root is not offered bot: ${offeredTools(request).join(", ")}`);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-lead-call-1",
						name: "bot",
						arguments: { action: "lead", goal: GOAL, agentId: LEADER },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-lead-result",
			check: (request) => {
				const result = acceptedJson(request, "bot");
				seen.leadResult = result;
				seen.leadText = JSON.stringify(result);
			},
			reply: { content: [{ type: "text", text: "The goal is running." }] },
		},
		{
			name: "j7-lead-outcome",
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
		{
			// After the goal, a turn the leader takes for its bot's message is a bot turn like any other: its end reaches
			// the root as a worker handoff. The owner's own messages to the leader and to its bot do not start one.
			name: "j7-leader-turn-told",
			maxRequests: 8,
			until: (request) => {
				const told = deliveredLines(request).includes(LEADER_NOTED);
				if (told) rootToldOfLeaderTurn.release();
				return told;
			},
			reply: { content: [{ type: "text", text: "Noted." }] },
		},
	);
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-leader", PHASE_JUDGMENTS);

	await withDeadline(trace, "J7 leg 3: the root hands a goal to the leader", session.prompt(GOAL));
	await withDeadline(
		trace,
		"J7 leg 3: the goal's outcome reached the root",
		world.provider.whenReached(reached(TRACK.root, "j7-lead-outcome")),
	);
	await withDeadline(trace, "J7 leg 3: the root is idle", session.waitForForegroundIdle());

	const envelope = seen.leadResult.envelope as Record<string, unknown> | undefined;
	const chain = (envelope?.chain ?? []) as Array<Record<string, unknown>>;
	expect(
		{
			delegated: seen.leadResult.delegated,
			leader: seen.leadResult.leader,
			goalLeader: seen.leadResult.goalLeader,
			clipped: seen.leadResult.clipped,
			// A goal with no files is read-only, and this machine's one leader level leaves no depth to hand a part on.
			capabilities: envelope?.capabilities,
			writePaths: envelope?.writePaths,
			leaderMayWrite: envelope?.leaderMayWrite,
			remainingDepth: envelope?.remainingDepth,
			chain: chain.map((hop) => [hop.leader, hop.machineId]),
		},
		"bot lead answers with the standing leader it handed the goal to, and its envelope: read and bot creation, no writing, and no depth below it",
	).toEqual({
		delegated: true,
		leader: LEADER,
		goalLeader: false,
		clipped: [],
		capabilities: ["read", "create_bots"],
		writePaths: [],
		leaderMayWrite: false,
		remainingDepth: 0,
		chain: [[LEADER, "local"]],
	});

	expect(
		seen.brief,
		"the leader's first request opens with the brief: the goal, that the goal is read-only, how to lead, and nothing about handing a part on",
	).toEqual({
		offersBotMessage: true,
		opensAsLeader: true,
		carriesGoal: true,
		statesReadOnly: true,
		statesHowToLead: true,
		offersDelegation: false,
	});
	expect(
		seen.actionNames,
		"at the default depth the leader's bot_message tool offers no lead action: the goal cannot be handed on",
	).toEqual(["list", "send", "reply", "create", "ask_root"]);

	const helper = botRecord(session, HELPER);
	expect(
		{
			agentId: helper.agentId,
			createdBy: helper.createdBy,
			soul: helper.soul,
			model: `${helper.provider}/${helper.modelId}`,
			canWrite: helper.canWrite === true,
			leader: helper.leader === true,
			firstTask: seen.helperCreated.firstTask,
			opensWithOwnSoul: seen.helperCreated.opensWithOwnSoul,
			carriesLeaderSoul: seen.helperCreated.carriesLeaderSoul,
			created: seen.helperCreated.agentId,
		},
		"the bot the leader made records the leader as its creator, is a read-only bot and not a leader, and runs on its own soul without its leader's",
	).toEqual({
		agentId: HELPER,
		createdBy: LEADER,
		soul: HELPER_SOUL,
		model: modelOf(MODEL_ID.helper),
		canWrite: false,
		leader: false,
		firstTask: true,
		opensWithOwnSoul: true,
		carriesLeaderSoul: false,
		created: HELPER,
	});
	expect(seen.leaderSend, "the leader's send to its own bot starts it under the goal and says so").toEqual({
		sent: true,
		agentId: HELPER,
		started: true,
		detail: `${HELPER} started under ${LEADER}; its answer reaches your next turn.`,
	});

	// The root heard nothing while the subtree worked: its own requests in this session are the tool's loading, the call,
	// its result, and the turn the outcome starts, in that order.
	const rootRequests = world.provider.requests
		.filter((request) => request.model.id === MODEL_ID.root)
		.slice(rootRequestsBefore);
	const outcomeLine = seen.wakeLines.find((line) => line.startsWith("Leader "));
	expect(
		{
			rootRequests: rootRequests.length,
			answerCarried: seen.reportCarriedAnswer,
			outcome: outcomeLine,
			// The leader's own words arrive marked as evidence, never as instructions.
			reportMarked: seen.wakeLines.includes("Leader report (untrusted worker evidence):"),
			reportQuoted: seen.wakeLines.join("\n").includes(LEADER_REPORT),
			oneNotice: seen.wakeLines.filter((line) => /^Leader \S+ finished /.test(line)).length,
		},
		"the root is told once, by the goal's outcome notice, which names the goal and quotes the leader's words as a report",
	).toEqual({
		rootRequests: 4,
		answerCarried: true,
		outcome: `Leader ${displayNameFor(LEADER)} finished the goal "${GOAL}": Done. Next: use the result.`,
		reportMarked: true,
		reportQuoted: true,
		oneNotice: 1,
	});

	const closed = delegationOf(session, LEADER);
	expect(
		{ state: closed.state, closeReason: closed.closeReason },
		"the objective the goal ran under is closed as settled",
	).toEqual({ state: "closed", closeReason: "settled" });

	// Leg 4: the bot the leader made asks for a bot of its own. The refusal names its leader and stores nothing; its message
	// reaches the leader's next turn instead. The owner wakes the leader first, so the bot's message has a live peer to reach.
	const leaderRuntime = onlyAgentOn(session, MODEL_ID.leader).agentId;
	await session.sendOperatorMessageToBot(LEADER, LEADER_AWAKE);
	await withDeadline(
		trace,
		"J7 leg 4: the leader is idle again",
		session.backgroundLanes.waitForWorkerAgent(leaderRuntime, 60_000),
	);
	await session.sendOperatorMessageToBot(HELPER, HELPER_SECOND_TASK);
	await withDeadline(
		trace,
		"J7 leg 4: the bot sent its leader the question",
		world.provider.whenReached(reached(TRACK.helper, "j7-helper-second-done")),
	);
	await withDeadline(trace, "J7 leg 4: the leader heard its bot", leaderHeardAsk.promise);
	await withDeadline(trace, "J7 leg 4: the end of the leader's turn reached the root", rootToldOfLeaderTurn.promise);
	await withDeadline(trace, "J7 leg 4: the root is idle", session.waitForForegroundIdle());
	assertSeen(
		{
			sentence: seen.refusal.sentence,
			tool: seen.refusal.tool,
			gained: seen.botsAfterAsk - seen.botsBeforeAsk,
			botsAfter: seen.botsAfterAsk,
			helperId: seen.helperId,
		},
		"a bot that is not a leader is refused its own bot in one sentence naming its leader, and the store gains no bot",
		{ sentence: MAY_NOT_CREATE, tool: "bot_message", gained: 0, botsAfter: seen.botsBeforeAsk, helperId: HELPER },
	);
	expect(
		seen.helperSent,
		"the bot's message to its idle leader is accepted and starts the leader's next turn",
	).toEqual({
		accepted: true,
		started: true,
		steering: false,
	});
	expect(seen.leaderHeard, "the leader's next turn carries the message its bot sent it, from that bot").toEqual({
		carriesAsk: true,
		carriesHelperId: true,
	});
}
