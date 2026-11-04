import { createHash } from "node:crypto";
import { LEDGER_RULES } from "./ledger-rules.ts";

/**
 * The rule ledger: standing rules kept out of the always-on system prompt and read in full, on demand,
 * through `ledger_read`. The prompt carries only an index (topic, id, trigger).
 *
 * An entry's id is derived from its content, so it can never describe a version other than the one the
 * model read: `<topic>@<first 8 hex of sha256(body)>`. Ids, not file paths, are what a later
 * verification anchors on. The rules are product constants (`ledger-rules.ts`), so the prompt build has no
 * filesystem dependency.
 */

/** The tool that carries the ledger. A prompt shows the index only while this tool is active. */
export const LEDGER_READ_TOOL_NAME = "ledger_read";

/** A rule must fit one tool result whole; a larger rule is split into smaller topics instead. */
export const MAX_LEDGER_ENTRY_CHARS = 4096;
const TOPIC_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_WHEN_CHARS = 120;

export interface LedgerRuleSource {
	readonly topic: string;
	/** The situation that makes the rule apply; rendered in the prompt index. */
	readonly when: string;
	/** Tool that must be active for the rule to apply; the entry is omitted from the index otherwise. */
	readonly requires?: string;
	/** Tools whose calls this rule governs; the host blocks such a call until the rule is in context. */
	readonly gates?: readonly string[];
	readonly body: string;
}

export interface LedgerEntry extends LedgerRuleSource {
	readonly id: string;
}

export function ledgerEntryId(topic: string, body: string): string {
	return `${topic}@${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 8)}`;
}

/** Validates one rule; an invalid constant is a programming error and fails the first prompt build loudly. */
export function buildLedgerEntry(source: LedgerRuleSource): LedgerEntry {
	const { topic, when, requires, gates } = source;
	if (!TOPIC_PATTERN.test(topic)) throw new Error(`Ledger topic ${topic} must be kebab-case.`);
	if (when.length === 0 || when.length > MAX_WHEN_CHARS) {
		throw new Error(`Ledger topic ${topic} needs a when trigger of at most ${MAX_WHEN_CHARS} characters.`);
	}
	if (requires !== undefined && !TOOL_PATTERN.test(requires)) {
		throw new Error(`Ledger topic ${topic} has an invalid requires tool name.`);
	}
	if (gates?.some((tool) => !TOOL_PATTERN.test(tool))) {
		throw new Error(`Ledger topic ${topic} has an invalid gates tool name.`);
	}
	if (gates && new Set(gates).size !== gates.length) {
		throw new Error(`Ledger topic ${topic} lists a gated tool more than once.`);
	}
	const body = source.body.replace(/\r\n?/g, "\n").trim();
	if (body.length === 0) throw new Error(`Ledger topic ${topic} has no body.`);
	if (body.length > MAX_LEDGER_ENTRY_CHARS) {
		throw new Error(
			`Ledger topic ${topic} is ${body.length} characters; the limit is ${MAX_LEDGER_ENTRY_CHARS}. Split it into smaller topics.`,
		);
	}
	return {
		topic,
		when,
		body,
		id: ledgerEntryId(topic, body),
		...(requires ? { requires } : {}),
		...(gates?.length ? { gates } : {}),
	};
}

let catalog: readonly LedgerEntry[] | undefined;

/** Every rule, sorted by topic and validated once. */
export function loadLedgerCatalog(): readonly LedgerEntry[] {
	if (catalog) return catalog;
	const entries = LEDGER_RULES.map(buildLedgerEntry).sort((left, right) => left.topic.localeCompare(right.topic));
	if (new Set(entries.map((entry) => entry.topic)).size !== entries.length) {
		throw new Error("Ledger topics must be unique.");
	}
	const gatedBy = new Map<string, string>();
	for (const entry of entries) {
		for (const tool of entry.gates ?? []) {
			const owner = gatedBy.get(tool);
			if (owner) throw new Error(`Ledger tool ${tool} is gated by both ${owner} and ${entry.topic}.`);
			gatedBy.set(tool, entry.topic);
		}
	}
	catalog = entries;
	return entries;
}

export function findLedgerEntry(topic: string): LedgerEntry | undefined {
	return loadLedgerCatalog().find((entry) => entry.topic === topic);
}

/** The rule that governs calls to `toolName`, if any. */
export function ledgerEntryGating(toolName: string): LedgerEntry | undefined {
	return loadLedgerCatalog().find((entry) => entry.gates?.includes(toolName));
}

export function requireLedgerEntry(topic: string): LedgerEntry {
	const entry = findLedgerEntry(topic);
	if (!entry) throw new Error(`Ledger topic ${topic} does not exist.`);
	return entry;
}

/** The exact text `ledger_read` returns: the id line, then the whole rule. */
export function formatLedgerEntry(entry: LedgerEntry): string {
	return `LEDGER-ID: ${entry.id}\n\n${entry.body}`;
}

/** The prompt index for the given entries. Empty when none apply. */
export function renderLedgerIndex(entries: readonly LedgerEntry[]): string | undefined {
	if (entries.length === 0) return undefined;
	const lines = entries.map((entry) => `- ${entry.id}: ${entry.when}`);
	return `LEDGER: when a trigger applies, read the whole rule first with ledger_read(topic) and cite its id in the action it governs.\n${lines.join("\n")}`;
}
