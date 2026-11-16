/**
 * The mail this session's workers send to bots that answer in sessions of their own, as the session keeps it beside its
 * transcript in `<session>.worker-mail.json`:
 * - each goal's mail, one entry updated in place: it holds the goal open until its answer is handed on or it is found
 *   gone (`LeaderController`), then stays among the newest ended ones (`MAX_ENDED_GOAL_MAILS`); an open mail of a goal
 *   no longer open is released, as nothing waits on it any more;
 * - the metered spend those bots' turns made answering each goal's mail, which the goal's budget counts, kept while the
 *   goal's objective is in the session's store;
 * - the hop of each bot's reply handed to a worker's mailbox, and the worker attempt that read the reply into its turn,
 *   recorded when that attempt reads it (`messagesRead`, told by the worker's mailbox admission before the message is
 *   marked delivered): kept while the reply is being handed on, while the turn its message started or the attempt that
 *   read it runs, and while the mailbox holds it unread (a turn may yet read it), until that worker is gone
 *   (`replyTurnOver`). A mail that turn sends continues the reply's chain (`hopAfter`), in a goal or not, so a worker
 *   and a bot answering each other stop at `MAX_BOT_MAIL_HOPS`. A reply no turn of it runs any more, its message read,
 *   refused or forgotten, is released.
 *
 * It is a file of its own with its own version, which no older build lists (they list a session directory by `.jsonl`)
 * and the orchestration store never holds, so mail takes nothing of a goal's evidence bound. The one process hosting the
 * session writes it, whole and atomically, on each change. A file a newer build wrote is never overwritten (this build
 * keeps its record in memory); one that does not read is set aside under a name of its own, and the owner is told.
 */

import { readFileSync, renameSync } from "node:fs";
import { interfaceText } from "../language/interface-text.ts";
import { atomicFileFamily, isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";

export const WORKER_MAIL_LEDGER_VERSION = 1;
/** The ledger's suffix beside a session's transcript; no reader of a session directory lists it. */
export const WORKER_MAIL_LEDGER_SUFFIX = ".worker-mail.json";
/** Most ended goal mails a session keeps to show; the latest sent are kept. No decision reads an ended one. */
export const MAX_ENDED_GOAL_MAILS = 32;

/**
 * How a goal stopped waiting for a mail: its reply reached the worker or the session (`answered`), the mail was never sent
 * (`unsent`), the bot no longer holds it or no longer answers in a session of its own (`gone`), or the reply expired
 * unread (`expired`).
 */
export const GOAL_MAIL_ENDS = ["answered", "unsent", "gone", "expired"] as const;
export type GoalMailEndHow = (typeof GOAL_MAIL_ENDS)[number];

/** How a goal stopped waiting for a mail, and the metered spend the bot's session made answering it. */
export interface GoalMailEnd {
	readonly how: GoalMailEndHow;
	/** The reply's hop, when it was handed on. */
	readonly replyHop?: number;
	readonly meteredUsd: number;
}

/** A mail a worker of a goal sent to a bot that answers in a session of its own: the goal waits for its reply. */
export interface GoalMail {
	readonly mailId: string;
	readonly objectiveId: string;
	/** The bot mailed. */
	readonly agentId: string;
	/** The runtime of the worker that sent it. */
	readonly worker: string;
	/** Its place in its chain (`MAX_BOT_MAIL_HOPS`). */
	readonly hop: number;
	readonly sentAt: number;
	/** When the goal's settle step first found the goal done but for this mail's answer, and kept it open for it. */
	readonly awaitedAt?: number;
	readonly end?: GoalMailEnd;
}

/**
 * A bot's reply handed to a worker's mailbox under `messageId`: the worker turn that message starts, or the attempt that
 * read it into its running turn (`attemptId`), continues the reply's chain.
 */
export interface ReplyTurn {
	readonly messageId: string;
	readonly worker: string;
	readonly hop: number;
	/** The worker attempt that last read the reply's message into its turn (`messagesRead`); absent while none has. */
	readonly attemptId?: string;
}

/** A worker's running turn: its attempt, and the mailbox message that started it, when one did. */
export interface WorkerMailTurn {
	readonly attemptId: string;
	readonly controlMessageId?: string;
}

/** What a session's worker controller reads of its workers' mail and tells it. */
export interface WorkerMailPort {
	/** The metered spend bots answering in sessions of their own made for a goal's mail. */
	goalSpentUsd(objectiveId: string): number;
	/**
	 * Told, before the messages can be marked delivered, when a worker's attempt reads mailbox messages into its turn.
	 * Absent on a host that runs only part of its parent's work: such a host reads no message another turn would read.
	 */
	messagesRead?(worker: string, attemptId: string, messageIds: readonly string[]): void;
}

interface WorkerMailState {
	readonly mails: readonly GoalMail[];
	readonly goalSpentUsd: Readonly<Record<string, number>>;
	readonly replies: readonly ReplyTurn[];
}

const EMPTY: WorkerMailState = { mails: [], goalSpentUsd: {}, replies: [] };
const MAX_ID_CHARS = 512;

/** The ledger's path beside a session's transcript (`<stem>.jsonl` gives `<stem>.worker-mail.json`). */
export function workerMailLedgerPath(sessionFile: string): string {
	return `${sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : sessionFile}${WORKER_MAIL_LEDGER_SUFFIX}`;
}

/**
 * The ledger files beside a session's transcript: the ledger, the unreadable ones set aside under its name and the
 * temporaries of its crashed atomic writes. They hold only the session's own mail, so they go with its transcript.
 */
export function workerMailLedgerFiles(sessionFile: string): string[] {
	return atomicFileFamily(workerMailLedgerPath(sessionFile));
}

function isId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;
}

