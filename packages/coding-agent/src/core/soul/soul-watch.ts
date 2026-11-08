import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { SoulHold } from "./soul-hold.ts";

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

/** A stamp no file has: a baseline carrying it is never taken for unchanged, so the next `reconcile` reads the file. */
const UNMATCHED_STAMP: SoulStamp = { mtimeMs: -1, ctimeMs: -1, size: -1, ino: -1 };

function sha256Of(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function revisionOf(path: string): SoulRevision {
	let stamp = stampOf(path);
	let revision: SoulRevision = { text: undefined, digest: undefined, stamp };
	for (let attempt = 0; attempt < MAX_READ_ATTEMPTS && stamp; attempt++) {
		const text = readFileSync(path, "utf8");
		const after = stampOf(path);
		revision = { text, digest: sha256Of(text), stamp: after };
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
	private readonly resumed: { readonly observed: SoulRevision; readonly hold: SoulHold } | undefined;

	/**
	 * Baselines on what is on disk, except while a persisted hold names exactly that revision: an agent change an earlier
	 * session left unreviewed. Then the accounted text is the one the hold recorded as standing before the change, so the
	 * change is found as a difference (`reconcile`, `resumedHold`) and is never taken in as the owner's by the restart. A
	 * hold for a revision the file no longer has is stale: whoever wrote it since is the owner's.
	 */
	constructor(path: string, hold?: SoulHold) {
		this.path = path;
		const disk = revisionOf(path);
		if (hold && hold.observedDigest === disk.digest) {
			this.accounted = {
				text: hold.standing,
				digest: hold.standing === undefined ? undefined : sha256Of(hold.standing),
				stamp: UNMATCHED_STAMP,
			};
			this.resumed = { observed: disk, hold };
		} else {
			this.accounted = disk;
			this.resumed = undefined;
		}
	}

	/** The unreviewed change a persisted hold kept, found on disk at construction; undefined when none applied. */
	get resumedHold(): { readonly observed: SoulRevision; readonly hold: SoulHold } | undefined {
		return this.resumed;
	}

	/** The accounted-for text, which a revert restores; undefined when the file did not exist. */
	get known(): string | undefined {
		return this.accounted.text;
	}

	/** The digest of the accounted revision: what a verdict's authority to restore was made against. */
	get accountedDigest(): string | undefined {
		return this.accounted.digest;
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
