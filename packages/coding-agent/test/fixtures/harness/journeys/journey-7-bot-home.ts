import "../builtin-install.ts";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
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
import { BOT_HOME_COALESCE_MS } from "../../../../src/core/bots/bot-home-watch.ts";
import {
	botInboxStopWaiting,
	botInboxWaiting,
	enqueueBotInbox,
	readBotInbox,
	readBotInboxRefusals,
} from "../../../../src/core/bots/bot-inbox.ts";
import { BOT_OPEN_RETRY_FIRST_MS, BOT_OPEN_RETRY_MAX_MS } from "../../../../src/core/bots/bot-open-retry.ts";
import { markOwedRelease, owedReleases } from "../../../../src/core/bots/bot-owed-releases.ts";
import { continueBotSession } from "../../../../src/core/bots/bot-session-open.ts";
import { earlierAwayFleetQueueMetadataPath } from "../../../../src/core/fleet/fleet-queue-store.ts";
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
/** Sent just before the owner's stop, which covers it: refused by the stop, so no turn ever carries it. */
const STOPPED_QUESTION = "Which branch holds the release fixes?";
const SIXTH_QUESTION = "Which channel announces the release?";
const SIXTH_ANSWER = "The release is announced in the releases channel.";
const SEVENTH_QUESTION = "Who keeps the release checklist?";
const SEVENTH_ANSWER = "The release manager keeps the release checklist.";
/** Left waiting in the retired bot's inbox, as a process that retired the bot and ended before its release left it. */
const OWED_QUESTION = "Which team owns the release dashboard?";
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
 * opens it and answers. A release a process left owed when it ended is taken up by the next host. Every message reaches a closed session, so no owner words are left to settle and no System One
 * question is asked in either mode.
 */
export async function runJourney7BotHomePhase(world: HarnessWorld): Promise<void> {
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	let ownerBundle: string;
	try {
		ownerBundle = await runLeg(world, session);
	} finally {
		expect(await world.disposeSessionInBody(session), "the root session disposes cleanly").toBeUndefined();
	}
	await replacedHostTellsNothing(world, ownerBundle);
	await owedReleaseTakenUp(world);
	world.trace.mark("root", "j7.bot-home");
}

/**
 * Leg: a root session replaced by another (the first disposed, then a new one created, as a new, resumed or forked session
 * does) gives the bots a new host, which keeps what the process told: the bot's session state standing in both homes,
 * told when the first root's host opened the bot's session (`ownerBundle`, the owner's copy left unused), is told no
 * more when the new host opens it.
 */
async function replacedHostTellsNothing(world: HarnessWorld, ownerBundle: string): Promise<void> {
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	const hostLock = resolve(botHostLockFile(world.agentDir, KEEPER));
	try {
		const mark = world.warnings.length;
		const sent = await session.sendOperatorMessageToBot(KEEPER, SEVENTH_QUESTION);
		await withDeadline(
			world.trace,
			"J7 bot home: the bot answered through the host that replaced the first root's",
			world.provider.whenReached(reached(TRACK.homeBot, "j7-home-replaced")),
		);
		await waitForBotRosterState(world, session, KEEPER, "idle");
		expect(
			{ mode: sent.mode, warnings: world.warnings.slice(mark) },
			"the host that replaced the first root's opens the bot's session beside its state in both homes and tells nothing the process told already",
		).toEqual({ mode: "followed_up", warnings: [] });
		expect(
			session.retirePersistentBot(KEEPER),
			"retiring the bot through the replacing root closes its session",
		).toEqual({ retired: true, detail: `Bot ${KEEPER} retired.` });
		await withDeadline(
			world.trace,
			"J7 bot home: the replacing root's host let the bot's session go",
			world.io.waitForMutation(() => processLockHolder(hostLock) === undefined),
		);
	} finally {
		rmSync(ownerBundle, { recursive: true, force: true });
		expect(await world.disposeSessionInBody(session), "the replacing root session disposes cleanly").toBeUndefined();
	}
}

