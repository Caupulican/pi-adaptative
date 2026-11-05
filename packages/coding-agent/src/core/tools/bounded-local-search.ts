import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import { INSTALLED_TOOL_METADATA_BOUND } from "../../utils/tools-manager.ts";
import { addResourceIgnoreText, createResourceIgnoreMatcher, type ResourceIgnoreMatcher } from "../resource-ignore.ts";
import { readBoundedLocalText } from "./bounded-local-text.ts";
import { isValidUTF8 } from "./file-encoding-policy.ts";
import { LocalReadSession } from "./local-read-io.ts";
import { resolveInstalledSearchTool } from "./managed-search-tool.ts";
import { type ReadOperation, ReadWorkLimitError } from "./read-operation-context.ts";
import { runReadProcess } from "./read-process.ts";

type IgnoreLayer = { root: string; matcher: ResourceIgnoreMatcher };

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Expected an integer of at least ${minimum}`);
	return Math.min(value, maximum);
}

export function validateBoundedGlob(pattern: string): void {
	if (pattern.length > 256 || /[{}()\\\x00-\x1f]/.test(pattern))
		throw new Error("Bounded search accepts only *, **, ?, and character-class globs (maximum 256 characters)");
}

/** One traversal strategy, shared by find/grep, with local hierarchical ignore semantics. */
async function walk(
	io: LocalReadSession,
	root: string,
	visit: (path: string) => Promise<boolean>,
	includeFdIgnore: boolean,
	cwd: string,
): Promise<void> {
	const initial = await io.stat(root);
	if (!initial) throw new Error("Search path not found");
	if (initial.isFile()) {
		await visit(root);
		return;
	}
	if (!initial.isDirectory()) throw new Error("Search path must be a regular file or directory");
	const loadLayer = async (directory: string): Promise<IgnoreLayer> => {
		const matcher = createResourceIgnoreMatcher();
		for (const name of includeFdIgnore ? [".gitignore", ".ignore", ".fdignore"] : [".gitignore", ".ignore"]) {
			const path = join(directory, name);
			if (!(await io.stat(path))) continue;
			const bytes = await io.readFile(path);
			if (!isValidUTF8(bytes) || bytes.includes(0)) throw new Error("Search ignore rules must be UTF-8 text");
			addResourceIgnoreText(matcher, bytes.toString("utf8"));
		}
		return { root: directory, matcher };
	};
	const ancestors: string[] = [];
	const within = relative(resolve(cwd), root);
	if (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		for (let directory = root; directory !== resolve(cwd); ) {
			directory = dirname(directory);
			ancestors.unshift(directory);
		}
	}
	const inherited: IgnoreLayer[] = [];
	for (const directory of ancestors) inherited.push(await loadLayer(directory));
	const pending: Array<{ path: string; ignores: IgnoreLayer[] }> = [{ path: root, ignores: inherited }];
	while (pending.length > 0) {
		io.operation.assertCurrent();
		const next = pending.pop()!;
		const layer = await loadLayer(next.path);
		const ignores = [...next.ignores, layer];
		const members = await io.list(next.path);
		for (const entry of members) {
			if (entry.name === ".git" || entry.kind === "link" || entry.kind === "other") continue;
			const path = join(next.path, entry.name);
			let ignored = false;
			for (const rule of ignores) {
				const verdict = rule.matcher.test(
					relative(rule.root, path).replaceAll("\\", "/") + (entry.kind === "dir" ? "/" : ""),
				);
				if (verdict.ignored) ignored = true;
				else if (verdict.unignored) ignored = false;
			}
			if (ignored) continue;
			if (entry.kind === "dir") pending.push({ path, ignores });
			else if (!(await visit(path))) return;
		}
		if (io.partial) return;
	}
}

export async function boundedFind(
	operation: ReadOperation,
	root: string,
	input: { pattern: string; limit?: number; ignoreCase?: boolean },
	cwd: string,
): Promise<{ paths: string[]; partial: boolean; publish(text: string, partial?: boolean): void }> {
	validateBoundedGlob(input.pattern);
	const io = new LocalReadSession(operation);
	const paths: string[] = [];
	const limit = boundedInteger(input.limit, 1000, 1, 1000);
	const pattern = input.pattern === "." ? "**/*" : input.pattern;
	try {
		await walk(
			io,
			root,
			async (file) => {
				const name = relative(root, file).replaceAll("\\", "/") || basename(file);
				if (
					minimatch(name, pattern, {
						matchBase: true,
						dot: true,
						nobrace: true,
						noext: true,
						nocase: input.ignoreCase,
					})
				) {
					paths.push(name);
					if (paths.length >= limit) {
						io.partial = true;
						return false;
					}
				}
				return true;
			},
			true,
			cwd,
		);
	} catch (error) {
		if (!(error instanceof ReadWorkLimitError)) throw error;
		io.partial = true;
	}
	return {
		paths,
		partial: io.partial,
		publish: (text, partial) => io.publish(root, JSON.stringify(input), text, partial ? "partial" : undefined),
	};
}

export async function boundedGrep(
	operation: ReadOperation,
	root: string,
	input: { pattern: string; glob?: string; limit?: number; context?: number; ignoreCase?: boolean; literal?: boolean },
	cwd: string,
	excludeFile?: (absolutePath: string) => boolean,
): Promise<{ text: string; partial: boolean; publish(text: string, partial?: boolean): void }> {
	if (input.pattern.length > 4096 || input.pattern.includes("\0") || input.pattern.includes("\n"))
		throw new Error("Bounded grep requires a single-line pattern of at most 4096 characters");
	if (input.glob) validateBoundedGlob(input.glob);
	const io = new LocalReadSession(operation);
	// Resolution is a fixed-size prerequisite, never a version subprocess or provisioning call.
	operation.charge("metadata", INSTALLED_TOOL_METADATA_BOUND);
	const binary = resolveInstalledSearchTool("rg");
	const lines: string[] = [];
	const limit = boundedInteger(input.limit, 100, 1, 100);
	const context = boundedInteger(input.context, 0, 0, 10);
	let matches = 0;
	try {
		await walk(
			io,
			resolve(root),
			async (file) => {
				const name = relative(root, file).replaceAll("\\", "/") || basename(file);
				if (input.glob && !minimatch(name, input.glob, { matchBase: true, dot: true, nobrace: true, noext: true }))
					return true;
				// A named file is searched as asked; only files a directory search reaches are skipped.
				if (file !== resolve(root) && excludeFile?.(file)) return true;
				const source = await readBoundedLocalText(io, file, cwd);
				const args = ["--no-config", "--color=never", "--line-number", "--text", `--max-count=${limit - matches}`];
				if (context > 0) args.push(`--context=${context}`);
				if (input.ignoreCase) args.push("--ignore-case");
				if (input.literal) args.push("--fixed-strings");
				args.push("--", input.pattern, "-");
				const result = await runReadProcess(operation, binary, args, {
					cwd: dirname(file),
					input: Buffer.from(source.text, "utf8"),
				});
				if (result.code !== 0 && result.code !== 1 && !result.capped)
					throw new Error(`grep could not evaluate pattern: ${result.stderr.toString("utf8").slice(0, 1024)}`);
				const output = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout, { stream: result.capped });
				if (output.length > 0) {
					// One process per source preserves anchors and newline-less EOF exactly.
					lines.push(`${name}:\n${output.trimEnd()}`);
					matches += output.split("\n").filter((line) => /^\d+:/.test(line)).length;
				}
				if (result.capped || matches >= limit) {
					io.partial = true;
					return false;
				}
				return true;
			},
			false,
			cwd,
		);
	} catch (error) {
		if (!(error instanceof ReadWorkLimitError)) throw error;
		io.partial = true;
	}
	const text = lines.join("\n") || "No matches found in the observed files";
	return {
		text,
		partial: io.partial,
		publish: (result, partial) => io.publish(root, JSON.stringify(input), result, partial ? "partial" : undefined),
	};
}
