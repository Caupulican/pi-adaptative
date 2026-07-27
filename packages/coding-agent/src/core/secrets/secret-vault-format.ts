import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { isAbsolute, normalize, sep } from "node:path";
import {
	formatDotenvVariables,
	MAX_DOTENV_VARIABLES,
	parseDotenvDocument,
	SecretDotenvError,
	validateDotenvValue,
	validateDotenvVariableName,
} from "./secret-dotenv.ts";

const VAULT_VERSION = 1;
export const VAULT_MARKER = "pi-secret-vault-v1";
const VAULT_AAD = Buffer.from("pi-secret-vault:v1", "utf8");
const AES_ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;
export const DEFAULT_SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const MIN_SCRYPT_N = 1_024;
const MAX_SCRYPT_N = 65_536;
export const MAX_VAULT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_VAULT_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_PROFILES = 64;
export const MAX_VARIABLES_PER_PROFILE = MAX_DOTENV_VARIABLES;
export const MAX_BINDINGS_PER_PROFILE = 16;
const MAX_PASSPHRASE_CHARS = 4_096;
const MIN_NEW_PASSPHRASE_CHARS = 12;
export const SECRET_PROFILE_ID_MAX_CHARS = 64;
export const SECRET_DESCRIPTION_MAX_CHARS = 240;
export const SECRET_PROFILE_ID_PATTERN = `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,${SECRET_PROFILE_ID_MAX_CHARS - 2}}[A-Za-z0-9])?$`;
export { SECRET_VARIABLE_NAME_MAX_CHARS, SECRET_VARIABLE_NAME_PATTERN } from "./secret-dotenv.ts";
export const SECRET_PRINTABLE_METADATA_PATTERN = "^[^\\u0000-\\u001f\\u007f-\\u009f]+$";
export const MANAGED_ENV_HEADER_PREFIX = "# pi-secret-store:v1 profile=";
const PROFILE_ID_RE = new RegExp(SECRET_PROFILE_ID_PATTERN);
const PRINTABLE_METADATA_RE = new RegExp(SECRET_PRINTABLE_METADATA_PATTERN);
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export type SecretVaultErrorCode =
	| "already_initialized"
	| "ambiguous_binding"
	| "binding_missing"
	| "destination_conflict"
	| "destination_invalid"
	| "invalid_description"
	| "invalid_dotenv"
	| "invalid_passphrase"
	| "invalid_profile"
	| "invalid_variable"
	| "not_initialized"
	| "not_unlocked"
	| "profile_limit"
	| "profile_missing"
	| "symlink_refused"
	| "unlock_failed"
	| "value_too_large"
	| "variable_limit"
	| "vault_corrupt"
	| "vault_too_large";

export class SecretVaultError extends Error {
	readonly code: SecretVaultErrorCode;

	constructor(code: SecretVaultErrorCode, message: string) {
		super(message);
		this.name = "SecretVaultError";
		this.code = code;
	}
}

export interface SecretVariableValue {
	name: string;
	value: string;
}

export interface SecretProfileSummary {
	profile: string;
	description?: string;
	variableNames: string[];
	bindings: SecretBindingSummary[];
	createdAt: string;
	updatedAt: string;
}

export interface SecretBindingSummary {
	workspace: string;
	envFile: string;
	updatedAt: string;
}

export interface SecretBindingResolution extends SecretBindingSummary {
	profile: string;
	destination: string;
	variableNames: string[];
}

export type SecretEnvDestinationState = "missing" | "managed-profile" | "managed-other" | "unmanaged";

export interface SecretMaterializationResult {
	profile: string;
	variableNames: string[];
	previousState: SecretEnvDestinationState;
}

export interface SecretRemovalResult {
	profile: string;
	removedProfile: boolean;
	removedVariableNames: string[];
	managedMaterializationRemoved: boolean;
	boundMaterializationsRemoved: number;
}

export interface SecretVaultOptions {
	agentDir: string;
	/** Test-only cost override. Production callers should retain the default. */
	scryptN?: number;
	now?: () => Date;
	/** Reset credential-bearing child process state after activation, mutation, or lock. */
	onEnvironmentChanged?: () => void;
}

export interface VaultKdf {
	algorithm: "scrypt";
	salt: string;
	N: number;
	r: number;
	p: number;
	keyLength: number;
}

export interface VaultCiphertext {
	iv: string;
	tag: string;
	ciphertext: string;
}

export interface VaultEnvelope {
	version: 1;
	kdf: VaultKdf;
	payload: VaultCiphertext;
}

export interface SecretProfileRecord {
	profile: string;
	description?: string;
	createdAt: string;
	updatedAt: string;
	dotenv: string;
	bindings: SecretBindingSummary[];
}

