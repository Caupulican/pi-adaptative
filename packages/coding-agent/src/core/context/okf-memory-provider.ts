import { createHash } from "node:crypto";
import { lstatSync, opendirSync, type Stats } from "node:fs";
import { join, relative } from "node:path";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import { observeMemoryDirectory, readObservedMemoryFileSync } from "../memory/memory-file-read.ts";
import {
	assertMemoryReadActive,
	INCOMPLETE_MEMORY_READ,
	type MemoryReadContext,
} from "../memory/memory-read-context.ts";
import { sameFileVersion } from "../util/bounded-file.ts";
import type { MemoryScope } from "./context-item.ts";
import { fetchLocalMemoryItem, searchLocalMemoryItems, tokenOverlapScore } from "./local-memory-search.ts";
import type {
	MemoryItem,
	MemoryItemKind,
	MemoryProvider,
	MemoryProviderCapabilities,
	MemoryRef,
	MemorySearchRequest,
	MemorySearchResult,
} from "./memory-provider-contract.ts";
import {
	type OkfMemoryDiagnostic,
	type ParsedOkfMemoryDocument,
	PI_OKF_PROVIDER_ID,
	parseOkfMemoryDocument,
} from "./okf-memory.ts";

export interface OkfMemoryProviderOptions {
	rootDir: string;
	providerId?: string;
	maxFileBytes?: number;
	maxDocuments?: number;
	/** Current workspace identity. When set, foreign project-scoped records are excluded. */
	projectId?: string;
	projectRoot?: string;
}

export interface OkfMemoryLoadEntry {
	path: string;
	relativePath: string;
	parsed: ParsedOkfMemoryDocument;
}

export interface OkfMemoryLoadReport {
	entries: OkfMemoryLoadEntry[];
	diagnostics: Array<{ path: string; diagnostics: OkfMemoryDiagnostic[] }>;
}

const DEFAULT_MAX_FILE_BYTES = 512_000;
const DEFAULT_MAX_DOCUMENTS = 1_000;
const MAX_DIRECTORY_ENTRIES = 4_096;
const MAX_DIRECTORIES = 256;
const OKF_EXTENSIONS = [".okf.md", ".okf", ".md"];

const OKF_PROVIDER_CAPABILITIES: MemoryProviderCapabilities = {
	search: true,
	fetch: true,
	write: false,
	delete: false,
	shortTerm: false,
	longTerm: true,
	graph: false,
	citations: true,
	scopes: ["session", "project", "user", "global"],
	localOnly: true,
};

function isOkfPath(path: string): boolean {
	return OKF_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function walkFiles(rootDir: string, maxDocuments: number, projectId?: string, context?: MemoryReadContext): string[] {
	const files: string[] = [];
	const directories = new Map<string, Stats>();
	let complete = true;
	assertMemoryReadActive(context);
	observeMemoryDirectory(rootDir, context);
	const pending = [rootDir];
	const visitedDirectories = new Set<string>();
	try {
		const root = lstatSync(rootDir);
		if (!root.isDirectory() || root.isSymbolicLink()) return files;
	} catch {
		return files;
	}
	// Reserve the bounded discovery budget for the selected workspace before global/foreign
	// records consume it. Both directory components must be real directories, never symlinks.
	if (projectId && projectId !== "." && projectId !== ".." && !/[\\/]/.test(projectId)) {
		const projectsDir = join(rootDir, "projects");
		const selectedDir = join(projectsDir, projectId.toLowerCase());
		try {
			if (
				[projectsDir, selectedDir].every((path) => {
					const entry = lstatSync(path);
					return entry.isDirectory() && !entry.isSymbolicLink();
				})
			)
				pending.push(selectedDir);
		} catch {
			// Missing project storage leaves ordinary bounded discovery available.
		}
	}
	while (pending.length > 0 && files.length < maxDocuments && visitedDirectories.size < MAX_DIRECTORIES) {
		assertMemoryReadActive(context);
		const dir = pending.pop();
		if (dir === undefined || visitedDirectories.has(dir)) continue;
		visitedDirectories.add(dir);
		let directory: ReturnType<typeof opendirSync>;
		try {
			observeMemoryDirectory(dir, context);
			directories.set(dir, lstatSync(dir));
			directory = opendirSync(dir);
		} catch {
			complete = false;
			continue;
		}
		try {
			const entries: Array<{ name: string; directory: boolean; file: boolean }> = [];
			for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
				assertMemoryReadActive(context);
				if (entries.length >= MAX_DIRECTORY_ENTRIES) {
					complete = false;
					break;
				}
				if (entry.isSymbolicLink()) continue;
				entries.push({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() });
			}
			entries.sort((left, right) => left.name.localeCompare(right.name));
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.directory) pending.push(path);
				else if (entry.file && isOkfPath(path)) {
					files.push(path);
					if (files.length >= maxDocuments) break;
				}
			}
		} finally {
			directory.closeSync();
		}
	}
	complete &&= pending.length === 0 && files.length < maxDocuments;
	const revision = createHash("sha256").update(JSON.stringify(files)).digest("hex");
	const isCurrent = (): boolean => {
		try {
			return [...directories].every(([path, version]) => sameFileVersion(version, lstatSync(path)));
		} catch {
			return false;
		}
	};
	context?.observe?.({
		sources: Object.freeze([Object.freeze({ kind: "managed", ref: rootDir, revision })]),
		complete,
		isCurrent,
		revalidate: async (next) => {
			assertMemoryReadActive(next);
			const current = walkFiles(rootDir, maxDocuments, projectId, {
				signal: next.signal,
				deadlineAt: next.deadlineAt,
			});
			return isCurrent() && revision === createHash("sha256").update(JSON.stringify(current)).digest("hex");
		},
	});
	return files;
}

