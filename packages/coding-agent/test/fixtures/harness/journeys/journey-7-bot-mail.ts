import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { BOT_MAIL_TOOL_NAME } from "../../../../src/core/tools/bot-mail-tool-name.ts";
import type { TurnOriginRecord } from "../../../../src/kernel/turn-origin-stamp.ts";
import { createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	acceptedJson,
	agentsOn,
	BOT_SESSION_JUDGMENTS,
	botSessionFilesText,
	carries,
	createOwnerBot,
	enqueueBot,
	MODEL_ID,
	offeredTools,
	reached,
	soulMatcher,
	TRACK,
	waitForBotRosterState,
} from "./journey-7-shared.ts";

const ASKER = "mail-asker";
const ASKER_SOUL = "You find out the owner's answers from the other bots and say them in one short sentence.";
const ANSWERER = "mail-answerer";
const ANSWERER_SOUL = "You answer other bots' questions about the backoff delay with one short sentence.";
const OWNER_REQUEST = "Ask mail-answerer how long the backoff delay is.";
const MAIL_QUESTION = "How long is the backoff delay?";
const ASKER_SENT = "I asked mail-answerer.";
const MAIL_ANSWER = "The backoff delay is five seconds.";
const ASKER_NOTED = "The backoff delay is five seconds, says mail-answerer.";

/** The turn origins a bot's own session files recorded on its messages, oldest first. */
function recordedOrigins(world: HarnessWorld, agentId: string): TurnOriginRecord[] {
	return botSessionFilesText(world, agentId)
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => (JSON.parse(line) as { turnOrigin?: TurnOriginRecord }).turnOrigin)
		.filter((origin): origin is TurnOriginRecord => origin !== undefined);
}

/** The requests a bot's own model received in this phase, told apart by its soul. */
function requestsOf(world: HarnessWorld, modelId: string, soul: string): ScriptedRequest[] {
	const ofBot = soulMatcher(soul);
	return world.provider.requests.filter((request) => request.model.id === modelId && ofBot(request));
}

/**
 * Leg: a bot mails another bot. The owner asks one bot to find something out from another; in its own session the bot
 * holds `bot_mail` and sends the question. The mail runs as the receiving bot's own turn, in its own session (no worker
 * stands for it, no root turn runs), stamped as an agent's mail from the sender at the chain's first hop, never as the
 * owner's words; the receiver answers in plain words, and its answer comes back to the asker once, as a reply its session
 * takes as a turn of its own, which is not mailed back again.
 */
