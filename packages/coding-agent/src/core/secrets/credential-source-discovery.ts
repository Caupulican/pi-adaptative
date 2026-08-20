import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { CredentialVariable } from "./credential-manager.ts";
import { type CredentialMigrationSource, resolveCredentialMigrationSources } from "./credential-migration-source.ts";

const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERY_DIRECTORIES = 256;
const MAX_DISCOVERY_ENTRIES = 10_000;
const MAX_DISCOVERY_ENVIRONMENT_CANDIDATES = 32;
const MAX_DISCOVERY_DOTENV_CANDIDATES = 32;
const MAX_DISCOVERY_VARIABLE_NAMES = 256;
const MAX_DISCOVERY_METADATA_BYTES = 64 * 1024;
const EXCLUDED_DIRECTORY_NAMES = new Set([
	".git",
	".hg",
	".svn",
	".cache",
	".next",
	".turbo",
	".yarn",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"target",
	"vendor",
]);
const DOTENV_TEMPLATE_NAME_RE = /(?:^|[._-])(?:defaults?|dist|example|sample|template)(?:$|[._-])/i;
const CREDENTIAL_ENV_NAME_RE =
	/(?:^|_)(?:ACCESS_KEY|API_KEY|CREDENTIALS?|CLIENT_SECRET|PASS|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/i;
const CREDENTIAL_URL_NAME_RE = /^(?:DATABASE|DB|MONGO(?:DB)?|MYSQL|POSTGRES(?:QL)?|REDIS)_URL$/i;
const EXCLUDED_ENVIRONMENT_NAMES = new Set(["BW_SESSION"]);

export type CredentialMigrationDiscoveryErrorCode = "discovery_cancelled" | "discovery_unavailable";

export class CredentialMigrationDiscoveryError extends Error {
	readonly code: CredentialMigrationDiscoveryErrorCode;

	constructor(code: CredentialMigrationDiscoveryErrorCode, message: string) {
		super(message);
		this.name = "CredentialMigrationDiscoveryError";
		this.code = code;
	}
}

export interface CredentialMigrationSourceCandidate {
	source: CredentialMigrationSource;
	variableNames: string[];
}

export interface CredentialMigrationDiscoveryResult {
	candidates: CredentialMigrationSourceCandidate[];
	skipped: number;
	truncated: boolean;
}

export type CredentialMigrationSourceDiscoverer = (
	cwd: string,
	signal?: AbortSignal,
) => Promise<CredentialMigrationDiscoveryResult>;

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new CredentialMigrationDiscoveryError("discovery_cancelled", "Credential discovery was cancelled.");
	}
}

function isCredentialEnvironmentName(name: string): boolean {
	return (
		!EXCLUDED_ENVIRONMENT_NAMES.has(name.toUpperCase()) &&
		(CREDENTIAL_ENV_NAME_RE.test(name) || CREDENTIAL_URL_NAME_RE.test(name))
	);
}

function isDotenvCandidateName(name: string): boolean {
	if (DOTENV_TEMPLATE_NAME_RE.test(name)) return false;
	const lower = name.toLowerCase();
	return lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env");
}

function candidateMetadataBytes(candidate: CredentialMigrationSourceCandidate): number {
	const sourceIdentity =
		candidate.source.kind === "environment"
			? candidate.source.name
			: candidate.source.kind === "file"
				? `${candidate.source.path}\0${candidate.source.variable}`
				: candidate.source.path;
	return (
		Buffer.byteLength(sourceIdentity, "utf8") +
		candidate.variableNames.reduce((total, name) => total + Buffer.byteLength(name, "utf8"), 0)
	);
}

async function inspectSource(
	source: CredentialMigrationSource,
	cwd: string,
	signal: AbortSignal | undefined,
	environment: NodeJS.ProcessEnv,
): Promise<string[] | undefined> {
	let variables: CredentialVariable[] = [];
	try {
		variables = await resolveCredentialMigrationSources([source], cwd, signal, environment);
		return variables.map((variable) => variable.name);
	} catch {
		return undefined;
	} finally {
		for (const variable of variables) variable.value = "";
		variables = [];
	}
}

