/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import { findEnvKeys, getEnvApiKey, getEnvAuthHeaders } from "@caupulican/pi-ai/env-api-keys";
import {
	getOAuthApiKey,
	getOAuthProvider,
	getOAuthProviders,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@caupulican/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";
import {
	acquireFileLockSync,
	LOW_LATENCY_FILE_LOCK_OPTIONS,
	writeFileAtomic,
	writeFileAtomicSync,
} from "./util/atomic-file.ts";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

/** A run of 24+ unbroken token characters: access/refresh tokens and JWT segments look like this,
 *  provider ids and ordinary prose do not. */
const TOKEN_LIKE_RE = /[A-Za-z0-9_]{24,}/g;

/** The failure text a provider or the lock layer produced, with anything token-shaped removed. */
function redactRefreshFailureReason(error: unknown): string {
	// Follow the cause chain: the refresh wrapper names the provider, its cause names what the
	// provider actually said (HTTP status, invalid_grant, a network error).
	const parts: string[] = [];
	const seen = new Set<unknown>();
	for (let current: unknown = error; current !== undefined && current !== null && !seen.has(current); ) {
		seen.add(current);
		const text = (current instanceof Error ? current.message : String(current)).trim();
		if (text.length > 0 && parts[parts.length - 1] !== text) parts.push(text);
		current = current instanceof Error ? current.cause : undefined;
	}
	const raw = parts.join(": ");
	const redacted = raw.replace(TOKEN_LIKE_RE, "[redacted]").trim();
	if (redacted.length === 0) return "no reason reported";
	return redacted.length > 300 ? `${redacted.slice(0, 300)}...` : redacted;
}

/**
 * A stored OAuth credential exists for the provider but cannot produce a usable key: it expired
 * and the refresh failed, was refused, or could not be attempted.
 *
 * This is not "no API key". The credential is there, so telling the user no key is configured
 * sends them to the wrong fix; the message names the credential, when it expired, why the refresh
 * failed, and the command that repairs it. The message is the user-facing text: layers that flatten
 * a rejection to its message (the model registry's request-auth resolution does) pass it through
 * unchanged, and structured consumers read {@link providerId}, {@link expiresAt} and {@link reason}.
 */
export class OAuthCredentialUnusableError extends Error {
	readonly providerId: string;
	readonly expiresAt: Date;
	readonly reason: string;

	constructor(providerId: string, expiresAtMs: number, reason: string) {
		const expiresAt = new Date(expiresAtMs);
		super(
			`OAuth credential for ${providerId} expired on ${expiresAt.toISOString()} and could not be refreshed ` +
				`(${reason}). Run pi login ${providerId} to reauthorize.`,
		);
		this.name = "OAuthCredentialUnusableError";
		this.providerId = providerId;
		this.expiresAt = expiresAt;
		this.reason = reason;
	}
}

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

type LockResult<T> = {
	result: T;
	next?: string;
};

type OAuthStorageRevision = {
	data: number;
	provider: number;
};

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileAtomicSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
			chmodSync(this.authPath, 0o600);
		}
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();

		let release: (() => void) | undefined;
		try {
			release = acquireFileLockSync(this.authPath, LOW_LATENCY_FILE_LOCK_OPTIONS);
			this.ensureFileExists();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileAtomicSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				realpath: false,
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			this.ensureFileExists();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				await writeFileAtomic(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private locked = false;
	private pending = Promise.resolve();

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		if (this.locked) throw new Error("Auth storage is locked by another transaction");
		this.locked = true;
		try {
			const { result, next } = fn(this.value);
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		} finally {
			this.locked = false;
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const previous = this.pending;
		const released = Promise.withResolvers<void>();
		this.pending = released.promise;
		await previous;
		this.locked = true;
		try {
			const { result, next } = await fn(this.value);
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		} finally {
			this.locked = false;
			released.resolve();
		}
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private dataRevision = 0;
	private reloadRevision = 0;
	private providerRevisions = new Map<string, number>();
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(stripBom(content)) as AuthStorageData;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.reloadRevision = ++this.dataRevision;
			this.providerRevisions.clear();
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		if (this.loadError) {
			return;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.data[provider] = credential;
		this.providerRevisions.set(provider, ++this.dataRevision);
		this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		delete this.data[provider];
		this.providerRevisions.set(provider, ++this.dataRevision);
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvAuthHeaders(provider)) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (this.data[provider]) {
			return { configured: true, source: "stored" };
		}

		if (this.runtimeOverrides.has(provider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: false, source: "environment", label: envKeys[0] };
		}

		if (this.fallbackResolver?.(provider)) {
			return { configured: false, source: "fallback", label: "custom provider config" };
		}

		return { configured: false };
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	private captureOAuthStorageRevision(providerId: string): OAuthStorageRevision {
		return { data: this.dataRevision, provider: this.providerRevisions.get(providerId) ?? this.reloadRevision };
	}

	/** Publish a refresh or recovery snapshot only after the backend commits and releases its lock. */
	private async withOAuthStorageLock<T>(
		providerId: string,
		fn: (current: AuthStorageData) => Promise<{ result: T; nextData?: AuthStorageData }>,
		revision = this.captureOAuthStorageRevision(providerId),
	): Promise<T | undefined> {
		if (this.captureOAuthStorageRevision(providerId).provider !== revision.provider) return undefined;
		const committed = await this.storage.withLockAsync<{ result: T; data: AuthStorageData } | undefined>(
			async (current) => {
				if (this.captureOAuthStorageRevision(providerId).provider !== revision.provider)
					return { result: undefined };
				const currentData = this.parseStorageData(current);
				const update = await fn(currentData);
				return {
					result: { result: update.result, data: update.nextData ?? currentData },
					next: update.nextData === undefined ? undefined : JSON.stringify(update.nextData, null, 2),
				};
			},
		);
		// Fence the returned key as well as the cache: a superseded rotation must not
		// authorize a pending request after a local logout, replacement or reload.
		if (!committed || this.captureOAuthStorageRevision(providerId).provider !== revision.provider) return undefined;
		if (this.dataRevision === revision.data) {
			this.data = committed.data;
		} else {
			// Other providers may change independently while this backend releases its lock.
			const credential = committed.data[providerId];
			if (credential) this.data[providerId] = credential;
			else delete this.data[providerId];
		}
		this.providerRevisions.set(providerId, ++this.dataRevision);
		this.loadError = null;
		return committed.result;
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.withOAuthStorageLock(providerId, async (currentData) => {
			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: { type: "oauth", ...refreshed.newCredentials },
			};
			return { result: refreshed, nextData: merged };
		});

		return result ?? null;
	}

	/**
	 * Recover an OAuth credential rejected before a response body was consumed.
	 * The lock re-checks the file so a concurrent process's rotation wins without
	 * causing an unnecessary refresh.
	 */
	async recoverRejectedOAuthApiKey(providerId: string, rejectedApiKey: string): Promise<string | undefined> {
		if (this.runtimeOverrides.has(providerId)) return undefined;
		const provider = getOAuthProvider(providerId);
		if (!provider) return undefined;

		return this.withOAuthStorageLock(providerId, async (currentData) => {
			const credential = currentData[providerId];
			if (credential?.type !== "oauth") return { result: undefined };

			const currentKey = provider.getApiKey(credential);
			if (currentKey !== rejectedApiKey && Date.now() < credential.expires) {
				return { result: currentKey };
			}

			try {
				const refreshed = await provider.refreshToken(credential);
				const nextCredential: OAuthCredential = { type: "oauth", ...refreshed };
				const nextData = { ...currentData, [providerId]: nextCredential };
				return { result: provider.getApiKey(nextCredential), nextData };
			} catch (error) {
				this.recordError(error);
				return { result: undefined };
			}
		});
	}

	/**
	 * Stored OAuth only: never executes key commands or resolves runtime/env/fallback API keys.
	 *
	 * Returns undefined when the provider has no stored OAuth credential at all. When one exists
	 * but is expired and unusable, this throws {@link OAuthCredentialUnusableError} instead of
	 * returning undefined — an expired credential is a different failure from a missing one, and
	 * reporting it as "no API key" hid a four-day-stale token behind the wrong instruction.
	 */
	async getOAuthApiKey(providerId: string): Promise<string | undefined> {
		const cred = this.data[providerId];
		const provider = getOAuthProvider(providerId);
		if (cred?.type !== "oauth" || !provider || this.loadError) return undefined;
		if (Date.now() < cred.expires) return provider.getApiKey(cred);
		const revision = this.captureOAuthStorageRevision(providerId);
		try {
			const refreshed = (await this.refreshOAuthTokenWithLock(providerId))?.apiKey;
			if (refreshed !== undefined) return refreshed;
			// No refresh happened. Either the credential is gone from the file (another process
			// logged out — then there genuinely is no credential) or it is still the expired one.
			const current = this.data[providerId];
			if (current?.type !== "oauth") return undefined;
			if (Date.now() < current.expires) return provider.getApiKey(current);
			throw new OAuthCredentialUnusableError(
				providerId,
				current.expires,
				"the stored refresh token was refused or is no longer present",
			);
		} catch (error) {
			if (error instanceof OAuthCredentialUnusableError) throw error;
			this.recordError(error);
			let updated: AuthCredential | null | undefined;
			try {
				updated = await this.withOAuthStorageLock(
					providerId,
					async (current) => ({ result: current[providerId] ?? null }),
					revision,
				);
			} catch (recoveryError) {
				this.recordError(recoveryError);
				throw new OAuthCredentialUnusableError(providerId, cred.expires, redactRefreshFailureReason(error));
			}
			// An explicit local intent or a removed stored OAuth credential wins over
			// failure recovery too. Recovery must never replace the whole cache blindly.
			if (updated?.type !== "oauth") return undefined;
			if (Date.now() < updated.expires) {
				return provider.getApiKey(updated);
			}
			throw new OAuthCredentialUnusableError(providerId, updated.expires, redactRefreshFailureReason(error));
		}
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed with locking)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 *
	 * Throws {@link OAuthCredentialUnusableError} when the provider's stored OAuth credential is
	 * expired and unrefreshable: that is a different failure from "no key configured", and the
	 * lower-priority sources below it must not quietly stand in for the credential the user chose.
	 */
	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			return resolveConfigValue(cred.key);
		}

		if (cred?.type === "oauth") {
			return this.getOAuthApiKey(providerId);
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		// Fall back to custom resolver (e.g., models.json custom providers)
		if (options?.includeFallback !== false) {
			return this.fallbackResolver?.(providerId) ?? undefined;
		}

		return undefined;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}
