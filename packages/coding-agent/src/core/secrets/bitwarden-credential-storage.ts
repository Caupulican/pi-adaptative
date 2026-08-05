import type { ChildProcess } from "node:child_process";
import { spawnProcess, waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { ensureToolWithDiagnostics, type ManagedToolResolver } from "../../utils/tools-manager.ts";
import {
	type CredentialProfileRecord,
	type CredentialProfileStorage,
	CredentialStorageError,
	type StoredCredentialProfileSummary,
	validateCredentialProfileName,
	validateCredentialProfileRecord,
} from "./credential-manager.ts";

const ITEM_NAME_PREFIX = "Pi credential profile · ";
const ENVELOPE_KIND = "pi.credential-profile";
const ENVELOPE_SCHEMA = 1;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PROFILE_ITEMS = 256;
const MAX_NOTE_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const SYNC_FRESHNESS_MS = 30_000;
const ITEM_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export type BitwardenCredentialStorageErrorCode =
	| "provider_command_failed"
	| "provider_unavailable"
	| "malformed_provider_data"
	| "not_connected"
	| "profile_not_found";

export class BitwardenCredentialStorageError extends CredentialStorageError {
	declare readonly code: BitwardenCredentialStorageErrorCode;

	constructor(code: BitwardenCredentialStorageErrorCode, message: string) {
		super(code, message);
		this.name = "BitwardenCredentialStorageError";
	}
}

export interface BitwardenCommandRequest {
	executable: string;
	args: string[];
	input?: string;
	sessionKey: string;
	signal?: AbortSignal;
}

export interface BitwardenCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	aborted?: boolean;
	timedOut?: boolean;
	outputLimitExceeded?: boolean;
}

export type BitwardenCommandRunner = (request: BitwardenCommandRequest) => Promise<BitwardenCommandResult>;

export interface BitwardenCredentialStorageOptions {
	resolveTool?: ManagedToolResolver;
	runCommand?: BitwardenCommandRunner;
}

interface BitwardenProfileEnvelope {
	kind: typeof ENVELOPE_KIND;
	schema: typeof ENVELOPE_SCHEMA;
	profile: string;
	description?: string;
	variables: Array<{ name: string; value: string }>;
	projectKeys: string[];
}

interface CachedBitwardenProfile {
	id: string;
	item: Record<string, unknown>;
	record: CredentialProfileRecord;
}

function appendBounded(current: string, chunk: Buffer | string, limit: number): { value: string; exceeded: boolean } {
	const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
	if (Buffer.byteLength(current, "utf8") + Buffer.byteLength(text, "utf8") <= limit) {
		return { value: current + text, exceeded: false };
	}
	return { value: current, exceeded: true };
}

function combineAbortSignal(source: AbortSignal | undefined, controller: AbortController): () => void {
	if (!source) return () => {};
	const abort = () => controller.abort();
	if (source.aborted) abort();
	else source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}

