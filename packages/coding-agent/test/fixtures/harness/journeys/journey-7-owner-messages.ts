import "../builtin-install.ts";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { botHostLockFile, botInboxDir } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { createAgentSessionRuntime, prepareAgentSessionRuntime } from "../../../../src/core/agent-session-runtime.ts";
import { LEFTOVER_REREAD_MAX_MINUTES } from "../../../../src/core/bots/bot-home-records.ts";
import { BotHostStateWriter } from "../../../../src/core/bots/bot-host-state.ts";
import {
	botInboxStopNames,
	botInboxWaiting,
	readBotInbox,
	readBotInboxStops,
} from "../../../../src/core/bots/bot-inbox.ts";
import { BOT_OPEN_RETRY_FIRST_MS } from "../../../../src/core/bots/bot-open-retry.ts";
import { BOT_SESSION_IDLE_BOUND_MS } from "../../../../src/core/bots/bot-session-host.ts";
import { OWED_INBOX_SWEEP_MS } from "../../../../src/core/bots/bot-session-owed-work.ts";
import { OWNER_STOPPED_REASON } from "../../../../src/core/delegation/worker-fleet-stop.ts";
import { interfaceText } from "../../../../src/core/language/interface-text.ts";
import { takeProcessLock } from "../../../../src/core/remote/host-lock.ts";
import { createBarrier } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	agentsOn,
	BOT_SESSION_JUDGMENTS,
	botRosterState,
	botSessionFilesText,
	carries,
	chatText,
	createOwnerBot,
	enqueueBot,
	MODEL_ID,
	modelOf,
	positionOf,
	reached,
	TRACK,
	teamLog,
	teamMessages,
	waitForBotRosterState,
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

const HELD = "held-elsewhere";
const HELD_SOUL = "You answer owner questions about the cache size with one short sentence.";
const HELD_QUESTION = "How large is the cache?";
const HELD_ANSWER = "The cache holds two hundred entries.";
const LEFTOVER_QUESTION = "How long does a cache entry live?";
const LEFTOVER_ANSWER = "A cache entry lives for ten minutes.";
/** Another bot session host: in another process, or another host in this one, the lock names it the same way. */
const OTHER_HOST = "j7-other-host";
const OTHER_HOST_SESSION = "0f1e2d3c-4b5a-4968-8776-655443322110";
const LATE = "late-stop";
const LATE_SOUL = "You answer owner questions about the queue depth with one short sentence.";
const QUITTER = "quit-stop";
const QUITTER_SOUL = "You answer owner questions about the batch size with one short sentence.";

/**
 * Leg 2: the owner writes to one bot and then to a group. A send to an idle bot starts its own session (no worker stands
 * for it); a send while that session's turn is held is taken by the same session at its next request boundary, in order,
 * and both messages and the answer are in the bot's own session files. A group send fans out to every member, each taking
 * it in its own session (no worker stands for a member), a mention narrows it to one, and a mention of a bot outside the group is refused before anything is delivered. None of it
 * starts a root turn: the owner talks to the bots, not through the orchestrator. A message to a bot another host holds
 * waits in the bot's inbox, naming that host's session and process, and builds nothing here; once that host gives the bot
 * back, this host takes the message and the bot answers it here, once. A stop of a bot another host holds that the bot's
 * home refused is held here and recorded by the periodic check once the home takes writes again, for that host to take;
 * one still held as the runtime quits is recorded then, the notice that it is recorded routed to the terminal once.
 */
