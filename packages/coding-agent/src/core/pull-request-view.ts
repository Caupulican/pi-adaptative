/**
 * The pull request of the current branch, as the status line shows it.
 *
 * `gh pr view` answers for the checked-out branch of a working directory. The answer is cached per
 * directory and branch, so switching branches never shows another branch's PR, and refreshed in the
 * background: a read never waits on the network, it returns what is known and starts a refresh when the
 * answer is older than `REFRESH_AFTER_MS`. A refresh that changes the answer notifies the listeners, so the
 * status line redraws on the event instead of polling. The view is absent when the branch has no pull
 * request or when `gh` is missing or signed out; the status line then shows nothing in its place.
 */
import { execFile } from "node:child_process";

export type PullRequestState = "open" | "draft" | "merged" | "closed";

export interface PullRequestView {
	readonly number: number;
	readonly state: PullRequestState;
	readonly url: string;
}

const REFRESH_AFTER_MS = 120_000;
const GH_TIMEOUT_MS = 8_000;

interface CacheEntry {
	view: PullRequestView | undefined;
	checkedAt: number;
	refreshing: boolean;
}

const cache = new Map<string, CacheEntry>();
const listeners = new Set<() => void>();

/** The record `gh pr view --json number,state,isDraft,url` prints. Pure. */
export function pullRequestViewFromJson(text: string): PullRequestView | undefined {
	let record: unknown;
	try {
		record = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!record || typeof record !== "object") return undefined;
	const { number, state, isDraft, url } = record as Record<string, unknown>;
	if (typeof number !== "number" || !Number.isInteger(number) || typeof url !== "string") return undefined;
	if (state === "MERGED") return { number, state: "merged", url };
	if (state === "CLOSED") return { number, state: "closed", url };
	if (state === "OPEN") return { number, state: isDraft === true ? "draft" : "open", url };
	return undefined;
}

function sameView(a: PullRequestView | undefined, b: PullRequestView | undefined): boolean {
	return a?.number === b?.number && a?.state === b?.state && a?.url === b?.url;
}

function refresh(cwd: string, entry: CacheEntry): void {
	entry.refreshing = true;
	execFile(
		"gh",
		["pr", "view", "--json", "number,state,isDraft,url"],
		{ cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, windowsHide: true },
		(error, stdout) => {
			entry.refreshing = false;
			entry.checkedAt = Date.now();
			const next = error ? undefined : pullRequestViewFromJson(stdout);
			if (sameView(entry.view, next)) return;
			entry.view = next;
			for (const listener of listeners) listener();
		},
	);
}

/** The branch's pull request as last seen; starts a background refresh when that is stale. Never blocks. */
export function readPullRequestView(cwd: string, branch: string | null): PullRequestView | undefined {
	if (!branch) return undefined;
	const key = `${cwd}\0${branch}`;
	let entry = cache.get(key);
	if (!entry) {
		entry = { view: undefined, checkedAt: 0, refreshing: false };
		cache.set(key, entry);
	}
	if (!entry.refreshing && Date.now() - entry.checkedAt >= REFRESH_AFTER_MS) refresh(cwd, entry);
	return entry.view;
}

/** Called when a refresh changes what a branch's pull request reads as. Returns the unsubscribe. */
export function onPullRequestChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
