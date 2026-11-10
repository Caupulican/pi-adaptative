/**
 * The owner's own recent commits, read for taste: a bounded sample of what the repository's configured identity wrote,
 * newest first, each with its subject line, author date and patch text. A later task mines the sample for candidate
 * taste facts; nothing here is knowledge, nothing is stored and no model is called. Two rules keep the sample honest:
 * every bound is a named constant and text a bound drops is stated in the text rather than silently missing, and every
 * patch and subject passes `redactKnownSecrets` before it is returned, so no secret-shaped text from history leaves this
 * module.
 *
 * The second function answers how many owner commits a later look would read after a commit id, which is what makes a
 * repeated look cheap: an origin reads only what is new since the head it recorded.
 */
import { type ExecResult, execCommand, withoutInheritedGitLocation } from "../exec.ts";
import { redactKnownSecrets } from "../security/secret-text.ts";

/** The origin label a proposal mined from commits carries (`docs/memory.md`): where the fact was seen. */
export const REPOSITORY_HISTORY_ORIGIN = "repository-history";

/** Owner commits one read lists before the sample bound stops it. */
export const MAX_LISTED_COMMITS = 60;
/** Characters of one commit's returned patch text. */
export const MAX_COMMIT_PATCH_CHARS = 6_000;
/** Characters of the whole sample's returned patch text. */
export const MAX_SAMPLE_PATCH_CHARS = 60_000;
/** Files of one commit whose diff is read; a wider change is stated as left out. */
export const MAX_PATCHED_FILES = 20;

const GIT_TIMEOUT_MS = 20_000;
const MAX_GIT_OUTPUT_CHARS = 1024 * 1024;
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FIELD_SEPARATOR = "\u001f";
/** The whole repository as a pathspec: a read started in a subdirectory still samples every path of a commit. */
const REPOSITORY_ROOT_PATHSPEC = ":/";

/**
 * Paths whose change teaches nothing about how the owner writes: lock files, installed dependencies, build output,
 * vendored trees, minified and generated files. One list, used by the change listing and by every file diff.
 */
export const UNINFORMATIVE_PATHSPECS: readonly string[] = [
	":(exclude,glob)**/package-lock.json",
	":(exclude,glob)**/*.lock",
	":(exclude,glob)**/pnpm-lock.yaml",
	":(exclude,glob)**/node_modules/**",
	":(exclude,glob)**/dist/**",
	":(exclude,glob)**/build/**",
	":(exclude,glob)**/vendor/**",
	":(exclude,glob)**/*.min.*",
	":(exclude,glob)**/*.generated.*",
];

/** The git options both a change listing and a file diff use: no color, no external diff, no rename detection. */
const PATH_RENDERING = ["show", "--no-color", "--no-ext-diff", "--no-renames"] as const;

/**
 * One git command of this module: a program, its own arguments and where it runs, never a shell line. The signature
 * matches the worktree-sync engine's exec seam, so a caller that already holds one passes it unchanged, and a harness
 * scripts git here instead of spawning it.
 */
export type RepositoryHistoryExec = (
	command: string,
	args: string[],
	options: { readonly cwd: string; readonly signal?: AbortSignal },
) => Promise<ExecResult>;

/** One commit of the sample. */
export interface OwnerCommit {
	/** The commit id, as git printed it. */
	readonly id: string;
	/** The subject line, redacted. */
	readonly subject: string;
	/** The author date, ISO 8601 with the author's offset. */
	readonly authoredAt: string;
	/** Whole file diffs in path order, redacted, then one line when files were left out. Never a partial file diff. */
	readonly patch: string;
}

/**
 * Why git could not name the owner here: the directory is not a work tree it can read (a missing git answers this too),
 * or the repository is configured with no identity, so "the owner's commits" means nothing.
 */
export type OwnerIdentityFailure = "not_a_work_tree" | "no_identity";

/** Why there was nothing to read. The three cases are the whole answer, and none of them is an error. */
export type OwnerHistoryEmptyReason = OwnerIdentityFailure | "no_commits";

/** What one read answered: a sample, or nothing to read and why. */
export type OwnerHistorySample =
	| {
			readonly status: "sample";
			/** The commit HEAD named when the sample was read. */
			readonly head: string;
			/** The configured identity the sample was filtered by. */
			readonly identity: string;
			/** Newest first. */
			readonly commits: readonly OwnerCommit[];
			/** Listed owner commits the sample bound left out. */
			readonly omittedCommits: number;
	  }
	| { readonly status: "empty"; readonly reason: OwnerHistoryEmptyReason };

