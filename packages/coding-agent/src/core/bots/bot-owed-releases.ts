/**
 * The owed-release journal: one entry per bot whose session release began and has not finished, written before the change
 * that makes the release owed (a retirement, a record leaving the session path) and removed once the release is done or
 * the bot is back on the session path. It is the debt's durable mark: a host that opens the bots takes up the releases a
 * process left owed when it ended by reading this journal alone (`BotRelease.recoverOwed`), so an empty or missing journal
 * costs one directory read, and only a bot with an entry is read.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { botHomeName, botOwedReleasesDir } from "../agent-paths.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";

/** The journal entry of bot `agentId`, named as its home is (`botHomeName`) and holding the exact id. */
function entryFile(agentDir: string, agentId: string): string {
	return join(botOwedReleasesDir(agentDir), botHomeName(agentId));
}

/** Marks bot `agentId`'s release owed until {@link clearOwedRelease}; a failed write throws. */
export function markOwedRelease(agentDir: string, agentId: string): void {
	writeFileAtomicSync(entryFile(agentDir, agentId), agentId);
}

/** Bot `agentId`'s release is done, or no longer owed: its entry is removed (none is no failure). */
export function clearOwedRelease(agentDir: string, agentId: string): void {
	rmSync(entryFile(agentDir, agentId), { force: true });
}

/** The bots whose release the journal holds owed, by exact id; a journal never written holds none. A failed read throws. */
export function owedReleases(agentDir: string): string[] {
	const dir = botOwedReleasesDir(agentDir);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	// An entry's name has no dot (`botHomeName`); a write's temporary file left by a crash has one and is no entry.
	return names.filter((name) => !name.includes(".")).map((name) => readFileSync(join(dir, name), "utf8"));
}
