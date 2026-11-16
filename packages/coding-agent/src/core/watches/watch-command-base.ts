/**
 * The environment a watched command starts from (`watchCommandEnvironment`): the few variables it inherits, enough to
 * find programs and format text, never a credential. A root session records its own for its directory as it starts
 * (`recordWatchCommandBase`: `state/watches/base/<directory key>.json`, the last writer wins), and the bot daemon starts
 * a bot's command watch from the record of the bot's directory (`readWatchCommandBase`), so the command sees the PATH and
 * locale the owner's sessions there see, not the daemon's own; with no record it starts from the daemon's. Builds up to
 * 0.104.65 neither write nor read these records.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stateFile } from "../../kernel/storage/paths.ts";
import { realPathIdentity } from "../autonomy/path-scope.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** The variables a watched command inherits: enough to find programs and format text, no credentials. */
const WATCH_COMMAND_KEEP = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"TZ",
	"TERM",
	"SHELL",
	"SYSTEMROOT",
	"COMSPEC",
	"PATHEXT",
] as const;

/** The kept variables of `source` (the process's own environment by default), each a string. */
export function watchCommandEnvironment(source: Readonly<Record<string, unknown>> = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of WATCH_COMMAND_KEEP) {
		const value = source[key];
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

/** `<agentDir>/state/watches/base/<key>.json`: one record per directory (`realPathIdentity`), named by its hash. */
function watchCommandBaseFile(agentDir: string, cwd: string): string {
	const key = createHash("sha256").update(realPathIdentity(cwd)).digest("hex").slice(0, 32);
	return stateFile(agentDir, "watches", "base", `${key}.json`);
}

/**
 * Records this process's watched-command environment for `cwd`, replacing any earlier record of that directory. Returns
 * why it could not be written (the earlier record, if any, stays), undefined once written.
 */
export function recordWatchCommandBase(agentDir: string, cwd: string): string | undefined {
	const record = { version: 1, cwd: realPathIdentity(cwd), env: watchCommandEnvironment() };
	try {
		writeFileAtomicSync(watchCommandBaseFile(agentDir, cwd), `${JSON.stringify(record, null, 1)}\n`, { mode: 0o600 });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * The environment a root session last recorded for `cwd`, kept to the watched-command variables; undefined when none
 * did. Throws when the record exists and does not read as one.
 */
export function readWatchCommandBase(agentDir: string, cwd: string): NodeJS.ProcessEnv | undefined {
	const file = watchCommandBaseFile(agentDir, cwd);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.env))
		throw new Error(`${file} is not a record of the environment watched commands start from.`);
	return watchCommandEnvironment(value.env);
}
