import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stateFile } from "../agent-paths.ts";
import type { CredentialStorageProvider, MachineCredentialSession } from "./credential-manager.ts";
import { parseDotenvDocument } from "./secret-dotenv.ts";

const MAX_BOOTSTRAP_FILES = 16;
const MAX_BOOTSTRAP_FILE_BYTES = 16 * 1024;
const PROVIDER_ENVIRONMENT_NAMES: ReadonlyArray<{
	name: "BWS_ACCESS_TOKEN" | "BW_SESSION";
	provider: CredentialStorageProvider;
}> = [
	{ name: "BWS_ACCESS_TOKEN", provider: "bitwarden_secrets_manager" },
	{ name: "BW_SESSION", provider: "bitwarden_password_manager" },
];

export interface MachineCredentialSessionDiscoveryOptions {
	environment?: NodeJS.ProcessEnv;
	candidateFiles?: readonly string[];
	signal?: AbortSignal;
}

function validSessionKey(value: string | undefined): string | undefined {
	if (
		value === undefined ||
		value.trim().length === 0 ||
		value.includes("\0") ||
		/[\r\n]/u.test(value) ||
		Buffer.byteLength(value, "utf8") > MAX_BOOTSTRAP_FILE_BYTES
	) {
		return undefined;
	}
	return value;
}

async function readBoundedBootstrapFile(path: string, signal?: AbortSignal): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch {
		return undefined;
	}
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > MAX_BOOTSTRAP_FILE_BYTES) return undefined;
		const buffer = Buffer.allocUnsafe(MAX_BOOTSTRAP_FILE_BYTES + 1);
		try {
			let offset = 0;
			while (offset < buffer.length) {
				if (signal?.aborted) return undefined;
				const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			if (offset > MAX_BOOTSTRAP_FILE_BYTES) return undefined;
			return buffer.subarray(0, offset).toString("utf8");
		} finally {
			buffer.fill(0);
		}
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => {});
	}
}

function sessionFromEnvironment(environment: NodeJS.ProcessEnv): MachineCredentialSession | undefined {
	for (const candidate of PROVIDER_ENVIRONMENT_NAMES) {
		const sessionKey = validSessionKey(environment[candidate.name]);
		if (sessionKey) return { provider: candidate.provider, sessionKey };
	}
	return undefined;
}

function sessionFromDocument(document: string): MachineCredentialSession | undefined {
	let variables: ReturnType<typeof parseDotenvDocument>["variables"] = [];
	try {
		variables = parseDotenvDocument(document).variables;
		const byName = new Map(variables.map((variable) => [variable.name, variable.value]));
		for (const candidate of PROVIDER_ENVIRONMENT_NAMES) {
			const sessionKey = validSessionKey(byName.get(candidate.name));
			if (sessionKey) return { provider: candidate.provider, sessionKey };
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		for (const variable of variables) variable.value = "";
		variables = [];
	}
}

/** Find a machine-owned Bitwarden bootstrap without projecting its value into model-visible metadata. */
export async function discoverMachineCredentialSession(
	options: MachineCredentialSessionDiscoveryOptions = {},
): Promise<MachineCredentialSession | undefined> {
	const environment = options.environment ?? process.env;
	const processSession = sessionFromEnvironment(environment);
	if (processSession) return processSession;

	const files = [...new Set((options.candidateFiles ?? []).map((path) => resolve(path)))].slice(
		0,
		MAX_BOOTSTRAP_FILES,
	);
	let passwordManagerSession: MachineCredentialSession | undefined;
	for (const file of files) {
		if (options.signal?.aborted) return undefined;
		let document = await readBoundedBootstrapFile(file, options.signal);
		if (document === undefined) continue;
		try {
			const session = sessionFromDocument(document);
			if (session?.provider === "bitwarden_secrets_manager") return session;
			passwordManagerSession ??= session;
		} finally {
			document = "";
		}
	}
	return passwordManagerSession;
}

/** Exact bootstrap files the runtime may consume and must deny to model-facing file tools. */
export function getMachineCredentialBootstrapFiles(
	agentDir: string,
	environment: NodeJS.ProcessEnv = process.env,
): string[] {
	const userHome = homedir();
	const configRoot = environment.XDG_CONFIG_HOME ? resolve(environment.XDG_CONFIG_HOME) : join(userHome, ".config");
	return [
		stateFile(agentDir, "secrets", "bws.env"),
		stateFile(agentDir, "secrets", "bw.env"),
		join(agentDir, "bws.env"),
		join(configRoot, "bws", "bws.env"),
		join(configRoot, "bws", "env"),
		join(configRoot, "bitwarden", "bws.env"),
		join(configRoot, "bitwarden-sm", "bws.env"),
		join(userHome, ".bws", "bws.env"),
	];
}

/** Bounded machine roots searched for migratable credential files after the project tree. */
export function getMachineCredentialDiscoveryRoots(
	agentDir: string,
	environment: NodeJS.ProcessEnv = process.env,
): string[] {
	return [
		agentDir,
		...new Set(getMachineCredentialBootstrapFiles(agentDir, environment).map((path) => dirname(path))),
	];
}
