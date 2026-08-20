import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ensureToolWithDiagnostics, type ManagedToolResolver } from "../../utils/tools-manager.ts";
import { type AtomicFileLockOptions, withFileLock } from "../util/atomic-file.ts";
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

const PROJECT_NAME = "Pi Credential Profiles";
const DATA_KEY_NAME = "Pi credential store · encryption key";
const DATA_KEY_NOTE = "Pi-managed profile encryption key";
const PROFILE_NOTE = "Pi-managed encrypted credential profile";
const DATA_KEY_PREFIX = "pi-credential-key:v1:";
const CIPHERTEXT_PREFIX = "pi-credential-profile:v1:";
const MAX_PROVIDER_ITEMS = 256;
const MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024;
const SYNC_FRESHNESS_MS = 30_000;
const PROVIDER_COORDINATION_LOCK_OPTIONS: Readonly<AtomicFileLockOptions> = Object.freeze({
	retries: 60,
	minRetryDelayMs: 50,
	maxRetryDelayMs: 500,
});
const PROVIDER_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export class BitwardenSecretsManagerStorageError extends CredentialStorageError {
	constructor(code: CredentialStorageError["code"], message: string) {
		super(code, message);
		this.name = "BitwardenSecretsManagerStorageError";
	}
}

export interface BitwardenSecretsManagerCommandRequest {
	executable: string;
	args: string[];
	accessToken: string;
	signal?: AbortSignal;
}

export type BitwardenSecretsManagerCommandResult = CredentialCliCommandResult;

export type BitwardenSecretsManagerCommandRunner = (
	request: BitwardenSecretsManagerCommandRequest,
) => Promise<BitwardenSecretsManagerCommandResult>;

export interface BitwardenSecretsManagerCredentialStorageOptions {
	coordinationFile: string;
	resolveTool?: ManagedToolResolver;
	runCommand?: BitwardenSecretsManagerCommandRunner;
}

interface SecretsManagerProject {
	id: string;
	organizationId: string;
	name: string;
}

interface SecretsManagerSecret {
	id: string;
	projectId: string;
	key: string;
	value: string;
}

interface CachedSecretsManagerProfile {
	id: string;
	record: CredentialProfileRecord;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		throw new BitwardenSecretsManagerStorageError(
			"malformed_provider_data",
			"Bitwarden Secrets Manager returned malformed data.",
		);
	}
}

function parseProject(value: unknown): SecretsManagerProject {
	if (
		!isObject(value) ||
		typeof value.id !== "string" ||
		!PROVIDER_ID_PATTERN.test(value.id) ||
		typeof value.organizationId !== "string" ||
		!PROVIDER_ID_PATTERN.test(value.organizationId) ||
		typeof value.name !== "string"
	) {
		throw new BitwardenSecretsManagerStorageError(
			"malformed_provider_data",
			"Bitwarden Secrets Manager returned malformed project data.",
		);
	}
	return { id: value.id, organizationId: value.organizationId, name: value.name };
}

function parseSecret(value: unknown, expectedProjectId: string): SecretsManagerSecret {
	if (
		!isObject(value) ||
		typeof value.id !== "string" ||
		!PROVIDER_ID_PATTERN.test(value.id) ||
		value.projectId !== expectedProjectId ||
		typeof value.key !== "string" ||
		typeof value.value !== "string" ||
		Buffer.byteLength(value.value, "utf8") > MAX_CIPHERTEXT_BYTES
	) {
		throw new BitwardenSecretsManagerStorageError(
			"malformed_provider_data",
			"Bitwarden Secrets Manager returned malformed secret data.",
		);
	}
	return { id: value.id, projectId: expectedProjectId, key: value.key, value: value.value };
}

function decodeBase64(value: string, expectedBytes?: number): Buffer {
	if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
		throw new BitwardenSecretsManagerStorageError(
			"malformed_provider_data",
			"Bitwarden Secrets Manager returned malformed encrypted profile data.",
		);
	}
	const decoded = Buffer.from(value, "base64");
	if ((expectedBytes !== undefined && decoded.length !== expectedBytes) || decoded.toString("base64") !== value) {
		decoded.fill(0);
		throw new BitwardenSecretsManagerStorageError(
			"malformed_provider_data",
			"Bitwarden Secrets Manager returned malformed encrypted profile data.",
		);
	}
	return decoded;
}

function parseDataKey(value: string): Buffer {
	if (!value.startsWith(DATA_KEY_PREFIX)) {
		throw new BitwardenSecretsManagerStorageError(
			"malformed_provider_data",
			"Bitwarden Secrets Manager returned a malformed profile encryption key.",
		);
	}
	return decodeBase64(value.slice(DATA_KEY_PREFIX.length), 32);
}

