/**
 * The root sessions that host bots in live processes: `state/bots/root-hosts/<id>.json`, one per root session attached
 * to its process's bot session host once it opened the bots owed work (`BotSessionAttachment.hostOwed`), removed as it
 * detaches. The bot daemon reads them (`readBotRootHostPlaces`): a bot working in a root's directory is that root's to
 * open, so the daemon opens none there and closes an idle one it hosts, which the root then opens for what it is owed.
 * A record whose process is proven gone on this machine is removed by the reader; one whose process cannot be judged
 * alive (another system's, an unreadable record) is not counted. Builds up to 0.104.65 write none: the daemon keeps
 * hosting while one of their roots is open, and that root's messages reach the bot through its inbox, as they reach any
 * host in another process.
 */

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	isOwnerProvenDeadOnThisMachine,
	isProcessOwnerRecord,
	judgeOwner,
	ownProcessOwner,
	type ProcessOwner,
} from "../../kernel/reliability/owner-identity.ts";
import { botRootHostsDir } from "../agent-paths.ts";
import { realPathIdentity } from "../autonomy/path-scope.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** One root session hosting bots: its process and the directory it works in. */
interface BotRootHostRecord {
	readonly version: 1;
	readonly owner: ProcessOwner;
	readonly cwd: string;
}

/**
 * Records that a root session working in `cwd` hosts bots in this process; returns the removal, which never throws: it
 * returns why the record could not be removed (undefined once it is gone), and a record left names this process, which
 * the reader removes once the process is gone.
 */
export function publishBotRootHost(agentDir: string, cwd: string): () => unknown {
	const file = join(botRootHostsDir(agentDir), `${randomBytes(8).toString("hex")}.json`);
	const record: BotRootHostRecord = { version: 1, owner: ownProcessOwner(), cwd };
	writeFileAtomicSync(file, `${JSON.stringify(record, null, 1)}\n`, { mode: 0o600 });
	return () => {
		try {
			rmSync(file, { force: true });
			return undefined;
		} catch (error) {
			return error;
		}
	};
}

function readRecord(file: string): BotRootHostRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// Removed since it was listed, or not written whole: it names no live root.
		return undefined;
	}
	return isPlainRecord(value) &&
		value.version === 1 &&
		isProcessOwnerRecord(value.owner) &&
		typeof value.cwd === "string"
		? { version: 1, owner: value.owner, cwd: value.cwd }
		: undefined;
}

/**
 * The directories (`realPathIdentity`) live root sessions host bots in, read now; records of processes proven gone are
 * removed. Throws when the directory exists and cannot be listed.
 */
export function readBotRootHostPlaces(agentDir: string): Set<string> {
	const dir = botRootHostsDir(agentDir);
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if (isMissingFileError(error)) return new Set();
		throw error;
	}
	const places = new Set<string>();
	for (const name of names) {
		const file = join(dir, name);
		const record = readRecord(file);
		if (!record) continue;
		if (judgeOwner(record.owner) === "alive") places.add(realPathIdentity(record.cwd));
		else if (isOwnerProvenDeadOnThisMachine(record.owner)) rmSync(file, { force: true });
	}
	return places;
}
