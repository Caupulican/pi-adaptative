import { statSync } from "node:fs";
import { dirname } from "node:path";

/** File systems stamp whole seconds (FAT: two); a change within this much before a call started still counts as inside it. */
const MTIME_SLACK_MS = 2_000;

interface SoulStamp {
	readonly mtimeMs: number;
	readonly size: number;
	readonly ino: number;
}

function stampOf(path: string): SoulStamp | undefined {
	const stats = statSync(path, { throwIfNoEntry: false });
	return stats ? { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino } : undefined;
}

function sameStamp(left: SoulStamp | undefined, right: SoulStamp | undefined): boolean {
	if (!left || !right) return left === right;
	return left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino;
}

/** What `SoulWatch.observe` found since the last time the harness accounted for the file. */
export type SoulObservation =
	| { readonly kind: "unchanged" }
	/** `inWindow`: the change happened while the observed call was running, so that call is its cause. */
	| { readonly kind: "changed"; readonly inWindow: boolean };

/**
 * Tracks the last state of `soul.md` the harness accounted for (a load, an owner write, a gated write, a judged
 * ungated change): its text, which a revert restores, and its stamp, which makes the check after a tool call one
 * `stat`. A change is attributed to a call only when it falls inside that call's run (a created or changed file by its
 * own modification time, a deleted one by the directory's), so an owner editing the file by hand between calls is
 * not mistaken for the agent.
 */
export class SoulWatch {
	private readonly path: string;
	private knownText: string | undefined;
	private stamp: SoulStamp | undefined;

	constructor(path: string, text: string | undefined) {
		this.path = path;
		this.knownText = text;
		this.stamp = stampOf(path);
	}

	/** The last accounted-for text; undefined when the file did not exist. */
	get known(): string | undefined {
		return this.knownText;
	}

	/** Accounts for the file as it is now, with `text` as its content (undefined when it does not exist). */
	adopt(text: string | undefined): void {
		this.knownText = text;
		this.stamp = stampOf(this.path);
	}

	observe(callStartedAt: number): SoulObservation {
		const now = stampOf(this.path);
		if (sameStamp(now, this.stamp)) return { kind: "unchanged" };
		const changedAt = now ? now.mtimeMs : statSync(dirname(this.path), { throwIfNoEntry: false })?.mtimeMs;
		return { kind: "changed", inWindow: changedAt !== undefined && changedAt >= callStartedAt - MTIME_SLACK_MS };
	}
}
