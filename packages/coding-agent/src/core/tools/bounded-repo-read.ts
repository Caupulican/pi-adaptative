import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { truncateHead } from "../../kernel/utils/truncate.ts";
import { INSTALLED_TOOL_METADATA_BOUND, resolveInstalledExecutable } from "../../utils/tools-manager.ts";
import { withoutHarnessLaunchEnv } from "../harness-environment.ts";
import { LocalReadSession } from "./local-read-io.ts";
import { boundReadResult, type ReadOperation, readDigest } from "./read-operation-context.ts";
import { runReadProcess } from "./read-process.ts";
import { toolTextResult } from "./render-utils.ts";
import type { RepoReadAction, RepoReadToolInput } from "./repo-read.ts";

const OPTIONS: Partial<Record<RepoReadAction, readonly string[]>> = {
	status: ["--short", "--porcelain", "--porcelain=v1", "--porcelain=v2"],
	log: ["--oneline", "--stat", "--name-only", "--name-status"],
	diff: ["--stat", "--name-only", "--name-status", "--cached", "--staged"],
	show: ["--stat", "--name-only", "--name-status", "--oneline"],
	"ls-files": ["--stage", "--modified", "--deleted"],
	"rev-parse": ["--verify"],
};

const CONFIG = [
	"--no-pager",
	"--literal-pathspecs",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"color.ui=false",
	"-c",
	"log.showSignature=false",
	"-c",
	"diff.external=",
	"-c",
	"diff.renames=false",
	"-c",
	"core.quotePath=true",
	"-c",
	"submodule.recurse=false",
	"-c",
	"diff.submodule=short",
];