export async function runJourney7OwnerMessagesPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the owner's session disposes cleanly").toBeUndefined();
	}
	// With the leg's root gone, the runtime's root is the only root of the process attached as it quits.
	await stopRecordedAtQuit(world);
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
	// Each group member answers in a session of its own: a group's message starts a turn there that calls no tool, so it is
	// never judged either, and no answer names a claim kind, so nothing else is asked. The held bot's second
	// message (`leftoverInInbox`) is routed after its first turn, which called no tool and left its words queued: the
	// backlog screen reads them before that turn is routed (`carries_0`), and a question asking how large the cache is
	// asks to understand something and instructs nothing, so it is set aside and not classified in full.
	if (world.systemOne.enabled)
		world.systemOne.enterPhase("j7-owner-messages", {
			...BOT_SESSION_JUDGMENTS,
			carries_0: { kind: "noul", probability: 0.97 },
		});
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
			// Each member takes the group's message in its own session: no worker stands for either.
			workers: [agentsOn(session, MODEL_ID.teamOne).length, agentsOn(session, MODEL_ID.teamTwo).length],
		},
		"a group message with no mention is delivered to both members, one request each in their own sessions, and stored for both before their answers",
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
		workers: [0, 0],
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
	await leftoverInInbox(world, session);
	await stopRecordedLate(world, session);
}

/**
 * An inbox file of a bot hosted here that neither reads nor can be set aside (its rename to `.unreadable` refused, as a
 * directory the process may not write refuses it) is told once however often the inbox is read, is not counted as waiting, and holds back none of the owner's
 * words; it is read again on its backoff, told nothing more when that read fails too, and read again at once, told as a
 * new one, when the file changes.
 */
