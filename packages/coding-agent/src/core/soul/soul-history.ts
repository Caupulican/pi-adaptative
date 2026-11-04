import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { soulHistoryFile, soulVersionsDir } from "../agent-paths.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";

/** Entries kept; an older entry and any version text no kept entry names are removed. */
export const SOUL_HISTORY_LIMIT = 20;

export type SoulAuthor = "owner" | "agent";
export type SoulReviewer = "allow" | "block" | "unreviewed";
/**
 * Typed entries for a change the harness reverted: `reverted` (an ungated write that failed the screen or the review
 * was undone) and `removed` (the file was deleted outside the gate and put back); both carry the restored text.
 * `unresolved`: a verdict on a change could not be committed because the soul lock stayed held elsewhere, and the
 * change was adopted without it.
 */
export type SoulHistoryEvent = "reverted" | "removed" | "unresolved";

/**
 * One write to `soul.md`. `sha256` and `bytes` identify the exact text the write put (or tried to put) in the file;
 * `versions/<sha256>.md` keeps that text whole, which is what `restore` writes back. A blocked write keeps no text:
 * it is the record that the attempt happened, not a version. `reviewer` is the System One verdict on the write
 * (`unreviewed` for an owner write, for an agent write no review judged, and for the baseline entry).
 */
export interface SoulHistoryEntry {
	readonly at: string;
	readonly sha256: string;
	readonly author: SoulAuthor;
	readonly reviewer: SoulReviewer;
	readonly bytes: number;
	readonly event?: SoulHistoryEvent;
}

/** Whether the entry's text is kept in `versions/`: every entry but a blocked attempt, which is only a record. */
export function entryKeepsText(entry: SoulHistoryEntry): boolean {
	return entry.reviewer !== "block" || entry.event !== undefined;
}

export function soulSha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function isEntry(value: unknown): value is SoulHistoryEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.at === "string" &&
		typeof entry.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(entry.sha256) &&
		(entry.author === "owner" || entry.author === "agent") &&
		(entry.reviewer === "allow" || entry.reviewer === "block" || entry.reviewer === "unreviewed") &&
		typeof entry.bytes === "number" &&
		(entry.event === undefined ||
			entry.event === "reverted" ||
			entry.event === "removed" ||
			entry.event === "unresolved")
	);
}

/**
 * The append-only record of `soul.md` writes under `<agentDir>/state/soul`. Each entry is one JSON line, and the file is
 * bounded to the last {@link SOUL_HISTORY_LIMIT} entries by rewriting it atomically after an append that passes the bound.
 */
export class SoulHistory {
	private readonly historyFile: string;
	private readonly versionsDir: string;

	constructor(agentDir: string) {
		this.historyFile = soulHistoryFile(agentDir);
		this.versionsDir = soulVersionsDir(agentDir);
	}

	/** The entries, oldest first. A line that is not an entry is skipped rather than hiding the rest. */
	list(): SoulHistoryEntry[] {
		if (!existsSync(this.historyFile)) return [];
		const entries: SoulHistoryEntry[] = [];
		for (const line of readFileSync(this.historyFile, "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isEntry(parsed)) entries.push(parsed);
			} catch {
				// A torn or foreign line is not an entry.
			}
		}
		return entries;
	}

	/** The text of one version, when it was kept. */
	readVersion(sha256: string): string | undefined {
		const file = join(this.versionsDir, `${sha256}.md`);
		return existsSync(file) ? readFileSync(file, "utf8") : undefined;
	}

	/** Stores a text whole under its hash (idempotent) and returns the hash; a revert keeps what it restores before it restores. */
	keep(text: string): string {
		const sha256 = soulSha256(text);
		const file = join(this.versionsDir, `${sha256}.md`);
		if (!existsSync(file)) writeFileAtomicSync(file, text);
		return sha256;
	}

	/**
	 * Records one write of `text`, the exact content of the document after it. A kept text is stored whole by its hash.
	 * `standing` is what the file holds right now: when no kept version has that text (the owner or a shell wrote it,
	 * outside the history), it is recorded first as an `owner` baseline so a restore can bring it back.
	 */
	record(input: {
		text: string;
		keepText: boolean;
		standing: string | undefined;
		author: SoulAuthor;
		reviewer: SoulReviewer;
		event?: SoulHistoryEvent;
		now?: Date;
	}): void {
		const now = input.now ?? new Date();
		const entries = this.list();
		if (input.standing !== undefined && !this.holdsVersion(entries, soulSha256(input.standing))) {
			entries.push(this.entry(input.standing, "owner", "unreviewed", now, true));
		}
		entries.push(this.entry(input.text, input.author, input.reviewer, now, input.keepText, input.event));
		const kept = entries.slice(-SOUL_HISTORY_LIMIT);
		writeFileAtomicSync(this.historyFile, `${kept.map((item) => JSON.stringify(item)).join("\n")}\n`);
		this.removeUnreferencedVersions(kept);
	}

	private holdsVersion(entries: readonly SoulHistoryEntry[], sha256: string): boolean {
		return entries.some((entry) => entry.sha256 === sha256 && entryKeepsText(entry));
	}

	private entry(
		text: string,
		author: SoulAuthor,
		reviewer: SoulReviewer,
		at: Date,
		keepText: boolean,
		event?: SoulHistoryEvent,
	): SoulHistoryEntry {
		const sha256 = soulSha256(text);
		if (keepText) {
			const file = join(this.versionsDir, `${sha256}.md`);
			if (!existsSync(file)) writeFileAtomicSync(file, text);
		}
		return {
			at: at.toISOString(),
			sha256,
			author,
			reviewer,
			bytes: Buffer.byteLength(text, "utf8"),
			...(event ? { event } : {}),
		};
	}

	private removeUnreferencedVersions(kept: readonly SoulHistoryEntry[]): void {
		if (!existsSync(this.versionsDir)) return;
		const referenced = new Set(kept.map((entry) => `${entry.sha256}.md`));
		for (const name of readdirSync(this.versionsDir)) {
			if (name.endsWith(".md") && !referenced.has(name)) unlinkSync(join(this.versionsDir, name));
		}
	}
}