/**
 * Leg: a release a process left owed when it ended is taken up by the next host. The bot is retired and its release
 * finished (`replacedHostTellsNothing`); a message then waiting in its inbox, with the bot's owed-release journal entry
 * standing, is what a process that retired the bot and ended before its release finished leaves (the record retired, the
 * release marked owed in the journal when it was prepared, the home still holding the message). The next root session's
 * host takes the release up from the journal as it opens the bots: the message is refused with the release's reason, the
 * bot's journal entry is removed, the bot's lock is given back and the owner is told nothing.
 */
async function owedReleaseTakenUp(world: HarnessWorld): Promise<void> {
	const words = interfaceText().botTeam;
	const hostLock = resolve(botHostLockFile(world.agentDir, KEEPER));
	// The mark the release's preparation writes before the retirement (`BotRelease.prepare`), which a process that ended
	// before the release finished leaves standing.
	markOwedRelease(world.agentDir, KEEPER);
	const left = enqueueBotInbox(world.agentDir, {
		agentId: KEEPER,
		text: OWED_QUESTION,
		from: { pid: process.pid, sessionId: createSessionId(), cwd: HARNESS_PROJECT_CWD },
		at: Date.now(),
	});
	expect(botInboxWaiting(world.agentDir, KEEPER), "the retired bot's inbox holds the message left owed").toBe(true);
	const mark = world.warnings.length;
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	try {
		await withDeadline(
			world.trace,
			"J7 bot home: the next host took up the release left owed",
			world.io.waitForMutation(() => !botInboxWaiting(world.agentDir, KEEPER)),
		);
		const refusals = readBotInboxRefusals(world.agentDir, KEEPER, (file, reason) => {
			throw new Error(`the bot's inbox holds an unreadable refusal ${file}: ${reason}`);
		});
		expect(
			{
				retired: botRecord(session, KEEPER).retired,
				refused: refusals.filter((item) => item.message.id === left.message.id).map((item) => item.message.reason),
				owed: owedReleases(world.agentDir).includes(KEEPER),
				lock: processLockHolder(hostLock),
				warnings: world.warnings.slice(mark),
			},
			"the next host released the retired bot whose release a process left owed: the message left waiting refused with the release's reason, the journal entry removed, the lock given back, the owner told nothing",
		).toEqual({
			retired: true,
			refused: [words.botInboxReleased(KEEPER)],
			owed: false,
			lock: undefined,
			warnings: [],
		});
	} finally {
		expect(
			await world.disposeSessionInBody(session),
			"the root session that took the release up disposes cleanly",
		).toBeUndefined();
	}
}

