import { ensureToolWithDiagnostics, type ManagedToolResolver } from "../../utils/tools-manager.ts";
import { type CredentialCliCommandResult, runCredentialCliCommand } from "./credential-cli-command.ts";
import {
	type CredentialProfileRecord,
	type CredentialProfileStorage,
	CredentialStorageError,
	type StoredCredentialProfileSummary,
	validateCredentialProfileName,
	validateCredentialProfileRecord,
} from "./credential-manager.ts";
import {
	CREDENTIAL_PROFILE_KEY_PREFIX,
	parseCredentialProfileEnvelope,
	serializeCredentialProfileEnvelope,
	summarizeCredentialProfiles,
} from "./credential-profile-envelope.ts";

const MAX_PROFILE_ITEMS = 256;
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

export type BitwardenCommandResult = CredentialCliCommandResult;

export type BitwardenCommandRunner = (request: BitwardenCommandRequest) => Promise<BitwardenCommandResult>;

export interface BitwardenCredentialStorageOptions {
	resolveTool?: ManagedToolResolver;
	runCommand?: BitwardenCommandRunner;
}

interface CachedBitwardenProfile {
	id: string;
	item: Record<string, unknown>;
	record: CredentialProfileRecord;
}

export async function runBitwardenCommand(request: BitwardenCommandRequest): Promise<BitwardenCommandResult> {
	return runCredentialCliCommand({
		executable: request.executable,
		args: request.args,
		...(request.input !== undefined ? { input: request.input } : {}),
		authEnvironment: { name: "BW_SESSION", value: request.sessionKey },
		omitEnvironmentVariables: ["BWS_ACCESS_TOKEN"],
		...(request.signal ? { signal: request.signal } : {}),
	});
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

function parseProfileItem(value: unknown): CachedBitwardenProfile | undefined {
	if (!isObject(value) || typeof value.name !== "string" || !value.name.startsWith(CREDENTIAL_PROFILE_KEY_PREFIX)) {
		return undefined;
	}
	const profile = value.name.slice(CREDENTIAL_PROFILE_KEY_PREFIX.length);
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
	try {
		return { id: value.id, item: value, record: parseCredentialProfileEnvelope(value.notes, profile) };
	} catch {
		throw new BitwardenCredentialStorageError(
			"malformed_provider_data",
			"Bitwarden returned malformed profile data.",
		);
	}
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
		return summarizeCredentialProfiles([...this.profiles.values()].map((profile) => profile.record));
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
		item.name = `${CREDENTIAL_PROFILE_KEY_PREFIX}${record.profile}`;
		item.notes = serializeCredentialProfileEnvelope(record);
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
			await this.runChecked(["list", "items", "--search", CREDENTIAL_PROFILE_KEY_PREFIX], undefined, signal),
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
