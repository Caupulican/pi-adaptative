import "../builtin-install.ts";
import { expect } from "vitest";
import { botHostLockFile } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { BotHostStateWriter } from "../../../../src/core/bots/bot-host-state.ts";
import { takeProcessLock } from "../../../../src/core/remote/host-lock.ts";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	agentsOn,
	botRosterState,
	botSessionFilesText,
	carries,
	chatText,
	createOwnerBot,
	enqueueBot,
	MODEL_ID,
	positionOf,
	reached,
	TRACK,
	teamLog,
	teamMessages,
	waitForBotRosterState,
} from "./journey-7-shared.ts";
import { INTAKE_JUDGMENTS_WITHOUT_GRANT } from "./shared.ts";

/** The owner-policy questions of a queued owner message in a session with no optional tool, no rule and every grant. */
const { optional_tool_0: _optionalTool, ...STEER_JUDGMENTS } = INTAKE_JUDGMENTS_WITHOUT_GRANT;

const READER = "reader-one";
const READER_SOUL = "You answer owner questions about the retry limit with one short sentence.";
const DIRECT_ONE = "How high is the retry limit?";
const DIRECT_TWO = "Say the same answer once more.";
const READER_ANSWER = "The retry limit is three.";

const TEAM = "j7-group";
const TEAM_ONE = "team-one";
const TEAM_TWO = "team-two";
const OUTSIDER = "ghost";
const TEAM_ONE_SOUL = "You answer group messages about the retry limit with one short sentence.";
const TEAM_TWO_SOUL = "You answer group messages about the request timeout with one short sentence.";
const TEAM_MESSAGE = "What is the retry limit?";
const TEAM_MENTION_BODY = "Answer once more, please.";
const TEAM_MENTION = `@${TEAM_ONE} ${TEAM_MENTION_BODY}`;
const OUTSIDER_MENTION = `@${OUTSIDER} Anything to add?`;
/** A bot that is not a member of the group cannot be reached through it; nothing is delivered and nothing is stored. */
const NOT_A_MEMBER = `Bot ${OUTSIDER} is not a member of group ${TEAM}.`;

const HELD = "held-elsewhere";
const HELD_SOUL = "You answer owner questions about the cache size with one short sentence.";
const HELD_QUESTION = "How large is the cache?";
const HELD_ANSWER = "The cache holds two hundred entries.";
/** Another bot session host: in another process, or another host in this one, the lock names it the same way. */
const OTHER_HOST = "j7-other-host";
const OTHER_HOST_SESSION = "0f1e2d3c-4b5a-4968-8776-655443322110";
/** The refusal names the session hosting the bot and its process, so the owner knows where to message it. */
const HELD_ELSEWHERE = `Bot ${HELD} is open in another session (${OTHER_HOST_SESSION.slice(0, 8)}, process ${process.pid}).`;

/**
 * Leg 2: the owner writes to one bot and then to a group. A send to an idle bot starts its own session (no worker stands
 * for it); a send while that session's turn is held is taken by the same session at its next request boundary, in order,
 * and both messages and the answer are in the bot's own session files. A group send fans out to every member, a
 * mention narrows it to one, and a mention of a bot outside the group is refused before anything is delivered. None of it
 * starts a root turn: the owner talks to the bots, not through the orchestrator. A bot another host holds is refused,
 * naming that host's session and process, and leaves nothing behind; once that host lets it go, the bot runs here.
 */