export interface VaultPayload {
	marker: typeof VAULT_MARKER;
	profiles: SecretProfileRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeCanonicalBase64(value: unknown, field: string, expectedBytes?: number): Buffer {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_VAULT_FILE_BYTES) {
		throw new SecretVaultError("vault_corrupt", `Secret vault ${field} is invalid.`);
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)) {
		decoded.fill(0);
		throw new SecretVaultError("vault_corrupt", `Secret vault ${field} is invalid.`);
	}
	return decoded;
}

export function validateScryptN(value: number): number {
	if (!Number.isInteger(value) || value < MIN_SCRYPT_N || value > MAX_SCRYPT_N || (value & (value - 1)) !== 0) {
		throw new SecretVaultError("vault_corrupt", "Secret vault KDF settings are invalid.");
	}
	return value;
}

export function createVaultKdf(scryptN: number): VaultKdf {
	const salt = randomBytes(SALT_LENGTH);
	try {
		return {
			algorithm: "scrypt",
			salt: salt.toString("base64"),
			N: validateScryptN(scryptN),
			r: SCRYPT_R,
			p: SCRYPT_P,
			keyLength: KEY_LENGTH,
		};
	} finally {
		salt.fill(0);
	}
}

function parseKdf(value: unknown): VaultKdf {
	if (!isRecord(value)) throw new SecretVaultError("vault_corrupt", "Secret vault KDF is missing.");
	if (value.algorithm !== "scrypt" || value.r !== SCRYPT_R || value.p !== SCRYPT_P || value.keyLength !== KEY_LENGTH) {
		throw new SecretVaultError("vault_corrupt", "Secret vault KDF settings are unsupported.");
	}
	const salt = decodeCanonicalBase64(value.salt, "salt", SALT_LENGTH);
	salt.fill(0);
	return {
		algorithm: "scrypt",
		salt: value.salt as string,
		N: validateScryptN(value.N as number),
		r: SCRYPT_R,
		p: SCRYPT_P,
		keyLength: KEY_LENGTH,
	};
}

function parseCiphertext(value: unknown): VaultCiphertext {
	if (!isRecord(value)) throw new SecretVaultError("vault_corrupt", "Secret vault payload is missing.");
	const iv = decodeCanonicalBase64(value.iv, "IV", IV_LENGTH);
	const tag = decodeCanonicalBase64(value.tag, "authentication tag", AUTH_TAG_LENGTH);
	const ciphertext = decodeCanonicalBase64(value.ciphertext, "ciphertext");
	iv.fill(0);
	tag.fill(0);
	ciphertext.fill(0);
	return {
		iv: value.iv as string,
		tag: value.tag as string,
		ciphertext: value.ciphertext as string,
	};
}

export function parseEnvelope(text: string): VaultEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new SecretVaultError("vault_corrupt", "Secret vault data is not valid JSON.");
	}
	if (!isRecord(parsed) || parsed.version !== VAULT_VERSION) {
		throw new SecretVaultError("vault_corrupt", "Secret vault version is unsupported.");
	}
	return { version: VAULT_VERSION, kdf: parseKdf(parsed.kdf), payload: parseCiphertext(parsed.payload) };
}

export function validateProfileId(profile: string): string {
	if (!PROFILE_ID_RE.test(profile) || WINDOWS_RESERVED_NAME_RE.test(profile)) {
		throw new SecretVaultError(
			"invalid_profile",
			"Profile names must be portable 1-64 character identifiers using letters, numbers, dot, dash, or underscore.",
		);
	}
	return profile;
}

export function validateDescription(description: string | undefined): string | undefined {
	if (description === undefined) return undefined;
	const normalized = description.trim();
	if (!normalized || normalized.length > SECRET_DESCRIPTION_MAX_CHARS || !PRINTABLE_METADATA_RE.test(normalized)) {
		throw new SecretVaultError("invalid_description", "Secret profile descriptions must be short printable text.");
	}
	return normalized;
}

export function validateBindingWorkspace(workspace: string): string {
	if (
		!isAbsolute(workspace) ||
		workspace.length > 4_096 ||
		workspace.includes("\0") ||
		/[\u0000-\u001f\u007f-\u009f]/.test(workspace)
	) {
		throw new SecretVaultError("destination_invalid", "Credential workspace must be an absolute local path.");
	}
	return normalize(workspace);
}

export function validateBindingEnvFile(envFile: string): string {
	const trimmed = envFile.trim();
	const normalized = normalize(trimmed);
	const segments = normalized.split(/[\\/]+/);
	const fileName = segments.at(-1) ?? "";
	if (
		!trimmed ||
		trimmed.length > 512 ||
		isAbsolute(trimmed) ||
		normalized === ".." ||
		normalized.startsWith(`..${sep}`) ||
		segments.includes("..") ||
		trimmed.includes("\0") ||
		/[\u0000-\u001f\u007f-\u009f]/.test(trimmed) ||
		!(fileName === ".env" || fileName.startsWith(".env.") || fileName.endsWith(".env"))
	) {
		throw new SecretVaultError(
			"destination_invalid",
			"Credential target must be a relative dotenv path inside the workspace (for example .env or config/dev.env).",
		);
	}
	return normalized;
}