/**
 * Discover supported credential sources without returning their values. The scan is deliberately
 * bounded to the current working tree plus the current process environment, never follows symlinks,
 * and skips dependency/build trees and dotenv templates.
 */
export async function discoverCredentialMigrationSources(
	cwd: string,
	signal?: AbortSignal,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<CredentialMigrationDiscoveryResult> {
	throwIfCancelled(signal);
	let root: string;
	try {
		root = await realpath(cwd);
		if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new CredentialMigrationDiscoveryError("discovery_unavailable", "Credential discovery root is unavailable.");
	}

	const candidates: CredentialMigrationSourceCandidate[] = [];
	let skipped = 0;
	let truncated = false;
	let environmentCandidateCount = 0;
	let dotenvCandidateCount = 0;
	let variableNameCount = 0;
	let metadataBytes = 0;
	const addCandidate = (
		candidate: CredentialMigrationSourceCandidate,
		category: "environment" | "dotenv",
	): boolean => {
		const categoryCount = category === "environment" ? environmentCandidateCount : dotenvCandidateCount;
		const categoryLimit =
			category === "environment" ? MAX_DISCOVERY_ENVIRONMENT_CANDIDATES : MAX_DISCOVERY_DOTENV_CANDIDATES;
		const nextMetadataBytes = metadataBytes + candidateMetadataBytes(candidate);
		if (
			categoryCount >= categoryLimit ||
			variableNameCount + candidate.variableNames.length > MAX_DISCOVERY_VARIABLE_NAMES ||
			nextMetadataBytes > MAX_DISCOVERY_METADATA_BYTES
		) {
			truncated = true;
			return false;
		}
		candidates.push(candidate);
		if (category === "environment") environmentCandidateCount++;
		else dotenvCandidateCount++;
		variableNameCount += candidate.variableNames.length;
		metadataBytes = nextMetadataBytes;
		return true;
	};

	for (const name of Object.keys(environment).sort((left, right) => left.localeCompare(right))) {
		throwIfCancelled(signal);
		if (!isCredentialEnvironmentName(name)) continue;
		const source = { kind: "environment" as const, name };
		const variableNames = await inspectSource(source, root, signal, environment);
		throwIfCancelled(signal);
		if (!variableNames) {
			skipped++;
			continue;
		}
		if (!addCandidate({ source, variableNames }, "environment")) break;
	}

	const directories: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
	let directoryIndex = 0;
	let visitedEntries = 0;
	let stopDirectoryScan = false;
	while (directoryIndex < directories.length && !stopDirectoryScan) {
		throwIfCancelled(signal);
		if (directoryIndex >= MAX_DISCOVERY_DIRECTORIES) {
			truncated = true;
			break;
		}
		const current = directories[directoryIndex++];
		let entries: Dirent<string>[];
		try {
			entries = await readdir(current.path, { withFileTypes: true });
		} catch {
			skipped++;
			continue;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			throwIfCancelled(signal);
			visitedEntries++;
			if (visitedEntries > MAX_DISCOVERY_ENTRIES) {
				truncated = true;
				stopDirectoryScan = true;
				break;
			}
			if (entry.isSymbolicLink()) continue;
			const path = join(current.path, entry.name);
			if (entry.isDirectory()) {
				if (current.depth < MAX_DISCOVERY_DEPTH && !EXCLUDED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) {
					directories.push({ path, depth: current.depth + 1 });
				}
				continue;
			}
			if (!entry.isFile() || !isDotenvCandidateName(entry.name)) continue;
			const source = { kind: "dotenv_file" as const, path: relative(root, path) };
			const variableNames = await inspectSource(source, root, signal, environment);
			throwIfCancelled(signal);
			if (!variableNames) {
				skipped++;
				continue;
			}
			if (!addCandidate({ source, variableNames }, "dotenv")) {
				stopDirectoryScan = true;
				break;
			}
		}
	}

	throwIfCancelled(signal);
	return { candidates, skipped, truncated };
}
