/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import { findEnvKeys, getEnvApiKey, getEnvAuthHeaders, getEnvCredentialValues } from "@caupulican/pi-ai/env-api-keys";
import {
	getOAuthProvider,
	getOAuthProviders,
	needsOAuthCredentialUpdate,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
	type OAuthProviderInterface,
	OAuthRefreshCompletedError,
	OAuthRefreshRejectedError,
	refreshOAuthToken,
	updateOAuthCredentials,
} from "@caupulican/pi-ai/oauth";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { isDeepStrictEqual } from "util";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { getCachedConfigValue, isCommandConfigValue, resolveConfigValue } from "./resolve-config-value.ts";
import { isCredentialSecretKey } from "./secrets/credential-content-mock.ts";
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
	refreshRefused?: boolean;
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

export class CredentialPersistenceError extends Error {
	readonly provider: string;
	readonly operation: "save" | "remove";

	constructor(provider: string, operation: "save" | "remove") {
		super(
			operation === "save"
				? `The ${provider} credential is available only in this session. Saving it failed.`
				: `The ${provider} credential was removed from this session. Removing the saved credential failed.`,
		);
		this.name = "CredentialPersistenceError";
		this.provider = provider;
		this.operation = operation;
	}
}

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "session" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
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

class AuthStorageLockCompromisedError extends Error {
	constructor(cause?: Error) {
		super("Auth storage lock was compromised", { cause });
		this.name = "AuthStorageLockCompromisedError";
	}
}

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
	/** Serialize provider refresh I/O without holding the auth-file transaction lock. */
	withProviderRefreshLock<T>(providerId: string, fn: () => Promise<T>): Promise<T>;
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
				throw new AuthStorageLockCompromisedError(lockCompromisedError);
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
				await writeFileAtomic(this.authPath, next, {
					...AUTH_FILE_WRITE_OPTIONS,
					beforeCommit: throwIfCompromised,
				});
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

	async withProviderRefreshLock<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
		this.ensureParentDir();
		const suffix = createHash("sha256").update(providerId).digest("hex").slice(0, 16);
		// proper-lockfile tracks ownership by canonical target, not by lockfilePath. A distinct
		// target is mandatory because this callback takes short authPath locks while it is held.
		const refreshTarget = `${this.authPath}.${suffix}.refresh`;
		const release = await lockfile.lock(refreshTarget, {
			realpath: false,
			retries: {
				retries: 10,
				factor: 2,
				minTimeout: 100,
				maxTimeout: 10000,
				randomize: true,
			},
			stale: 30000,
		});
		try {
			return await fn();
		} finally {
			await release().catch(() => undefined);
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private locked = false;
	private pending = Promise.resolve();
	private readonly providerRefreshes = new Map<string, Promise<void>>();

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

	async withProviderRefreshLock<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.providerRefreshes.get(providerId) ?? Promise.resolve();
		const released = Promise.withResolvers<void>();
		this.providerRefreshes.set(providerId, released.promise);
		await previous;
		try {
			return await fn();
		} finally {
			released.resolve();
			if (this.providerRefreshes.get(providerId) === released.promise) this.providerRefreshes.delete(providerId);
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
	private readonly pendingLogins = new Map<string, AbortController>();
	private readonly unpersistedChanges = new Map<string, AuthCredential["type"]>();
	private runtimeOverrides: Map<string, string> = new Map();
	/** Stale (unexpired, older-format) credential fingerprint this process already tried to refresh per provider. */
	private readonly staleRefreshAttempted = new Map<string, string>();
	private readonly refusedRefreshTokens = new Map<string, string>();
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

	/** Effective explicit override, without refreshing credentials or executing key commands. */
	getRuntimeApiKey(provider: string): string | undefined {
		return this.runtimeOverrides.get(provider);
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
		const data: unknown = JSON.parse(stripBom(content));
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new Error("Credential storage must contain a JSON object.");
		return data as AuthStorageData;
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
			const loaded = this.parseStorageData(content);
			for (const provider of this.pendingLogins.keys()) {
				if (!isDeepStrictEqual(this.data[provider], loaded[provider])) this.supersedeLogin(provider);
			}
			this.data = loaded;
			this.unpersistedChanges.clear();
			this.staleRefreshAttempted.clear();
			this.refusedRefreshTokens.clear();
			for (const [providerId, cred] of Object.entries(this.data)) {
				if (cred?.type === "oauth" && cred.refreshRefused && cred.refresh) {
					this.refusedRefreshTokens.set(providerId, cred.refresh);
				}
			}
			this.reloadRevision = ++this.dataRevision;
			this.providerRevisions.clear();
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): boolean {
		try {
			const committed = this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: merged, next: JSON.stringify(merged, null, 2) };
			});
			if (this.loadError) {
				this.importDurableSnapshot(committed);
				this.reloadRevision = ++this.dataRevision;
				this.providerRevisions.clear();
				this.loadError = null;
			}
			return true;
		} catch (error) {
			this.recordError(error);
			return false;
		}
	}

	private importDurableSnapshot(data: AuthStorageData): void {
		for (const provider of this.unpersistedChanges.keys()) {
			if (this.data[provider]) data[provider] = this.data[provider];
			else delete data[provider];
		}
		this.data = data;
	}

	private supersedeLogin(provider: string): void {
		const pending = this.pendingLogins.get(provider);
		if (!pending) return;
		this.pendingLogins.delete(provider);
		pending.abort(new Error(`The sign-in for ${provider} was superseded by a newer credential change.`));
	}

	private changeCredential(provider: string, credential: AuthCredential | undefined): boolean {
		this.supersedeLogin(provider);
		const type = credential?.type ?? this.data[provider]?.type ?? this.unpersistedChanges.get(provider);
		this.staleRefreshAttempted.delete(provider);
		if (credential?.type === "oauth" && credential.refreshRefused && credential.refresh) {
			this.refusedRefreshTokens.set(provider, credential.refresh);
		} else {
			this.refusedRefreshTokens.delete(provider);
		}
		if (credential) this.data[provider] = credential;
		else delete this.data[provider];
		this.providerRevisions.set(provider, ++this.dataRevision);
		const persisted = this.persistProviderChange(provider, credential);
		if (persisted) this.unpersistedChanges.delete(provider);
		else if (type) this.unpersistedChanges.set(provider, type);
		return persisted;
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider. Returns whether persistence succeeded; a failed write
	 * retains the existing session-only behavior and records its error for the host.
	 */
	set(provider: string, credential: AuthCredential): boolean {
		return this.changeCredential(provider, structuredClone(credential));
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): boolean {
		return this.changeCredential(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	listForRemoval(): { id: string; authType: AuthCredential["type"]; removalPending: boolean }[] {
		const options = Object.entries(this.data).map(([id, credential]) => ({
			id,
			authType: credential.type,
			removalPending: false,
		}));
		for (const [id, authType] of this.unpersistedChanges) {
			if (!this.data[id]) options.push({ id, authType, removalPending: true });
		}
		return options;
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
		const cred = this.get(provider);
		if (cred !== undefined) {
			if (cred.type === "oauth") {
				if (
					Date.now() < cred.expires ||
					(Boolean(cred.refresh) &&
						!cred.refreshRefused &&
						this.refusedRefreshTokens.get(provider) !== cred.refresh)
				) {
					return true;
				}
			} else {
				return true;
			}
		}
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
			return { configured: true, source: this.unpersistedChanges.has(provider) ? "session" : "stored" };
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

	/** Current known host credentials, read locally without refreshing OAuth or running config commands. */
	getKnownCredentialValues(providers: Iterable<string> = []): string[] {
		const values = new Set<string>();
		const add = (value: string | undefined): void => {
			if (value) values.add(value);
		};
		for (const [providerId, credential] of Object.entries(this.data)) {
			if (credential.type === "api_key") {
				add(
					isCommandConfigValue(credential.key)
						? getCachedConfigValue(credential.key)
						: resolveConfigValue(credential.key),
				);
				continue;
			}
			add(credential.access);
			add(credential.refresh);
			for (const [name, value] of Object.entries(credential)) {
				if (name === "access" || name === "refresh" || isCredentialSecretKey(name)) {
					if (typeof value === "string") add(value);
				}
			}
			try {
				add(getOAuthProvider(providerId)?.getApiKey(credential));
			} catch {
				// Malformed or plugin-specific OAuth data remains in storage; redaction must stay available.
			}
		}
		for (const value of this.runtimeOverrides.values()) add(value);
		for (const provider of providers) {
			for (const value of getEnvCredentialValues(provider)) add(value);
		}
		return [...values];
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
		callbacks.signal?.throwIfAborted();
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		this.supersedeLogin(providerId);
		const attempt = new AbortController();
		this.pendingLogins.set(providerId, attempt);
		const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, attempt.signal]) : attempt.signal;
		try {
			const credentials = await provider.login({ ...callbacks, signal });
			signal.throwIfAborted();
			this.pendingLogins.delete(providerId);
			if (!this.set(providerId, { type: "oauth", ...credentials }))
				throw new CredentialPersistenceError(providerId, "save");
		} finally {
			if (this.pendingLogins.get(providerId) === attempt) this.pendingLogins.delete(providerId);
		}
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		if (!this.remove(provider)) throw new CredentialPersistenceError(provider, "remove");
	}

	private captureOAuthStorageRevision(providerId: string): OAuthStorageRevision {
		return { data: this.dataRevision, provider: this.providerRevisions.get(providerId) ?? this.reloadRevision };
	}

	/** Project refusal only onto the exact stored refresh token that the provider rejected. Callers hold the storage lock. */
	private refusedOAuthCredential(
		providerId: string,
		credential: AuthCredential | undefined,
	): OAuthCredential | undefined {
		if (
			credential?.type !== "oauth" ||
			credential.refreshRefused ||
			this.refusedRefreshTokens.get(providerId) !== credential.refresh
		) {
			return undefined;
		}
		return { ...credential, refreshRefused: true };
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
				if (this.captureOAuthStorageRevision(providerId).provider !== revision.provider)
					return { result: undefined };
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
			this.importDurableSnapshot(committed.data);
		} else {
			// Other providers may change independently while this backend releases its lock.
			const credential = committed.data[providerId];
			if (credential) this.data[providerId] = credential;
			else {
				delete this.data[providerId];
				this.staleRefreshAttempted.delete(providerId);
			}
		}
		this.providerRevisions.set(providerId, ++this.dataRevision);
		this.loadError = null;
		return committed.result;
	}

	/**
	 * Serialize one provider's refresh across processes, but keep network I/O outside the auth-file
	 * transaction. The second short transaction is a complete-credential compare-and-swap: logout,
	 * replacement, or a sibling rotation wins without replaying the token endpoint.
	 */
	private async withOAuthRefreshLock(
		providerId: string,
		refresh: (credential: OAuthCredential) => Promise<OAuthCredentials | undefined>,
	): Promise<OAuthCredentials | undefined> {
		if (this.unpersistedChanges.has(providerId)) return undefined;
		return this.storage.withProviderRefreshLock(providerId, async () => {
			const revision = this.captureOAuthStorageRevision(providerId);
			const posted = await this.storage.withLockAsync<OAuthCredential | undefined>(async (current) => {
				const credential = this.parseStorageData(current)[providerId];
				return { result: credential?.type === "oauth" ? structuredClone(credential) : undefined };
			});
			if (!posted || this.captureOAuthStorageRevision(providerId).provider !== revision.provider) return undefined;

			let refreshed: OAuthCredentials | undefined;
			let completedError: OAuthRefreshCompletedError | undefined;
			try {
				refreshed = await refresh(structuredClone(posted));
			} catch (error) {
				if (!(error instanceof OAuthRefreshCompletedError) || error.providerId !== providerId) throw error;
				this.recordError(error);
				completedError = error;
				refreshed = error.credentials;
			}
			let received: OAuthCredential | undefined = refreshed ? { type: "oauth", ...refreshed } : undefined;
			if (!received) received = this.refusedOAuthCredential(providerId, posted);
			if (!received) return undefined;
			const finalReceived = received;

			const commit = async () =>
				this.withOAuthStorageLock(
					providerId,
					async (current) => {
						const credential = current[providerId];
						if (credential?.type !== "oauth") return { result: undefined };
						if (!isDeepStrictEqual(credential, posted)) {
							return { result: Date.now() < credential.expires ? credential : undefined };
						}
						if (isDeepStrictEqual(posted, finalReceived)) {
							return { result: finalReceived.refreshRefused ? undefined : finalReceived };
						}
						return {
							result: finalReceived.refreshRefused ? undefined : finalReceived,
							nextData: { ...current, [providerId]: finalReceived },
						};
					},
					revision,
				);

			let result: OAuthCredentials | undefined;
			try {
				result = await commit();
			} catch (error) {
				let persistenceError = error;
				let retryCommitted = false;
				if (error instanceof AuthStorageLockCompromisedError) {
					try {
						result = await commit();
						retryCommitted = true;
					} catch (retryError) {
						persistenceError = retryError;
					}
				}
				if (!retryCommitted && this.captureOAuthStorageRevision(providerId).provider === revision.provider) {
					// Match the native saving token source: a save failure is recorded, but the freshly
					// rotated token remains authoritative for this process instead of being discarded.
					this.recordError(persistenceError);
					this.data[providerId] = finalReceived;
					this.unpersistedChanges.set(providerId, "oauth");
					this.providerRevisions.set(providerId, ++this.dataRevision);
					result = finalReceived.refreshRefused ? undefined : finalReceived;
				} else if (!retryCommitted) {
					throw persistenceError;
				}
			}
			if (result && completedError && isDeepStrictEqual(result, finalReceived)) {
				this.markStaleRefreshAttempted(providerId, result);
				throw completedError;
			}
			return result && Date.now() < result.expires ? result : undefined;
		});
	}

	/**
	 * Whether a stored OAuth credential must be refreshed before use: when it expired, or when the
	 * provider finds it stale (still valid, stored by an older version that lacks data it now reads).
	 * A stale credential stays usable, so its upgrade is tried once per credential state in this
	 * process: a provider whose refresh keeps failing is not re-asked on every request, while a
	 * newly stored or reloaded credential remains eligible.
	 */
	private noteRefreshRefusal(providerId: string, credential: OAuthCredentials, error: unknown): void {
		const rejection = error instanceof Error && !(error instanceof OAuthRefreshRejectedError) ? error.cause : error;
		if (rejection instanceof OAuthRefreshRejectedError) this.refusedRefreshTokens.set(providerId, credential.refresh);
	}

	private staleCredentialKey(credential: OAuthCredentials): string {
		return JSON.stringify(
			Object.entries(credential)
				.filter(([key]) => key !== "type")
				.sort(([left], [right]) => left.localeCompare(right)),
		);
	}

	private markStaleRefreshAttempted(providerId: string, credential: OAuthCredentials): void {
		this.staleRefreshAttempted.set(providerId, this.staleCredentialKey(credential));
	}

	private needsOAuthRefresh(providerId: string, provider: OAuthProviderInterface, cred: OAuthCredentials): boolean {
		if (Date.now() >= cred.expires) return true;
		return (
			needsOAuthCredentialUpdate(provider, cred) &&
			this.staleRefreshAttempted.get(providerId) !== this.staleCredentialKey(cred)
		);
	}

	/**
	 * Rotate an expired token or update stale provider-owned account state. Both operations share
	 * the provider refresh lock, but only token rotation can permanently refuse a refresh token.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
		onStaleUpgrade?: () => void,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const newCredentials = await this.withOAuthRefreshLock(providerId, async (cred) => {
			if (!this.needsOAuthRefresh(providerId, provider, cred)) {
				return cred;
			}
			if (cred.refreshRefused || this.refusedRefreshTokens.get(providerId) === cred.refresh) {
				return Date.now() < cred.expires ? cred : undefined;
			}
			const expired = Date.now() >= cred.expires;
			if (!expired) {
				this.markStaleRefreshAttempted(providerId, cred);
				onStaleUpgrade?.();
			}
			try {
				return expired ? await refreshOAuthToken(provider, cred) : await updateOAuthCredentials(provider, cred);
			} catch (error) {
				if (expired) this.noteRefreshRefusal(providerId, cred, error);
				throw error;
			}
		});
		return newCredentials ? { apiKey: provider.getApiKey(newCredentials), newCredentials } : null;
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

		const recovered = await this.withOAuthRefreshLock(providerId, async (credential) => {
			const currentKey = provider.getApiKey(credential);
			if (currentKey !== rejectedApiKey && Date.now() < credential.expires) {
				return credential;
			}
			if (credential.refreshRefused || this.refusedRefreshTokens.get(providerId) === credential.refresh)
				return undefined;

			try {
				return await refreshOAuthToken(provider, credential);
			} catch (error) {
				if (error instanceof OAuthRefreshCompletedError) throw error;
				this.noteRefreshRefusal(providerId, credential, error);
				this.recordError(error);
				return undefined;
			}
		});
		const recoveredKey = recovered ? provider.getApiKey(recovered) : undefined;
		// A foreign metadata edit can retain the very key that triggered recovery.
		// Preserve that write, but do not present the rejected key as a repaired one.
		return recoveredKey !== rejectedApiKey ? recoveredKey : undefined;
	}

	/**
	 * Stored OAuth only: never executes key commands or resolves runtime/env/fallback API keys.
	 *
	 * Returns undefined when the provider has no stored OAuth credential at all. When one exists
	 * but is expired and unusable, this throws {@link OAuthCredentialUnusableError} instead of
	 * returning undefined — an expired credential is a different failure from a missing one, and
	 * reporting it as "no API key" hid a four-day-stale token behind the wrong instruction.
	 */
	getOAuthRequestHeaders(providerId: string, apiKey: string): Record<string, string> | undefined {
		return this.getOAuthRequestProjection(providerId, apiKey).credentialHeaders;
	}

	/** Stored OAuth only: freeze every provider-owned request projection beside the matching key. */
	getOAuthRequestProjection(
		providerId: string,
		apiKey: string,
	): {
		credentialHeaders?: Record<string, string>;
		providerRequestContext?: Readonly<Record<string, unknown>>;
	} {
		const credential = this.data[providerId];
		const provider = getOAuthProvider(providerId);
		if (this.runtimeOverrides.has(providerId) || credential?.type !== "oauth" || !provider) return {};
		if (provider.getApiKey(credential) !== apiKey) return {};
		const credentialHeaders = provider.getRequestHeaders?.(credential);
		const context = provider.getRequestContext?.(credential);
		const providerRequestContext = context === undefined ? undefined : Object.freeze(structuredClone(context));
		return {
			...(credentialHeaders !== undefined ? { credentialHeaders } : {}),
			...(providerRequestContext !== undefined ? { providerRequestContext } : {}),
		};
	}

	/** Stored OAuth only: freeze provider-owned, non-secret session state beside the matching key. */
	getOAuthRequestContext(providerId: string, apiKey: string): Readonly<Record<string, unknown>> | undefined {
		return this.getOAuthRequestProjection(providerId, apiKey).providerRequestContext;
	}

	async getOAuthApiKey(providerId: string): Promise<string | undefined> {
		const cred = this.data[providerId];
		const provider = getOAuthProvider(providerId);
		if (cred?.type !== "oauth" || !provider) return undefined;
		if (this.unpersistedChanges.has(providerId)) {
			if (Date.now() < cred.expires) return provider.getApiKey(cred);
			throw new OAuthCredentialUnusableError(
				providerId,
				cred.expires,
				"the session-only credential could not be saved",
			);
		}
		if (this.loadError) return undefined;
		if (!this.needsOAuthRefresh(providerId, provider, cred)) return provider.getApiKey(cred);
		let staleOnlyUpgrade = false;
		const revision = this.captureOAuthStorageRevision(providerId);
		try {
			const refreshed = (
				await this.refreshOAuthTokenWithLock(providerId, () => {
					staleOnlyUpgrade = true;
				})
			)?.apiKey;
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
			if (error instanceof OAuthRefreshCompletedError) {
				if (!staleOnlyUpgrade) throw error;
				// A stale-only upgrade already persisted the rotated token and recorded the
				// discovery error; keep the still-valid credential in use.
				const current = this.data[providerId];
				if (current?.type === "oauth" && Date.now() < current.expires) {
					return provider.getApiKey(current);
				}
				throw error;
			}
			this.recordError(error);
			let updated: AuthCredential | null | undefined;
			try {
				updated = await this.withOAuthStorageLock(
					providerId,
					async (current) => {
						const stored = current[providerId];
						const marked = this.refusedOAuthCredential(providerId, stored);
						if (marked) {
							return { result: marked, nextData: { ...current, [providerId]: marked } };
						}
						return { result: stored ?? null };
					},
					revision,
				);
			} catch (recoveryError) {
				try {
					updated = await this.withOAuthStorageLock(
						providerId,
						async (current) => ({ result: current[providerId] ?? null }),
						revision,
					);
				} catch {
					this.recordError(recoveryError);
					if (this.captureOAuthStorageRevision(providerId).provider !== revision.provider) {
						return undefined;
					}
					if (staleOnlyUpgrade && Date.now() < cred.expires) {
						return provider.getApiKey(cred);
					}
					throw new OAuthCredentialUnusableError(providerId, cred.expires, redactRefreshFailureReason(error));
				}
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
		const runtimeKey = this.getRuntimeApiKey(providerId);
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