function encryptProfile(record: CredentialProfileRecord, dataKey: Buffer): string {
	let serialized = serializeCredentialProfileEnvelope(record);
	const plaintext = Buffer.from(serialized, "utf8");
	const iv = randomBytes(12);
	try {
		const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const tag = cipher.getAuthTag();
		try {
			return `${CIPHERTEXT_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
		} finally {
			ciphertext.fill(0);
			tag.fill(0);
		}
	} finally {
		serialized = "";
		plaintext.fill(0);
		iv.fill(0);
	}
}

function decryptProfile(value: string, profile: string, dataKey: Buffer): CredentialProfileRecord {
	if (!value.startsWith(CIPHERTEXT_PREFIX) || Buffer.byteLength(value, "utf8") > MAX_CIPHERTEXT_BYTES) {
		throw new BitwardenSecretsManagerStorageError(
			"malformed_provider_data",
			"Bitwarden Secrets Manager returned malformed encrypted profile data.",
		);
	}
	const encoded = value.slice(CIPHERTEXT_PREFIX.length).split(":");
	if (encoded.length !== 3) {
		throw new BitwardenSecretsManagerStorageError(
			"malformed_provider_data",
			"Bitwarden Secrets Manager returned malformed encrypted profile data.",
		);
	}
	const iv = decodeBase64(encoded[0] ?? "", 12);
	const tag = decodeBase64(encoded[1] ?? "", 16);
	const ciphertext = decodeBase64(encoded[2] ?? "");
	let plaintext = Buffer.alloc(0);
	let serialized = "";
	try {
		const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
		decipher.setAuthTag(tag);
		plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		serialized = plaintext.toString("utf8");
		return parseCredentialProfileEnvelope(serialized, profile);
	} catch (error) {
		if (error instanceof BitwardenSecretsManagerStorageError) throw error;
		throw new BitwardenSecretsManagerStorageError(
			"malformed_provider_data",
			"Bitwarden Secrets Manager returned malformed encrypted profile data.",
		);
	} finally {
		iv.fill(0);
		tag.fill(0);
		ciphertext.fill(0);
		plaintext.fill(0);
		serialized = "";
	}
}

export async function runBitwardenSecretsManagerCommand(
	request: BitwardenSecretsManagerCommandRequest,
): Promise<BitwardenSecretsManagerCommandResult> {
	return runCredentialCliCommand({
		executable: request.executable,
		args: request.args,
		authEnvironment: { name: "BWS_ACCESS_TOKEN", value: request.accessToken },
		omitEnvironmentVariables: ["BW_SESSION"],
		...(request.signal ? { signal: request.signal } : {}),
	});
}

export class BitwardenSecretsManagerCredentialStorage implements CredentialProfileStorage {
	private readonly coordinationFile: string;
	private readonly resolveTool: ManagedToolResolver;
	private readonly runCommand: BitwardenSecretsManagerCommandRunner;
	private readonly profiles = new Map<string, CachedSecretsManagerProfile>();
	private executable: string | undefined;
	private accessToken: string | undefined;
	private project: SecretsManagerProject | undefined;
	private dataKey: Buffer | undefined;
	private lastSyncAt = 0;

	constructor(options: BitwardenSecretsManagerCredentialStorageOptions) {
		if (options.coordinationFile.trim().length === 0) {
			throw new TypeError("Bitwarden Secrets Manager requires a coordination file.");
		}
		this.coordinationFile = options.coordinationFile;
		this.resolveTool = options.resolveTool ?? ensureToolWithDiagnostics;
		this.runCommand = options.runCommand ?? runBitwardenSecretsManagerCommand;
	}

	async connect(accessToken: string, signal?: AbortSignal): Promise<void> {
		this.lock();
		const resolution = await this.resolveTool("bws", true);
		if (resolution.status === "unavailable") {
			throw new BitwardenSecretsManagerStorageError(
				"provider_unavailable",
				`Bitwarden Secrets Manager CLI could not be provisioned (${resolution.failureCode}).`,
			);
		}
		this.executable = resolution.path;
		this.accessToken = accessToken;
		try {
			await this.reload(signal);
		} catch (error) {
			this.lock();
			throw error;
		}
	}

	async refresh(signal?: AbortSignal): Promise<void> {
		this.assertConnected();
		if (Date.now() - this.lastSyncAt >= SYNC_FRESHNESS_MS) await this.reload(signal);
	}

	async listProfiles(): Promise<StoredCredentialProfileSummary[]> {
		this.assertConnected();
		return summarizeCredentialProfiles([...this.profiles.values()].map((profile) => profile.record));
	}

	async readProfile(profile: string): Promise<CredentialProfileRecord> {
		this.assertConnected();
		const cached = this.profiles.get(profile);
		if (!cached) {
			throw new BitwardenSecretsManagerStorageError("profile_not_found", "Credential profile was not found.");
		}
		return structuredClone(cached.record);
	}

	async writeProfile(record: CredentialProfileRecord, signal?: AbortSignal): Promise<void> {
		validateCredentialProfileRecord(record);
		this.assertConnected();
		await this.withProviderCoordination(signal, async () => {
			await this.reloadUnderCoordination(signal);
			const { project } = this.assertConnected();
			const dataKey = await this.ensureDataKeyUnderCoordination(signal);
			let ciphertext = encryptProfile(record, dataKey);
			try {
				const existing = this.profiles.get(record.profile);
				const key = `${CREDENTIAL_PROFILE_KEY_PREFIX}${record.profile}`;
				const output = existing
					? await this.runChecked(
							[
								"secret",
								"edit",
								existing.id,
								"--key",
								key,
								"--value",
								ciphertext,
								"--note",
								PROFILE_NOTE,
								"--project-id",
								project.id,
							],
							signal,
						)
					: await this.runChecked(
							["secret", "create", key, ciphertext, project.id, "--note", PROFILE_NOTE],
							signal,
						);
				const stored = parseSecret(parseJson(output), project.id);
				if (stored.key !== key || stored.value !== ciphertext) {
					throw new BitwardenSecretsManagerStorageError(
						"malformed_provider_data",
						"Bitwarden Secrets Manager returned malformed profile data.",
					);
				}
				this.profiles.set(record.profile, { id: stored.id, record: structuredClone(record) });
				this.lastSyncAt = Date.now();
			} finally {
				ciphertext = "";
			}
		});
	}

	async deleteProfile(profile: string, signal?: AbortSignal): Promise<void> {
		this.assertConnected();
		await this.withProviderCoordination(signal, async () => {
			await this.reloadUnderCoordination(signal);
			const cached = this.profiles.get(profile);
			if (!cached) {
				throw new BitwardenSecretsManagerStorageError("profile_not_found", "Credential profile was not found.");
			}
			await this.runChecked(["secret", "delete", cached.id], signal);
			for (const variable of cached.record.variables) variable.value = "";
			this.profiles.delete(profile);
			this.lastSyncAt = Date.now();
		});
	}

	lock(): void {
		this.executable = undefined;
		this.accessToken = undefined;
		this.project = undefined;
		this.dataKey?.fill(0);
		this.dataKey = undefined;
		for (const cached of this.profiles.values()) {
			for (const variable of cached.record.variables) variable.value = "";
		}
		this.profiles.clear();
		this.lastSyncAt = 0;
	}

	private assertConnected(): {
		executable: string;
		accessToken: string;
		project: SecretsManagerProject;
	} {
		if (!this.executable || !this.accessToken || !this.project) {
			throw new BitwardenSecretsManagerStorageError("not_connected", "Bitwarden is not connected.");
		}
		return { executable: this.executable, accessToken: this.accessToken, project: this.project };
	}

	private async reload(signal?: AbortSignal): Promise<void> {
		await this.withProviderCoordination(signal, () => this.reloadUnderCoordination(signal));
	}

	private async reloadUnderCoordination(signal?: AbortSignal): Promise<void> {
		const projectsValue = parseJson(await this.runChecked(["project", "list"], signal));
		if (!Array.isArray(projectsValue) || projectsValue.length > MAX_PROVIDER_ITEMS) {
			throw new BitwardenSecretsManagerStorageError(
				"malformed_provider_data",
				"Bitwarden Secrets Manager returned an invalid project list.",
			);
		}
		const matchingProjects = projectsValue.map(parseProject).filter((project) => project.name === PROJECT_NAME);
		if (matchingProjects.length > 1) {
			throw new BitwardenSecretsManagerStorageError(
				"malformed_provider_data",
				"Bitwarden Secrets Manager contains duplicate Pi credential projects.",
			);
		}
		const project =
			matchingProjects[0] ??
			parseProject(parseJson(await this.runChecked(["project", "create", PROJECT_NAME], signal)));
		if (project.name !== PROJECT_NAME) {
			throw new BitwardenSecretsManagerStorageError(
				"malformed_provider_data",
				"Bitwarden Secrets Manager returned the wrong credential project.",
			);
		}
		this.project = project;
		const secretsValue = parseJson(await this.runChecked(["secret", "list", project.id], signal));
		if (!Array.isArray(secretsValue) || secretsValue.length > MAX_PROVIDER_ITEMS) {
			throw new BitwardenSecretsManagerStorageError(
				"malformed_provider_data",
				"Bitwarden Secrets Manager returned an invalid secret list.",
			);
		}
		const secrets = secretsValue.map((secret) => parseSecret(secret, project.id));
		const keySecrets = secrets.filter((secret) => secret.key === DATA_KEY_NAME);
		if (keySecrets.length > 1) {
			throw new BitwardenSecretsManagerStorageError(
				"malformed_provider_data",
				"Bitwarden Secrets Manager contains duplicate Pi encryption keys.",
			);
		}
		const nextKey = keySecrets[0] ? parseDataKey(keySecrets[0].value) : undefined;
		const nextProfiles = new Map<string, CachedSecretsManagerProfile>();
		try {
			for (const secret of secrets) {
				if (!secret.key.startsWith(CREDENTIAL_PROFILE_KEY_PREFIX)) continue;
				if (!nextKey) {
					throw new BitwardenSecretsManagerStorageError(
						"malformed_provider_data",
						"Bitwarden Secrets Manager profile encryption key is missing.",
					);
				}
				const profile = secret.key.slice(CREDENTIAL_PROFILE_KEY_PREFIX.length);
				try {
					validateCredentialProfileName(profile);
				} catch {
					throw new BitwardenSecretsManagerStorageError(
						"malformed_provider_data",
						"Bitwarden Secrets Manager returned malformed profile data.",
					);
				}
				if (nextProfiles.has(profile)) {
					throw new BitwardenSecretsManagerStorageError(
						"malformed_provider_data",
						"Bitwarden Secrets Manager contains duplicate Pi credential profiles.",
					);
				}
				nextProfiles.set(profile, { id: secret.id, record: decryptProfile(secret.value, profile, nextKey) });
			}
		} catch (error) {
			for (const cached of nextProfiles.values()) {
				for (const variable of cached.record.variables) variable.value = "";
			}
			nextKey?.fill(0);
			throw error;
		}
		this.dataKey?.fill(0);
		this.dataKey = nextKey;
		for (const cached of this.profiles.values()) {
			for (const variable of cached.record.variables) variable.value = "";
		}
		this.profiles.clear();
		for (const [profile, cached] of nextProfiles) this.profiles.set(profile, cached);
		this.lastSyncAt = Date.now();
	}

	private async ensureDataKeyUnderCoordination(signal?: AbortSignal): Promise<Buffer> {
		if (this.dataKey) return this.dataKey;
		const { project } = this.assertConnected();
		const generated = randomBytes(32);
		let serialized = `${DATA_KEY_PREFIX}${generated.toString("base64")}`;
		try {
			const stored = parseSecret(
				parseJson(
					await this.runChecked(
						["secret", "create", DATA_KEY_NAME, serialized, project.id, "--note", DATA_KEY_NOTE],
						signal,
					),
				),
				project.id,
			);
			if (stored.key !== DATA_KEY_NAME || stored.value !== serialized) {
				throw new BitwardenSecretsManagerStorageError(
					"malformed_provider_data",
					"Bitwarden Secrets Manager returned a malformed profile encryption key.",
				);
			}
			this.dataKey = Buffer.from(generated);
			return this.dataKey;
		} finally {
			generated.fill(0);
			serialized = "";
		}
	}

	private async withProviderCoordination<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
		signal?.throwIfAborted();
		try {
			return await withFileLock(
				this.coordinationFile,
				async () => {
					signal?.throwIfAborted();
					return operation();
				},
				PROVIDER_COORDINATION_LOCK_OPTIONS,
			);
		} catch (error) {
			if (error instanceof CredentialStorageError || signal?.aborted) throw error;
			throw new BitwardenSecretsManagerStorageError(
				"provider_command_failed",
				"Bitwarden Secrets Manager coordination failed safely.",
			);
		}
	}

	private async runChecked(args: string[], signal?: AbortSignal): Promise<string> {
		if (!this.executable || !this.accessToken) {
			throw new BitwardenSecretsManagerStorageError("not_connected", "Bitwarden is not connected.");
		}
		const result = await this.runCommand({
			executable: this.executable,
			args,
			accessToken: this.accessToken,
			...(signal ? { signal } : {}),
		});
		if (
			result.exitCode !== 0 ||
			result.aborted === true ||
			result.timedOut === true ||
			result.outputLimitExceeded === true
		) {
			throw new BitwardenSecretsManagerStorageError(
				"provider_command_failed",
				"Bitwarden Secrets Manager command failed safely without exposing provider output.",
			);
		}
		return result.stdout;
	}
}