async function runLeg(world: HarnessWorld, session: AgentSession): Promise<string> {
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
		{ name: "j7-home-both", reply: { content: [{ type: "text", text: SIXTH_ANSWER }] } },
		{ name: "j7-home-replaced", reply: { content: [{ type: "text", text: SEVENTH_ANSWER }] } },
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
	// The away runs' queue file under the name an earlier build gave it, standing where their own file is absent: whose it
	// is only their ledger can prove, so the move carries it under that name and never adopts it.
	const awayFleet = 3;
	const earlierAwayInOwner = earlierAwayFleetQueueMetadataPath(owner, sessionId());
	const earlierAwayInBot = earlierAwayFleetQueueMetadataPath(home.orchestrationHome, sessionId());
	writeFileSync(earlierAwayInOwner, `${JSON.stringify(PLANTED_FLEET)}\n`);
	expect(
		{
			ownerHomeHolds: orchestrationHomeHoldsSession(owner, sessionId()),
			botHomeHolds: orchestrationHomeHoldsSession(home.orchestrationHome, sessionId()),
			inOwnerHome: [...planted].sort().map((index) => existsSync(ownerPieces[index] as string)),
			earlierAway: {
				inOwnerHome: existsSync(earlierAwayInOwner),
				ownInOwnerHome: existsSync(ownerPieces[awayFleet] as string),
			},
		},
		"the bot session's bundle and fleet queue file stand in the owner's home and nothing of it in the bot's, as an earlier build left them",
	).toEqual({
		ownerHomeHolds: true,
		botHomeHolds: false,
		inOwnerHome: [...planted].map(() => true),
		earlierAway: { inOwnerHome: true, ownInOwnerHome: false },
	});
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
			earlierAway: {
				inOwnerHome: existsSync(earlierAwayInOwner),
				underItsName: JSON.parse(readFileSync(earlierAwayInBot, "utf8")),
				underTheAwayName: existsSync(botPieces[awayFleet] as string),
			},
			holders: holdersIn(home.orchestrationHome, sessionId()),
			ownerHolders: holdersIn(owner, sessionId()),
			warnings: world.warnings.slice(moveMark),
		},
		"the host's open moves the session's state into the bot's home, its fleet queue file included and the away runs' file an earlier build named carried under that name, leaves none of it in the owner's home and continues the conversation there, telling nothing",
	).toEqual({
		mode: "followed_up",
		carried: { secondQuestion: true, secondAnswer: true, third: true },
		inBotHome: plantedPieces.map(() => true),
		inOwnerHome: [],
		ownerHomeHolds: false,
		fleet: PLANTED_FLEET,
		earlierAway: { inOwnerHome: false, underItsName: PLANTED_FLEET, underTheAwayName: false },
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
		opening: true,
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
		/**
		 * Hands the bot-home watch's gathered notices to the host now instead of after its real window, then lets an open
		 * they ask for run to its end before the next turn (its steps are synchronous file calls and promise continuations):
		 * had the host read its own take and release of the bot's lock as another host's, that open would have armed one
		 * more attempt by then.
		 */
		const deliverHomeNotices = async () => {
			world.timers.advance("bot-home-watch", BOT_HOME_COALESCE_MS);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(
				world.timers.armedSnapshot("bot-home-watch"),
				"the bot-home watch delivered its batch and gathered no other change after it",
			).toEqual([]);
		};
		// The owner's `/bot msg` shows why the message waits (the chat's status line), so the host tells nothing more.
		const sent = await session.sendOperatorMessageToBot(KEEPER, FIFTH_QUESTION, { showsWaits: true });
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
		await deliverHomeNotices();
		expect(
			retrySteps(),
			"the send's attempt armed the host's one retry, due within the backoff's first step",
		).toEqual([1]);
		const asked = world.io.waitForOperation((operation) => operation.kind === "rm" && operation.path === hostLock);
		const rearmed = world.timers.nextArmed("provider-admission");
		world.timers.advance("provider-admission", BOT_OPEN_RETRY_FIRST_MS);
		await withDeadline(trace, "J7 bot home: the host asked again for the held session", asked);
		await withDeadline(trace, "J7 bot home: the host armed its next attempt", rearmed);
		await deliverHomeNotices();
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

	// Step 6: the owner's stop of the hosted bot whose take fails (a message it covers cannot leave the inbox) still ends
	// the bot's work, telling what it left behind a symbolic link in the bot's home; the take tried again after its
	// backoff applies the stop and tells that link nothing more: the notice is told once for the stop and its links.
	const linkedSession = join(home.sessionsDir, "linked-elsewhere.jsonl");
	const linkedTarget = join(home.dir, "linked-elsewhere-target.jsonl");
	writeFileSync(linkedTarget, "");
	symlinkSync(linkedTarget, linkedSession);
	const requestsBeforeStop = keeperRequests();
	const covered = enqueueBotInbox(world.agentDir, {
		agentId: KEEPER,
		text: STOPPED_QUESTION,
		from: { pid: process.pid, sessionId: session.sessionId, cwd: HARNESS_PROJECT_CWD },
		at: Date.now(),
	});
	const stuck = world.io.denyUntilCleared({
		name: "j7-home-covered-message-stays",
		kind: "rm",
		matches: (operation) => operation.path === covered.file,
		code: "EACCES",
	});
	const linkSentence = words.botLinkedSessionsJobsLeft(KEEPER, [linkedSession]);
	const [notAppliedHead, notAppliedTail] = words.botStopNotApplied(KEEPER, "\0").split("\0");
	const stopMark = world.warnings.length;
	const sessionAlarmsBefore = new Set(world.timers.armedSnapshot("bot-sessions").map((alarm) => alarm.handle));
	const shapes = (warnings: readonly string[]) =>
		warnings.map((warning) =>
			warning === linkSentence
				? "link"
				: warning.startsWith(notAppliedHead ?? "") && warning.endsWith(notAppliedTail ?? "")
					? "notApplied"
					: warning,
		);
	let retryDue: number[];
	try {
		session.stopPersistentBot(KEEPER);
		expect(
			{
				stopWaits: botInboxStopWaiting(world.agentDir, KEEPER),
				coveredWaits: botInboxWaiting(world.agentDir, KEEPER),
				warnings: shapes(world.warnings.slice(stopMark)),
			},
			"a stop whose take failed waits with the message it covers, the owner told of the failure and of the link once",
		).toEqual({
			stopWaits: true,
			coveredWaits: true,
			warnings: ["notApplied", "link"],
		});
		// The pass the stop started ends after its failed take settles: until then a drain only asks it to read again, which
		// a pass that ended on a failed take does not, so the retry is fired once that pass is gone. The take still fails
		// meanwhile: the bot-home watch's batch is gathered on the wall clock, and one falling due in this wait (an inbox
		// change of the step before, such as its drain's removal of the answered message) drains the inbox, which takes the
		// stop again. Failing, that take arms the one retry again, a step further; cleared before it, it would apply the stop
		// and leave no retry to fire.
		await new Promise<void>((resolve) => setImmediate(resolve));
		// The take's retry is the alarm the failed takes armed on the host's clock, within the backoff's longest step.
		retryDue = world.timers
			.armedSnapshot("bot-sessions")
			.filter((alarm) => !sessionAlarmsBefore.has(alarm.handle) && alarm.remainingMs <= BOT_OPEN_RETRY_MAX_MS)
			.map((alarm) => alarm.remainingMs);
		expect(retryDue.length, "the failed take armed one retry on the host's clock").toBe(1);
	} finally {
		stuck.clear();
	}
	// Cleared and fired with nothing awaited between: no other drain takes the stop before its retry does.
	const applied = world.io.waitForMutation(
		() => !botInboxStopWaiting(world.agentDir, KEEPER) && !botInboxWaiting(world.agentDir, KEEPER),
	);
	world.timers.advance("bot-sessions", Math.max(...retryDue));
	await withDeadline(trace, "J7 bot home: the stop's take tried again applied it", applied);
	const stopWarnings = shapes(world.warnings.splice(stopMark));
	const refusals = readBotInboxRefusals(world.agentDir, KEEPER, (file, reason) => {
		throw new Error(`the bot's inbox holds an unreadable refusal ${file}: ${reason}`);
	});
	expect(
		{
			warnings: stopWarnings,
			refused: refusals.filter((item) => item.message.id === covered.message.id).map((item) => item.message.reason),
			requests: keeperRequests() - requestsBeforeStop,
		},
		"the take tried again applied the stop and refused the message it covers, the link told once for the stop however often its take ran, no turn started",
	).toEqual({
		warnings: ["notApplied", "link"],
		refused: [words.botTurnAbortReasons.ownerStopped],
		requests: 0,
	});
	unlinkSync(linkedSession);
	unlinkSync(linkedTarget);
	await retire("J7 bot home: after the released answer");

	// Step 7: the session's state standing in both homes (a bundle of it left in the owner's home beside the bot's) is
	// told once per process: this root's host tells it as it opens the bot's session, and the host that replaces it
	// (`replacedHostTellsNothing`) tells it no more.
	const ownerBundle = ownerPieces[bundle] as string;
	mkdirSync(ownerBundle, { recursive: true });
	const bothMark = world.warnings.length;
	const sixthMode = await ask(
		SIXTH_QUESTION,
		"j7-home-both",
		"J7 bot home: the bot answered beside its state in both homes",
	);
	expect(
		{ mode: sixthMode, warnings: world.warnings.splice(bothMark) },
		"the bot's session opens on its own home's state beside the owner's copy, the owner told once where that copy stays unused",
	).toEqual({ mode: "followed_up", warnings: [words.botSessionStateInBothHomes(KEEPER, ownerBundle)] });
	await retire("J7 bot home: after the answer beside both homes");
	return ownerBundle;
}
