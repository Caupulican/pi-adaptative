import "../builtin-install.ts";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect } from "vitest";
import { botHostLockFile } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { sessionStatePieces } from "../../../../src/core/bots/bot-bundle-move.ts";
import { type BotHome, botHomeOf } from "../../../../src/core/bots/bot-home.ts";
import { readBotInbox } from "../../../../src/core/bots/bot-inbox.ts";
import { BOT_OPEN_RETRY_FIRST_MS } from "../../../../src/core/bots/bot-open-retry.ts";
import { continueBotSession } from "../../../../src/core/bots/bot-session-open.ts";
import { interfaceText } from "../../../../src/core/language/interface-text.ts";
import { managerSessionHomeNow } from "../../../../src/core/orchestration-homes.ts";
import { processLockHolder } from "../../../../src/core/remote/host-lock.ts";
import {
	acquireSessionBundleLease,
	orchestrationHomeHoldsSession,
	readSessionLeaseHolders,
} from "../../../../src/kernel/session/session-bundle-lifecycle.ts";
import { ownerOrchestrationHome, sameOrchestrationHome } from "../../../../src/kernel/session/session-bundle-paths.ts";
import { createSessionId } from "../../../../src/kernel/session/session-id-generation.ts";
import { CURRENT_SESSION_VERSION } from "../../../../src/kernel/session/session-manager.ts";
import type { ScriptedRequest } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	botRecord,
	botRosterState,
	carries,
	createOwnerBot,
	enqueueBot,
	MODEL_ID,
	modelOf,
	reached,
	TRACK,
	waitForBotRosterState,
} from "./journey-7-shared.ts";

const KEEPER = "home-keeper";
const SOUL = "You answer owner questions about the release calendar with one short sentence.";
/** Every question asks what something is, and every answer states a fact that names no test, check, commit or change. */
const FIRST_QUESTION = "Which day does the release train leave?";
const FIRST_ANSWER = "The release train leaves on Thursday.";
const SECOND_QUESTION = "Who signs off the release notes?";
const SECOND_ANSWER = "The documentation lead signs off the release notes.";
const THIRD_QUESTION = "How many release candidates are cut?";
const THIRD_ANSWER = "Two release candidates are cut.";
/** Sent while the pointer is a symbolic link: the load stops, so no turn ever carries it. */
const LINKED_QUESTION = "Where is the release calendar kept?";
const FIFTH_QUESTION = "When does the release freeze start?";
const FIFTH_ANSWER = "The release freeze starts on Monday.";
/** The fleet queue file an earlier build left beside the bot session's state in the owner's home: a stopped, empty queue. */
const PLANTED_FLEET = { v: 1, stopped: true, entries: [] };

interface SessionPointer {
	readonly version: number;
	readonly sessionId: string;
	readonly file: string;
}

function readPointer(home: BotHome): SessionPointer {
	return JSON.parse(readFileSync(home.pointerFile, "utf8")) as SessionPointer;
}

/** The session files of the bot's home, by name. */
function sessionFiles(home: BotHome): string[] {
	return readdirSync(home.sessionsDir)
		.filter((name) => name.endsWith(".jsonl"))
		.sort();
}

/** Each session file of the bot's home with its whole text: what a stopped load must leave as it was. */
function sessionFileTexts(home: BotHome): Record<string, string> {
	return Object.fromEntries(
		sessionFiles(home).map((name) => [name, readFileSync(join(home.sessionsDir, name), "utf8")]),
	);
}

/** The id the first line of a session file names. */
function headerId(home: BotHome, file: string): unknown {
	const [first] = readFileSync(join(home.sessionsDir, file), "utf8").split("\n");
	return (JSON.parse(first ?? "{}") as { id?: unknown }).id;
}

/** What holds the session's lease in `home`: each holder's role and whether it is this process's. */
function holdersIn(home: BotHome["orchestrationHome"], sessionId: string): Array<{ role: string; self: boolean }> {
	return readSessionLeaseHolders(home, sessionId).map((holder) => ({ role: holder.role, self: holder.self }));
}

