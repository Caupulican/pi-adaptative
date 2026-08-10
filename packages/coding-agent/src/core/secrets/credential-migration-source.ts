import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { CredentialVariable } from "./credential-manager.ts";
import {
	MAX_DOTENV_DOCUMENT_BYTES,
	MAX_DOTENV_VALUE_BYTES,
	MAX_DOTENV_VARIABLES,
	parseDotenvDocument,
	validateDotenvValue,
	validateDotenvVariableName,
} from "./secret-dotenv.ts";

const MAX_SOURCE_PATH_CHARS = 4096;

export type CredentialMigrationSource =
	| { kind: "environment"; name: string }
	| { kind: "dotenv_file"; path: string }
	| { kind: "file"; path: string; variable: string };

export type CredentialMigrationSourceResolver = (
	sources: readonly CredentialMigrationSource[],
	cwd: string,
	signal?: AbortSignal,
) => Promise<CredentialVariable[]>;

export type CredentialMigrationSourceErrorCode =
	| "duplicate_variable"
	| "invalid_source"
	| "source_not_found"
	| "source_unavailable";

export class CredentialMigrationSourceError extends Error {
	readonly code: CredentialMigrationSourceErrorCode;

	constructor(code: CredentialMigrationSourceErrorCode, message: string) {
		super(message);
		this.name = "CredentialMigrationSourceError";
		this.code = code;
	}
}

async function readBoundedCredentialFile(
	rawPath: string,
	cwd: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<string> {
	if (rawPath.length === 0 || rawPath.length > MAX_SOURCE_PATH_CHARS || rawPath.includes("\0")) {
		throw new CredentialMigrationSourceError("invalid_source", "Credential source path is invalid.");
	}
	const path = resolve(cwd, rawPath);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch {
		throw new CredentialMigrationSourceError("source_unavailable", "Credential source file could not be opened.");
	}
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > maxBytes) {
			throw new CredentialMigrationSourceError(
				"invalid_source",
				"Credential source must be a regular file within the supported size limit.",
			);
		}
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		try {
			let offset = 0;
			while (offset < buffer.length) {
				if (signal?.aborted) {
					throw new CredentialMigrationSourceError("source_unavailable", "Credential migration cancelled.");
				}
				const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			if (offset > maxBytes) {
				throw new CredentialMigrationSourceError(
					"invalid_source",
					"Credential source must be a regular file within the supported size limit.",
				);
			}
			return buffer.subarray(0, offset).toString("utf8");
		} finally {
			buffer.fill(0);
		}
	} catch (error) {
		if (error instanceof CredentialMigrationSourceError) throw error;
		throw new CredentialMigrationSourceError("source_unavailable", "Credential source file could not be read.");
	} finally {
		await handle.close().catch(() => {});
	}
}

export async function resolveCredentialMigrationSources(
	sources: readonly CredentialMigrationSource[],
	cwd: string,
	signal?: AbortSignal,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<CredentialVariable[]> {
	if (sources.length === 0 || sources.length > MAX_DOTENV_VARIABLES) {
		throw new CredentialMigrationSourceError("invalid_source", "Credential migration requires 1-64 sources.");
	}
	const variables: CredentialVariable[] = [];
	try {
		for (const source of sources) {
			if (signal?.aborted) {
				throw new CredentialMigrationSourceError("source_unavailable", "Credential migration cancelled.");
			}
			if (source.kind === "environment") {
				const name = validateDotenvVariableName(source.name);
				if (!Object.hasOwn(environment, name)) {
					throw new CredentialMigrationSourceError(
						"source_not_found",
						`Credential environment variable ${name} is unavailable.`,
					);
				}
				const value = environment[name];
				if (typeof value !== "string") {
					throw new CredentialMigrationSourceError(
						"source_not_found",
						`Credential environment variable ${name} is unavailable.`,
					);
				}
				variables.push({ name, value: validateDotenvValue(value) });
			} else if (source.kind === "dotenv_file") {
				const document = await readBoundedCredentialFile(source.path, cwd, MAX_DOTENV_DOCUMENT_BYTES, signal);
				variables.push(...parseDotenvDocument(document).variables);
			} else if (source.kind === "file") {
				const name = validateDotenvVariableName(source.variable);
				const value = await readBoundedCredentialFile(source.path, cwd, MAX_DOTENV_VALUE_BYTES, signal);
				variables.push({ name, value: validateDotenvValue(value) });
			} else {
				throw new CredentialMigrationSourceError("invalid_source", "Credential migration source is invalid.");
			}
			if (variables.length > MAX_DOTENV_VARIABLES) {
				throw new CredentialMigrationSourceError("invalid_source", "Credential migration exceeds 64 variables.");
			}
		}
		const names = new Set<string>();
		for (const variable of variables) {
			if (names.has(variable.name)) {
				throw new CredentialMigrationSourceError(
					"duplicate_variable",
					`Credential migration defines ${variable.name} more than once.`,
				);
			}
			names.add(variable.name);
		}
		return variables;
	} catch (error) {
		for (const variable of variables) variable.value = "";
		throw error instanceof CredentialMigrationSourceError
			? error
			: new CredentialMigrationSourceError("invalid_source", "Credential source data is invalid.");
	}
}
