/**
 * Which project a checkout is, independent of where it sits on a machine: `RepoKey = sha256("repo/1|" + the sorted root
 * commits + "|" + the normalized origin)`. Two clones of one project on two machines get one key; a fork with the same
 * history and another origin gets another. The origin is folded to `host/path` (no scheme, no user or token, no
 * `.git`, lowercase), so a credential in a remote URL never reaches the key or the wire.
 *
 * Git runs by argument vector, no shell, only for checkouts the owner listed (`remote/settings.json` `repos`), and only
 * when a peer that speaks `cap/1` is connected. Results are cached per process.
 */

import { createHash } from "node:crypto";
import { execCommand, withoutInheritedGitLocation } from "../exec.ts";

export interface RepoIdentity {
	readonly path: string;
	readonly repoKey: string;
	/** The checkout's current commit, read fresh at most once per {@link HEAD_TTL_MS}. */
	readonly headSha?: string;
}

const MAX_ROOT_COMMITS = 4;
const GIT_TIMEOUT_MS = 10_000;
const HEAD_TTL_MS = 60_000;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** `https://user:token@Host/Org/Repo.git`, `git@host:org/repo` and `ssh://git@host/org/repo` all fold to `host/org/repo`. */
export function normalizeOrigin(url: string): string {
	let rest = url.trim();
	const hostOf = (authority: string): string => authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
	const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
	if (scheme) {
		rest = rest.slice(scheme[0].length);
		const slash = rest.indexOf("/");
		rest = slash < 0 ? hostOf(rest) : `${hostOf(rest.slice(0, slash))}/${rest.slice(slash + 1)}`;
	} else {
		// scp-like `[user@]host:org/repo`: the first colon, before any slash, separates the host from the path.
		const colon = rest.indexOf(":");
		if (colon > 0 && !rest.slice(0, colon).includes("/"))
			rest = `${hostOf(rest.slice(0, colon))}/${rest.slice(colon + 1)}`;
	}
	return rest
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "")
		.toLowerCase();
}

export function repoKeyOf(rootCommits: readonly string[], origin: string): string {
	return createHash("sha256")
		.update(`repo/1|${[...rootCommits].sort().join(",")}|${origin}`)
		.digest("hex");
}

async function git(path: string, args: string[]): Promise<string | undefined> {
	const result = await execCommand("git", args, path, {
		timeout: GIT_TIMEOUT_MS,
		env: withoutInheritedGitLocation(),
	});
	return result.code === 0 ? result.stdout.trim() : undefined;
}

interface CachedIdentity {
	readonly repoKey: string | undefined;
	headSha?: string;
	headAt: number;
}

const cache = new Map<string, Promise<CachedIdentity>>();

export function resetRepoIdentityCache(): void {
	cache.clear();
}

async function readKey(path: string): Promise<CachedIdentity> {
	const roots = (await git(path, ["rev-list", "--max-parents=0", "HEAD"]))
		?.split(/\s+/)
		.filter((sha) => SHA.test(sha))
		.slice(0, MAX_ROOT_COMMITS);
	if (!roots || roots.length === 0) return { repoKey: undefined, headAt: 0 };
	const origin = await git(path, ["remote", "get-url", "origin"]);
	return { repoKey: repoKeyOf(roots, origin ? normalizeOrigin(origin) : ""), headAt: 0 };
}

/** The identity of the checkout at `path`, or undefined when it is not a git checkout with history. */
export async function resolveRepoIdentity(path: string, now = Date.now()): Promise<RepoIdentity | undefined> {
	let pending = cache.get(path);
	if (!pending) {
		pending = readKey(path);
		cache.set(path, pending);
	}
	const cached = await pending;
	if (!cached.repoKey) return undefined;
	if (now - cached.headAt > HEAD_TTL_MS) {
		const head = await git(path, ["rev-parse", "HEAD"]);
		cached.headSha = head && SHA.test(head) ? head : undefined;
		cached.headAt = now;
	}
	return { path, repoKey: cached.repoKey, ...(cached.headSha ? { headSha: cached.headSha } : {}) };
}
