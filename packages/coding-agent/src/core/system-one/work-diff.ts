/**
 * Repository outcome evidence measured from the actual pre-mutation working tree. Existing owner
 * changes are part of the baseline, including untracked files. Snapshotting uses a private index;
 * neither the checkout's index nor HEAD changes.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { bindChildProcessAbort, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { withoutInheritedGitLocation } from "../exec.ts";
import { parseRepositoryHeadRecord } from "../objective-execution/repository-head-state.ts";
import { createProcessScratchDirectory } from "../process-scratch.ts";
import { type AddedSuppression, addedSuppressions } from "./suppression-scan.ts";

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
	/**
	 * Lint and type-check suppressions the work adds, scanned over the whole diff: the content of new files and
	 * every change past the {@link WORK_DIFF_PATCH_LIMIT} patch bound, which `patch` itself does not carry.
	 * Absent when the source did not scan (the check then reads `patch`).
	 */
	readonly suppressions?: readonly AddedSuppression[];
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
/** Suppression hits kept; every path with a hit is still listed before the cap is reached. */
export const WORK_DIFF_SUPPRESSION_LIMIT = 500;
const GIT_TIMEOUT_MS = 20_000;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const HASH_OBJECT_BATCH_PATHS = 256;
const HASH_OBJECT_BATCH_ARGUMENT_UNITS = process.platform === "win32" ? 24 * 1024 : 64 * 1024;

export interface WorkEvidenceOperationOptions {
	readonly signal?: AbortSignal;
	/** Absolute monotonic wall-clock deadline shared by every operation in one observation. */
	readonly deadline?: number;
}

type WorkEvidenceFailureKind = "aborted" | "timeout" | "command" | "filesystem" | "unstable" | "invalid";

export class WorkEvidenceError extends Error {
	readonly stage: string;
	readonly kind: WorkEvidenceFailureKind;
	readonly detail: string;

	constructor(stage: string, kind: WorkEvidenceFailureKind, detail: string, cause?: unknown) {
		super(`Repository work evidence failed at ${stage} (${kind}): ${detail}`, { cause });
		this.name = "WorkEvidenceError";
		this.stage = stage;
		this.kind = kind;
		this.detail = detail;
	}
}

function boundedDetail(value: unknown): string {
	const text = value instanceof Error ? value.message : String(value);
	return text
		.replace(/[\u0000-\u001F\u007F]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 384);
}

export function workEvidenceDiagnostic(error: unknown): string {
	if (error instanceof WorkEvidenceError)
		return `repository_work_${error.kind}:${error.stage}:${error.detail}`.slice(0, 512);
	return `repository_work_unavailable:unknown:${boundedDetail(error) || "unknown failure"}`.slice(0, 512);
}

function remainingTimeout(options: WorkEvidenceOperationOptions): number {
	options.signal?.throwIfAborted();
	if (options.deadline === undefined) return GIT_TIMEOUT_MS;
	const remaining = options.deadline - Date.now();
	if (remaining <= 0) throw new WorkEvidenceError("deadline", "timeout", "aggregate deadline expired");
	return Math.min(GIT_TIMEOUT_MS, remaining);
}

function hashArgumentUnits(path: string): number {
	return (process.platform === "win32" ? path.length : Buffer.byteLength(path)) + 1;
}