function isPortableAbsolutePath(value: string): boolean {
	return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function belongsToSelectedProject(
	entry: OkfMemoryLoadEntry,
	options: Pick<OkfMemoryProviderOptions, "projectId" | "projectRoot">,
): boolean {
	const item = entry.parsed.item;
	if (item === undefined) return false;
	if (options.projectId === undefined) return true;
	if (item.scope === "user" || item.scope === "global") return true;
	if (item.scope !== "project") return false;
	if (entry.parsed.projectId !== undefined) return entry.parsed.projectId === options.projectId.toLowerCase();
	const normalizedRelativePath = entry.relativePath.replaceAll("\\", "/");
	if (normalizedRelativePath.startsWith(`projects/${options.projectId.toLowerCase()}/`)) return true;
	const projectRoot = options.projectRoot;
	if (projectRoot === undefined) return false;
	return item.evidenceRefs.some(
		(ref) => ref.type === "external" && isPortableAbsolutePath(ref.id) && isPathWithinScope(ref.id, projectRoot),
	);
}

function scoreItem(queryTokens: ReadonlySet<string>, item: MemoryItem): number {
	return tokenOverlapScore(queryTokens, [item.title, item.summary, item.content]);
}

function reasonForMatch(score: number, item: MemoryItem): string {
	return `local OKF match score ${score.toFixed(3)} for ${item.providerId}/${item.scope}/${item.kind}`;
}

export function loadOkfMemoryBundle(
	options: OkfMemoryProviderOptions,
	context?: MemoryReadContext,
): OkfMemoryLoadReport {
	const providerId = options.providerId ?? PI_OKF_PROVIDER_ID;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxDocuments = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
	const entries: OkfMemoryLoadEntry[] = [];
	const diagnostics: Array<{ path: string; diagnostics: OkfMemoryDiagnostic[] }> = [];

	for (const path of walkFiles(options.rootDir, maxDocuments, options.projectId, context)) {
		assertMemoryReadActive(context);
		let content: string;
		try {
			const read = readObservedMemoryFileSync(path, maxFileBytes, "OKF memory document", context);
			if (read === undefined) continue;
			content = read;
		} catch {
			assertMemoryReadActive(context);
			context?.observe?.(INCOMPLETE_MEMORY_READ);
			continue;
		}

		const relativePath = relative(options.rootDir, path);
		const parsed = parseOkfMemoryDocument(content, {
			providerId,
			uri: `okf:${relativePath}`,
			fallbackId: relativePath,
		});
		if (parsed.diagnostics.length > 0) diagnostics.push({ path, diagnostics: parsed.diagnostics });
		const entry = { path, relativePath, parsed };
		if (parsed.item !== undefined && belongsToSelectedProject(entry, options)) entries.push(entry);
	}

	return { entries, diagnostics };
}

export function createOkfMemoryProvider(options: OkfMemoryProviderOptions): MemoryProvider {
	function items(context?: MemoryReadContext): MemoryItem[] {
		return loadOkfMemoryBundle(options, context).entries.flatMap((entry) =>
			entry.parsed.item === undefined ? [] : [entry.parsed.item],
		);
	}

	return {
		id: options.providerId ?? PI_OKF_PROVIDER_ID,
		label: "Pi OKF Memory",
		source: "pi_native",
		capabilities: OKF_PROVIDER_CAPABILITIES,

		async search(request: MemorySearchRequest, context?: MemoryReadContext): Promise<MemorySearchResult[]> {
			return searchLocalMemoryItems(items(context), request, { score: scoreItem, reason: reasonForMatch }, context);
		},

		async fetch(ref: MemoryRef, context?: MemoryReadContext): Promise<MemoryItem | undefined> {
			return fetchLocalMemoryItem(items(context), options.providerId ?? PI_OKF_PROVIDER_ID, ref);
		},
	};
}

export function listOkfMemoryScopes(report: OkfMemoryLoadReport): MemoryScope[] {
	return Array.from(
		new Set(report.entries.flatMap((entry) => (entry.parsed.item ? [entry.parsed.item.scope] : []))),
	).sort();
}

export function listOkfMemoryKinds(report: OkfMemoryLoadReport): MemoryItemKind[] {
	return Array.from(
		new Set(report.entries.flatMap((entry) => (entry.parsed.item ? [entry.parsed.item.kind] : []))),
	).sort();
}
