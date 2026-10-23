import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GH_RESOLVED_LINE = /^remote\.(.+)\.gh-resolved(?:\s+(.*))?$/;
const MAX_PIN_REASON_CHARS = 240;

export type GithubOriginGitRunner = (args: string[], options?: { allowFail?: boolean }) => Promise<string>;

export type GithubOriginPinResult =
	| { status: "pinned"; slug: string }
	| { status: "already"; slug: string }
	| { status: "skipped"; reason: string }
	| { status: "failed"; reason: string };

export function githubOriginPinDiagnostic(result: GithubOriginPinResult): string | undefined {
	return result.status === "failed" ? `GitHub origin pin failed: ${result.reason}` : undefined;
}

/**
 * Pins the origin without blocking the caller: each git child costs tens of milliseconds on Windows,
 * and the session must answer its first request without waiting for them. A completed pin that is
 * not a failure records nothing; a failure is appended only while the session is still live.
 */
export async function reportGithubOriginPinForSession(
	cwd: string,
	isChildSession: boolean,
	sessionManager: {
		appendCustomMessageEntry(
			customType: string,
			content: string,
			display: boolean,
			details?: { status: GithubOriginPinResult["status"]; reason?: string },
		): string;
	},
	host: { isDisposed: () => boolean; warn: (message: string) => void },
	git?: GithubOriginGitRunner,
): Promise<void> {
	if (isChildSession) return;
	try {
		const pin = await pinGithubOriginForSession(cwd, git);
		const diagnostic = githubOriginPinDiagnostic(pin);
		if (!diagnostic || host.isDisposed()) return;
		sessionManager.appendCustomMessageEntry("github_origin_pin", diagnostic, true, {
			status: pin.status,
			reason: pin.status === "failed" ? pin.reason : undefined,
		});
	} catch (error) {
		host.warn(
			`github_origin_pin: failed to record pin diagnostic: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function boundedReason(reason: string): string {
	return reason.length <= MAX_PIN_REASON_CHARS ? reason : `${reason.slice(0, MAX_PIN_REASON_CHARS - 1)}…`;
}

export function parseGithubOriginSlug(url: string): string {
	const trimmed = String(url ?? "").trim();
	const match = trimmed.match(
		/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	);
	if (!match) {
		throw new Error(`Not a GitHub origin URL: ${url}`);
	}
	return `${match[1]}/${match[2]}`;
}

export function parseGhResolvedMap(configText: string): Record<string, string> {
	const map: Record<string, string> = {};
	for (const line of String(configText ?? "").split("\n")) {
		const match = GH_RESOLVED_LINE.exec(line.trim());
		if (match?.[1]) map[match[1]] = match[2] ?? "";
	}
	return map;
}

export function githubOriginPinPlan(
	originUrl: string,
	resolvedByRemote: Record<string, string> = {},
): { setOrigin: boolean; unset: string[] } {
	parseGithubOriginSlug(originUrl);
	const unset = Object.keys(resolvedByRemote).filter((remote) => remote !== "origin");
	return { setOrigin: resolvedByRemote.origin !== "base", unset };
}

function defaultGit(cwd: string): GithubOriginGitRunner {
	return async (args, options = {}) => {
		try {
			const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
			return stdout;
		} catch (error) {
			const status = (error as { code?: unknown }).code;
			const stdout = (error as { stdout?: unknown }).stdout;
			// git config --get-regexp exits 1 when there are no matches; --unset-all exits 5 when absent.
			if (options.allowFail && (status === 1 || status === 5)) {
				return typeof stdout === "string" ? stdout : "";
			}
			throw error;
		}
	};
}

/**
 * Runtime owner of unattended `gh` origin pinning. The precommit CLI remains
 * `scripts/github-origin.mjs`; this module ships inside the coding-agent package.
 */
/**
 * Whether `cwd` is inside a linked worktree: the nearest `.git` entry above it is a file (`gitdir: ...`),
 * not the primary checkout's directory. The pin lives in the config every worktree shares, so a session
 * inside a lane worktree must not rewrite it.
 */
function insideLinkedWorktree(cwd: string): boolean {
	for (let dir = cwd; ; dir = dirname(dir)) {
		try {
			return statSync(join(dir, ".git")).isFile();
		} catch {
			// No `.git` entry at this level.
		}
		if (dirname(dir) === dir) return false;
	}
}

export async function pinGithubOriginForSession(
	cwd: string,
	git: GithubOriginGitRunner = defaultGit(cwd),
): Promise<GithubOriginPinResult> {
	if (insideLinkedWorktree(cwd)) return { status: "skipped", reason: "linked worktree" };
	try {
		const originUrl = (await git(["remote", "get-url", "origin"])).trim();
		if (!originUrl) return { status: "skipped", reason: "no origin remote" };
		let slug: string;
		try {
			slug = parseGithubOriginSlug(originUrl);
		} catch {
			return { status: "skipped", reason: "not a GitHub origin" };
		}
		const resolvedText = await git(["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"], { allowFail: true });
		const initial = parseGhResolvedMap(resolvedText);
		const plan = githubOriginPinPlan(originUrl, initial);
		const mutated = plan.setOrigin || plan.unset.length > 0;
		if (plan.setOrigin) await git(["config", "remote.origin.gh-resolved", "base"]);
		for (const remote of plan.unset) {
			await git(["config", "--unset-all", `remote.${remote}.gh-resolved`], { allowFail: true });
		}
		const verified = mutated
			? parseGhResolvedMap(await git(["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"], { allowFail: true }))
			: initial;
		if (verified.origin !== "base") {
			return { status: "failed", reason: "origin gh-resolved is not base after pin" };
		}
		const extras = Object.keys(verified).filter((remote) => remote !== "origin");
		if (extras.length > 0) {
			return {
				status: "failed",
				reason: `competing gh-resolved remotes remain: ${extras.join(",")}`,
			};
		}
		if (!plan.setOrigin && plan.unset.length === 0) return { status: "already", slug };
		return { status: "pinned", slug };
	} catch (error) {
		let reason = "github origin pin failed";
		try {
			const message = error !== null && typeof error === "object" ? Reflect.get(error, "message") : error;
			if (typeof message === "string" && message.length > 0) reason = message;
		} catch {
			// Keep the fallback when getters throw.
		}
		if (/not a git repository/i.test(reason) || /no such remote/i.test(reason)) {
			return { status: "skipped", reason: "not a git repository" };
		}
		return { status: "failed", reason: boundedReason(reason) };
	}
}
