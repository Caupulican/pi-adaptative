import {
	createGithubThreadEvent,
	type GithubReviewState,
	type GithubThreadEvent,
	type GithubThreadEventKind,
	githubBranchName,
	githubEventBody,
	githubLogin,
	HostEventError,
} from "../../core/events/host-event-contract.ts";
import type { CiCommandPort, CiRepository } from "./ci-provider.ts";

/** Items per GitHub page, and the pages one endpoint reads per collection. */
const PER_PAGE = 100;
const MAX_PAGES = 10;
/** Pull requests whose reviews one collection reads; the rest wait for the next collection. */
export const MAX_REVIEWED_PULL_REQUESTS = 16;
const REVIEW_STATES: Readonly<Record<string, GithubReviewState>> = {
	APPROVED: "approved",
	CHANGES_REQUESTED: "changes_requested",
	COMMENTED: "commented",
	DISMISSED: "dismissed",
};

/**
 * A comment endpoint's position: the newest creation instant read, and the ids created at that instant, so a
 * comment sharing the instant is neither repeated nor skipped. `since` selects by update time, so an edited older
 * comment is listed again and ignored by its creation time.
 */
export interface GithubCommentCursor {
	readonly at: string;
	readonly ids: readonly number[];
}

/** An id-ordered endpoint's position: occurrences after `afterId`, none created before `since`. */
export interface GithubIdCursor {
	readonly afterId: number;
	readonly since: string;
}

export interface GithubCollection<C> {
	readonly events: readonly GithubThreadEvent[];
	readonly cursor: C;
	/** The page bound was reached: occurrences past it may be missing. */
	readonly truncated: boolean;
	/** Items that did not fit a thread event and were skipped. */
	readonly skipped: number;
}

/** One listed item does not fit a thread event: it is skipped and counted. A failed command fails the collection. */
class GithubItemError extends Error {}

function skippable(error: unknown): boolean {
	return error instanceof GithubItemError || error instanceof HostEventError;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new GithubItemError("Invalid GitHub object.");
	return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Invalid GitHub listing.");
	return value;
}

function positive(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new GithubItemError("Invalid GitHub id.");
	return value;
}

function instant(value: unknown): string {
	const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(time)) throw new GithubItemError("Invalid GitHub time.");
	return new Date(time).toISOString();
}