export async function runJourney7OwnerMessagesPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the owner's session disposes cleanly").toBeUndefined();
	}
	trace.mark("root", "j7.owner-messages");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	createOwnerBot(session, READER, MODEL_ID.reader, READER_SOUL);
	createOwnerBot(session, TEAM_ONE, MODEL_ID.teamOne, TEAM_ONE_SOUL);
	createOwnerBot(session, TEAM_TWO, MODEL_ID.teamTwo, TEAM_TWO_SOUL);
	// The outsider exists as a bot, so the mention reaches the group's membership check rather than a missing bot.
	createOwnerBot(session, OUTSIDER, MODEL_ID.teamOne, "You answer questions nobody asks with one short sentence.");
	session.getBotTeamStore().upsertTeam({
		teamId: TEAM,
		name: "Retry group",
		memberAgentIds: [TEAM_ONE, TEAM_TWO],
	});

	const rootRequestsBefore = world.provider.requests.filter((request) => request.model.id === MODEL_ID.root).length;
	const held = createBarrier();
	const firstTurnReached = createBarrier();
	const seen = {
		firstSoul: false,
		firstCarried: false,
		secondCarried: false,
		order: [] as number[],
		teamOneBodies: [] as string[],
		teamTwoCount: 0,
	};

	enqueueBot(
		world,
		TRACK.reader,
		MODEL_ID.reader,
		READER_SOUL,
		{
			name: "j7-reader-first",
			gate: held.promise,
			check: (request) => {
				// The bot's soul stands in its own prompt under its own heading, whatever the model's capability class.
				seen.firstSoul = (request.context.systemPrompt ?? "").includes(`SOUL\n${READER_SOUL}`);
				seen.firstCarried = carries(request, DIRECT_ONE);
				firstTurnReached.release();
			},
			reply: { content: [{ type: "text", text: "One moment." }] },
		},
		{
			name: "j7-reader-second",
			maxRequests: 8,
			until: (request) => carries(request, DIRECT_TWO),
			reply: (request) => {
				seen.secondCarried = carries(request, DIRECT_TWO);
				seen.order = [positionOf(request, DIRECT_ONE), positionOf(request, DIRECT_TWO)];
				return { content: [{ type: "text", text: READER_ANSWER }] };
			},
		},
	);
	enqueueBot(
		world,
		TRACK.teamOne,
		MODEL_ID.teamOne,
		TEAM_ONE_SOUL,
		{
			name: "j7-team-one-first",
			check: (request) => {
				seen.teamOneBodies.push(carries(request, TEAM_MENTION_BODY) ? "mention" : "group");
			},
			reply: { content: [{ type: "text", text: "It is three." }] },
		},
		{
			name: "j7-team-one-second",
			check: (request) => {
				seen.teamOneBodies.push(carries(request, TEAM_MENTION_BODY) ? "mention" : "group");
			},
			reply: { content: [{ type: "text", text: "It is still three." }] },
		},
	);
	enqueueBot(world, TRACK.teamTwo, MODEL_ID.teamTwo, TEAM_TWO_SOUL, {
		name: "j7-team-two-first",
		check: () => {
			seen.teamTwoCount = world.provider.requests.filter((entry) => entry.model.id === MODEL_ID.teamTwo).length;
		},
		reply: { content: [{ type: "text", text: "It is two." }] },
	});

	// The bot's own session runs System One as the root does. Its first message starts a turn that calls no tool, so its
	// words are never judged; the second, written while that turn runs, is a steer judged in full when it is queued: the
	// owner-policy questions alone, since every edge class is granted, no rule is written and no optional tool is offered.
	// No group member is a session, and no answer names a claim kind, so nothing else is asked.
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-owner-messages", STEER_JUDGMENTS);

	// One bot, two owner messages: the second is written while the first turn is held at its request.
	const first = await session.sendOperatorMessageToBot(READER, DIRECT_ONE);
	await withDeadline(trace, "J7 leg 2: the bot's first turn reached its request", firstTurnReached.promise);
	const agentsWhileHeld = agentsOn(session, MODEL_ID.reader).length;
	const rosterWhileHeld = botRosterState(session, READER);
	const second = await session.sendOperatorMessageToBot(READER, DIRECT_TWO);
	held.release();
	await withDeadline(
		trace,
		"J7 leg 2: the same bot took the second message",
		world.provider.whenReached(reached(TRACK.reader, "j7-reader-second")),
	);
	await waitForBotRosterState(world, session, READER, "idle");

	expect(
		{
			first: first.mode,
			second: second.mode,
			agentId: [first.agentId, second.agentId],
			carried: [seen.firstSoul, seen.firstCarried, seen.secondCarried],
			// The bot is a session of its own: no worker stands for it, while its turn is held or after it.
			agents: [agentsWhileHeld, agentsOn(session, MODEL_ID.reader).length],
			// The roster follows the session: running while its turn is held, idle once the turn settled.
			roster: [rosterWhileHeld, botRosterState(session, READER)],
			// Taken in order: the first message is still in the conversation before the second.
			order: seen.order[0] !== -1 && seen.order[0] < seen.order[1],
		},
		"a send to an idle bot starts its own session, a second send while its turn is held is taken by the same session afterwards, in order, and the roster follows it",
	).toEqual({
		first: "started",
		second: "steered",
		agentId: [READER, READER],
		carried: [true, true, true],
		agents: [0, 0],
		roster: ["running", "idle"],
		order: true,
	});

	// A group of both bots: no mention reaches every member, one request each, and the group's message is stored with them.
	const groupMessage = await session.sendOperatorMessageToTeam(TEAM, TEAM_MESSAGE);
	await withDeadline(
		trace,
		"J7 leg 2: the first member took the group message",
		world.provider.whenReached(reached(TRACK.teamOne, "j7-team-one-first")),
	);
	await withDeadline(
		trace,
		"J7 leg 2: the second member took the group message",
		world.provider.whenReached(reached(TRACK.teamTwo, "j7-team-two-first")),
	);
	const storedGroup = teamMessages(session, TEAM)[0];
	// The group's whole log, as it was written: the owner's message entered it before the first member was dispatched, so a
	// member that answers at once is logged after the question it answers.
	const logAfterGroup = teamLog(session, TEAM);
	expect(
		{
			targets: [...groupMessage.message.targetAgentIds],
			deliveries: groupMessage.deliveries.map((delivery) => [delivery.agentId, delivery.outcome]),
			storedTargets: [...(storedGroup?.targetAgentIds ?? [])],
			storedDeliveries: storedGroup?.deliveries.map((delivery) => [delivery.agentId, delivery.outcome]),
			storedText: storedGroup?.text,
			firstInLog: { sent: logAfterGroup[0]?.sender.kind, text: logAfterGroup[0]?.text },
			requestsEach: [seen.teamOneBodies.length, seen.teamTwoCount],
		},
		"a group message with no mention is delivered to both members, one request each, and stored for both before their answers",
	).toEqual({
		targets: [TEAM_ONE, TEAM_TWO],
		deliveries: [
			[TEAM_ONE, "started"],
			[TEAM_TWO, "started"],
		],
		storedTargets: [TEAM_ONE, TEAM_TWO],
		storedDeliveries: [
			[TEAM_ONE, "started"],
			[TEAM_TWO, "started"],
		],
		storedText: TEAM_MESSAGE,
		firstInLog: { sent: "operator", text: TEAM_MESSAGE },
		requestsEach: [1, 1],
	});

	// A mention narrows the group to one member and reaches it without the address.
	const mentioned = await session.sendOperatorMessageToTeam(TEAM, TEAM_MENTION);
	await withDeadline(
		trace,
		"J7 leg 2: the mentioned member took the message",
		world.provider.whenReached(reached(TRACK.teamOne, "j7-team-one-second")),
	);
	const storedMention = teamMessages(session, TEAM)[1];
	expect(
		{
			targets: [...mentioned.message.targetAgentIds],
			deliveries: mentioned.deliveries.map((delivery) => [delivery.agentId, delivery.outcome]),
			storedTargets: [...(storedMention?.targetAgentIds ?? [])],
			storedDeliveries: storedMention?.deliveries.map((delivery) => [delivery.agentId, delivery.outcome]),
			storedText: storedMention?.text,
			unmentionedRequests: world.provider.requests.filter((entry) => entry.model.id === MODEL_ID.teamTwo).length,
		},
		"a group message that names one member reaches only that member and is stored for it alone, with what its delivery did",
	).toEqual({
		targets: [TEAM_ONE],
		deliveries: [[TEAM_ONE, "followed_up"]],
		storedTargets: [TEAM_ONE],
		storedDeliveries: [[TEAM_ONE, "followed_up"]],
		storedText: TEAM_MENTION,
		unmentionedRequests: 1,
	});
	expect(
		seen.teamOneBodies,
		"both members read the group message, and only the mentioned one reads the mention, without its address",
	).toEqual(["group", "mention"]);

	// A mention of a bot the group does not hold is refused before any delivery or write.
	const storedBefore = teamMessages(session, TEAM).length;
	await expect(
		session.sendOperatorMessageToTeam(TEAM, OUTSIDER_MENTION),
		"the refusal names the bot and the group",
	).rejects.toThrow(NOT_A_MEMBER);
	expect(
		{ stored: teamMessages(session, TEAM).length, storedBefore },
		"a refused group message delivers nothing and stores nothing",
	).toEqual({ stored: storedBefore, storedBefore: 2 });

	// The owner's words reach the bot's own chat, and no root turn ran.
	const chat = chatText(session, READER);
	expect(
		{
			carriesFirst: chat.includes(DIRECT_ONE),
			carriesSecond: chat.includes(DIRECT_TWO),
			carriesAnswer: chat.includes(READER_ANSWER),
		},
		"the bot's chat shows the owner's two messages and the bot's answer",
	).toEqual({ carriesFirst: true, carriesSecond: true, carriesAnswer: true });
	// The conversation lives in the bot's own session files, under its home, not in the owner's session.
	const filesText = botSessionFilesText(world, READER);
	expect(
		{
			carriesFirst: filesText.includes(DIRECT_ONE),
			carriesSecond: filesText.includes(DIRECT_TWO),
			carriesAnswer: filesText.includes(READER_ANSWER),
		},
		"the bot's own session files hold the owner's two messages and the bot's answer",
	).toEqual({ carriesFirst: true, carriesSecond: true, carriesAnswer: true });
	expect(
		world.provider.requests.filter((request) => request.model.id === MODEL_ID.root).length - rootRequestsBefore,
		"an owner's message to a bot or a group starts no root turn",
	).toBe(0);

	await sendToBotHeldElsewhere(world, session);
}

