/**
 * A bot's home, `<agentDir>/bots/<id>/`: `profile.json` (what defines the bot) and `sessions/` (its own root session
 * files). Its memory blackboard is the store's (`memory/bots/<id>.md`), whichever path the bot runs on. The store record (`state/bots/store.json`) stays the index and the source of truth: the profile is
 * written from it, whole and atomically, the first time the bot runs as a session and again whenever the record's
 * defining fields changed. This module is the profile's one writer, and it writes only when the content differs, so a
 * store save that touches the record's summary or read marks never rewrites the file.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { botHomeDir, botProfileFile, botSessionsDir } from "../agent-paths.ts";
import type { PersistentBotRecord } from "../delegation/persistent-bot-team-store.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";

/** What a bot's record defines, as `profile.json` holds it. */
export interface BotProfile {
	readonly version: 1;
	readonly agentId: string;
	readonly displayName: string;
	readonly description?: string;
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: string;
	/** The bot's standing instructions: they open its system prompt. */
	readonly soul?: string;
	/** Whether the bot may edit files. The record keeps no narrower write scope: a writing bot writes in its working directory. */
	readonly canWrite: boolean;
	readonly createdBy?: string;
}

/** The profile a record defines. */
export function botProfileOf(record: PersistentBotRecord): BotProfile {
	return {
		version: 1,
		agentId: record.agentId,
		displayName: record.displayName,
		...(record.description ? { description: record.description } : {}),
		provider: record.provider,
		modelId: record.modelId,
		...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
		...(record.soul ? { soul: record.soul } : {}),
		canWrite: record.canWrite === true,
		...(record.createdBy ? { createdBy: record.createdBy } : {}),
	};
}

/** The paths of one bot's home. */
export interface BotHome {
	readonly dir: string;
	readonly profileFile: string;
	readonly sessionsDir: string;
}

export function botHomeOf(agentDir: string, botId: string): BotHome {
	return {
		dir: botHomeDir(agentDir, botId),
		profileFile: botProfileFile(agentDir, botId),
		sessionsDir: botSessionsDir(agentDir, botId),
	};
}

/** The text the profile file holds: the same profile always gives the same text, so a rewrite is detectable by comparison. */
function profileText(profile: BotProfile): string {
	return `${JSON.stringify(profile, null, 1)}\n`;
}

/**
 * Creates the home of the bot `record` names (its directories) and brings its profile up to date with the record.
 * Returns the home and the profile as written.
 */
export function ensureBotHome(agentDir: string, record: PersistentBotRecord): { home: BotHome; profile: BotProfile } {
	const home = botHomeOf(agentDir, record.agentId);
	mkdirSync(home.sessionsDir, { recursive: true });
	const profile = botProfileOf(record);
	const text = profileText(profile);
	if (!existsSync(home.profileFile) || readFileSync(home.profileFile, "utf8") !== text)
		writeFileAtomicSync(home.profileFile, text, { mode: 0o600 });
	return { home, profile };
}
