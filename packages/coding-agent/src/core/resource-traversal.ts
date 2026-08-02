import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { addResourceIgnoreRules, type ResourceIgnoreMatcher, toPosixResourcePath } from "./resource-ignore.ts";

export interface ResourceDirectoryRecord {
	readonly name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface ResourceStatRecord {
	isDirectory(): boolean;
	isFile(): boolean;
}

/** Filesystem boundary used by resource discovery and deterministic traversal tests. */
export interface ResourceTraversalPort {
	pathExists(path: string): boolean;
	readDirectory(path: string): readonly ResourceDirectoryRecord[];
	stat(path: string): ResourceStatRecord;
}

const NODE_RESOURCE_TRAVERSAL_PORT: ResourceTraversalPort = {
	pathExists: existsSync,
	readDirectory: (path) => readdirSync(path, { withFileTypes: true }),
	stat: statSync,
};

export interface ResourceDirectoryEntry {
	name: string;
	path: string;
	isDirectory: boolean;
	isFile: boolean;
	isSymbolicLink: boolean;
}

export interface ResourceTraversalOptions {
	followSymbolicLinks?: boolean;
	ignoreMatcher?: ResourceIgnoreMatcher;
	onDirectoryReadError?: (path: string, error: unknown) => void;
	port?: ResourceTraversalPort;
	rootDir?: string;
	skipHidden?: boolean;
	skipNodeModules?: boolean;
}

/** Lexically classify a path under a resource root without accepting prefix-sharing siblings. */
export function isResourcePathWithin(target: string, root: string): boolean {
	const relativePath = relative(resolve(root), resolve(target));
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

/**
 * Read and classify one directory once. Unreadable directories and broken links are omitted,
 * matching resource discovery's best-effort startup contract.
 */
export function readResourceDirectory(dir: string, options: ResourceTraversalOptions = {}): ResourceDirectoryEntry[] {
	const port = options.port ?? NODE_RESOURCE_TRAVERSAL_PORT;
	if (!port.pathExists(dir)) return [];

	const rootDir = options.rootDir ?? dir;
	if (options.ignoreMatcher) {
		addResourceIgnoreRules(options.ignoreMatcher, dir, rootDir);
	}

	let records: readonly ResourceDirectoryRecord[];
	try {
		records = port.readDirectory(dir);
	} catch (error) {
		options.onDirectoryReadError?.(dir, error);
		return [];
	}

	const entries: ResourceDirectoryEntry[] = [];
	for (const record of records) {
		if (options.skipHidden && record.name.startsWith(".")) continue;
		if (options.skipNodeModules && record.name === "node_modules") continue;

		const path = join(dir, record.name);
		const isSymbolicLink = record.isSymbolicLink();
		let isDirectory = record.isDirectory();
		let isFile = record.isFile();
		if (isSymbolicLink) {
			if (options.followSymbolicLinks === false) continue;
			try {
				const target = port.stat(path);
				isDirectory = target.isDirectory();
				isFile = target.isFile();
			} catch {
				continue;
			}
		}

		if (options.ignoreMatcher) {
			const relativePath = toPosixResourcePath(relative(rootDir, path));
			if (options.ignoreMatcher.ignores(isDirectory ? `${relativePath}/` : relativePath)) continue;
		}

		entries.push({ name: record.name, path, isDirectory, isFile, isSymbolicLink });
	}
	return entries;
}

/** Collect matching files with one accumulator; nested walks never copy completed prefixes. */
export function collectResourceFilesRecursively(
	dir: string,
	matchesFile: (entry: ResourceDirectoryEntry) => boolean,
	options: ResourceTraversalOptions = {},
): string[] {
	const files: string[] = [];
	const rootDir = options.rootDir ?? dir;
	const traversalOptions = options.rootDir === rootDir ? options : { ...options, rootDir };

	const visit = (currentDir: string): void => {
		for (const entry of readResourceDirectory(currentDir, traversalOptions)) {
			if (entry.isDirectory) {
				visit(entry.path);
			} else if (entry.isFile && matchesFile(entry)) {
				files.push(entry.path);
			}
		}
	};

	visit(dir);
	return files;
}