/** Git internals are opaque: only native processes, retained output, scope and time are bounded. */
export async function executeBoundedRepoRead(operation: ReadOperation, input: RepoReadToolInput, cwd: string) {
	const allowed = OPTIONS[input.action];
	if (!allowed) throw new Error(`Bounded repo_read does not support ${input.action}`);
	if ((input.options?.length ?? 0) > 8 || input.options?.some((option) => !allowed.includes(option)))
		throw new Error(`Bounded repo_read accepts only these ${input.action} options: ${allowed.join(", ") || "none"}`);
	if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))
		throw new Error("repo_read limit must be a positive integer");
	const runDir = resolve(cwd, input.path ?? ".");
	const paths = input.paths ?? [];
	if (paths.length > 16) throw new Error("Bounded repo_read accepts at most 16 explicit paths");
	if (["status", "diff", "show", "ls-files"].includes(input.action) && paths.length === 0)
		throw new Error("Bounded repo_read requires explicit file or directory paths for this action");
	for (const path of paths) {
		const local = relative(runDir, resolve(runDir, path));
		if (
			!path ||
			/[\x00-\x1f\x7f*?[\]{}:]/.test(path) ||
			path.startsWith("-") ||
			isAbsolute(path) ||
			local === ".." ||
			local.startsWith(`..${sep}`)
		)
			throw new Error("Bounded repo_read requires literal paths inside its directory");
	}
	const revisions = input.revisions ?? [];
	if (
		revisions.length > (input.action === "diff" ? 2 : 1) ||
		revisions.some(
			(revision) =>
				!/^(?:HEAD|[a-fA-F0-9]{40}|[a-fA-F0-9]{64}|refs\/[a-zA-Z0-9_./-]+)$/.test(revision) ||
				revision.includes(".."),
		)
	)
		throw new Error("Bounded repo_read requires HEAD, a full commit hash, or an explicit refs/ name");
	if (["status", "ls-files"].includes(input.action) && revisions.length)
		throw new Error("This repo_read action does not accept revisions");
	const limit = Math.min(input.limit ?? 100, 400);
	const logFileProjection =
		input.action === "log" &&
		input.options?.some((option) => ["--stat", "--name-only", "--name-status"].includes(option)) === true;
	// Git log otherwise reads the whole repository even when cwd is a scoped subdirectory.
	const targetPaths = logFileProjection && paths.length === 0 ? ["."] : paths;
	const nativeEnvironment: NodeJS.ProcessEnv = withoutHarnessLaunchEnv(process.env);
	for (const key of Object.keys(nativeEnvironment))
		if (key.toUpperCase().startsWith("GIT_")) delete nativeEnvironment[key];
	Object.assign(nativeEnvironment, {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_NO_LAZY_FETCH: "1",
		GIT_ALLOW_PROTOCOL: "",
		GIT_PAGER: "cat",
		PAGER: "cat",
		LC_ALL: "C",
	});
	const inspect = async (active: ReadOperation) => {
		const io = new LocalReadSession(active);
		await active.authorizePath(runDir, "directory");
		active.charge("metadata", 1);
		const canonicalDirectory = await realpath(runDir);
		await active.authorizePath(canonicalDirectory, "directory");
		const directory = await io.stat(runDir);
		if (!directory?.isDirectory()) throw new Error("repo_read path must be a directory");
		for (const path of targetPaths) {
			const absolute = resolve(runDir, path);
			await active.authorizePath(absolute, "metadata");
			// The parent is authorized even for a deleted Git path.
			await active.authorizePath(dirname(absolute), "directory");
			// Literal Git pathspecs can recurse, even when this name is a file in today's worktree.
			// The same name may denote a deleted or historical directory in a requested revision.
			await active.authorizeSubtree(absolute);
		}
		active.charge("metadata", INSTALLED_TOOL_METADATA_BOUND);
		const binary = resolveInstalledExecutable(["git"]);
		if (!binary) throw new Error("An installed Git executable is required");
		const run = (args: string[]) =>
			runReadProcess(active, binary, [...CONFIG, ...args], {
				cwd: runDir,
				env: nativeEnvironment,
				outputCap: 128 * 1024,
			});
		const repository = await run(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
		if (repository.code !== 0 || repository.capped) throw new Error("repo_read could not identify its repository");
		const head = await run(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
		if (head.capped) throw new Error("repo_read could not identify HEAD");
		const pins: string[] = [];
		const requested = revisions.length
			? revisions
			: ["log", "show", "rev-parse"].includes(input.action)
				? ["HEAD"]
				: [];
		for (const revision of requested) {
			const pin = await run(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
			const hash = pin.stdout.toString("ascii").trim();
			if (pin.code !== 0 || pin.capped || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash))
				throw new Error("repo_read could not resolve the requested commit");
			pins.push(hash);
		}
		const safety = ["log", "diff", "show"].includes(input.action)
			? ["--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=all"]
			: [];
		const shape =
			input.action === "log"
				? ["--oneline", `--max-count=${Math.min(limit, 20)}`, ...(!logFileProjection ? ["--no-patch"] : [])]
				: input.action === "status"
					? ["--short", "--untracked-files=no", "--ignore-submodules=all"]
					: input.action === "show"
						? ["--format=medium"]
						: [];
		const output = await run([
			input.action,
			...safety,
			...shape,
			...(input.options ?? []),
			...pins,
			...(targetPaths.length ? ["--", ...targetPaths] : []),
		]);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(output.stdout, { stream: output.capped });
		const stderr = new TextDecoder("utf-8", { fatal: true }).decode(output.stderr, { stream: output.capped });
		return {
			output,
			text,
			stderr,
			identity: readDigest(
				JSON.stringify({
					canonicalDirectory,
					directoryVersion: `${directory.dev}:${directory.ino}:${directory.mode}:${directory.mtimeMs}:${directory.ctimeMs}`,
					repository: repository.stdout.toString("base64"),
					head: { code: head.code, value: head.stdout.toString("base64") },
					pins,
					code: output.code,
					capped: output.capped,
					stdout: output.stdout.toString("base64"),
					stderr: output.stderr.toString("base64"),
				}),
			),
		};
	};
	const startedAt = Date.now();
	const result = await inspect(operation);
	if (result.output.code !== 0 && !result.output.capped)
		throw new Error(`git ${input.action}: ${result.stderr.trim().slice(0, 1024) || result.output.code}`);
	const truncation = truncateHead(result.text, { maxLines: limit });
	const partial = result.output.capped || truncation.truncated || input.action === "log";
	let text = truncation.content || "(no output)";
	if (result.stderr.trim()) text += `\n[stderr: ${result.stderr.trim().slice(0, 1024)}]`;
	text += `\n[Native Git read: process count, output and deadline bounded; internal Git I/O is not metered.${partial ? " Partial result." : ""}]`;
	const bounded = boundReadResult(text);
	text = bounded.text;
	operation.observe({
		sourceRef: runDir,
		query: JSON.stringify(input),
		result: text,
		coverage: partial || bounded.truncated ? "partial" : "complete",
		workClass: "native-process",
		revalidate: async (active) => (await inspect(active)).identity === result.identity,
	});
	return toolTextResult({
		text,
		details: {
			action: input.action,
			exitCode: result.output.code,
			durationMs: Date.now() - startedAt,
			capped: result.output.capped,
			truncation,
		},
	});
}