/**
 * One host runs a bot's session at a time: while another host holds the bot's lock and says what its session is doing, the
 * owner's message here is refused in the product's words, naming that host's session and process, and builds nothing.
 * Once that host gave the bot back, the same message starts the bot's own session here.
 */
async function sendToBotHeldElsewhere(world: HarnessWorld, session: AgentSession): Promise<void> {
	createOwnerBot(session, HELD, MODEL_ID.held, HELD_SOUL);
	const taken = takeProcessLock(botHostLockFile(world.agentDir, HELD), OTHER_HOST);
	if (!taken.held) throw new Error("the other host could not take the bot's lock");
	const otherState = new BotHostStateWriter(world.agentDir, {
		agentId: HELD,
		hostKind: "session",
		hostSessionId: OTHER_HOST_SESSION,
		botSessionId: "j7-held-elsewhere-session",
		holder: OTHER_HOST,
	});
	otherState.publish("idle");
	// The bot's soul opens its own system prompt, so a request carrying it is the bot's.
	const heldRequests = () =>
		world.provider.requests.filter((request) => (request.context.systemPrompt ?? "").includes(HELD_SOUL)).length;
	const heldRequestsBefore = heldRequests();
	try {
		await expect(
			session.sendOperatorMessageToBot(HELD, HELD_QUESTION),
			"a bot another host holds is refused, naming that host's session and process",
		).rejects.toThrow(HELD_ELSEWHERE);
	} finally {
		otherState.clear();
		taken.lock.release();
	}
	expect(
		{
			files: botSessionFilesText(world, HELD),
			requests: heldRequests() - heldRequestsBefore,
		},
		"the refused message built no session of the bot here and reached no model",
	).toEqual({ files: "", requests: 0 });

	enqueueBot(world, TRACK.held, MODEL_ID.held, HELD_SOUL, {
		name: "j7-held-first",
		check: (request) => {
			if (!carries(request, HELD_QUESTION)) throw new Error("the owner's message to the released bot is missing");
		},
		reply: { content: [{ type: "text", text: HELD_ANSWER }] },
	});
	const sent = await session.sendOperatorMessageToBot(HELD, HELD_QUESTION);
	await withDeadline(
		world.trace,
		"J7 leg 2: the bot the other host gave back answered here",
		world.provider.whenReached(reached(TRACK.held, "j7-held-first")),
	);
	await waitForBotRosterState(world, session, HELD, "idle");
	expect(
		{ sent: sent.mode, files: botSessionFilesText(world, HELD).includes(HELD_ANSWER) },
		"once the other host gave the bot back, the owner's message starts its own session here",
	).toEqual({ sent: "started", files: true });
}
