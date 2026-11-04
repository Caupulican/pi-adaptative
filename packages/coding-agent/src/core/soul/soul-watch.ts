import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** `ctime` moves on any content write, whatever a writer does to `mtime`; `ino` moves when the file is replaced. */
interface SoulStamp {
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	readonly size: number;
	readonly ino: number;
}

/**
 * One exact revision of `soul.md`: its text, the digest of that text and the stamp it was read under. A decision about
 * a revision is only valid while the file still has that digest; `undefined` text is an absent file.
 */
export interface SoulRevision {
	readonly text: string | undefined;
	readonly digest: string | undefined;
	readonly stamp: SoulStamp | undefined;
}

/** A read that sees the stamp move under it is repeated this many times, then taken as read: the next check catches it. */
const MAX_READ_ATTEMPTS = 3;

function stampOf(path: string): SoulStamp | undefined {
	const stats = statSync(path, { throwIfNoEntry: false });
	return stats ? { mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size, ino: stats.ino } : undefined;
}

function sameStamp(left: SoulStamp | undefined, right: SoulStamp | undefined): boolean {
	if (!left || !right) return left === right;
	return (
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.size === right.size &&
		left.ino === right.ino
	);
}

function revisionOf(path: string): SoulRevision {
	let stamp = stampOf(path);
	let revision: SoulRevision = { text: undefined, digest: undefined, stamp };
	for (let attempt = 0; attempt < MAX_READ_ATTEMPTS && stamp; attempt++) {
		const text = readFileSync(path, "utf8");
		const after = stampOf(path);
		revision = { text, digest: createHash("sha256").update(text, "utf8").digest("hex"), stamp: after };
		if (sameStamp(stamp, after)) break;
		stamp = after;
	}
	return revision;
}

/**
 * The last state of `soul.md` the harness accounted for: a load, an owner write, a gated write or a judged change. It
 * is a revision, not a time: whether the file changed is a question about its stamp and digest, so an unchanged file
 * costs one `stat` and nothing about when a change happened is guessed.
 */
export class SoulWatch {
	private readonly path: string;
	private accounted: SoulRevision;

	constructor(path: string) {
		this.path = path;
		this.accounted = revisionOf(path);
	}

	/** The accounted-for text, which a revert restores; undefined when the file did not exist. */
	get known(): string | undefined {
		return this.accounted.text;
	}

	/** The file as it is right now. */
	current(): SoulRevision {
		return revisionOf(this.path);
	}

	/**
	 * The file's revision when its content differs from the accounted one, else undefined. A stamp that moved over the
	 * same content (a touch) is absorbed.
	 */
	reconcile(): SoulRevision | undefined {
		if (sameStamp(stampOf(this.path), this.accounted.stamp)) return undefined;
		const now = revisionOf(this.path);
		if (now.digest === this.accounted.digest) {
			this.accounted = now;
			return undefined;
		}
		return now;
	}

	/** Accounts for exactly this revision: its text, digest and stamp advance together. */
	adopt(revision: SoulRevision): void {
		this.accounted = revision;
	}
}