export async function runJourney7BotMailPhase(world: HarnessWorld): Promise<void> {
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the owner's session disposes cleanly").toBeUndefined();
	}
	world.trace.mark("root", "j7.bot-mail");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const { trace } = world;
	createOwnerBot(session, ASKER, MODEL_ID.mailAsker, ASKER_SOUL);
	createOwnerBot(session, ANSWERER, MODEL_ID.mailAnswerer, ANSWERER_SOUL);
	const rootRequestsBefore = world.provider.requests.filter((request) => request.model.id === MODEL_ID.root).length;
	// The receiver's answer is held until the asker's turn ended, so the reply starts a turn of the asker's own rather than
	// joining the one that sent the mail.
	const askerIdle = createBarrier();
	const seen = {
		offered: false,
		sent: undefined as Record<string, unknown> | undefined,
		mailCarried: false,
		mailNotOwner: false,
		replyCarried: false,
	};

	enqueueBot(
		world,
		TRACK.mailAsker,
		MODEL_ID.mailAsker,
		ASKER_SOUL,
		{
			name: "j7-mail-asker-send",
			check: (request) => {
				seen.offered = offeredTools(request).includes(BOT_MAIL_TOOL_NAME);
			},
			reply: {
				content: [
					{
						type: "toolCall",
						id: "j7-mail-send",
						name: BOT_MAIL_TOOL_NAME,
						arguments: { action: "send", to: ANSWERER, message: MAIL_QUESTION },
					},
				],
				stopReason: "toolUse",
			},
		},
		{
			name: "j7-mail-asker-sent",
			check: (request) => {
				seen.sent = acceptedJson(request, BOT_MAIL_TOOL_NAME);
			},
			reply: { content: [{ type: "text", text: ASKER_SENT }] },
		},
		{
			name: "j7-mail-asker-reply",
			check: (request) => {
				seen.replyCarried = carries(request, MAIL_ANSWER);
			},
			reply: { content: [{ type: "text", text: ASKER_NOTED }] },
		},
	);
	enqueueBot(world, TRACK.mailAnswerer, MODEL_ID.mailAnswerer, ANSWERER_SOUL, {
		name: "j7-mail-answerer",
		gate: askerIdle.promise,
		check: (request) => {
			seen.mailCarried = carries(request, MAIL_QUESTION);
			seen.mailNotOwner = carries(request, `Mail from bot ${ASKER}`) && !carries(request, OWNER_REQUEST);
		},
		reply: { content: [{ type: "text", text: MAIL_ANSWER }] },
	});

	// The owner's message starts the asker's turn that calls a tool: its words are judged as an owner request that calls a
	// tool is in a bot's own session, the owner-policy questions alone. The mail and the reply are an agent's words, each
	// starting a turn that calls no tool, so neither is judged, and no answer names a claim kind.
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-mail", BOT_SESSION_JUDGMENTS);

	const sent = await session.sendOperatorMessageToBot(ASKER, OWNER_REQUEST);
	await withDeadline(
		trace,
		"J7 bot mail: the asker read its send's result",
		world.provider.whenReached(reached(TRACK.mailAsker, "j7-mail-asker-sent")),
	);
	await waitForBotRosterState(world, session, ASKER, "idle");
	askerIdle.release();
	await withDeadline(
		trace,
		"J7 bot mail: the receiving bot took the mail in its own session",
		world.provider.whenReached(reached(TRACK.mailAnswerer, "j7-mail-answerer")),
	);
	await withDeadline(
		trace,
		"J7 bot mail: the asker took the reply",
		world.provider.whenReached(reached(TRACK.mailAsker, "j7-mail-asker-reply")),
	);
	await waitForBotRosterState(world, session, ANSWERER, "idle");
	await waitForBotRosterState(world, session, ASKER, "idle");

	const mailOrigins = recordedOrigins(world, ANSWERER).filter((origin) => origin.k === "agent-mail");
	const replyOrigins = recordedOrigins(world, ASKER).filter((origin) => origin.ref?.startsWith("reply:") === true);
	expect(
		{
			sent: sent.mode,
			offered: seen.offered,
			mail: { sent: seen.sent?.sent, to: seen.sent?.to },
			carried: [seen.mailCarried, seen.mailNotOwner],
			// The mail is the receiver's own turn: stamped as an agent's mail from the sender, first in its chain.
			mailOrigins: mailOrigins.map((origin) => [origin.from, origin.hop, origin.shown]),
			// No worker stands for either bot, and no root turn ran.
			workers: [agentsOn(session, MODEL_ID.mailAsker).length, agentsOn(session, MODEL_ID.mailAnswerer).length],
			rootRequests:
				world.provider.requests.filter((request) => request.model.id === MODEL_ID.root).length - rootRequestsBefore,
		},
		"the asker mails the other bot with bot_mail, and the mail runs as the receiving bot's own turn under an agent's-mail origin, with no worker and no root turn",
	).toEqual({
		sent: "started",
		offered: true,
		mail: { sent: true, to: ANSWERER },
		carried: [true, true],
		mailOrigins: [[`bot:${ASKER}`, 1, MAIL_QUESTION]],
		workers: [0, 0],
		rootRequests: 0,
	});
	expect(
		{
			replyCarried: seen.replyCarried,
			// One reply, a hop further on, from the receiver, with its answer.
			replies: replyOrigins.map((origin) => [origin.k, origin.from, origin.hop, origin.shown]),
			// The asker's three requests (the send, the send's result, the reply) and the receiver's one: the reply's answer is
			// not mailed back again.
			requests: [
				requestsOf(world, MODEL_ID.mailAsker, ASKER_SOUL).length,
				requestsOf(world, MODEL_ID.mailAnswerer, ANSWERER_SOUL).length,
			],
		},
		"the receiver's answer reaches the asker once, as a reply its own session takes, and is not answered again",
	).toEqual({
		replyCarried: true,
		replies: [["agent-mail", `bot:${ANSWERER}`, 2, MAIL_ANSWER]],
		requests: [3, 1],
	});
}
