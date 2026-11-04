import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getLedgerDir } from "../../config.ts";

/**
 * The rule ledger: standing rules kept out of the always-on system prompt and read in full, on demand,
 * through `ledger_read`. The prompt carries only an index (topic, id, trigger).
 *
 * An entry's id is derived from its content, so it can never describe a version other than the one the
 * model read: `<topic>@<first 8 hex of sha256(body)>`. Ids, not file paths, are what a later
 * verification anchors on.
 */

/** A rule must fit one tool result whole; a larger rule is split into smaller topics instead. */
export const MAX_LEDGER_ENTRY_CHARS = 4096;
/** The tool that carries the ledger. A prompt shows the index only while this tool is active. */
export const LEDGER_READ_TOOL_NAME = "ledger_read";

const TOPIC_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_WHEN_CHARS = 120;

export interface LedgerEntry {
	readonly topic: string;
	/** The situation that makes the rule apply; rendered in the prompt index. */
	readonly when: string;
	readonly body: string;
	readonly id: string;
	/** Tool that must be active for the rule to apply; the entry is omitted from the index otherwise. */
	readonly requires?: string;
}

export function ledgerEntryId(topic: string, body: string): string {
	return `${topic}@${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 8)}`;
}

/** Parses `---\ntopic: x\nwhen: y\n---\nbody`; the topic must equal the file name stem. */
export function parseLedgerFile(fileName: string, raw: string): LedgerEntry {
	const text = raw.replace(/\r\n?/g, "\n");
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
	if (!match) throw new Error(`Ledger file ${fileName} must start with a --- front matter block.`);
	const fields = new Map<string, string>();
	for (const line of match[1].split("\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) throw new Error(`Ledger file ${fileName} has an invalid front matter line: ${line}`);
		fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
	}
	const topic = fields.get("topic");
	const when = fields.get("when");
	if (!topic || !TOPIC_PATTERN.test(topic)) throw new Error(`Ledger file ${fileName} needs a kebab-case topic.`);
	if (topic !== basename(fileName, ".md")) {
		throw new Error(`Ledger file ${fileName} declares topic ${topic}; the file name must match.`);
	}
	if (!when || when.length > MAX_WHEN_CHARS) {
		throw new Error(`Ledger file ${fileName} needs a when trigger of at most ${MAX_WHEN_CHARS} characters.`);
	}
	const requires = fields.get("requires");
	if (requires !== undefined && !/^[a-z][a-z0-9_]*$/.test(requires)) {
		throw new Error(`Ledger file ${fileName} has an invalid requires tool name.`);
	}
	const body = match[2].trim();
	if (body.length === 0) throw new Error(`Ledger file ${fileName} has no body.`);
	if (body.length > MAX_LEDGER_ENTRY_CHARS) {
		throw new Error(
			`Ledger file ${fileName} is ${body.length} characters; the limit is ${MAX_LEDGER_ENTRY_CHARS}. Split it into smaller topics.`,
		);
	}
	return { topic, when, body, id: ledgerEntryId(topic, body), ...(requires ? { requires } : {}) };
}

const catalogs = new Map<string, readonly LedgerEntry[]>();

/** Loads every rule in `dir`, sorted by topic. A malformed file fails the load loudly; it is never skipped. */
export function loadLedgerCatalog(dir: string = getLedgerDir()): readonly LedgerEntry[] {
	const cached = catalogs.get(dir);
	if (cached) return cached;
	const entries = readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => parseLedgerFile(name, readFileSync(join(dir, name), "utf8")));
	catalogs.set(dir, entries);
	return entries;
}

export function findLedgerEntry(topic: string, dir?: string): LedgerEntry | undefined {
	return loadLedgerCatalog(dir).find((entry) => entry.topic === topic);
}

/** The exact text `ledger_read` returns: the id line, then the whole rule. */
export function formatLedgerEntry(entry: LedgerEntry): string {
	return `LEDGER-ID: ${entry.id}\n\n${entry.body}`;
}

/** The prompt index for the topics whose gate passes. Empty when none apply. */
export function renderLedgerIndex(entries: readonly LedgerEntry[]): string | undefined {
	if (entries.length === 0) return undefined;
	const lines = entries.map((entry) => `- ${entry.id}: ${entry.when}`);
	return `LEDGER: when a trigger applies, read the whole rule first with ledger_read(topic) and cite its id in the action it governs.\n${lines.join("\n")}`;
}