/** The pull request or issue number a GitHub URL names, and whether it names a pull request. */
function threadOf(url: unknown): { number: number; pullRequest: boolean } {
	if (typeof url !== "string" || !URL.canParse(url)) throw new GithubItemError("Invalid GitHub URL.");
	const match = /\/(pull|pulls|issues)\/(\d+)(?:[/#?]|$)/.exec(new URL(url).pathname);
	if (!match) throw new GithubItemError("GitHub URL names no thread.");
	return { number: positive(Number(match[2])), pullRequest: match[1] !== "issues" };
}

/**
 * Reads GitHub thread occurrences of one repository through the `gh` command. Read-only: every call is a GET.
 * A pull request's head branch is recorded only for a head in the same repository with a valid branch name.
 */
export class GithubThreadProvider {
	private readonly port: CiCommandPort;
	private readonly branches = new Map<number, string | null>();
	private viewer?: string;

	constructor(port: CiCommandPort) {
		this.port = port;
	}

	private async api(repository: CiRepository, path: string, signal: AbortSignal): Promise<unknown> {
		return JSON.parse(await this.port.run("gh", ["api", "--hostname", repository.host, path], signal));
	}

	/** The signed-in login: review requests and assignments are the ones naming it. */
	private async login(repository: CiRepository, signal: AbortSignal): Promise<string> {
		this.viewer ??= githubLogin(record(await this.api(repository, "user", signal)).login).toLowerCase();
		return this.viewer;
	}

	private async branchOf(repository: CiRepository, number: number, signal: AbortSignal): Promise<string | undefined> {
		if (!this.branches.has(number)) {
			const pull = record(await this.api(repository, `repos/${repository.nameWithOwner}/pulls/${number}`, signal));
			const head = record(pull.head);
			let branch: string | null = null;
			try {
				if (record(head.repo).id === repository.repositoryId) branch = githubBranchName(head.ref);
			} catch {
				// A fork's head, a deleted head repository or a branch name outside the bounded ref grammar: no branch.
			}
			this.branches.set(number, branch);
		}
		return this.branches.get(number) ?? undefined;
	}

	private async event(
		repository: CiRepository,
		kind: GithubThreadEventKind,
		item: {
			id: unknown;
			url: unknown;
			thread: { number: number; pullRequest: boolean };
			author: unknown;
			at: unknown;
			body?: unknown;
			state?: GithubReviewState;
		},
		signal: AbortSignal,
	): Promise<GithubThreadEvent> {
		const branch = item.thread.pullRequest ? await this.branchOf(repository, item.thread.number, signal) : undefined;
		if (item.body !== undefined && item.body !== null && typeof item.body !== "string")
			throw new GithubItemError("Invalid GitHub body.");
		const text = typeof item.body === "string" && item.body ? item.body : undefined;
		return createGithubThreadEvent({
			kind,
			githubId: positive(item.id),
			repository: { host: repository.host, repositoryId: repository.repositoryId },
			thread: { ...item.thread, ...(branch === undefined ? {} : { branch }) },
			author: githubLogin(record(item.author).login),
			occurredAt: instant(item.at),
			url: typeof item.url === "string" ? item.url : "",
			...(kind === "review-submitted" ? { state: item.state } : {}),
			...(text === undefined ? {} : { body: githubEventBody(text) }),
		});
	}

	/** Pull request conversation comments (`issues/comments`) or review comments (`pulls/comments`) since a cursor. */
	async comments(
		repository: CiRepository,
		kind: "pull-request-comment" | "review-comment",
		cursor: GithubCommentCursor,
		signal: AbortSignal,
	): Promise<GithubCollection<GithubCommentCursor>> {
		const endpoint = kind === "review-comment" ? "pulls/comments" : "issues/comments";
		const events: GithubThreadEvent[] = [];
		const seen = new Set(cursor.ids);
		let at = cursor.at;
		let ids = [...cursor.ids];
		let skipped = 0;
		let truncated = false;
		for (let page = 1; page <= MAX_PAGES; page++) {
			const items = list(
				await this.api(
					repository,
					`repos/${repository.nameWithOwner}/${endpoint}?since=${encodeURIComponent(cursor.at)}&sort=updated&direction=asc&per_page=${PER_PAGE}&page=${page}`,
					signal,
				),
			);
			for (const value of items) {
				try {
					const item = record(value);
					const id = positive(item.id);
					const created = instant(item.created_at);
					// Edited earlier comments are listed by update time; only creation at or after the cursor is new.
					if (created < cursor.at || (created === cursor.at && seen.has(id))) continue;
					if (created > at) {
						at = created;
						ids = [];
					}
					if (created === at) ids.push(id);
					seen.add(id);
					const thread = threadOf(kind === "review-comment" ? item.pull_request_url : item.html_url);
					// A conversation comment on a plain issue is no pull request occurrence.
					if (!thread.pullRequest) continue;
					events.push(
						await this.event(
							repository,
							kind,
							{ id, url: item.html_url, thread, author: item.user, at: item.created_at, body: item.body ?? "" },
							signal,
						),
					);
				} catch (error) {
					if (!skippable(error)) throw error;
					skipped++;
				}
			}
			if (items.length < PER_PAGE) return { events, cursor: { at, ids: [...new Set(ids)] }, truncated, skipped };
			truncated = page === MAX_PAGES;
		}
		return { events, cursor: { at, ids: [...new Set(ids)] }, truncated, skipped };
	}

	/**
	 * Review requests and assignments naming the signed-in login, merges and closes of pull requests (`issues/events`).
	 * The listing's order is not documented; GitHub serves it newest first, so pages are read until one reaches the
	 * cursor (an id at or below it, or a creation before `since`). Every item is still filtered by id.
	 */
	async issueEvents(
		repository: CiRepository,
		cursor: GithubIdCursor,
		signal: AbortSignal,
	): Promise<GithubCollection<GithubIdCursor>> {
		const viewer = await this.login(repository, signal);
		const events: GithubThreadEvent[] = [];
		let afterId = cursor.afterId;
		let skipped = 0;
		for (let page = 1; page <= MAX_PAGES; page++) {
			const items = list(
				await this.api(
					repository,
					`repos/${repository.nameWithOwner}/issues/events?per_page=${PER_PAGE}&page=${page}`,
					signal,
				),
			);
			let reached = items.length < PER_PAGE;
			for (const value of items) {
				try {
					const item = record(value);
					const id = positive(item.id);
					const created = instant(item.created_at);
					if (id <= cursor.afterId || created < cursor.since) {
						reached = true;
						continue;
					}
					afterId = Math.max(afterId, id);
					const issue = record(item.issue);
					const thread = { number: positive(issue.number), pullRequest: issue.pull_request !== undefined };
					const kind = this.issueEventKind(item, thread.pullRequest, viewer);
					if (!kind) continue;
					events.push(
						await this.event(
							repository,
							kind,
							{ id, url: issue.html_url, thread, author: item.actor, at: item.created_at },
							signal,
						),
					);
				} catch (error) {
					if (!skippable(error)) throw error;
					skipped++;
				}
			}
			if (reached) return { events, cursor: { afterId, since: cursor.since }, truncated: false, skipped };
		}
		return { events, cursor: { afterId, since: cursor.since }, truncated: true, skipped };
	}

	private issueEventKind(
		item: Record<string, unknown>,
		pullRequest: boolean,
		viewer: string,
	): GithubThreadEventKind | undefined {
		const named = (value: unknown) => {
			if (!value || typeof value !== "object") return false;
			const login = (value as { login?: unknown }).login;
			return typeof login === "string" && login.toLowerCase() === viewer;
		};
		if (item.event === "review_requested")
			return pullRequest && named(item.requested_reviewer) ? "review-requested" : undefined;
		if (item.event === "assigned") return named(item.assignee) ? "issue-assigned" : undefined;
		if (item.event === "merged") return pullRequest ? "pull-request-merged" : undefined;
		if (item.event === "closed") return pullRequest ? "pull-request-closed" : undefined;
		return undefined;
	}

	/** Submitted reviews of one pull request; the listing is in submission order. Pending reviews are not submitted. */
	async reviews(
		repository: CiRepository,
		pullRequest: number,
		cursor: GithubIdCursor,
		signal: AbortSignal,
	): Promise<GithubCollection<GithubIdCursor>> {
		const events: GithubThreadEvent[] = [];
		let afterId = cursor.afterId;
		let skipped = 0;
		for (let page = 1; page <= MAX_PAGES; page++) {
			const items = list(
				await this.api(
					repository,
					`repos/${repository.nameWithOwner}/pulls/${pullRequest}/reviews?per_page=${PER_PAGE}&page=${page}`,
					signal,
				),
			);
			for (const value of items) {
				try {
					const item = record(value);
					const id = positive(item.id);
					const state = typeof item.state === "string" ? REVIEW_STATES[item.state] : undefined;
					if (id <= cursor.afterId || !state || item.submitted_at === undefined || item.submitted_at === null)
						continue;
					const submitted = instant(item.submitted_at);
					afterId = Math.max(afterId, id);
					if (submitted < cursor.since) continue;
					events.push(
						await this.event(
							repository,
							"review-submitted",
							{
								id,
								url: item.html_url,
								thread: { number: pullRequest, pullRequest: true },
								author: item.user,
								at: item.submitted_at,
								body: item.body ?? "",
								state,
							},
							signal,
						),
					);
				} catch (error) {
					if (!skippable(error)) throw error;
					skipped++;
				}
			}
			if (items.length < PER_PAGE)
				return { events, cursor: { afterId, since: cursor.since }, truncated: false, skipped };
		}
		return { events, cursor: { afterId, since: cursor.since }, truncated: true, skipped };
	}

	/** Pull requests, open or closed, whose head is `branch` in this repository. */
	async pullRequestsOf(repository: CiRepository, branch: string, signal: AbortSignal): Promise<number[]> {
		const owner = repository.nameWithOwner.split("/")[0]!;
		const items = list(
			await this.api(
				repository,
				`repos/${repository.nameWithOwner}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=${PER_PAGE}`,
				signal,
			),
		);
		return items.flatMap((value) => {
			try {
				return [positive(record(value).number)];
			} catch {
				return [];
			}
		});
	}
}