/**
 * Leg: a bot's own session lives in its home, through the host's own load. Its first answer starts the session in
 * `bots/<id>/sessions`, records it in `bots/<id>/session.json` and keeps its orchestration state in
 * `bots/<id>/orchestration`, none of it in the owner's home. A host that closes (the bot retired) and opens it again
 * continues the session the pointer names, not a newer file beside it. A session whose state an earlier build left in the
 * owner's home is moved into the bot's on open, its fleet queue file included, leaving nothing behind. A pointer that is a
 * symbolic link stops the load with the product's sentence and starts nothing. While a session of the owner holds the
 * bot's session, the host stays out and the message waits, the send saying why; once that session lets it go, the host
 * opens it and answers. Every message reaches a closed session, so no owner words are left to settle and no System One
 * question is asked in either mode.
 */
export async function runJourney7BotHomePhase(world: HarnessWorld): Promise<void> {
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	try {
		await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the root session disposes cleanly").toBeUndefined();
	}
	world.trace.mark("root", "j7.bot-home");
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<void> {
	const trace = world.trace;
	const words = interfaceText().botTeam;
	const home = botHomeOf(world.agentDir, KEEPER);
	const owner = ownerOrchestrationHome(world.agentDir);
	const hostLock = resolve(botHostLockFile(world.agentDir, KEEPER));
	createOwnerBot(session, KEEPER, MODEL_ID.homeBot, SOUL);
	const seen = {
		continued: { firstQuestion: false, firstAnswer: false, second: false },
		moved: { secondQuestion: false, secondAnswer: false, third: false },
		released: { thirdQuestion: false, thirdAnswer: false, fifth: false, linked: true },
	};
	const keeperRequests = () =>
		world.provider.requests.filter((request: ScriptedRequest) => (request.context.systemPrompt ?? "").includes(SOUL))
			.length;
	enqueueBot(
		world,
		TRACK.homeBot,
		MODEL_ID.homeBot,
		SOUL,
		{ name: "j7-home-first", reply: { content: [{ type: "text", text: FIRST_ANSWER }] } },
		{
			name: "j7-home-continued",
			check: (request) => {
				seen.continued = {
					firstQuestion: carries(request, FIRST_QUESTION),
					firstAnswer: carries(request, FIRST_ANSWER),
					second: carries(request, SECOND_QUESTION),
				};
			},
			reply: { content: [{ type: "text", text: SECOND_ANSWER }] },
		},
		{
			name: "j7-home-moved",
			check: (request) => {
				seen.moved = {
					secondQuestion: carries(request, SECOND_QUESTION),
					secondAnswer: carries(request, SECOND_ANSWER),
					third: carries(request, THIRD_QUESTION),
				};
			},
			reply: { content: [{ type: "text", text: THIRD_ANSWER }] },
		},
		{
			name: "j7-home-released",
			check: (request) => {
				seen.released = {
					thirdQuestion: carries(request, THIRD_QUESTION),
					thirdAnswer: carries(request, THIRD_ANSWER),
					fifth: carries(request, FIFTH_QUESTION),
					linked: carries(request, LINKED_QUESTION),
				};
			},
			reply: { content: [{ type: "text", text: FIFTH_ANSWER }] },
		},
	);
	// Each owner message reaches a closed session, so its turn, which calls no tool, leaves its words unjudged and nothing
	// settles them: no System One question is asked in this leg (as for the bot-spend leg).
	if (world.systemOne.enabled) world.systemOne.enterPhase("j7-bot-home", {});
	const legMark = world.warnings.length;
	const ask = async (question: string, step: string, label: string) => {
		const sent = await session.sendOperatorMessageToBot(KEEPER, question);
		await withDeadline(trace, label, world.provider.whenReached(reached(TRACK.homeBot, step)));
		await waitForBotRosterState(world, session, KEEPER, "idle");
		return sent.mode;
	};
	let sessionIdValue: string | undefined;
	const sessionId = (): string => {
		if (sessionIdValue === undefined) throw new Error("the keeper's session id was read before its session existed");
		return sessionIdValue;
	};
	// The bot's host let the session go: no lease of it is held in the bot's home and the host lock names no holder.
	const closed = () =>
		readSessionLeaseHolders(home.orchestrationHome, sessionId()).length === 0 &&
		processLockHolder(hostLock) === undefined;
	const retire = async (label: string) => {
		expect(
			{
				retired: session.retirePersistentBot(KEEPER),
				recordRetired: botRecord(session, KEEPER).retired === true,
				roster: botRosterState(session, KEEPER),
			},
			`${label}: retiring the idle bot marks its record retired and closes its session`,
		).toEqual({
			retired: { retired: true, detail: `Bot ${KEEPER} retired.` },
			recordRetired: true,
			roster: "retired",
		});
		await withDeadline(trace, `${label}: the bot's host let its session go`, world.io.waitForMutation(closed));
	};

	// Step 1: the first answer starts the bot's session in its home: the pointer names its file, and its orchestration
	// state lives in the bot's home, none of it in the owner's.
	const firstMode = await ask(FIRST_QUESTION, "j7-home-first", "J7 bot home: the bot answered its first question");
	const pointer = readPointer(home);
	sessionIdValue = pointer.sessionId;
	expect(
		{
			mode: firstMode,
			pointer,
			files: sessionFiles(home),
			header: headerId(home, pointer.file),
			holders: holdersIn(home.orchestrationHome, sessionId()),
			botHomeHolds: orchestrationHomeHoldsSession(home.orchestrationHome, sessionId()),
			ownerHomeHolds: orchestrationHomeHoldsSession(owner, sessionId()),
			inOwnerHome: sessionStatePieces(owner, sessionId()).filter((piece) => existsSync(piece)),
		},
		"the first answer starts one session in the bot's sessions directory, the pointer names it, and its host holds it in the bot's orchestration home with nothing of it in the owner's",
	).toEqual({
		mode: "started",
		pointer: { version: 1, sessionId: sessionId(), file: pointer.file },
		files: [pointer.file],
		header: sessionId(),
		holders: [{ role: "bot-host", self: true }],
		botHomeHolds: true,
		ownerHomeHolds: false,
		inOwnerHome: [],
	});
	await retire("J7 bot home: after the first answer");

	// Step 2: a newer session file beside the pointed one is not what a reopened host continues: the pointer decides.
	const newerId = createSessionId();
	const newerTimestamp = new Date(Date.now() + 60_000).toISOString();
	const newerFile = `${newerTimestamp.replace(/[:.]/g, "-")}_${newerId}.jsonl`;
	const newerText = `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: newerId, timestamp: newerTimestamp, cwd: HARNESS_PROJECT_CWD })}\n`;
	writeFileSync(join(home.sessionsDir, newerFile), newerText);
	const secondMode = await ask(
		SECOND_QUESTION,
		"j7-home-continued",
		"J7 bot home: the reopened bot answered its second question",
	);
	expect(
		{
			mode: secondMode,
			carried: seen.continued,
			pointer: readPointer(home),
			newer: readFileSync(join(home.sessionsDir, newerFile), "utf8"),
			holders: holdersIn(home.orchestrationHome, sessionId()),
			newerHolders: holdersIn(home.orchestrationHome, newerId),
		},
		"a reopened host continues the session its pointer names, with its history, and leaves a newer session file beside it untouched and unheld",
	).toEqual({
		mode: "followed_up",
		carried: { firstQuestion: true, firstAnswer: true, second: true },
		pointer,
		newer: newerText,
		holders: [{ role: "bot-host", self: true }],
		newerHolders: [],
	});
	await retire("J7 bot home: after the continued answer");
	unlinkSync(join(home.sessionsDir, newerFile));

	// Step 3: state an earlier build kept in the owner's home (the session's bundle and fleet queue file, and whatever else
	// of it the bot's home holds once its host let it go) is moved into the bot's home by its host's open, and nothing of
	// it stays behind. A closed session's lease registry is removed with its last holder, so none stands to move.
	const botPieces = sessionStatePieces(home.orchestrationHome, sessionId());
	const ownerPieces = sessionStatePieces(owner, sessionId());
	const bundle = 0;
	const fleet = 2;
	const planted = new Set<number>([bundle, fleet]);
	botPieces.forEach((piece, index) => {
		if (!existsSync(piece)) return;
		mkdirSync(dirname(ownerPieces[index] as string), { recursive: true });
		renameSync(piece, ownerPieces[index] as string);
		planted.add(index);
	});
	// A bundle the session never wrote into is an empty directory: an earlier build made it all the same.
	mkdirSync(ownerPieces[bundle] as string, { recursive: true });
	mkdirSync(dirname(ownerPieces[fleet] as string), { recursive: true });
	writeFileSync(ownerPieces[fleet] as string, `${JSON.stringify(PLANTED_FLEET)}\n`);
	expect(
		{
			ownerHomeHolds: orchestrationHomeHoldsSession(owner, sessionId()),
			botHomeHolds: orchestrationHomeHoldsSession(home.orchestrationHome, sessionId()),
			inOwnerHome: [...planted].sort().map((index) => existsSync(ownerPieces[index] as string)),
		},
		"the bot session's bundle and fleet queue file stand in the owner's home and nothing of it in the bot's, as an earlier build left them",
	).toEqual({ ownerHomeHolds: true, botHomeHolds: false, inOwnerHome: [...planted].map(() => true) });
	const moveMark = world.warnings.length;
	const thirdMode = await ask(
		THIRD_QUESTION,
		"j7-home-moved",
		"J7 bot home: the moved bot answered its third question",
	);
	const plantedPieces = [...planted].sort();
	expect(
		{
			mode: thirdMode,
			carried: seen.moved,
			inBotHome: plantedPieces.map((index) => existsSync(botPieces[index] as string)),
			inOwnerHome: ownerPieces.filter((piece) => existsSync(piece)),
			ownerHomeHolds: orchestrationHomeHoldsSession(owner, sessionId()),
			fleet: JSON.parse(readFileSync(botPieces[fleet] as string, "utf8")),
			holders: holdersIn(home.orchestrationHome, sessionId()),
			ownerHolders: holdersIn(owner, sessionId()),
			warnings: world.warnings.slice(moveMark),
		},
		"the host's open moves the session's state into the bot's home, its fleet queue file included, leaves none of it in the owner's home and continues the conversation there, telling nothing",
	).toEqual({
		mode: "followed_up",
		carried: { secondQuestion: true, secondAnswer: true, third: true },
		inBotHome: plantedPieces.map(() => true),
		inOwnerHome: [],
		ownerHomeHolds: false,
		fleet: PLANTED_FLEET,
		holders: [{ role: "bot-host", self: true }],
		ownerHolders: [],
		warnings: [],
	});
	await retire("J7 bot home: after the moved answer");

	// Step 4: a pointer that is a symbolic link stops the load with the product's sentence: nothing is set aside, no
	// session is started, no model is asked and the message is not kept.
	const pointerTarget = join(home.dir, "session-pointer.json");
	renameSync(home.pointerFile, pointerTarget);
	symlinkSync(pointerTarget, home.pointerFile);
	const linkMark = world.warnings.length;
	const filesBeforeLink = sessionFileTexts(home);
	const requestsBeforeLink = keeperRequests();
	const refused = await session.sendOperatorMessageToBot(KEEPER, LINKED_QUESTION).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(
		{
			refused: refused instanceof Error ? { name: refused.name, message: refused.message } : refused,
			files: sessionFileTexts(home),
			setAside: readdirSync(home.dir).filter((name) => name.startsWith("session.json.")),
			linked: lstatSync(home.pointerFile).isSymbolicLink(),
			recordRetired: botRecord(session, KEEPER).retired === true,
			holders: holdersIn(home.orchestrationHome, sessionId()),
			lockHolder: processLockHolder(hostLock),
			inbox: readBotInbox(world.agentDir, KEEPER, () => undefined).length,
			requests: keeperRequests() - requestsBeforeLink,
			warnings: world.warnings.slice(linkMark),
		},
		"a symbolic-link pointer stops the load with the owner-worded link sentence, sets nothing aside, starts no session, asks no model, keeps no message and leaves the bot retired",
	).toEqual({
		refused: { name: "BotSessionLinkError", message: words.botSessionFileLinked(home.pointerFile) },
		files: filesBeforeLink,
		setAside: [],
		linked: true,
		recordRetired: true,
		holders: [],
		lockHolder: undefined,
		inbox: 0,
		requests: 0,
		warnings: [],
	});
	unlinkSync(home.pointerFile);
	renameSync(pointerTarget, home.pointerFile);

	// Step 5: while a session of the owner holds the bot's session (as a session opened on the bot's sessions directory
	// does), the host stays out and the message waits, the send saying why; once it lets go, the host opens it and answers.
	const manager = continueBotSession(world.agentDir, home, HARNESS_PROJECT_CWD);
	const roots = manager.getStorageRoots();
	expect(
		{
			sessionId: manager.getSessionId(),
			inBotHome: sameOrchestrationHome(roots.orchestrationHome, home.orchestrationHome),
		},
		"a session opened on the bot's sessions directory continues the pointed session in the bot's home",
	).toEqual({ sessionId: sessionId(), inBotHome: true });
	const lease = acquireSessionBundleLease(roots.orchestrationHome, sessionId(), {
		role: "session",
		refuseHosted: true,
		homeNow: managerSessionHomeNow(manager),
	});
	try {
		const [holder] = readSessionLeaseHolders(home.orchestrationHome, sessionId());
		if (holder === undefined) throw new Error("the owner's session took no lease of the bot's session");
		const armedBefore = new Set(world.timers.armedSnapshot("provider-admission").map((alarm) => alarm.handle));
		/** The alarms on the admission clock armed since the send, each placed in the backoff step its delay is due in. */
		const retrySteps = () =>
			world.timers
				.armedSnapshot("provider-admission")
				.filter((alarm) => !armedBefore.has(alarm.handle))
				.map((alarm) => Math.ceil(alarm.remainingMs / BOT_OPEN_RETRY_FIRST_MS));
		const sent = await session.sendOperatorMessageToBot(KEEPER, FIFTH_QUESTION);
		const waiting = readBotInbox(world.agentDir, KEEPER, (file, reason) => {
			throw new Error(`the bot's inbox holds an unreadable message ${file}: ${reason}`);
		});
		expect(
			{
				sent,
				waiting: waiting.map((item) => ({ id: item.message.id, text: item.message.text })),
				holders: holdersIn(home.orchestrationHome, sessionId()),
				requests: keeperRequests(),
			},
			"while a session of the owner holds the bot's session, the host is kept out and the message waits in the bot's inbox, the send naming that session in the product's words",
		).toEqual({
			sent: {
				agentId: KEEPER,
				mode: "queued",
				messageId: waiting[0]?.message.id,
				modelRef: modelOf(MODEL_ID.homeBot),
				waitsFor: words.botWordsWaitForOpen(
					KEEPER,
					words.botSessionOpenElsewhere(KEEPER, words.botSessionHolderSession(holder.owner.pid)),
				),
			},
			waiting: [{ id: sent.messageId, text: FIFTH_QUESTION }],
			holders: [{ role: "session", self: true }],
			requests: 3,
		});
		// The host asks again while the session still holds it: its retry, due within the backoff's first step after the
		// send's own attempt, finds the session held and arms the next within the second. Its own take and release of the
		// bot's lock on each attempt ask nothing more (the home watch tells them from another host's, so no attempt of its
		// own doubles the backoff), and the owner, told by the send, is told nothing more.
		expect(
			retrySteps(),
			"the send's attempt armed the host's one retry, due within the backoff's first step",
		).toEqual([1]);
		const asked = world.io.waitForOperation((operation) => operation.kind === "rm" && operation.path === hostLock);
		const rearmed = world.timers.nextArmed("provider-admission");
		world.timers.advance("provider-admission", BOT_OPEN_RETRY_FIRST_MS);
		await withDeadline(trace, "J7 bot home: the host asked again for the held session", asked);
		await withDeadline(trace, "J7 bot home: the host armed its next attempt", rearmed);
		expect(
			retrySteps(),
			"the held session's retry armed the host's one next attempt, due within the backoff's second step",
		).toEqual([2]);
	} finally {
		lease.release();
	}
	world.timers.advance("provider-admission", 2 * BOT_OPEN_RETRY_FIRST_MS);
	await withDeadline(
		trace,
		"J7 bot home: the host opened the released session and answered the waiting message",
		world.provider.whenReached(reached(TRACK.homeBot, "j7-home-released")),
	);
	await waitForBotRosterState(world, session, KEEPER, "idle");
	expect(
		{
			carried: seen.released,
			pointer: readPointer(home),
			holders: holdersIn(home.orchestrationHome, sessionId()),
			inbox: readBotInbox(world.agentDir, KEEPER, () => undefined).length,
			requests: keeperRequests(),
			warnings: world.warnings.slice(legMark),
		},
		"once the owner's session let the bot's session go, its host opened the pointed session and answered the waiting message, the owner told nothing beyond the send",
	).toEqual({
		carried: { thirdQuestion: true, thirdAnswer: true, fifth: true, linked: false },
		pointer,
		holders: [{ role: "bot-host", self: true }],
		inbox: 0,
		requests: 4,
		warnings: [],
	});
	await retire("J7 bot home: after the released answer");
}
