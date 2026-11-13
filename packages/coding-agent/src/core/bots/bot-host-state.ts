/**
 * What the process hosting a bot's session says that session is doing, for every other process on the agent directory:
 * `bots/<id>/host-state.json`, written by the one process that holds `bots/<id>/host.lock`. A second pi session (or the
 * detached daemon) shows the bot's roster state from it and its conversation from the session files beside it.
 *
 * The file is trusted only while the lock names a live process and the file names that same process: a host that was
 * killed leaves both behind, and the lock's liveness judgement (`judgeOwner`) is what says the state is gone. The host
 * writes only on a change of state and compares the text, so a burst of session events is one write.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import {
	isProcessOwnerRecord,
	type OwnerStanding,
	ownProcessOwner,
	type ProcessOwner,
} from "../../kernel/reliability/owner-identity.ts";
import { botHostLockFile, botHostStateFile } from "../agent-paths.ts";
import { processLockHolder } from "../remote/host-lock.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
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
}

/** The process hosting a bot, as another process sees it. */
export interface RemoteBotHost {
	readonly pid: number;
	readonly standing: OwnerStanding;
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
			typeof value.botSessionId !== "string"
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
		};
	} catch {
		return undefined;
	}
}

/**
 * The process, other than this one, hosting the bot's session now. Undefined when the lock names no live process or
 * names this one: a process answers for its own sessions from memory.
 */
export function readRemoteBotHost(agentDir: string, agentId: string): RemoteBotHost | undefined {
	const holder = processLockHolder(botHostLockFile(agentDir, agentId));
	if (!holder || holder.owner.pid === process.pid) return undefined;
	const file = botHostStateFile(agentDir, agentId);
	const written = existsSync(file) ? parseState(readFileSync(file, "utf8")) : undefined;
	// A file another process wrote earlier (its host is gone, a new one has not published yet) says nothing of this host.
	const own = written?.owner.pid === holder.owner.pid && written.agentId === agentId ? written : undefined;
	return {
		pid: holder.owner.pid,
		standing: holder.standing,
		state: own?.state,
		hostKind: own?.hostKind,
		hostSessionId: own?.hostSessionId,
	};
}

/** The one writer of a bot's `host-state.json`: the process holding the bot's lock. */
export class BotHostStateWriter {
	private readonly file: string;
	private readonly base: Omit<BotHostState, "state">;
	private lastText: string | undefined;

	constructor(
		agentDir: string,
		base: { agentId: string; hostKind: BotHostKind; hostSessionId?: string; botSessionId: string },
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
