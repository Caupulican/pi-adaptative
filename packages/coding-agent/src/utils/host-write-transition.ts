import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { withFileLockSync } from "../kernel/storage/atomic-file.ts";

const MAX_BYTES = 1024 * 1024;
const MAX_TRANSITIONS = 256;
/** The journal keeps its newest lines once it grows past this many bytes. */
const JOURNAL_MAX_BYTES = 256 * 1024;
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
			if (journal !== undefined) appendHostTransition(journal, transition);
		}
	} catch {
		// Missing attribution remains visible to the protected-path watch.
	}
	return result;
}

/** Appends one transition to the journal, keeping only its newest lines once it grows past the bound. */
function appendHostTransition(journal: string, transition: Transition): void {
	mkdirSync(dirname(journal), { recursive: true });
	withFileLockSync(journal, () => {
		appendFileSync(journal, `${JSON.stringify(transition)}\n`, { mode: 0o600 });
		if (statSync(journal).size <= JOURNAL_MAX_BYTES) return;
		const lines = readFileSync(journal, "utf8").split("\n").filter(Boolean);
		writeFileSync(journal, `${lines.slice(-JOURNAL_KEPT_LINES).join("\n")}\n`, { mode: 0o600 });
	});
}

/** The journal's transitions, oldest first; a line that does not parse is skipped, and a missing journal holds none. */
function readHostTransitions(journal: string): Transition[] {
	if (!existsSync(journal)) return [];
	const found: Transition[] = [];
	for (const line of readFileSync(journal, "utf8").split("\n")) {
		if (!line) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (
				typeof value === "object" &&
				value !== null &&
				typeof (value as Transition).path === "string" &&
				typeof (value as Transition).before === "string" &&
				typeof (value as Transition).after === "string" &&
				typeof (value as Transition).at === "number"
			)
				found.push(value as Transition);
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