function isHop(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isUsd(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTime(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseEnd(value: unknown): GoalMailEnd | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, ["how", "replyHop", "meteredUsd"])) return undefined;
	const { how, replyHop, meteredUsd } = value;
	if (!(GOAL_MAIL_ENDS as readonly unknown[]).includes(how) || !isUsd(meteredUsd)) return undefined;
	if (replyHop !== undefined && !isHop(replyHop)) return undefined;
	return { how: how as GoalMailEndHow, meteredUsd, ...(replyHop !== undefined ? { replyHop } : {}) };
}

function parseMail(value: unknown): GoalMail | undefined {
	const keys = ["mailId", "objectiveId", "agentId", "worker", "hop", "sentAt", "awaitedAt", "end"];
	if (!isPlainRecord(value) || !hasOnlyKeys(value, keys)) return undefined;
	const { mailId, objectiveId, agentId, worker, hop, sentAt, awaitedAt } = value;
	if (!isId(mailId) || !isId(objectiveId) || !isId(agentId) || !isId(worker) || !isHop(hop) || !isTime(sentAt))
		return undefined;
	if (awaitedAt !== undefined && !isTime(awaitedAt)) return undefined;
	const end = value.end === undefined ? undefined : parseEnd(value.end);
	if (value.end !== undefined && !end) return undefined;
	return {
		mailId,
		objectiveId,
		agentId,
		worker,
		hop,
		sentAt,
		...(awaitedAt !== undefined ? { awaitedAt } : {}),
		...(end ? { end } : {}),
	};
}

function parseReply(value: unknown): ReplyTurn | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, ["messageId", "worker", "hop", "attemptId"])) return undefined;
	const { messageId, worker, hop, attemptId } = value;
	if (!isId(messageId) || !isId(worker) || !isHop(hop)) return undefined;
	if (attemptId !== undefined && !isId(attemptId)) return undefined;
	return { messageId, worker, hop, ...(attemptId !== undefined ? { attemptId } : {}) };
}

