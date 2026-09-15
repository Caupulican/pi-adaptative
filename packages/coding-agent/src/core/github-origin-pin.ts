import { execFileSync } from "node:child_process";

const GH_RESOLVED_LINE = /^remote\.(.+)\.gh-resolved(?:\s+(.*))?$/;
const MAX_PIN_REASON_CHARS = 240;

export type GithubOriginGitRunner = (args: string[], options?: { allowFail?: boolean }) => string;

export type GithubOriginPinResult =
	| { status: "pinned"; slug: string }
	| { status: "already"; slug: string }
	| { status: "skipped"; reason: string }
	| { status: "failed"; reason: string };

export function githubOriginPinDiagnostic(result: GithubOriginPinResult): string | undefined {
	return result.status === "failed" ? `GitHub origin pin failed: ${result.reason}` : undefined;
}

export function reportGithubOriginPinForSession(
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
	git?: GithubOriginGitRunner,
): void {
	if (isChildSession) return;
	const pin = pinGithubOriginForSession(cwd, git);
	const diagnostic = githubOriginPinDiagnostic(pin);
	if (!diagnostic) return;
	sessionManager.appendCustomMessageEntry("github_origin_pin", diagnostic, true, {
		status: pin.status,
		reason: pin.status === "failed" ? pin.reason : undefined,
	});
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
	return (args, options = {}) => {
		try {
			return execFileSync("git", args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			const status = (error as { status?: number }).status;
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
export function pinGithubOriginForSession(
	cwd: string,
	git: GithubOriginGitRunner = defaultGit(cwd),
): GithubOriginPinResult {
	try {
		const originUrl = git(["remote", "get-url", "origin"]).trim();
		if (!originUrl) return { status: "skipped", reason: "no origin remote" };
		let slug: string;
		try {
			slug = parseGithubOriginSlug(originUrl);
		} catch {
			return { status: "skipped", reason: "not a GitHub origin" };
		}
		const resolvedText = git(["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"], { allowFail: true });
		const initial = parseGhResolvedMap(resolvedText);
		const plan = githubOriginPinPlan(originUrl, initial);
		const mutated = plan.setOrigin || plan.unset.length > 0;
		if (plan.setOrigin) git(["config", "remote.origin.gh-resolved", "base"]);
		for (const remote of plan.unset) {
			git(["config", "--unset-all", `remote.${remote}.gh-resolved`], { allowFail: true });
		}
		const verified = mutated
			? parseGhResolvedMap(git(["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"], { allowFail: true }))
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