/** How many owner commits a later look would read after a commit id. */
export type OwnerCommitCount =
	| { readonly status: "counted"; readonly count: number }
	| { readonly status: "unknown"; readonly reason: OwnerIdentityFailure | "unknown_commit" };

export interface ReadOwnerHistoryOptions {
	/** The working directory whose repository is read; the identity is the one configured there. */
	readonly cwd: string;
	readonly signal?: AbortSignal;
	/** Replaces the production git runner. */
	readonly exec?: RepositoryHistoryExec;
}

export interface CountOwnerCommitsOptions extends ReadOwnerHistoryOptions {
	/** The commit the later look starts after. */
	readonly after: string;
}

/**
 * The production runner: `execCommand` without a shell, with the inherited git location removed and no terminal
 * prompt, under a timeout and the caller's abort signal. It is a seam because the reader is otherwise untestable: a
 * harness answers these commands instead of spawning git.
 */
export function createRepositoryHistoryExec(): RepositoryHistoryExec {
	return (command, args, options) =>
		execCommand(command, args, options.cwd, {
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: MAX_GIT_OUTPUT_CHARS,
			// A read of the owner's own history asks nothing: no credential prompt, and no git location inherited from a hook.
			env: { ...withoutInheritedGitLocation(), GIT_TERMINAL_PROMPT: "0" },
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
}

type RunGit = (args: string[]) => Promise<ExecResult>;

function runner(options: ReadOwnerHistoryOptions): RunGit {
	const exec = options.exec ?? createRepositoryHistoryExec();
	const call = { cwd: options.cwd, ...(options.signal === undefined ? {} : { signal: options.signal }) };
	return (args) => exec("git", args, call);
}

type OwnerIdentity =
	| { readonly status: "resolved"; readonly identity: string }
	| { readonly status: "empty"; readonly reason: OwnerIdentityFailure };

/** The identity the repository is configured with, which is what "the owner" means here. */
async function resolveOwner(run: RunGit): Promise<OwnerIdentity> {
	const inside = await run(["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || inside.stdout.trim() !== "true") return { status: "empty", reason: "not_a_work_tree" };
	const configured = await run(["config", "--get", "user.email"]);
	const identity = configured.code === 0 ? configured.stdout.trim() : "";
	return identity === "" ? { status: "empty", reason: "no_identity" } : { status: "resolved", identity };
}

interface ListedCommit {
	readonly id: string;
	readonly authoredAt: string;
	readonly subject: string;
}

/** `%H%x1f%aI%x1f%s` per line: the id, the author date, then the rest of the line as the subject. */
function parseListing(stdout: string): ListedCommit[] {
	const listed: ListedCommit[] = [];
	for (const line of stdout.split("\n")) {
		if (line === "") continue;
		const idEnd = line.indexOf(FIELD_SEPARATOR);
		const dateEnd = line.indexOf(FIELD_SEPARATOR, idEnd + 1);
		const id = line.slice(0, idEnd);
		if (idEnd < 0 || dateEnd < 0 || !COMMIT_ID.test(id))
			throw new Error("git log answered a line that is not a commit record of this format");
		listed.push({ id, authoredAt: line.slice(idEnd + 1, dateEnd), subject: line.slice(dateEnd + 1) });
	}
	return listed;
}

/** One line for a commit whose changed paths git would not list: stated, never passed off as an empty change. */
const UNREADABLE_CHANGE = "[this commit's change could not be read]";

function filesLeftOut(count: number): string {
	return `[${count} file diff${count === 1 ? "" : "s"} left out: a commit reads ${MAX_PATCHED_FILES} files and ${MAX_COMMIT_PATCH_CHARS} characters at most]`;
}

/**
 * The changed paths of a commit that teach something, unquoted and without the uninformative ones; undefined when git
 * would not list them.
 */
async function changedPaths(id: string, run: RunGit): Promise<string[] | undefined> {
	const listed = await run([
		...PATH_RENDERING,
		"--name-only",
		"-z",
		"--format=",
		id,
		"--",
		REPOSITORY_ROOT_PATHSPEC,
		...UNINFORMATIVE_PATHSPECS,
	]);
	if (listed.code !== 0 || listed.stdoutTruncated) return undefined;
	return listed.stdout.split("\0").filter((path) => path !== "");
}

/**
 * One commit's patch: whole file diffs in path order until the next one would pass the per-commit bound, so a file's
 * diff is never cut; the files not read, whatever the reason, are one stated line. A file whose own diff is longer than
 * the bound, or arrived truncated, cannot fit, and neither can anything after it.
 */
async function commitPatch(id: string, run: RunGit): Promise<string> {
	const paths = await changedPaths(id, run);
	if (paths === undefined) return `${UNREADABLE_CHANGE}\n`;
	const diffs: string[] = [];
	let chars = 0;
	for (const path of paths) {
		if (diffs.length >= MAX_PATCHED_FILES) break;
		const shown = await run([...PATH_RENDERING, "-U1", "--format=", id, "--", `:(top,literal)${path}`]);
		if (shown.code !== 0 || shown.stdoutTruncated) break;
		const text = redactKnownSecrets(shown.stdout);
		if (chars + text.length > MAX_COMMIT_PATCH_CHARS) break;
		diffs.push(text);
		chars += text.length;
	}
	const leftOut = paths.length - diffs.length;
	if (leftOut === 0) return diffs.join("");
	return `${diffs.join("")}${filesLeftOut(leftOut)}\n`;
}

/** Newest first, until the sample bound: the commits that did not fit are counted, never cut. */
async function sampledCommits(listed: readonly ListedCommit[], run: RunGit): Promise<OwnerCommit[]> {
	const commits: OwnerCommit[] = [];
	let chars = 0;
	for (const commit of listed) {
		const patch = await commitPatch(commit.id, run);
		// One break separates two patch texts; the sample bound counts the text the reader returns.
		const addition = commits.length === 0 ? patch.length : patch.length + 1;
		if (chars + addition > MAX_SAMPLE_PATCH_CHARS) break;
		chars += addition;
		commits.push({
			id: commit.id,
			authoredAt: commit.authoredAt,
			subject: redactKnownSecrets(commit.subject),
			patch,
		});
	}
	return commits;
}

/**
 * The git author filter for one identity. The angle brackets are part of the fixed string: git matches `--author` anywhere
 * in the author line `Name <email>`, so the bare address would also match `aa@example.test` for `a@example.test`, while
 * `Name <a@example.test>` matches only the identity itself.
 */
function authorFilter(identity: string): string {
	return `--author=<${identity}>`;
}

/**
 * Reads a bounded sample of the owner's commits. Merges are skipped and the author filter is the configured identity as
 * a fixed string, so no pattern of history can widen it.
 */
export async function readOwnerHistory(options: ReadOwnerHistoryOptions): Promise<OwnerHistorySample> {
	const run = runner(options);
	const owner = await resolveOwner(run);
	if (owner.status === "empty") return { status: "empty", reason: owner.reason };
	const head = await run(["rev-parse", "--verify", "HEAD"]);
	const headId = head.code === 0 ? head.stdout.trim() : "";
	if (headId === "") return { status: "empty", reason: "no_commits" };
	const listing = await run([
		"log",
		"--no-merges",
		"--fixed-strings",
		authorFilter(owner.identity),
		`--max-count=${MAX_LISTED_COMMITS}`,
		`--format=%H${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s`,
		"HEAD",
	]);
	// A work tree whose history git cannot list is, for this reader, a directory it cannot read: nothing to sample.
	if (listing.code !== 0) return { status: "empty", reason: "not_a_work_tree" };
	// The listing is the sample's index: a truncated one would silently drop commits the result claims to account for.
	if (listing.stdoutTruncated) throw new Error("git log answered more than this reader's output bound");
	const listed = parseListing(listing.stdout);
	if (listed.length === 0) return { status: "empty", reason: "no_commits" };
	const commits = await sampledCommits(listed, run);
	return {
		status: "sample",
		head: headId,
		identity: owner.identity,
		commits,
		omittedCommits: listed.length - commits.length,
	};
}

/**
 * How many commits the owner authored after `after`, merges excluded as in the sample, which answers whether a repeated
 * look is worth it. An id git does not know answers `unknown`, as does a directory that is not a work tree or one
 * configured with no identity.
 */
export async function countOwnerCommitsAfter(options: CountOwnerCommitsOptions): Promise<OwnerCommitCount> {
	// Only a commit id reaches git: a caller's text can never arrive as an option or a rev expression of its own.
	if (!COMMIT_ID.test(options.after)) return { status: "unknown", reason: "unknown_commit" };
	const run = runner(options);
	const owner = await resolveOwner(run);
	if (owner.status === "empty") return { status: "unknown", reason: owner.reason };
	const counted = await run([
		"rev-list",
		"--count",
		"--no-merges",
		"--fixed-strings",
		authorFilter(owner.identity),
		`${options.after}..HEAD`,
	]);
	if (counted.code !== 0) return { status: "unknown", reason: "unknown_commit" };
	const count = Number.parseInt(counted.stdout.trim(), 10);
	if (!Number.isSafeInteger(count) || count < 0) throw new Error("git rev-list --count did not answer a count");
	return { status: "counted", count };
}
