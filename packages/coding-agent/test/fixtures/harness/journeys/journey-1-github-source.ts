/**
 * The scripted GitHub side of a GitHub routine journey: `gh api` reads answered from a comment list, and a CI provider
 * whose checked-out revision has no run, so the source registers its repository and observes nothing else.
 */

import type { CiCommandPort, CiProvider, CiRepository } from "../../../../src/host/ci/ci-provider.ts";

/** The signed-in login the scripted `gh api user` answers with; it opened pull request 12. */
export const GITHUB_VIEWER = "harness-owner";

/** One scripted conversation comment, timed from the first `since` the source sends. */
export interface GithubCommentItem {
	readonly id: number;
	readonly offsetMs: number;
	readonly pullRequest: number;
	readonly author: string;
	readonly body: string;
}

export function githubComment(
	id: number,
	offsetMs: number,
	pullRequest: number,
	author: string,
	body: string,
): GithubCommentItem {
	return { id, offsetMs, pullRequest, author, body };
}

export interface ScriptedGithub {
	readonly port: CiCommandPort;
	readonly provider: CiProvider;
	/** The first `since` the source sent for a comment listing, in ms; undefined until it asked. */
	readonly firstSinceMs: () => number | undefined;
}

/**
 * Pull requests 12 (the viewer's) and 13 (another login's), the comments the caller lists, and nothing else: any other
 * command or read lands in `unscripted` and fails. Every `gh api` path is recorded in `ghPaths`.
 */
export function scriptGithub(input: {
	readonly repository: CiRepository;
	readonly comments: () => readonly GithubCommentItem[];
	readonly ghPaths: string[];
	readonly unscripted: string[];
}): ScriptedGithub {
	const { repository, ghPaths, unscripted } = input;
	let firstSinceMs: number | undefined;
	const listed = (path: string) => {
		const since = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("since");
		if (since === null) throw new Error(`Comment listing without since: ${path}`);
		firstSinceMs ??= Date.parse(since);
		const startMs = firstSinceMs;
		return input.comments().map((item) => ({
			id: item.id,
			created_at: new Date(startMs + item.offsetMs).toISOString(),
			html_url: `https://github.com/${repository.nameWithOwner}/pull/${item.pullRequest}#issuecomment-${item.id}`,
			user: { login: item.author },
			body: item.body,
		}));
	};
	const base = `repos/${repository.nameWithOwner}`;
	const port: CiCommandPort = {
		run: async (executable, args, signal) => {
			signal.throwIfAborted();
			const path = args.at(-1) ?? "";
			ghPaths.push(path);
			if (executable !== "gh" || args.length !== 4 || args[0] !== "api" || args[2] !== repository.host) {
				unscripted.push(`${executable} ${args.join(" ")}`);
				throw new Error("Unscripted command.");
			}
			if (path === "user") return JSON.stringify({ login: GITHUB_VIEWER });
			if (path.startsWith(`${base}/pulls?state=all&sort=updated&direction=desc&`))
				return JSON.stringify([
					{ number: 12, user: { login: GITHUB_VIEWER } },
					{ number: 13, user: { login: "reviewer-b" } },
				]);
			if (path.startsWith(`${base}/issues/comments?`)) return JSON.stringify(listed(path));
			if (path === `${base}/pulls/12` || path === `${base}/pulls/13`)
				return JSON.stringify({
					head: { ref: `feature-${path.slice(-2)}`, repo: { id: repository.repositoryId } },
				});
			unscripted.push(path);
			throw new Error(`Unscripted GitHub read: ${path}`);
		},
		wait: async () => {
			throw new Error("GitHub thread collection never waits on a command.");
		},
		tail: async () => {
			throw new Error("GitHub thread collection never reads a log.");
		},
	};
	const provider: CiProvider = {
		repository: async () => repository,
		collect: async (headSha, signal) => {
			signal.throwIfAborted();
			return {
				subject: {
					host: repository.host,
					repositoryId: repository.repositoryId,
					workflowId: repository.workflowId,
					headSha,
				},
				events: [],
			};
		},
		failedJobs: async () => {
			throw new Error("No CI attempt is red in this phase.");
		},
		waitForRun: async () => {
			throw new Error("No CI run is pending in this phase.");
		},
	};
	return { port, provider, firstSinceMs: () => firstSinceMs };
}