/** The state a file of this version holds for `sessionId`; undefined when it does not read as one. */
function parseState(value: unknown, sessionId: string): WorkerMailState | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, ["version", "sessionId", "mails", "goalSpentUsd", "replies"]))
		return undefined;
	if (value.version !== WORKER_MAIL_LEDGER_VERSION || value.sessionId !== sessionId) return undefined;
	const { mails, goalSpentUsd, replies } = value;
	if (!Array.isArray(mails) || !Array.isArray(replies) || !isPlainRecord(goalSpentUsd)) return undefined;
	const parsedMails = mails.map(parseMail);
	const parsedReplies = replies.map(parseReply);
	const spent = Object.entries(goalSpentUsd);
	if (parsedMails.some((mail) => !mail) || parsedReplies.some((reply) => !reply)) return undefined;
	if (spent.some(([objectiveId, usd]) => !isId(objectiveId) || !isUsd(usd))) return undefined;
	return {
		mails: parsedMails as GoalMail[],
		goalSpentUsd: Object.fromEntries(spent) as Record<string, number>,
		replies: parsedReplies as ReplyTurn[],
	};
}

/**
 * A goal's mail spend as a session's ledger holds it now, for a process that does not host the session
 * (`away-parent-context.ts`): read on each call, nothing set aside or written. A ledger that is missing, does not read or
 * is newer counts none, as its own session does until it sets the file aside and tells the owner; a read that fails
 * otherwise throws.
 */