export async function runBitwardenCommand(request: BitwardenCommandRequest): Promise<BitwardenCommandResult> {
	const controller = new AbortController();
	const detachAbort = combineAbortSignal(request.signal, controller);
	let stdout = "";
	let stderr = "";
	let outputLimitExceeded = false;
	let child: ChildProcess;
	try {
		child = spawnProcess(request.executable, request.args, {
			env: { ...process.env, BW_SESSION: request.sessionKey, NO_COLOR: "1" },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout?.on("data", (chunk: Buffer | string) => {
			const appended = appendBounded(stdout, chunk, MAX_COMMAND_OUTPUT_BYTES);
			stdout = appended.value;
			if (appended.exceeded) {
				outputLimitExceeded = true;
				controller.abort();
			}
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const appended = appendBounded(stderr, chunk, MAX_COMMAND_OUTPUT_BYTES);
			stderr = appended.value;
			if (appended.exceeded) {
				outputLimitExceeded = true;
				controller.abort();
			}
		});
		child.stdin?.end(request.input);
		const terminal = await waitForChildProcessWithTermination(child, {
			signal: controller.signal,
			timeoutMs: COMMAND_TIMEOUT_MS,
			killGraceMs: 2_000,
		});
		return {
			exitCode: terminal.code ?? 1,
			stdout,
			stderr,
			...(terminal.reason === "aborted" ? { aborted: true } : {}),
			...(terminal.reason === "timeout" ? { timedOut: true } : {}),
			...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
		};
	} catch {
		return { exitCode: 1, stdout: "", stderr: "" };
	} finally {
		detachAbort();
		stdout = "";
		stderr = "";
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		throw new BitwardenCredentialStorageError(
			"malformed_provider_data",
			"Bitwarden returned malformed profile data.",
		);
	}
}

function parseEnvelope(note: string, expectedProfile: string): CredentialProfileRecord {
	if (Buffer.byteLength(note, "utf8") > MAX_NOTE_BYTES) {
		throw new BitwardenCredentialStorageError(
			"malformed_provider_data",
			"Bitwarden returned an oversized profile record.",
		);
	}
	const value = parseJson(note);
	if (
		!isObject(value) ||
		value.kind !== ENVELOPE_KIND ||
		value.schema !== ENVELOPE_SCHEMA ||
		value.profile !== expectedProfile ||
		(value.description !== undefined && typeof value.description !== "string") ||
		!Array.isArray(value.variables) ||
		!Array.isArray(value.projectKeys) ||
		!value.variables.every(
			(variable) => isObject(variable) && typeof variable.name === "string" && typeof variable.value === "string",
		) ||
		!value.projectKeys.every((key) => typeof key === "string")
	) {
		throw new BitwardenCredentialStorageError(
			"malformed_provider_data",
			"Bitwarden returned malformed profile data.",
		);
	}
	const record: CredentialProfileRecord = {
		profile: expectedProfile,
		...(typeof value.description === "string" ? { description: value.description } : {}),
		variables: value.variables.map((variable) => ({
			name: (variable as Record<string, unknown>).name as string,
			value: (variable as Record<string, unknown>).value as string,
		})),
		projectKeys: value.projectKeys as string[],
	};
	try {
		return validateCredentialProfileRecord(record);
	} catch {
		throw new BitwardenCredentialStorageError(
			"malformed_provider_data",
			"Bitwarden returned malformed profile data.",
		);
	}
}

function parseProfileItem(value: unknown): CachedBitwardenProfile | undefined {
	if (!isObject(value) || typeof value.name !== "string" || !value.name.startsWith(ITEM_NAME_PREFIX)) return undefined;
	const profile = value.name.slice(ITEM_NAME_PREFIX.length);
	if (
		value.type !== 2 ||
		typeof value.id !== "string" ||
		!ITEM_ID_PATTERN.test(value.id) ||
		typeof value.notes !== "string" ||
		!isObject(value.secureNote) ||
		value.secureNote.type !== 0
	) {
		throw new BitwardenCredentialStorageError(
			"malformed_provider_data",
			"Bitwarden returned malformed profile data.",
		);
	}
	try {
		validateCredentialProfileName(profile);
	} catch {
		throw new BitwardenCredentialStorageError(
			"malformed_provider_data",
			"Bitwarden returned malformed profile data.",
		);
	}
	return { id: value.id, item: value, record: parseEnvelope(value.notes, profile) };
}

function profileSummary(record: CredentialProfileRecord): StoredCredentialProfileSummary {
	return {
		profile: record.profile,
		...(record.description ? { description: record.description } : {}),
		variableNames: record.variables.map((variable) => variable.name),
		projectKeys: [...record.projectKeys],
	};
}

function createEnvelope(record: CredentialProfileRecord): BitwardenProfileEnvelope {
	return {
		kind: ENVELOPE_KIND,
		schema: ENVELOPE_SCHEMA,
		profile: record.profile,
		...(record.description ? { description: record.description } : {}),
		variables: record.variables.map((variable) => ({ ...variable })),
		projectKeys: [...record.projectKeys],
	};
}

export class BitwardenCredentialStorage implements CredentialProfileStorage {
	private readonly resolveTool: ManagedToolResolver;
	private readonly runCommand: BitwardenCommandRunner;
	private readonly profiles = new Map<string, CachedBitwardenProfile>();
	private executable: string | undefined;
	private sessionKey: string | undefined;
	private loaded = false;
	private lastSyncAt = 0;

	constructor(options: BitwardenCredentialStorageOptions = {}) {
		this.resolveTool = options.resolveTool ?? ensureToolWithDiagnostics;
		this.runCommand = options.runCommand ?? runBitwardenCommand;
	}

	async connect(sessionKey: string, signal?: AbortSignal): Promise<void> {
		this.lock();
		const resolution = await this.resolveTool("bw", true);
		if (resolution.status === "unavailable") {
			throw new BitwardenCredentialStorageError(
				"provider_unavailable",
				`Bitwarden CLI could not be provisioned (${resolution.failureCode}).`,
			);
		}
		this.executable = resolution.path;
		this.sessionKey = sessionKey;
		try {
			await this.reload(signal, true);
		} catch (error) {
			this.lock();
			throw error;
		}
	}

	async refresh(signal?: AbortSignal): Promise<void> {
		this.assertConnected();
		if (this.loaded && Date.now() - this.lastSyncAt < SYNC_FRESHNESS_MS) return;
		await this.reload(signal, true);
	}

	async listProfiles(signal?: AbortSignal): Promise<StoredCredentialProfileSummary[]> {
		await this.ensureLoaded(signal);
		return [...this.profiles.values()]
			.map((profile) => profileSummary(profile.record))
			.sort((left, right) => left.profile.localeCompare(right.profile));
	}

	async readProfile(profile: string, signal?: AbortSignal): Promise<CredentialProfileRecord> {
		await this.ensureLoaded(signal);
		const cached = this.profiles.get(profile);
		if (!cached) {
			throw new BitwardenCredentialStorageError("profile_not_found", "Credential profile was not found.");
		}
		return structuredClone(cached.record);
	}

	async writeProfile(record: CredentialProfileRecord, signal?: AbortSignal): Promise<void> {
		validateCredentialProfileRecord(record);
		await this.ensureLoaded(signal);
		const existing = this.profiles.get(record.profile);
		let item: Record<string, unknown>;
		if (existing) {
			item = structuredClone(existing.item);
		} else {
			const template = parseJson(await this.runChecked(["get", "template", "item"], undefined, signal));
			if (!isObject(template)) {
				throw new BitwardenCredentialStorageError(
					"malformed_provider_data",
					"Bitwarden returned a malformed item template.",
				);
			}
			item = template;
		}
		item.type = 2;
		item.name = `${ITEM_NAME_PREFIX}${record.profile}`;
		item.notes = JSON.stringify(createEnvelope(record));
		item.secureNote = { type: 0 };

		let serialized = "";
		let encoded = "";
		try {
			serialized = JSON.stringify(item);
			encoded = Buffer.from(serialized, "utf8").toString("base64");
			const output = existing
				? await this.runChecked(["edit", "item", existing.id], encoded, signal)
				: await this.runChecked(["create", "item"], encoded, signal);
			const updated = parseProfileItem(parseJson(output));
			if (!updated || updated.record.profile !== record.profile) {
				throw new BitwardenCredentialStorageError(
					"malformed_provider_data",
					"Bitwarden returned malformed profile data.",
				);
			}
			this.profiles.set(record.profile, updated);
			this.lastSyncAt = Date.now();
		} finally {
			serialized = "";
			encoded = "";
			item.notes = "";
		}
	}

	async deleteProfile(profile: string, signal?: AbortSignal): Promise<void> {
		await this.ensureLoaded(signal);
		const cached = this.profiles.get(profile);
		if (!cached) {
			throw new BitwardenCredentialStorageError("profile_not_found", "Credential profile was not found.");
		}
		await this.runChecked(["delete", "item", cached.id], undefined, signal);
		this.profiles.delete(profile);
		this.lastSyncAt = Date.now();
	}

	lock(): void {
		this.executable = undefined;
		this.sessionKey = undefined;
		for (const cached of this.profiles.values()) {
			for (const variable of cached.record.variables) variable.value = "";
			cached.item.notes = "";
		}
		this.profiles.clear();
		this.loaded = false;
		this.lastSyncAt = 0;
	}

	private assertConnected(): { executable: string; sessionKey: string } {
		if (!this.executable || !this.sessionKey) {
			throw new BitwardenCredentialStorageError("not_connected", "Bitwarden is not connected.");
		}
		return { executable: this.executable, sessionKey: this.sessionKey };
	}

	private async ensureLoaded(signal?: AbortSignal): Promise<void> {
		this.assertConnected();
		if (!this.loaded) await this.reload(signal, false);
	}

	private async reload(signal: AbortSignal | undefined, attemptSync: boolean): Promise<void> {
		if (attemptSync) {
			try {
				await this.runChecked(["sync"], undefined, signal);
			} catch (error) {
				if (!(error instanceof BitwardenCredentialStorageError) || error.code !== "provider_command_failed") {
					throw error;
				}
				// A network sync failure must not discard a locally available encrypted vault.
			}
		}
		const rawItems = parseJson(
			await this.runChecked(["list", "items", "--search", ITEM_NAME_PREFIX], undefined, signal),
		);
		if (!Array.isArray(rawItems) || rawItems.length > MAX_PROFILE_ITEMS) {
			throw new BitwardenCredentialStorageError(
				"malformed_provider_data",
				"Bitwarden returned an invalid number of profile items.",
			);
		}
		const next = new Map<string, CachedBitwardenProfile>();
		for (const rawItem of rawItems) {
			const parsed = parseProfileItem(rawItem);
			if (!parsed) continue;
			if (next.has(parsed.record.profile)) {
				throw new BitwardenCredentialStorageError(
					"malformed_provider_data",
					"Bitwarden contains duplicate Pi credential profiles.",
				);
			}
			next.set(parsed.record.profile, parsed);
		}
		this.lockProfileCache();
		for (const [profile, cached] of next) this.profiles.set(profile, cached);
		this.loaded = true;
		this.lastSyncAt = Date.now();
	}

	private lockProfileCache(): void {
		for (const cached of this.profiles.values()) {
			for (const variable of cached.record.variables) variable.value = "";
			cached.item.notes = "";
		}
		this.profiles.clear();
	}

	private async runChecked(
		args: string[],
		input: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<string> {
		const { executable, sessionKey } = this.assertConnected();
		const result = await this.runCommand({
			executable,
			args,
			...(input !== undefined ? { input } : {}),
			sessionKey,
			...(signal ? { signal } : {}),
		});
		if (
			result.exitCode !== 0 ||
			result.aborted === true ||
			result.timedOut === true ||
			result.outputLimitExceeded === true
		) {
			throw new BitwardenCredentialStorageError(
				"provider_command_failed",
				"Bitwarden command failed safely without exposing provider output.",
			);
		}
		return result.stdout;
	}
}
