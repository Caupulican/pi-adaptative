/**
 * What the process hosting a bot's session says that session is doing, for every other process on the agent directory:
 * `bots/<id>/host-state.json`, written by the one process that holds `bots/<id>/host.lock`. A second pi session (or the
 * detached daemon) shows the bot's roster state from it and its conversation from the session files beside it.
 *
 * The file is trusted only while the lock names a live process and the file names that same process: a host that was
 * killed leaves both behind, and the lock's liveness judgement (`judgeOwner`) is what says the state is gone. The host
 * writes only on a change of state and compares the text, so a burst of session events is one write.
 */

import { readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import {
	isProcessOwnerRecord,
	type OwnerStanding,
	ownProcessOwner,
	type ProcessOwner,
} from "../../kernel/reliability/owner-identity.ts";
import {
	botHomeDir,
	botHomeHostLockFile,
	botHomeHostStateFile,
	botHomeName,
	botHostStateFile,
} from "../agent-paths.ts";
import { processLockHolder } from "../remote/host-lock.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** What a loaded bot session is doing; a bot with no loaded session has no state. */
export type BotSessionState = "running" | "queued" | "idle";

const STATES: readonly string[] = ["running", "queued", "idle"];

/** What kind of process hosts the session: a pi session today; the detached daemon takes the same lock when it hosts bots. */
export type BotHostKind = "session" | "daemon";

/** The persisted state: who hosts the session and what it is doing. */
export interface BotHostState {
	readonly version: 1;
	readonly agentId: string;
	readonly state: BotSessionState;
	readonly owner: ProcessOwner;
	readonly hostKind: BotHostKind;
	/** The pi session of the hosting process, for naming it to the owner; absent when the host is not a session. */
	readonly hostSessionId?: string;
	/** The bot's own session id. */
	readonly botSessionId: string;
	/** The host inside its process that holds the lock (`HostLockRecord.holder`): the file speaks for that host only. */
	readonly holder: string;
}

/** The process hosting a bot, as another process sees it. */
export interface RemoteBotHost {
	readonly pid: number;
	/** The process as its lock names it: judged again to tell a host that was killed, which publishes nothing. */
	readonly owner: ProcessOwner;
	readonly standing: OwnerStanding;
	/** The hold's token (`processLockHolder`): a new hold of the lock, even by the same host, has a new one. */
	readonly lockToken: string;
	/** What the host says its session is doing; undefined while the host has not written it yet. */
	readonly state: BotSessionState | undefined;
	readonly hostKind: BotHostKind | undefined;
	readonly hostSessionId: string | undefined;
}

function parseState(text: string): BotHostState | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (
			!isPlainRecord(value) ||
			value.version !== 1 ||
			typeof value.agentId !== "string" ||
			typeof value.state !== "string" ||
			!STATES.includes(value.state) ||
			!isProcessOwnerRecord(value.owner) ||
			(value.hostKind !== "session" && value.hostKind !== "daemon") ||
			(value.hostSessionId !== undefined && typeof value.hostSessionId !== "string") ||
			typeof value.botSessionId !== "string" ||
			typeof value.holder !== "string"
		)
			return undefined;
		return {
			version: 1,
			agentId: value.agentId,
			state: value.state as BotSessionState,
			owner: value.owner,
			hostKind: value.hostKind,
			...(value.hostSessionId !== undefined ? { hostSessionId: value.hostSessionId } : {}),
			botSessionId: value.botSessionId,
			holder: value.holder,
		};
	} catch {
		return undefined;
	}
}

type LockHolder = NonNullable<ReturnType<typeof processLockHolder>>;

/**
 * The state the lock's live `holder` published in the bot home `homeDir`, for a bot `isBot` accepts; undefined while it
 * has published none. A file another host wrote earlier (it is gone, a new one has not published yet) says nothing of
 * this host.
 */
function publishedState(
	homeDir: string,
	holder: LockHolder,
	isBot: (agentId: string) => boolean,
): BotHostState | undefined {
	const text = stateText(botHomeHostStateFile(homeDir));
	const written = text === undefined ? undefined : parseState(text);
	return written?.owner.pid === holder.owner.pid && written.holder === holder.holder && isBot(written.agentId)
		? written
		: undefined;
}

/**
 * The host, other than `ownHolder`, hosting the bot's session now: in another process, or another host in this one.
 * Undefined when the lock names no live process or names `ownHolder`: a host answers for its own sessions from memory.
 */
export function readRemoteBotHost(agentDir: string, agentId: string, ownHolder: string): RemoteBotHost | undefined {
	const homeDir = botHomeDir(agentDir, agentId);
	const holder = processLockHolder(botHomeHostLockFile(homeDir));
	if (!holder || holder.holder === ownHolder) return undefined;
	const own = publishedState(homeDir, holder, (written) => written === agentId);
	return {
		pid: holder.owner.pid,
		owner: holder.owner,
		standing: holder.standing,
		lockToken: holder.token,
		state: own?.state,
		hostKind: own?.hostKind,
		hostSessionId: own?.hostSessionId,
	};
}

/**
 * The text of a host's state file; undefined when there is none. Read without a check first: a closing host deletes the
 * file, so it can go between any check and the read.
 */
function stateText(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
}

/**
 * Whether a live host holds the session of the bot whose home is `homeDir` now, whichever process, and whichever host
 * in it (this process's included), holds the lock; undefined when the lock names no live process (a holder whose
 * standing is foreign or unknown is live: nothing proves it gone). `botSessionId` is the session the host published,
 * undefined while it has published none. Keyed by the home's directory, as the startup retention sweep enumerates the
 * homes (a home whose profile is gone has no bot id to name).
 */
export function readBotHomeHost(homeDir: string): { readonly botSessionId: string | undefined } | undefined {
	const holder = processLockHolder(botHomeHostLockFile(homeDir));
	if (!holder) return undefined;
	const name = basename(homeDir);
	return { botSessionId: publishedState(homeDir, holder, (agentId) => botHomeName(agentId) === name)?.botSessionId };
}

/** The one writer of a bot's `host-state.json`: the process holding the bot's lock. */
export class BotHostStateWriter {
	private readonly file: string;
	private readonly base: Omit<BotHostState, "state">;
	private lastText: string | undefined;

	constructor(
		agentDir: string,
		base: { agentId: string; hostKind: BotHostKind; hostSessionId?: string; botSessionId: string; holder: string },
	) {
		this.file = botHostStateFile(agentDir, base.agentId);
		this.base = { version: 1, owner: ownProcessOwner(), ...base };
	}

	/** Publishes the state; the same state again writes nothing. */
	publish(state: BotSessionState): void {
		const text = `${JSON.stringify({ ...this.base, state }, null, 1)}\n`;
		if (text === this.lastText) return;
		writeFileAtomicSync(this.file, text, { mode: 0o600 });
		this.lastText = text;
	}

	/** The session closed: the file goes with it. */
	clear(): void {
		this.lastText = undefined;
		rmSync(this.file, { force: true });
	}
}