async function git(
	stage: string,
	cwd: string,
	args: readonly string[],
	input?: string,
	env: NodeJS.ProcessEnv = { ...withoutInheritedGitLocation(), LC_ALL: "C" },
	options: WorkEvidenceOperationOptions = {},
): Promise<string> {
	const timeoutMs = remainingTimeout(options);
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn("git", [...args], {
			cwd,
			env,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
	} catch (error) {
		throw new WorkEvidenceError(stage, "command", boundedDetail(error), error);
	}
	if (options.signal) bindChildProcessAbort(child, options.signal);
	let stdinError: unknown;
	let stdinSettlement: Promise<void> = Promise.resolve();
	if (input !== undefined && child.stdin) {
		const stdin = child.stdin;
		stdinSettlement = new Promise((resolve) => {
			let settled = false;
			const settle = () => {
				if (settled) return;
				settled = true;
				resolve();
			};
			stdin.once("finish", settle);
			stdin.once("close", settle);
			stdin.on("error", (error) => {
				stdinError ??= error;
				settle();
			});
		});
		try {
			stdin.end(input);
		} catch (error) {
			stdinError = error;
			stdin.destroy();
		}
	}
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	child.stdout?.on("data", (chunk: Buffer) => {
		stdoutBytes += chunk.length;
		if (stdoutBytes <= GIT_OUTPUT_LIMIT) stdout.push(chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
		if (stderrBytes <= GIT_OUTPUT_LIMIT) stderr.push(chunk);
	});
	let terminal: Awaited<ReturnType<typeof waitForChildProcessWithTermination>>;
	try {
		terminal = await waitForChildProcessWithTermination(child, {
			timeoutMs,
			killGraceMs: 1_000,
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (error) {
		child.stdin?.destroy();
		await stdinSettlement;
		throw new WorkEvidenceError(stage, "command", boundedDetail(error), error);
	}
	child.stdin?.destroy();
	await stdinSettlement;
	if (stdoutBytes > GIT_OUTPUT_LIMIT || stderrBytes > GIT_OUTPUT_LIMIT)
		throw new WorkEvidenceError(stage, "command", "git output exceeded the 64 MiB evidence bound");
	if (terminal.reason === "aborted")
		throw new WorkEvidenceError(stage, "aborted", boundedDetail(options.signal?.reason ?? "operation aborted"));
	if (terminal.reason === "timeout")
		throw new WorkEvidenceError(
			stage,
			"timeout",
			boundedDetail(`git ${args[0] ?? "command"} exceeded ${timeoutMs}ms`),
		);
	if (stdinError)
		throw new WorkEvidenceError(stage, "command", `git input failed: ${boundedDetail(stdinError)}`, stdinError);
	if (terminal.code !== 0) {
		const detail = Buffer.concat(stderr).toString("utf8").trim();
		throw new WorkEvidenceError(
			stage,
			"command",
			boundedDetail(detail || `git exited with code ${terminal.code ?? "unknown"}`),
		);
	}
	return Buffer.concat(stdout).toString("utf8");
}

export function discoverWorkRepository(cwd: string): { readonly root?: string; readonly diagnostic?: string } {
	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			env: { ...withoutInheritedGitLocation(), LC_ALL: "C" },
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: GIT_OUTPUT_LIMIT,
			timeout: GIT_TIMEOUT_MS,
		}).trim();
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

/** Non-blocking repository discovery for tool admission and completion evidence paths. */
export async function discoverWorkRepositoryAsync(
	cwd: string,
	options: WorkEvidenceOperationOptions = {},
): Promise<{ readonly root?: string; readonly diagnostic?: string }> {
	try {
		const root = (await git("discover", cwd, ["rev-parse", "--show-toplevel"], undefined, undefined, options)).trim();
		return root ? { root } : { diagnostic: "repository_discovery_empty" };
	} catch (error) {
		if (
			error instanceof WorkEvidenceError &&
			/^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point [^)]*)\)/m.test(
				error.detail,
			)
		)
			return {};
		return { diagnostic: workEvidenceDiagnostic(error) };
	}
}

export function readWorkRepositoryRoot(cwd: string): string | undefined {
	return discoverWorkRepository(cwd).root;
}

/** Session baselines must survive Git garbage collection throughout a resumed objective. */
export async function retainWorkBaseline(
	baseline: WorkBaseline,
	identity: string,
	options: WorkEvidenceOperationOptions = {},
): Promise<void> {
	const key = createHash("sha256").update(identity).digest("hex");
	await git(
		"retain",
		baseline.root,
		["update-ref", `refs/pi/work-baselines/${key}`, baseline.tree],
		undefined,
		undefined,
		options,
	);
}

/** Captures tracked and untracked bytes without staging anything in the real index. */
export async function captureWorkBaseline(
	cwd: string,
	options: WorkEvidenceOperationOptions = {},
): Promise<WorkBaseline> {
	let scratch: string | undefined;
	let baseline: WorkBaseline | undefined;
	let failure: WorkEvidenceError | undefined;
	try {
		const root = (await git("discover", cwd, ["rev-parse", "--show-toplevel"], undefined, undefined, options)).trim();
		if (!root) throw new WorkEvidenceError("discover", "invalid", "git returned an empty repository root");
		const readHead = async (): Promise<string | undefined> =>
			(
				await git(
					"head_fence",
					root,
					["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"],
					undefined,
					undefined,
					options,
				)
			)
				.split("\0")
				.map(parseRepositoryHeadRecord)
				.find((head) => head !== undefined);
		const revision = await readHead();
		if (!revision) throw new WorkEvidenceError("head_fence", "invalid", "repository revision is unavailable");
		scratch = createProcessScratchDirectory("pi-work-snapshot-");
		const env = { ...withoutInheritedGitLocation(), GIT_INDEX_FILE: join(scratch, "index") };
		await git(
			"read_tree",
			root,
			revision === "unborn" ? ["read-tree", "--empty"] : ["read-tree", revision],
			undefined,
			env,
			options,
		);
		const paths = new Set([
			...(
				await git(
					"changed_paths",
					root,
					revision === "unborn"
						? ["ls-files", "--cached", "-z"]
						: ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", revision, "--"],
					undefined,
					undefined,
					options,
				)
			).split("\0"),
			...(
				await git(
					"untracked_paths",
					root,
					["ls-files", "--others", "--exclude-standard", "-z"],
					undefined,
					undefined,
					options,
				)
			).split("\0"),
		]);
		paths.delete("");
		const modes = new Map(
			(await git("index_modes", root, ["ls-files", "--stage", "-z"], undefined, undefined, options))
				.split("\0")
				.filter(Boolean)
				.map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, 6)] as const),
		);
		const fileMode =
			(await git("file_mode", root, ["config", "--get", "core.filemode"], undefined, undefined, options)).trim() !==
			"false";
		const entries: string[] = [];
		const regularFiles: { readonly path: string; readonly mode: string }[] = [];
		for (const path of paths) {
			options.signal?.throwIfAborted();
			remainingTimeout(options);
			const absolute = join(root, path);
			let stat: Awaited<ReturnType<typeof lstat>>;
			try {
				stat = await lstat(absolute);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				entries.push(`0 ${"0".repeat(40)}\t${path}\0`);
				continue;
			}
			let mode: string;
			let hash: string;
			if (stat.isSymbolicLink()) {
				mode = "120000";
				hash = (
					await git(
						"hash_symlink",
						root,
						["hash-object", "-w", "--stdin", "--no-filters"],
						await readlink(absolute),
						undefined,
						options,
					)
				).trim();
			} else if (stat.isDirectory() && modes.get(path) === "160000") {
				mode = "160000";
				hash = (await git("hash_submodule", absolute, ["rev-parse", "HEAD"], undefined, undefined, options)).trim();
			} else if (stat.isFile()) {
				mode = !fileMode && modes.has(path) ? modes.get(path)! : stat.mode & 0o111 ? "100755" : "100644";
				regularFiles.push({ path, mode });
				continue;
			} else {
				throw new Error(`Unsupported repository entry: ${path}`);
			}
			entries.push(`${mode} ${hash}\t${path}\0`);
		}
		for (let start = 0; start < regularFiles.length; ) {
			let end = start;
			let argumentUnits = 0;
			while (end < regularFiles.length && end - start < HASH_OBJECT_BATCH_PATHS) {
				const nextUnits = hashArgumentUnits(regularFiles[end]!.path);
				if (end > start && argumentUnits + nextUnits > HASH_OBJECT_BATCH_ARGUMENT_UNITS) break;
				argumentUnits += nextUnits;
				end++;
			}
			const batch = regularFiles.slice(start, end);
			const hashes = (
				await git(
					"hash_files",
					root,
					["hash-object", "-w", "--no-filters", "--", ...batch.map((file) => file.path)],
					undefined,
					undefined,
					options,
				)
			)
				.trim()
				.split("\n")
				.filter(Boolean);
			if (hashes.length !== batch.length)
				throw new WorkEvidenceError(
					"hash_files",
					"invalid",
					`git returned ${hashes.length} hashes for ${batch.length} paths`,
				);
			for (let index = 0; index < batch.length; index++) {
				const file = batch[index]!;
				entries.push(`${file.mode} ${hashes[index]!}\t${file.path}\0`);
			}
			start = end;
		}
		if (entries.length)
			await git("update_index", root, ["update-index", "-z", "--index-info"], entries.join(""), env, options);
		const tree = (await git("write_tree", root, ["write-tree"], undefined, env, options)).trim();
		if ((await readHead()) !== revision)
			throw new WorkEvidenceError("head_fence", "unstable", "repository revision changed during capture");
		baseline = { root, revision, tree };
	} catch (error) {
		failure =
			error instanceof WorkEvidenceError
				? error
				: new WorkEvidenceError(
						"snapshot",
						options.signal?.aborted ? "aborted" : "filesystem",
						boundedDetail(error),
						error,
					);
	}
	if (scratch) {
		try {
			await rm(scratch, { recursive: true, force: true });
		} catch (cleanupError) {
			failure = new WorkEvidenceError(
				"scratch_cleanup",
				"filesystem",
				boundedDetail(
					failure
						? `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}; prior failure: ${workEvidenceDiagnostic(failure)}`
						: cleanupError,
				),
				failure ? new AggregateError([failure, cleanupError]) : cleanupError,
			);
		}
	}
	if (failure) throw failure;
	if (!baseline) throw new WorkEvidenceError("snapshot", "invalid", "capture produced no baseline");
	return baseline;
}

