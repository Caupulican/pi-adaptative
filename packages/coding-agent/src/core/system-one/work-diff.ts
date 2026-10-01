/**
 * Repository outcome evidence measured from the actual pre-mutation working tree. Existing owner
 * changes are part of the baseline, including untracked files. Snapshotting uses a private index;
 * neither the checkout's index nor HEAD changes.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutInheritedGitLocation } from "../exec.ts";
import { parseRepositoryHeadRecord } from "../objective-execution/repository-head-state.ts";
import { removeTreeSync } from "../util/remove-tree.ts";

export interface WorkBaseline {
	readonly root: string;
	readonly revision: string;
	readonly tree: string;
}

/** What the completion check reads of the work. */
export interface WorkDiff {
	/** The commit the work is measured from. */
	readonly base: string;
	/** Raw Git tree diff from the admitted working bytes, bounded. */
	readonly patch: string;
	/** Characters of the patch left out to keep the check bounded; 0 when complete. */
	readonly omittedChars: number;
	/** New files git does not track yet, which `git diff` does not show. */
	readonly untracked: readonly string[];
	/** A failed snapshot after an observed mutation is missing evidence, never an empty outcome. */
	readonly diagnostic?: string;
	readonly repositories?: readonly { root: string; base: string }[];
}

/**
 * Whether the goal changed the repository: only then do the code-only completion questions (root
 * cause, scope of the diff, duplicated responsibility, untested regression paths) apply. A goal that
 * changed the machine, a service, or delivered an answer is judged on its outcome evidence alone.
 */
export function hasRepositoryOutcome(work: WorkDiff | undefined, recordedChanges = 0): boolean {
	return (
		recordedChanges > 0 ||
		(work !== undefined &&
			(work.diagnostic !== undefined || work.patch.trim().length > 0 || work.untracked.length > 0))
	);
}

/** Enough for any focused change; larger work is judged on its first part and the file list. */
export const WORK_DIFF_PATCH_LIMIT = 24_000;
export const WORK_DIFF_UNTRACKED_LIMIT = 50;

function git(
	cwd: string,
	args: readonly string[],
	input?: string,
	env: NodeJS.ProcessEnv = { ...withoutInheritedGitLocation(), LC_ALL: "C" },
): string {
	return execFileSync("git", args, {
		cwd,
		env,
		input,
		encoding: "utf-8",
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
		timeout: 20_000,
	});
}

export function discoverWorkRepository(cwd: string): { readonly root?: string; readonly diagnostic?: string } {
	try {
		const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
		return root ? { root } : { diagnostic: "repository_discovery_empty" };
	} catch (error) {
		const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
		if (
			/^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point [^)]*)\)/m.test(
				stderr,
			)
		)
			return {};
		return { diagnostic: "repository_discovery_unavailable" };
	}
}

export function readWorkRepositoryRoot(cwd: string): string | undefined {
	return discoverWorkRepository(cwd).root;
}

/** Session baselines must survive Git garbage collection throughout a resumed objective. */
export function retainWorkBaseline(baseline: WorkBaseline, identity: string): void {
	const key = createHash("sha256").update(identity).digest("hex");
	git(baseline.root, ["update-ref", `refs/pi/work-baselines/${key}`, baseline.tree]);
}

/** Captures tracked and untracked bytes without staging anything in the real index. */
export function captureWorkBaseline(cwd: string): WorkBaseline | undefined {
	let scratch: string | undefined;
	try {
		const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
		const readHead = (): string | undefined =>
			git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"])
				.split("\0")
				.map(parseRepositoryHeadRecord)
				.find((head) => head !== undefined);
		const revision = readHead();
		if (!revision) return undefined;
		scratch = mkdtempSync(join(tmpdir(), "pi-work-snapshot-"));
		const env = { ...withoutInheritedGitLocation(), GIT_INDEX_FILE: join(scratch, "index") };
		git(root, revision === "unborn" ? ["read-tree", "--empty"] : ["read-tree", revision], undefined, env);
		const paths = new Set([
			...git(
				root,
				revision === "unborn"
					? ["ls-files", "--cached", "-z"]
					: ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", revision, "--"],
			).split("\0"),
			...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
		]);
		paths.delete("");
		const modes = new Map(
			git(root, ["ls-files", "--stage", "-z"])
				.split("\0")
				.filter(Boolean)
				.map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, 6)] as const),
		);
		const fileMode = git(root, ["config", "--get", "core.filemode"]).trim() !== "false";
		const entries: string[] = [];
		for (const path of paths) {
			const absolute = join(root, path);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(absolute);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				entries.push(`0 ${"0".repeat(40)}\t${path}\0`);
				continue;
			}
			let mode: string;
			let hash: string;
			if (stat.isSymbolicLink()) {
				mode = "120000";
				hash = git(root, ["hash-object", "-w", "--stdin", "--no-filters"], readlinkSync(absolute)).trim();
			} else if (stat.isDirectory() && modes.get(path) === "160000") {
				mode = "160000";
				hash = git(absolute, ["rev-parse", "HEAD"]).trim();
			} else if (stat.isFile()) {
				mode = !fileMode && modes.has(path) ? modes.get(path)! : stat.mode & 0o111 ? "100755" : "100644";
				hash = git(root, ["hash-object", "-w", "--no-filters", "--", path]).trim();
			} else {
				throw new Error(`Unsupported repository entry: ${path}`);
			}
			entries.push(`${mode} ${hash}\t${path}\0`);
		}
		if (entries.length) git(root, ["update-index", "-z", "--index-info"], entries.join(""), env);
		const tree = git(root, ["write-tree"], undefined, env).trim();
		if (readHead() !== revision) return undefined;
		return { root, revision, tree };
	} catch {
		return undefined;
	} finally {
		if (scratch) removeTreeSync(scratch);
	}
}

/**
 * Current bytes against the admitted dirty baseline, restricted to observed mutation paths when
 * supplied. Commits, partial failed writes, additions and deletions remain visible.
 */
export function readWorkDiff(cwd: string, baseline: WorkBaseline, paths?: readonly string[]): WorkDiff {
	try {
		const current = captureWorkBaseline(cwd);
		if (!current || current.root !== baseline.root)
			throw new Error("Repository baseline unavailable or scope changed");
		const selected = paths?.length ? paths.map((path) => `:(literal)${path}`) : [];
		const full = git(current.root, [
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			baseline.tree,
			current.tree,
			"--",
			...selected,
		]);
		const additions = git(current.root, [
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--name-only",
			"--diff-filter=A",
			"-z",
			baseline.tree,
			current.tree,
			"--",
			...selected,
		]);
		const added = new Set(additions.split("\0").filter(Boolean));
		const untracked = git(current.root, ["ls-files", "--others", "--exclude-standard", "-z"])
			.split("\0")
			.filter((path) => added.has(path));
		return {
			base: baseline.revision,
			patch: full.slice(0, WORK_DIFF_PATCH_LIMIT),
			omittedChars: Math.max(0, full.length - WORK_DIFF_PATCH_LIMIT),
			untracked: untracked.slice(0, WORK_DIFF_UNTRACKED_LIMIT),
		};
	} catch {
		return {
			base: baseline.revision,
			patch: "",
			omittedChars: 0,
			untracked: [],
			diagnostic:
				"Repository outcome evidence is unavailable; recapture and verify the affected work before completion.",
		};
	}
}