async function leftoverInInbox(world: HarnessWorld, session: AgentSession): Promise<void> {
	const words = interfaceText().botTeam;
	const file = join(botInboxDir(world.agentDir, HELD), `${String(Date.now()).padStart(15, "0")}-${randomUUID()}.json`);
	const parseFailure = (text: string): string => {
		try {
			JSON.parse(text);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		throw new Error(`${text} parsed`);
	};
	const told = (text: string) =>
		words.botHomeRecordNotSetAside(
			HELD,
			words.homeRecordKinds.inboxMessage,
			file,
			parseFailure(text),
			LEFTOVER_REREAD_MAX_MINUTES,
		);
	const FIRST_TEXT = "not a message";
	const SECOND_TEXT = "still not a message";
	writeFileSync(file, FIRST_TEXT);
	const keptInPlace = world.io.denyUntilCleared({
		name: "j7-leftover-not-set-aside",
		kind: "rename",
		matches: (operation) => operation.path === file,
		code: "EACCES",
	});
	const mark = world.warnings.length;
	let answered = false;
	enqueueBot(world, TRACK.held, MODEL_ID.held, HELD_SOUL, {
		name: "j7-held-leftover",
		check: (request) => {
			if (!carries(request, LEFTOVER_QUESTION)) throw new Error("the owner's words beside the leftover are missing");
		},
		reply: () => {
			answered = true;
			return { content: [{ type: "text", text: LEFTOVER_ANSWER }] };
		},
	});
	try {
		// Read by the chat twice (and by any drain the home watch asks for meanwhile): told once, and not waiting.
		chatText(session, HELD);
		chatText(session, HELD);
		expect(
			{
				waiting: botInboxWaiting(world.agentDir, HELD),
				warnings: world.warnings.slice(mark),
				left: existsSync(file),
			},
			"an inbox file that neither reads nor can be set aside is told once, stays in place and is not counted as waiting",
		).toEqual({ waiting: false, warnings: [told(FIRST_TEXT)], left: true });
		const sent = await session.sendOperatorMessageToBot(HELD, LEFTOVER_QUESTION);
		await withDeadline(
			world.trace,
			"J7 leg 2: the bot answered the owner's words beside the leftover",
			world.provider.whenReached(reached(TRACK.held, "j7-held-leftover")),
		);
		await waitForBotRosterState(world, session, HELD, "idle");
		expect(
			{ mode: sent.mode, answered, warnings: world.warnings.slice(mark) },
			"the owner's words are given to the bot at once, not held behind the leftover, and nothing more is told",
		).toEqual({ mode: "followed_up", answered: true, warnings: [told(FIRST_TEXT)] });
		// Changed, the file is listed and read again at once, and told as a new one; its backoff starts again from the first.
		writeFileSync(file, SECOND_TEXT);
		const changedWaiting = botInboxWaiting(world.agentDir, HELD);
		chatText(session, HELD);
		const realNow = Date.now;
		const startedAt = realNow();
		const backoff: boolean[] = [botInboxWaiting(world.agentDir, HELD)];
		try {
			// Its read due after the first backoff step: listed, read again, told nothing, and not due again within the next.
			Date.now = () => startedAt + BOT_OPEN_RETRY_FIRST_MS;
			backoff.push(botInboxWaiting(world.agentDir, HELD));
			chatText(session, HELD);
			backoff.push(botInboxWaiting(world.agentDir, HELD));
		} finally {
			Date.now = realNow;
		}
		expect(
			{ changedWaiting, backoff, warnings: world.warnings.slice(mark) },
			"a changed leftover is listed and told again once, then read again only when its backoff is due, told nothing more",
		).toEqual({
			changedWaiting: true,
			backoff: [false, true, false],
			warnings: [told(FIRST_TEXT), told(SECOND_TEXT)],
		});
	} finally {
		keptInPlace.clear();
		rmSync(file, { force: true });
	}
	expect(botInboxWaiting(world.agentDir, HELD), "the leftover removed, nothing waits").toBe(false);
}

/**
 * One host runs a bot's session at a time: while another host holds the bot's lock and says what its session is doing, the
 * owner's message here is not refused and builds nothing here. It waits in the bot's inbox, and the send names that host's
 * session and process. Once that host gives the bot back, this host takes the inbox on its own (the home watch announces
 * the host's change): the bot's own session opens here and answers that message, exactly once.
 */
async function sendToBotHeldElsewhere(world: HarnessWorld, session: AgentSession): Promise<void> {
	createOwnerBot(session, HELD, MODEL_ID.held, HELD_SOUL);
	// The bot's soul opens its own system prompt, so a request carrying it is the bot's.
	const heldRequests = () =>
		world.provider.requests.filter((request) => (request.context.systemPrompt ?? "").includes(HELD_SOUL));
	const heldRequestsBefore = heldRequests().length;
	let askedTimes = -1;
	enqueueBot(world, TRACK.held, MODEL_ID.held, HELD_SOUL, {
		name: "j7-held-first",
		check: (request) => {
			if (!carries(request, HELD_QUESTION)) throw new Error("the owner's message to the released bot is missing");
			askedTimes = ownerMessagesCarrying(request.context.messages, HELD_QUESTION);
		},
		reply: { content: [{ type: "text", text: HELD_ANSWER }] },
	});
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
	try {
		const sent = await session.sendOperatorMessageToBot(HELD, HELD_QUESTION);
		const waiting = readBotInbox(world.agentDir, HELD, (file, reason) => {
			throw new Error(`the bot's inbox holds an unreadable message ${file}: ${reason}`);
		});
		expect(
			{
				sent,
				waiting: waiting.map((item) => ({
					id: item.message.id,
					text: item.message.text,
					from: item.message.from.sessionId,
				})),
				files: botSessionFilesText(world, HELD),
				requests: heldRequests().length - heldRequestsBefore,
			},
			"a message to a bot another host holds waits in the bot's inbox, the send naming that host's session and process, and builds no session of the bot here and reaches no model",
		).toEqual({
			sent: {
				agentId: HELD,
				mode: "queued",
				messageId: waiting[0]?.message.id,
				modelRef: modelOf(MODEL_ID.held),
				deliveredTo: { pid: process.pid, sessionId: OTHER_HOST_SESSION },
			},
			waiting: [{ id: sent.messageId, text: HELD_QUESTION, from: session.sessionId }],
			files: "",
			requests: 0,
		});
	} finally {
		// The other host gives the bot back: its state is cleared and its lock released.
		otherState.clear();
		taken.lock.release();
	}

	await withDeadline(
		world.trace,
		"J7 leg 2: this host took the inbox of the bot the other host gave back, and the bot answered here",
		world.provider.whenReached(reached(TRACK.held, "j7-held-first")),
	);
	await waitForBotRosterState(world, session, HELD, "idle");
	expect(
		{
			asked: askedTimes,
			requests: heldRequests().length - heldRequestsBefore,
			inbox: readBotInbox(world.agentDir, HELD, () => undefined).length,
			answered: botSessionFilesText(world, HELD).includes(HELD_ANSWER),
			stored: ownerMessagesCarrying(botSessionMessages(world, HELD), HELD_QUESTION),
		},
		"once the other host gave the bot back, this host took the waiting message: the bot's own session opened here and answered it, delivered once and taken out of the inbox",
	).toEqual({ asked: 1, requests: 1, inbox: 0, answered: true, stored: 1 });
}

/**
 * The owner's stop of a bot another host holds, made while the bot's home refuses the write, is held by this process,
 * the owner told it could not be recorded. Once the home takes writes again, the periodic check records it for that host
 * to take, dated and sent as it was made and scoped to the work there was then (a bot that never ran has none), and the
 * owner is told it is recorded now. Once the other host gives the bot back, this host takes the stop and nothing waits.
 */
async function stopRecordedLate(world: HarnessWorld, session: AgentSession): Promise<void> {
	const words = interfaceText().botTeam;
	createOwnerBot(session, LATE, MODEL_ID.held, LATE_SOUL);
	const inbox = resolve(botInboxDir(world.agentDir, LATE));
	const taken = takeProcessLock(botHostLockFile(world.agentDir, LATE), OTHER_HOST);
	if (!taken.held) throw new Error("the other host could not take the bot's lock");
	const otherState = new BotHostStateWriter(world.agentDir, {
		agentId: LATE,
		hostKind: "session",
		hostSessionId: OTHER_HOST_SESSION,
		botSessionId: "j7-late-stop-session",
		holder: OTHER_HOST,
	});
	otherState.publish("idle");
	const [notRecordedHead, notRecordedTail] = words.botStopNotRecorded(LATE, "\0").split("\0");
	const shapes = (warnings: readonly string[]) =>
		warnings.map((warning) =>
			warning.startsWith(notRecordedHead ?? "") && warning.endsWith(notRecordedTail ?? "") ? "notRecorded" : warning,
		);
	const mark = world.warnings.length;
	try {
		const unwritable = world.io.denyUntilCleared({
			name: "j7-late-stop-unwritten",
			kind: "write",
			matches: (operation) => resolve(operation.path).startsWith(inbox),
			code: "EACCES",
		});
		const madeFrom = Date.now();
		try {
			session.stopPersistentBot(LATE);
		} finally {
			unwritable.clear();
		}
		const madeBy = Date.now();
		expect(
			{ stops: botInboxStopNames(world.agentDir, LATE), warnings: shapes(world.warnings.slice(mark)) },
			"a stop the bot's home refused is not recorded, and the owner is told it is held here",
		).toEqual({ stops: [], warnings: ["notRecorded"] });
		const recorded = world.io.waitForMutation(() => botInboxStopNames(world.agentDir, LATE).length > 0);
		// The bots' sessions share the clock the check runs on, each closed when idle for BOT_SESSION_IDLE_BOUND_MS: the
		// check's minute is shorter, so every idle bound armed before it is still armed after it, the same alarm a minute nearer.
		const idleBounds = () =>
			world.timers.armedSnapshot("bot-sessions").filter((alarm) => alarm.delayMs === BOT_SESSION_IDLE_BOUND_MS);
		const idleBefore = idleBounds();
		world.timers.advance("bot-sessions", OWED_INBOX_SWEEP_MS);
		expect(
			{ armed: idleBefore.length > 0, after: idleBounds() },
			"the periodic check's minute closes no idle bot session: each idle bound armed before it is the same alarm after it, a minute nearer",
		).toEqual({
			armed: true,
			after: idleBefore.map((alarm) => ({ ...alarm, remainingMs: alarm.remainingMs - OWED_INBOX_SWEEP_MS })),
		});
		await withDeadline(world.trace, "J7 leg 2: the periodic check recorded the stop held here", recorded);
		const stops = readBotInboxStops(world.agentDir, LATE, (file, reason) => {
			throw new Error(`the bot's inbox holds an unreadable stop ${file}: ${reason}`);
		});
		expect(
			{
				stops: stops.map((item) => ({
					scopedFile: item.file.endsWith(".scoped.stop.json"),
					madeThen: item.message.at >= madeFrom && item.message.at <= madeBy,
					from: { pid: item.message.from.pid, sessionId: item.message.from.sessionId },
					reasonCode: item.message.reasonCode,
					scope: item.message.scope,
				})),
				warnings: shapes(world.warnings.slice(mark)),
			},
			"while another host holds the bot, the periodic check records the stop held here, dated and sent as it was made and scoped to the work there was then, and the owner is told it is recorded now",
		).toEqual({
			stops: [
				{
					scopedFile: true,
					madeThen: true,
					from: { pid: process.pid, sessionId: session.sessionId },
					reasonCode: OWNER_STOPPED_REASON,
					scope: { kind: "scoped", attempts: [], plans: [] },
				},
			],
			warnings: ["notRecorded", words.botStopRecordedLate(LATE)],
		});
	} finally {
		// The other host gives the bot back: its state is cleared and its lock released.
		otherState.clear();
		taken.lock.release();
	}
	await withDeadline(
		world.trace,
		"J7 leg 2: this host took the stop recorded late once the other host gave the bot back",
		world.io.waitForMutation(() => botInboxStopNames(world.agentDir, LATE).length === 0),
	);
	// The leg's warnings are asserted whole here and claimed, so the journey's close finds none of them unclassified.
	expect(
		shapes(world.warnings.splice(mark)),
		"the stop recorded late is taken here once the bot is given back, and the owner is told nothing more",
	).toEqual(["notRecorded", words.botStopRecordedLate(LATE)]);
}

/**
 * The owner's stop of a bot another host holds, refused by the bot's home and held by this process, is recorded one last
 * time as the runtime quits: its root is the only root of the process attached, so its host's stops are the runtime's own.
 * The runtime routes the notice that the stop is recorded now to its terminal, once, while the live session was told only
 * that it could not be recorded; the stop waits in the bot's inbox, dated and sent as it was made and scoped to the work
 * there was then (a bot that never ran has none). Once the other host gives the bot back, a root of this process takes it
 * and tells nothing more.
 */
async function stopRecordedAtQuit(world: HarnessWorld): Promise<void> {
	const words = interfaceText().botTeam;
	const routed: string[] = [];
	const runtime = await createAgentSessionRuntime(
		async ({ cwd, agentDir }) =>
			prepareAgentSessionRuntime({
				activate: async (freshManager) => {
					const root = await world.createRootSession(MODEL_ID.root, { agentDir, sessionManager: freshManager });
					return {
						session: root.session,
						sessionManager: root.sessionManager,
						getExtensionRunner: root.getExtensionRunner,
						extensionsResult: root.extensionsResult,
						services: {
							cwd,
							agentDir,
							authStorage: world.authStorage,
							settingsManager: root.settingsManager,
							modelRegistry: world.modelRegistry,
							resourceLoader: root.session.resourceLoader,
							diagnostics: [],
						},
						diagnostics: [],
					};
				},
				dispose: () => {},
			}),
		{
			cwd: HARNESS_PROJECT_CWD,
			agentDir: world.agentDir,
			sessionManager: world.createSessionManager(),
			onTerminalWarnings: (warnings) => {
				routed.push(...warnings);
			},
		},
	);
	const quitting = runtime.session;
	const quittingSessionId = quitting.sessionId;
	createOwnerBot(quitting, QUITTER, MODEL_ID.held, QUITTER_SOUL);
	const inbox = resolve(botInboxDir(world.agentDir, QUITTER));
	const taken = takeProcessLock(botHostLockFile(world.agentDir, QUITTER), OTHER_HOST);
	if (!taken.held) throw new Error("the other host could not take the quitting bot's lock");
	const otherState = new BotHostStateWriter(world.agentDir, {
		agentId: QUITTER,
		hostKind: "session",
		hostSessionId: OTHER_HOST_SESSION,
		botSessionId: "j7-quit-stop-session",
		holder: OTHER_HOST,
	});
	otherState.publish("idle");
	const [notRecordedHead, notRecordedTail] = words.botStopNotRecorded(QUITTER, "\0").split("\0");
	const shapes = (warnings: readonly string[]) =>
		warnings.map((warning) =>
			warning.startsWith(notRecordedHead ?? "") && warning.endsWith(notRecordedTail ?? "") ? "notRecorded" : warning,
		);
	const mark = world.warnings.length;
	let taker: AgentSession | undefined;
	try {
		const unwritable = world.io.denyUntilCleared({
			name: "j7-quit-stop-unwritten",
			kind: "write",
			matches: (operation) => resolve(operation.path).startsWith(inbox),
			code: "EACCES",
		});
		const madeFrom = Date.now();
		try {
			quitting.stopPersistentBot(QUITTER);
		} finally {
			unwritable.clear();
		}
		const madeBy = Date.now();
		expect(
			{ stops: botInboxStopNames(world.agentDir, QUITTER), warnings: shapes(world.warnings.slice(mark)) },
			"a stop the bot's home refused is not recorded, and the owner is told it is held here",
		).toEqual({ stops: [], warnings: ["notRecorded"] });
		// No periodic check runs before the quit (the bots' clock is not moved): the quit is what records it.
		await withDeadline(world.trace, "J7 leg 2: the runtime holding the stop quits", runtime.dispose());
		const stops = readBotInboxStops(world.agentDir, QUITTER, (file, reason) => {
			throw new Error(`the quitting bot's inbox holds an unreadable stop ${file}: ${reason}`);
		});
		expect(
			{
				routed,
				warnings: shapes(world.warnings.slice(mark)),
				stops: stops.map((item) => ({
					scopedFile: item.file.endsWith(".scoped.stop.json"),
					madeThen: item.message.at >= madeFrom && item.message.at <= madeBy,
					from: { pid: item.message.from.pid, sessionId: item.message.from.sessionId },
					reasonCode: item.message.reasonCode,
					scope: item.message.scope,
				})),
			},
			"the runtime's quit records the stop its root held, dated, sent and scoped as it was made, and routes the notice that it is recorded now to its terminal once, the live session told only that it could not be recorded",
		).toEqual({
			routed: [words.botStopRecordedLate(QUITTER)],
			warnings: ["notRecorded"],
			stops: [
				{
					scopedFile: true,
					madeThen: true,
					from: { pid: process.pid, sessionId: quittingSessionId },
					reasonCode: OWNER_STOPPED_REASON,
					scope: { kind: "scoped", attempts: [], plans: [] },
				},
			],
		});
		// A root of this process watches the bot's home when the other host gives the bot back.
		taker = (await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() })).session;
	} finally {
		// The other host gives the bot back: its state is cleared and its lock released.
		otherState.clear();
		taken.lock.release();
	}
	if (taker === undefined) throw new Error("no root of this process was made to take the stop recorded at quit");
	const takingRoot = taker;
	try {
		await withDeadline(
			world.trace,
			"J7 leg 2: a root of this process took the stop recorded at quit once the other host gave the bot back",
			world.io.waitForMutation(() => botInboxStopNames(world.agentDir, QUITTER).length === 0),
		);
		// The leg's warnings are asserted whole here and claimed, so the journey's close finds none of them unclassified.
		expect(
			{ routed, warnings: shapes(world.warnings.splice(mark)) },
			"the stop recorded at quit is taken once the bot is given back, and the owner is told nothing more",
		).toEqual({ routed: [words.botStopRecordedLate(QUITTER)], warnings: ["notRecorded"] });
	} finally {
		expect(
			await world.disposeSessionInBody(takingRoot),
			"the taking root's session disposes cleanly",
		).toBeUndefined();
	}
}

/** How many user messages of a conversation carry `text`: the owner's words delivered once are in one of them. */
function ownerMessagesCarrying(messages: readonly unknown[], text: string): number {
	return messages.filter(
		(message) =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "user" &&
			JSON.stringify(message).includes(text),
	).length;
}

/** The messages the bot's own session files hold, in the order they were written. */
function botSessionMessages(world: HarnessWorld, agentId: string): unknown[] {
	return botSessionFilesText(world, agentId)
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { type?: unknown; message?: unknown })
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message);
}
