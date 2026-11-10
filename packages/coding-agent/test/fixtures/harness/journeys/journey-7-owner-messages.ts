import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import { createBarrier, HARNESS_PROVIDER } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	agentsOn,
	carries,
	chatText,
	enqueueBot,
	MODEL_ID,
	positionOf,
	reached,
	TRACK,
	teamMessages,
} from "./journey-7-shared.ts";

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

/**
 * Leg 2: the owner writes to one bot and then to a group. A send to an idle bot starts its worker; a send while that worker
 * is held is taken by the same bot at its next request boundary, in order. A group send fans out to every member, a
 * mention narrows it to one, and a mention of a bot outside the group is refused before anything is delivered. None of it
 * starts a root turn: the owner talks to the bots, not through the orchestrator.
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

function createBot(session: AgentSession, agentId: string, modelId: string, soul: string): void {
	session.upsertPersistentBot({
		agentId,
		displayName: displayNameFor(agentId),
		provider: HARNESS_PROVIDER,
		modelId,
		soul,
		createdBy: "owner",
	});
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	createBot(session, READER, MODEL_ID.reader, READER_SOUL);
	createBot(session, TEAM_ONE, MODEL_ID.teamOne, TEAM_ONE_SOUL);
	createBot(session, TEAM_TWO, MODEL_ID.teamTwo, TEAM_TWO_SOUL);
	// The outsider exists as a bot, so the mention reaches the group's membership check rather than a missing bot.
	createBot(session, OUTSIDER, MODEL_ID.teamOne, "You answer questions nobody asks with one short sentence.");
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
				seen.firstSoul = (request.context.systemPrompt ?? "").includes(READER_SOUL);
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

	// No owner request is made in this leg, and nothing here is a claim about delivered work: no judgment is asked.
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-owner-messages", {});

	// One bot, two owner messages: the second is written while the first turn is held at its request.
	const first = await session.sendOperatorMessageToBot(READER, DIRECT_ONE);
	await withDeadline(trace, "J7 leg 2: the bot's first turn reached its request", firstTurnReached.promise);
	const agentsWhileHeld = agentsOn(session, MODEL_ID.reader).length;
	const second = await session.sendOperatorMessageToBot(READER, DIRECT_TWO);
	held.release();
	await withDeadline(
		trace,
		"J7 leg 2: the same bot took the second message",
		world.provider.whenReached(reached(TRACK.reader, "j7-reader-second")),
	);

	expect(
		{
			first: first.mode,
			second: second.mode,
			agentId: [first.agentId, second.agentId],
			carried: [seen.firstSoul, seen.firstCarried, seen.secondCarried],
			// The second message waits for the request in flight: it never starts a second worker for the bot.
			agents: [agentsWhileHeld, agentsOn(session, MODEL_ID.reader).length],
			// Taken in order: the first message is still in the conversation before the second.
			order: seen.order[0] !== -1 && seen.order[0] < seen.order[1],
		},
		"a send to an idle bot starts it, a second send while its turn is held is taken by the same bot afterwards, in order",
	).toEqual({
		first: "started",
		second: "steered",
		agentId: [READER, READER],
		carried: [true, true, true],
		agents: [1, 1],
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
	expect(
		{
			targets: [...groupMessage.message.targetAgentIds],
			deliveries: groupMessage.deliveries.map((delivery) => [delivery.agentId, delivery.outcome]),
			storedTargets: [...(storedGroup?.targetAgentIds ?? [])],
			storedText: storedGroup?.text,
			requestsEach: [seen.teamOneBodies.length, seen.teamTwoCount],
		},
		"a group message with no mention is delivered to both members, one request each, and stored for both",
	).toEqual({
		targets: [TEAM_ONE, TEAM_TWO],
		deliveries: [
			[TEAM_ONE, "started"],
			[TEAM_TWO, "started"],
		],
		storedTargets: [TEAM_ONE, TEAM_TWO],
		storedText: TEAM_MESSAGE,
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
			storedText: storedMention?.text,
			unmentionedRequests: world.provider.requests.filter((entry) => entry.model.id === MODEL_ID.teamTwo).length,
		},
		"a group message that names one member reaches only that member and is stored for it alone",
	).toEqual({
		targets: [TEAM_ONE],
		deliveries: [[TEAM_ONE, "steering"]],
		storedTargets: [TEAM_ONE],
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
	expect(
		world.provider.requests.filter((request) => request.model.id === MODEL_ID.root).length - rootRequestsBefore,
		"an owner's message to a bot or a group starts no root turn",
	).toBe(0);
}