/**
 * Current bytes against the admitted dirty baseline, restricted to observed mutation paths when
 * supplied. Commits, partial failed writes, additions and deletions remain visible.
 */
export async function readWorkDiff(
	cwd: string,
	baseline: WorkBaseline,
	paths?: readonly string[],
	options: WorkEvidenceOperationOptions = {},
): Promise<WorkDiff> {
	try {
		const current = await captureWorkBaseline(cwd, options);
		if (current.root !== baseline.root) throw new Error("Repository baseline unavailable or scope changed");
		const selected = paths?.length ? paths.map((path) => `:(literal)${path}`) : [];
		const full = await git(
			"diff",
			current.root,
			["diff", "--no-color", "--no-ext-diff", "--no-textconv", baseline.tree, current.tree, "--", ...selected],
			undefined,
			undefined,
			options,
		);
		const additions = await git(
			"added_paths",
			current.root,
			[
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
			],
			undefined,
			undefined,
			options,
		);
		const added = new Set(additions.split("\0").filter(Boolean));
		const untracked = (
			await git(
				"untracked_diff_paths",
				current.root,
				["ls-files", "--others", "--exclude-standard", "-z"],
				undefined,
				undefined,
				options,
			)
		)
			.split("\0")
			.filter((path) => added.has(path));
		return {
			base: baseline.revision,
			patch: full.slice(0, WORK_DIFF_PATCH_LIMIT),
			omittedChars: Math.max(0, full.length - WORK_DIFF_PATCH_LIMIT),
			untracked: untracked.slice(0, WORK_DIFF_UNTRACKED_LIMIT),
			// The whole diff, not the bounded patch: a new file's content is in it, and so is everything the
			// patch bound cuts off. Prose files are skipped by the scan itself.
			suppressions: addedSuppressions(full).slice(0, WORK_DIFF_SUPPRESSION_LIMIT),
		};
	} catch (error) {
		return {
			base: baseline.revision,
			patch: "",
			omittedChars: 0,
			untracked: [],
			diagnostic: workEvidenceDiagnostic(error),
		};
	}
}
