import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join, relative } from "node:path";
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

function walkFiles(rootDir: string, maxDocuments: number): string[] {
	const files: string[] = [];
	const pending = [rootDir];
	while (pending.length > 0 && files.length < maxDocuments) {
		const dir = pending.pop();
		if (dir === undefined) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir).sort();
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(dir, entry);
			let stat: Stats;
			try {
				stat = statSync(path);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				pending.push(path);
			} else if (stat.isFile() && isOkfPath(path)) {
				files.push(path);
				if (files.length >= maxDocuments) break;
			}
		}
	}
	return files;
}

function scoreItem(queryTokens: ReadonlySet<string>, item: MemoryItem): number {
	return tokenOverlapScore(queryTokens, [item.title, item.summary, item.content]);
}

function reasonForMatch(score: number, item: MemoryItem): string {
	return `local OKF match score ${score.toFixed(3)} for ${item.providerId}/${item.scope}/${item.kind}`;
}

export function loadOkfMemoryBundle(options: OkfMemoryProviderOptions): OkfMemoryLoadReport {
	const providerId = options.providerId ?? PI_OKF_PROVIDER_ID;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxDocuments = options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS;
	const entries: OkfMemoryLoadEntry[] = [];
	const diagnostics: Array<{ path: string; diagnostics: OkfMemoryDiagnostic[] }> = [];

	for (const path of walkFiles(options.rootDir, maxDocuments)) {
		let stat: Stats;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		if (stat.size > maxFileBytes) continue;

		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch {
			continue;
		}

		const relativePath = relative(options.rootDir, path);
		const parsed = parseOkfMemoryDocument(content, {
			providerId,
			uri: `okf:${relativePath}`,
			fallbackId: relativePath,
		});
		if (parsed.diagnostics.length > 0) diagnostics.push({ path, diagnostics: parsed.diagnostics });
		if (parsed.item !== undefined) entries.push({ path, relativePath, parsed });
	}

	return { entries, diagnostics };
}

export function createOkfMemoryProvider(options: OkfMemoryProviderOptions): MemoryProvider {
	let cachedReport: OkfMemoryLoadReport | undefined;

	function report(): OkfMemoryLoadReport {
		cachedReport ??= loadOkfMemoryBundle(options);
		return cachedReport;
	}

	function items(): MemoryItem[] {
		return report().entries.flatMap((entry) => (entry.parsed.item === undefined ? [] : [entry.parsed.item]));
	}

	return {
		id: options.providerId ?? PI_OKF_PROVIDER_ID,
		label: "Pi OKF Memory",
		source: "pi_native",
		capabilities: OKF_PROVIDER_CAPABILITIES,

		async search(request: MemorySearchRequest): Promise<MemorySearchResult[]> {
			return searchLocalMemoryItems(items(), request, { score: scoreItem, reason: reasonForMatch });
		},

		async fetch(ref: MemoryRef): Promise<MemoryItem | undefined> {
			return fetchLocalMemoryItem(items(), options.providerId ?? PI_OKF_PROVIDER_ID, ref);
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