function parseBinding(value: unknown): SecretBindingSummary {
	if (!isRecord(value) || typeof value.workspace !== "string" || typeof value.envFile !== "string") {
		throw new SecretVaultError("vault_corrupt", "Secret vault binding data is invalid.");
	}
	try {
		return {
			workspace: validateBindingWorkspace(value.workspace),
			envFile: validateBindingEnvFile(value.envFile),
			updatedAt: validateTimestamp(value.updatedAt),
		};
	} catch (error) {
		if (error instanceof SecretVaultError) {
			throw new SecretVaultError("vault_corrupt", "Secret vault binding data is invalid.");
		}
		throw error;
	}
}

export function validateVariableName(name: string): string {
	try {
		return validateDotenvVariableName(name);
	} catch (error) {
		if (error instanceof SecretDotenvError) {
			throw new SecretVaultError("invalid_variable", "Environment variable names must use portable dotenv syntax.");
		}
		throw error;
	}
}

export function validateSecretValue(value: string): string {
	try {
		return validateDotenvValue(value);
	} catch (error) {
		if (error instanceof SecretDotenvError) {
			throw new SecretVaultError(
				error.message.includes("64 KiB") ? "value_too_large" : "invalid_variable",
				error.message.includes("64 KiB")
					? "A secret value exceeds the 64 KiB limit."
					: "Secret values cannot contain null bytes.",
			);
		}
		throw error;
	}
}

export function validateDotenvProfileDocument(document: string): {
	document: string;
	variables: SecretVariableValue[];
} {
	try {
		return parseDotenvDocument(document);
	} catch (error) {
		if (error instanceof SecretDotenvError) throw new SecretVaultError("invalid_dotenv", error.message);
		throw error;
	}
}

function validateTimestamp(value: unknown): string {
	if (typeof value !== "string" || value.length > 64 || Number.isNaN(Date.parse(value))) {
		throw new SecretVaultError("vault_corrupt", "Secret vault timestamps are invalid.");
	}
	return value;
}

function parsePayload(value: unknown): VaultPayload {
	if (!isRecord(value) || value.marker !== VAULT_MARKER || !Array.isArray(value.profiles)) {
		throw new SecretVaultError("vault_corrupt", "Secret vault payload is invalid.");
	}
	if (value.profiles.length > MAX_PROFILES) {
		throw new SecretVaultError("vault_corrupt", "Secret vault profile count exceeds its bound.");
	}
	const profileNames = new Set<string>();
	const profiles: SecretProfileRecord[] = value.profiles.map((candidate) => {
		if (!isRecord(candidate) || typeof candidate.dotenv !== "string" || !Array.isArray(candidate.bindings)) {
			throw new SecretVaultError("vault_corrupt", "Secret vault profile data is invalid.");
		}
		const profile = validateProfileId(typeof candidate.profile === "string" ? candidate.profile : "");
		if (profileNames.has(profile))
			throw new SecretVaultError("vault_corrupt", "Secret vault profiles are duplicated.");
		profileNames.add(profile);
		let dotenv: string;
		try {
			dotenv = validateDotenvProfileDocument(candidate.dotenv).document;
		} catch {
			throw new SecretVaultError("vault_corrupt", "Secret vault dotenv data is invalid.");
		}
		if (candidate.bindings.length > MAX_BINDINGS_PER_PROFILE) {
			throw new SecretVaultError("vault_corrupt", "Secret vault binding count exceeds its bound.");
		}
		const bindingIds = new Set<string>();
		const bindings = candidate.bindings.map((binding) => {
			const parsed = parseBinding(binding);
			const id = `${parsed.workspace}\0${parsed.envFile}`;
			if (bindingIds.has(id)) throw new SecretVaultError("vault_corrupt", "Secret vault bindings are duplicated.");
			bindingIds.add(id);
			return parsed;
		});
		return {
			profile,
			...(candidate.description !== undefined
				? {
						description: validateDescription(
							typeof candidate.description === "string" ? candidate.description : "",
						),
					}
				: {}),
			createdAt: validateTimestamp(candidate.createdAt),
			updatedAt: validateTimestamp(candidate.updatedAt),
			dotenv,
			bindings: bindings.sort(
				(left, right) => left.workspace.localeCompare(right.workspace) || left.envFile.localeCompare(right.envFile),
			),
		};
	});
	return { marker: VAULT_MARKER, profiles: profiles.sort((left, right) => left.profile.localeCompare(right.profile)) };
}

