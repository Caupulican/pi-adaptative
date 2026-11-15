/**
 * A bot's home, `<agentDir>/bots/<id>/`: `profile.json` (what defines the bot), `sessions/` (its own root session
 * files), `session.json` (the pointer to the one it keeps its conversation in, `bot-session-pointer.ts`) and
 * `orchestration/` (the orchestration home of its sessions: their bundles, leases and specialists). Its memory blackboard is the store's (`memory/bots/<id>.md`), whichever path the bot runs on. The store record (`state/bots/store.json`) stays the index and the source of truth: the profile is
 * written from it, whole and atomically, the first time the bot runs as a session and again whenever the record's
 * defining fields changed. This module is the profile's one writer, and it writes only when the content differs, so a
 * store save that touches the record's summary or read marks never rewrites the file.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	botHomeOrchestrationHome,
	type OrchestrationHome,
	ownerOrchestrationHome,
	sameOrchestrationHome,
} from "../../kernel/session/session-bundle-paths.ts";
import { readSessionHeaderResult } from "../../kernel/session/session-header.ts";
import {
	botHomeDir,
	botHomeLegacySystemOneEvidenceDir,
	botHomeProfileFile,
	botHomeSessionsDir,
	botHomeSpendLedgerFile,
} from "../agent-paths.ts";
import type { PersistentBotRecord } from "../delegation/persistent-bot-team-store.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { type BotSessionLinks, botFileReadPath } from "./bot-session-pointer.ts";

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
	/** `<home>/session.json` -- which of its session files the bot keeps its conversation in (`BotSessionPointer`). */
	readonly pointerFile: string;
	/** `<home>/orchestration` -- where the bundles and leases of the bot's sessions and their workers live. */
	readonly orchestrationHome: OrchestrationHome;
	/** `<home>/spend.json` -- the bot's spend ledger: its charge watermark and spend windows (`BotSpendLedger`). */
	readonly spendFile: string;
}

export function botHomeOf(agentDir: string, botId: string): BotHome {
	return botHomeAt(botHomeDir(agentDir, botId));
}

/** The paths of the bot home whose directory is `dir` (`<agentDir>/bots/<name>`). */
export function botHomeAt(dir: string): BotHome {
	return {
		dir,
		profileFile: botHomeProfileFile(dir),
		sessionsDir: botHomeSessionsDir(dir),
		pointerFile: join(dir, "session.json"),
		orchestrationHome: botHomeOrchestrationHome(dir),
		spendFile: botHomeSpendLedgerFile(dir),
	};
}

/**
 * The ids of the sessions a bot home's `sessions/` directory holds, by their files' headers: a file whose header does not
 * read names none, and a home whose sessions never ran holds none. A session file that is a symbolic link is refused or
 * read through, as `links` says (`BotSessionLinks`: a read for the session's writer refuses it).
 */
export function botHomeSessionIds(sessionsDir: string, links: BotSessionLinks): string[] {
	return sessionFiles(sessionsDir).flatMap((path) => sessionIdIn(botFileReadPath(path, links)));
}

/**
 * The ids of the sessions a bot home's `sessions/` directory holds as files of its own, as {@link botHomeSessionIds}
 * reads them, for ending the work they placed: a session file that is a symbolic link is not read but returned in
 * `linked` (what it names is not the bot's work to end, and it holds no end of the rest back).
 */
export function botHomeOwnSessionIds(sessionsDir: string): { readonly ids: string[]; readonly linked: string[] } {
	const ids: string[] = [];
	const linked: string[] = [];
	for (const path of sessionFiles(sessionsDir))
		if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) linked.push(path);
		else ids.push(...sessionIdIn(path));
	return { ids, linked };
}

/** The session files a home's `sessions/` directory holds (its `.jsonl` entries); none when it does not exist. */
function sessionFiles(sessionsDir: string): string[] {
	if (!existsSync(sessionsDir)) return [];
	return readdirSync(sessionsDir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(sessionsDir, name));
}

/** The id the session file at `path` names in its header; none when the header does not read. */
function sessionIdIn(path: string): string[] {
	const header = readSessionHeaderResult(path);
	return header.ok ? [header.header.id] : [];
}

/**
 * Where an earlier build kept the System One evidence of a bot's own sessions, for a session whose orchestration home is
 * `home`: the bot's home directory's `typesafe-reviews` when `home` is a bot's, read after the session's bundle so
 * evidence the earlier build wrote stays readable; undefined for a session of the owner's home.
 * @deprecated Reads evidence an earlier build kept outside the session's bundle; replaced by the bundle's typesafe-reviews. Remove with botHomeLegacySystemOneEvidenceDir.
 */
export function legacyBotSystemOneEvidenceDir(agentDir: string, home: OrchestrationHome): string | undefined {
	if (sameOrchestrationHome(home, ownerOrchestrationHome(agentDir))) return undefined;
	return botHomeLegacySystemOneEvidenceDir(dirname(home.root));
}

/** `<agentDir>/bots/<id>/orchestration` -- the orchestration home of the bot's sessions. */
export function botOrchestrationHome(agentDir: string, botId: string): OrchestrationHome {
	return botHomeOf(agentDir, botId).orchestrationHome;
}

/**
 * The display name the home's profile gives the bot; undefined when the home has no profile, or one that does not read
 * as a profile (the home is then named by its directory). Only names the bot to the owner; nothing is decided by it.
 */
export function readBotProfileDisplayName(home: BotHome): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(home.profileFile, "utf8"));
	} catch (error) {
		if (!isMissingFileError(error)) harnessLog.warn("bots", "a bot's profile does not read", { home: home.dir });
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { version, displayName } = value as Record<string, unknown>;
	return version === 1 && typeof displayName === "string" && displayName.trim() !== "" ? displayName : undefined;
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
