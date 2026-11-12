import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../kernel/storage/atomic-file.ts";
import { readFileTailSync } from "../kernel/storage/bounded-file.ts";

const MAX_BYTES = 1024 * 1024;
const MAX_TRANSITIONS = 4_096;
const MAX_TRANSITION_BATCH = 2_049;
/** The journal keeps its newest lines once it grows past this many bytes. */
const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
const JOURNAL_KEPT_LINES = 512;

interface Transition {
	readonly path: string;
	readonly before: string;
	readonly after: string;
	readonly at: number;
}

/** This process's exact host writes (the explanation without a journal). */
const transitions: Transition[] = [];

/** Exact, bounded regular-file identity. Missing and unreadable are deliberately distinct. */
export function hostFileIdentity(path: string): string | undefined {
	let fd: number | undefined;
	try {
		const stat = lstatSync(path, { bigint: true });
		if (!stat.isFile() || stat.size > BigInt(MAX_BYTES)) return undefined;
		fd = openSync(path, "r");
		const signature = (value: typeof stat): string =>
			`${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
		const identity = signature(stat);
		if (signature(fstatSync(fd, { bigint: true })) !== identity) return undefined;
		const buffer = Buffer.alloc(Number(stat.size));
		let offset = 0;
		while (offset < buffer.length) {
			const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
			if (count === 0) return undefined;
			offset += count;
		}
		if (
			signature(fstatSync(fd, { bigint: true })) !== identity ||
			signature(lstatSync(path, { bigint: true })) !== identity
		)
			return undefined;
		return `file:${identity}:${createHash("sha256").update(buffer).digest("hex")}`;
	} catch (error) {
		return fd === undefined && (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Attribution is observational; a close failure must not fail a settings write.
			}
		}
	}
}

/** The bounded identity format used by protected-path fingerprints for files, directories and links. */
export function hostWatchedPathIdentity(path: string): string | undefined {
	try {
		const stat = lstatSync(path, { bigint: true });
		const signature = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
		if (stat.isSymbolicLink()) return `link:${signature}:${Buffer.from(readlinkSync(path)).toString("base64")}`;
		if (stat.isDirectory()) return `dir:${signature}`;
		if (stat.isFile()) return `file:${stat.size}:${signature}`;
		return `other:${signature}`;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : undefined;
	}
}

/**
 * Record an already completed, validated publication as one durable unit. Every after identity is rechecked at commit,
 * so a concurrent later mutation makes the whole batch unavailable for attribution instead of blessing a mixed tree.
 */
export function recordHostPathTransitionBatch(
	entries: readonly { readonly path: string; readonly before: string; readonly after: string }[],
	journal?: string,
): boolean {
	if (entries.length === 0 || entries.length > MAX_TRANSITION_BATCH) return false;
	const at = Date.now();
	const batch: Transition[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const target = resolve(entry.path);
		if (seen.has(target) || entry.before === entry.after || hostWatchedPathIdentity(target) !== entry.after)
			return false;
		seen.add(target);
		batch.push({ path: target, before: entry.before, after: entry.after, at });
	}
	if (journal !== undefined && !appendHostTransitionBatch(journal, batch)) return false;
	transitions.push(...batch);
	if (transitions.length > MAX_TRANSITIONS) transitions.splice(0, transitions.length - MAX_TRANSITIONS);
	return true;
}

/**
 * Attribution observes an already-authorized write; bookkeeping never changes its outcome. With a `journal` the write is
 * also appended to it, so a process that never made this write (another session on the same agent directory) can
 * explain the change the watch sees.
 */
export function withHostFileWrite<T>(path: string, expected: string, write: () => T, journal?: string): T {
	const before = hostFileIdentity(path);
	const result = write();
	try {
		const after = hostFileIdentity(path);
		const digest = createHash("sha256").update(expected).digest("hex");
		if (before !== undefined && after?.endsWith(`:${digest}`)) {
			const transition: Transition = { path: resolve(path), before, after, at: Date.now() };
			transitions.push(transition);
			if (transitions.length > MAX_TRANSITIONS) transitions.shift();
			if (journal !== undefined) appendHostTransitionLine(journal, JSON.stringify(transition));
		}
	} catch {
		// Missing attribution remains visible to the protected-path watch.
	}
	return result;
}

/** Read only complete newest journal lines, even when an older journal exceeds today's bound. */
function hostTransitionLines(journal: string): string[] {
	let tail: ReturnType<typeof readFileTailSync>;
	try {
		tail = readFileTailSync(journal, JOURNAL_MAX_BYTES + 1, "Host transition journal");
	} catch (error) {
		if (isMissingFileError(error)) return [];
		throw error;
	}
	let content = tail.content;
	if (tail.truncated || content.length > JOURNAL_MAX_BYTES) {
		const first = content.indexOf(0x0a);
		if (first < 0) return [];
		content = content.subarray(first + 1);
	}
	const lines: string[] = [];
	let end = content.lastIndexOf(0x0a);
	while (end >= 0 && lines.length < JOURNAL_KEPT_LINES) {
		const previous = end === 0 ? -1 : content.lastIndexOf(0x0a, end - 1);
		const line = content.subarray(previous + 1, end);
		if (line.length > 0) lines.push(line.toString("utf8"));
		end = previous;
	}
	return lines.reverse();
}

/** Both transition formats commit through the same locked, whole-line byte and count bound. */
function appendHostTransitionLine(journal: string, line: string): boolean {
	const lineBytes = Buffer.byteLength(line) + 1;
	if (lineBytes > JOURNAL_MAX_BYTES) return false;
	mkdirSync(dirname(journal), { recursive: true });
	return withFileLockSync(journal, () => {
		const lines = hostTransitionLines(journal);
		lines.push(line);
		let bytes = lines.reduce((sum, value) => sum + Buffer.byteLength(value) + 1, 0);
		let first = 0;
		while (lines.length - first > JOURNAL_KEPT_LINES || bytes > JOURNAL_MAX_BYTES) {
			bytes -= Buffer.byteLength(lines[first]!) + 1;
			first++;
		}
		writeFileAtomicSync(journal, `${lines.slice(first).join("\n")}\n`, { mode: 0o600 });
		return true;
	});
}

/** A tree publication is retained as one complete line, or not attributed at all. */
function appendHostTransitionBatch(journal: string, batch: readonly Transition[]): boolean {
	try {
		return appendHostTransitionLine(
			journal,
			JSON.stringify({ kind: "host-path-transition-batch", transitions: batch }),
		);
	} catch {
		return false;
	}
}

function isTransition(value: unknown): value is Transition {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Transition).path === "string" &&
		typeof (value as Transition).before === "string" &&
		typeof (value as Transition).after === "string" &&
		typeof (value as Transition).at === "number"
	);
}

/** The journal's transitions, oldest first; a line that does not parse is skipped, and a missing journal holds none. */
function readHostTransitions(journal: string): Transition[] {
	const found: Transition[] = [];
	let lines: string[];
	try {
		lines = hostTransitionLines(journal);
	} catch {
		// An unreadable or changing journal cannot prove host ownership.
		return found;
	}
	for (const line of lines) {
		if (!line) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (
				typeof value === "object" &&
				value !== null &&
				(value as { kind?: unknown }).kind === "host-path-transition-batch"
			) {
				const batch = (value as { transitions?: unknown }).transitions;
				if (
					Array.isArray(batch) &&
					batch.length > 0 &&
					batch.length <= MAX_TRANSITION_BATCH &&
					batch.every(isTransition)
				)
					found.push(...batch);
			} else if (isTransition(value)) found.push(value);
		} catch {
			// A torn line is skipped: it names no transition.
		}
	}
	return found;
}

/**
 * Only an uninterrupted chain of exact host writes explains a watched change. The chain is read from the journal when
 * there is one (every process's writes), else from this process's own writes.
 */
export function hostExplainsFileChange(
	path: string,
	before: string,
	after: string,
	from: number,
	to: number,
	journal?: string,
): boolean {
	let current = before;
	const target = resolve(path);
	const source = journal === undefined ? transitions : readHostTransitions(journal);
	for (const transition of source) {
		if (transition.path !== target || transition.at < from || transition.at > to) continue;
		if (transition.before !== current) return false;
		current = transition.after;
	}
	return current !== before && current === after;
}