export function scrubPayload(payload: VaultPayload): void {
	for (const profile of payload.profiles) profile.dotenv = "";
}

export function assertPassphrase(passphrase: string, creating: boolean): void {
	if (
		passphrase.length > MAX_PASSPHRASE_CHARS ||
		passphrase.includes("\0") ||
		(creating ? passphrase.length < MIN_NEW_PASSPHRASE_CHARS : passphrase.length === 0)
	) {
		throw new SecretVaultError(
			"invalid_passphrase",
			creating
				? `The vault passphrase must contain ${MIN_NEW_PASSPHRASE_CHARS}-${MAX_PASSPHRASE_CHARS} characters.`
				: "The vault passphrase is invalid.",
		);
	}
}

export function sameKdf(left: VaultKdf, right: VaultKdf): boolean {
	return (
		left.algorithm === right.algorithm &&
		left.salt === right.salt &&
		left.N === right.N &&
		left.r === right.r &&
		left.p === right.p &&
		left.keyLength === right.keyLength
	);
}

export async function deriveKey(passphrase: string, kdf: VaultKdf): Promise<Buffer> {
	const salt = Buffer.from(kdf.salt, "base64");
	const maxmem = Math.max(64 * 1024 * 1024, 128 * kdf.N * kdf.r + 16 * 1024 * 1024);
	try {
		return await new Promise<Buffer>((resolveKey, reject) => {
			scrypt(passphrase, salt, kdf.keyLength, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem }, (error, key) => {
				if (error) reject(error);
				else resolveKey(key);
			});
		});
	} finally {
		salt.fill(0);
	}
}

function encryptPayload(payload: VaultPayload, key: Buffer): VaultCiphertext {
	let serialized = JSON.stringify(payload);
	if (Buffer.byteLength(serialized, "utf8") > MAX_VAULT_PAYLOAD_BYTES) {
		serialized = "";
		throw new SecretVaultError("vault_too_large", "Secret vault payload exceeds its 2 MiB limit.");
	}
	const plaintext = Buffer.from(serialized, "utf8");
	serialized = "";
	const iv = randomBytes(IV_LENGTH);
	try {
		const cipher = createCipheriv(AES_ALGORITHM, key, iv);
		cipher.setAAD(VAULT_AAD);
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const tag = cipher.getAuthTag();
		try {
			return {
				iv: iv.toString("base64"),
				tag: tag.toString("base64"),
				ciphertext: ciphertext.toString("base64"),
			};
		} finally {
			tag.fill(0);
			ciphertext.fill(0);
		}
	} finally {
		plaintext.fill(0);
		iv.fill(0);
	}
}

export function decryptPayload(ciphertext: VaultCiphertext, key: Buffer): VaultPayload {
	const iv = Buffer.from(ciphertext.iv, "base64");
	const tag = Buffer.from(ciphertext.tag, "base64");
	const encrypted = Buffer.from(ciphertext.ciphertext, "base64");
	let plaintext: Buffer | undefined;
	try {
		const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
		decipher.setAAD(VAULT_AAD);
		decipher.setAuthTag(tag);
		plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
		if (plaintext.byteLength > MAX_VAULT_PAYLOAD_BYTES) {
			throw new SecretVaultError("vault_too_large", "Secret vault payload exceeds its 2 MiB limit.");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(plaintext.toString("utf8"));
		} catch {
			throw new SecretVaultError("vault_corrupt", "Secret vault payload is invalid.");
		}
		return parsePayload(parsed);
	} catch (error) {
		if (error instanceof SecretVaultError) throw error;
		throw new SecretVaultError("unlock_failed", "The vault passphrase is incorrect or the vault is damaged.");
	} finally {
		iv.fill(0);
		tag.fill(0);
		encrypted.fill(0);
		plaintext?.fill(0);
	}
}

export function serializeEnvelope(kdf: VaultKdf, payload: VaultPayload, key: Buffer): string {
	const envelope: VaultEnvelope = { version: VAULT_VERSION, kdf, payload: encryptPayload(payload, key) };
	const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
	if (Buffer.byteLength(serialized, "utf8") > MAX_VAULT_FILE_BYTES) {
		throw new SecretVaultError("vault_too_large", "Secret vault file exceeds its 4 MiB limit.");
	}
	return serialized;
}

export function profileSummary(profile: SecretProfileRecord): SecretProfileSummary {
	const parsed = validateDotenvProfileDocument(profile.dotenv);
	return {
		profile: profile.profile,
		...(profile.description ? { description: profile.description } : {}),
		variableNames: parsed.variables.map((variable) => variable.name),
		bindings: profile.bindings.map((binding) => ({ ...binding })),
		createdAt: profile.createdAt,
		updatedAt: profile.updatedAt,
	};
}

export function serializeVariableValues(values: readonly SecretVariableValue[]): string {
	return formatDotenvVariables(values);
}