export function readGoalMailSpentUsd(sessionFile: string, sessionId: string, objectiveId: string): number {
	let text: string;
	try {
		text = readFileSync(workerMailLedgerPath(sessionFile), "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return 0;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return 0;
	}
	return parseState(value, sessionId)?.goalSpentUsd[objectiveId] ?? 0;
}

/** The ended mails past the newest `MAX_ENDED_GOAL_MAILS` go, the oldest sent first; an open mail is always kept. */
function boundedMails(mails: readonly GoalMail[]): readonly GoalMail[] {
	let excess = mails.filter((mail) => mail.end).length - MAX_ENDED_GOAL_MAILS;
	if (excess <= 0) return mails;
	return mails.filter((mail) => !mail.end || excess-- <= 0);
}

export interface WorkerMailLedgerDeps {
	sessionId(): string;
	/** The session's transcript file; undefined while it has none (the ledger is kept in memory). */
	sessionFile(): string | undefined;
	now(): number;
	/** Tells the owner, in the owner's language. */
	warn(message: string): void;
	/** Whether no turn of the worker reads the reply's hop any more, nor can (`replyTurnOver`). */
	replyTurnOver(turn: ReplyTurn): boolean;
}

/** One session's worker mail: read when first used for that session, then every change written whole before it is taken. */
export class WorkerMailLedger implements WorkerMailPort {
	private readonly deps: WorkerMailLedgerDeps;
	private loaded: { readonly sessionId: string; writable: boolean; state: WorkerMailState } | undefined;
	private readonly listeners = new Set<() => void>();
	/** The replies being handed on in this process (`replyHanded` to `replyLeft`): kept before the mailbox holds them. */
	private readonly handing = new Set<string>();

	constructor(deps: WorkerMailLedgerDeps) {
		this.deps = deps;
	}

	/** Told after every change taken. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The goal's mail, open and recently ended, in the order it was sent. */
	goalMails(objectiveId: string): readonly GoalMail[] {
		return this.state().mails.filter((mail) => mail.objectiveId === objectiveId);
	}

	/** The open goal mail `mailId`; undefined when there is none or it ended. */
	openMail(mailId: string): GoalMail | undefined {
		return this.state().mails.find((mail) => mail.mailId === mailId && !mail.end);
	}

	/** The metered spend bots answering in sessions of their own made for the goal's mail. */
	goalSpentUsd(objectiveId: string): number {
		return this.state().goalSpentUsd[objectiveId] ?? 0;
	}

	/**
	 * The hop of a mail `worker` sends in `turn`: one past the latest reply handed to it that started that turn or that
	 * the turn's attempt read, else 1 (a chain of its own).
	 */
	hopAfter(worker: string, turn: WorkerMailTurn | undefined): number {
		if (!turn) return 1;
		const hops = this.state()
			.replies.filter(
				(reply) =>
					reply.worker === worker &&
					(reply.messageId === turn.controlMessageId || reply.attemptId === turn.attemptId),
			)
			.map((reply) => reply.hop);
		return hops.length === 0 ? 1 : Math.max(...hops) + 1;
	}

	/**
	 * Records a goal's mail before it is sent: open until it ends. A mail recorded open already is left as it was; one
	 * that ended (a replay of a send that failed) is open again, so the goal waits for the send it replays.
	 */
	sent(mail: Omit<GoalMail, "sentAt" | "awaitedAt" | "end">): void {
		this.change((state) => {
			if (this.openMail(mail.mailId)) return state;
			const others = state.mails.filter((entry) => entry.mailId !== mail.mailId);
			return { ...state, mails: [...others, { ...mail, sentAt: this.deps.now() }] };
		});
	}

	/** Records, once, that the goal was kept open for the open mail `mailId`'s answer. */
	awaited(mailId: string): void {
		const mail = this.openMail(mailId);
		if (!mail || mail.awaitedAt !== undefined) return;
		const awaitedAt = this.deps.now();
		this.change((state) => ({
			...state,
			mails: state.mails.map((entry) => (entry === mail ? { ...entry, awaitedAt } : entry)),
		}));
	}

	/** Ends the open mail `mailId`, its spend counted to its goal; one ended already, or unknown, changes nothing. */
	ended(mailId: string, end: GoalMailEnd): void {
		const mail = this.openMail(mailId);
		if (!mail) return;
		this.change((state) => ({
			...state,
			mails: boundedMails(state.mails.map((entry) => (entry === mail ? { ...entry, end } : entry))),
			goalSpentUsd:
				end.meteredUsd > 0
					? {
							...state.goalSpentUsd,
							[mail.objectiveId]: (state.goalSpentUsd[mail.objectiveId] ?? 0) + end.meteredUsd,
						}
					: state.goalSpentUsd,
		}));
	}

	/**
	 * Keeps what the goals still need: an open mail while its goal is `open`, an ended one and a goal's spend while the goal
	 * is `known` to the session's store.
	 */
	retainGoals(open: ReadonlySet<string>, known: ReadonlySet<string>): void {
		this.change((state) => ({
			...state,
			mails: state.mails.filter((mail) => (mail.end ? known.has(mail.objectiveId) : open.has(mail.objectiveId))),
			goalSpentUsd: Object.fromEntries(
				Object.entries(state.goalSpentUsd).filter(([objectiveId]) => known.has(objectiveId)),
			),
		}));
	}

	/**
	 * Records, before it is handed on, the hop of a reply a worker's mailbox takes under `messageId`; it is kept as being
	 * handed on until `replyLeft`.
	 */
	replyHanded(reply: Omit<ReplyTurn, "attemptId">): void {
		this.handing.add(reply.messageId);
		this.change((state) => {
			const held = state.replies.find((entry) => entry.messageId === reply.messageId);
			if (held?.hop === reply.hop && held.worker === reply.worker) return state;
			const others = state.replies.filter((entry) => entry.messageId !== reply.messageId);
			return {
				...state,
				replies: [...others, { ...reply, ...(held?.attemptId ? { attemptId: held.attemptId } : {}) }],
			};
		});
	}

	/**
	 * The attempt `attemptId` of `worker` read the mailbox messages `messageIds` into its turn: each reply among them
	 * continues its chain in that turn and is kept while that attempt runs. A message read again by a later attempt (the
	 * first ended before it was marked delivered) moves to that attempt.
	 */
	messagesRead(worker: string, attemptId: string, messageIds: readonly string[]): void {
		const read = (entry: ReplyTurn) => entry.worker === worker && messageIds.includes(entry.messageId);
		if (!this.state().replies.some((entry) => read(entry) && entry.attemptId !== attemptId)) return;
		this.change((state) => ({
			...state,
			replies: state.replies.map((entry) => (read(entry) ? { ...entry, attemptId } : entry)),
		}));
	}

	/** The reply `messageId` reached no worker turn (its worker ended): no turn continues its chain. */
	replyDropped(messageId: string): void {
		this.change((state) => ({ ...state, replies: state.replies.filter((entry) => entry.messageId !== messageId) }));
	}

	/**
	 * The hand-on of the reply `messageId` returned, taken or not: its hop is kept from now on only while a turn of the
	 * worker can read it (`replyTurnOver`), so a reply the mailbox did not take is released here.
	 */
	replyLeft(messageId: string): void {
		if (!this.handing.delete(messageId)) return;
		this.change((state) => state);
	}

	private state(): WorkerMailState {
		const sessionId = this.deps.sessionId();
		if (this.loaded?.sessionId !== sessionId) this.loaded = this.load(sessionId);
		return this.loaded.state;
	}

	private load(sessionId: string): { readonly sessionId: string; writable: boolean; state: WorkerMailState } {
		const sessionFile = this.deps.sessionFile();
		const path = sessionFile === undefined ? undefined : workerMailLedgerPath(sessionFile);
		let text: string | undefined;
		try {
			text = path === undefined ? undefined : readFileSync(path, "utf8");
		} catch (error) {
			// A file that is there but does not read (its permissions, a directory at its path) is left as it is and never
			// overwritten, as one that cannot be set aside: this build's record is kept in memory, told once, and no worker
			// turn that admits a message fails on it.
			if (path !== undefined && !isMissingFileError(error)) {
				this.deps.warn(interfaceText().botTeam.workerMailLedgerUnreadable(path, undefined, String(error)));
				return { sessionId, writable: false, state: EMPTY };
			}
		}
		if (path === undefined || text === undefined) return { sessionId, writable: true, state: EMPTY };
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			value = undefined;
		}
		if (isPlainRecord(value) && typeof value.version === "number" && value.version > WORKER_MAIL_LEDGER_VERSION) {
			this.deps.warn(interfaceText().botTeam.workerMailLedgerNewer(path));
			return { sessionId, writable: false, state: EMPTY };
		}
		const state = parseState(value, sessionId);
		if (state) return { sessionId, writable: true, state };
		const aside = `${path}.unreadable-${this.deps.now()}`;
		try {
			renameSync(path, aside);
		} catch (error) {
			// The unreadable file stays where it is, never overwritten; this build's record is kept in memory.
			this.deps.warn(interfaceText().botTeam.workerMailLedgerUnreadable(path, undefined, String(error)));
			return { sessionId, writable: false, state: EMPTY };
		}
		this.deps.warn(interfaceText().botTeam.workerMailLedgerUnreadable(path, aside));
		return { sessionId, writable: true, state: EMPTY };
	}

	/**
	 * Takes the next state once written, the replies whose turn is over left out (one being handed on is kept); nothing is
	 * written for no change.
	 */
	private change(next: (state: WorkerMailState) => WorkerMailState): void {
		const current = this.state();
		const proposed = next(current);
		const state = {
			...proposed,
			replies: proposed.replies.filter(
				(reply) => this.handing.has(reply.messageId) || !this.deps.replyTurnOver(reply),
			),
		};
		if (JSON.stringify(state) === JSON.stringify(current)) return;
		const loaded = this.loaded;
		const sessionFile = loaded?.writable ? this.deps.sessionFile() : undefined;
		if (sessionFile !== undefined)
			writeFileAtomicSync(
				workerMailLedgerPath(sessionFile),
				`${JSON.stringify({ version: WORKER_MAIL_LEDGER_VERSION, sessionId: this.deps.sessionId(), ...state })}\n`,
			);
		if (loaded) loaded.state = state;
		for (const listener of [...this.listeners]) listener();
	}
}
