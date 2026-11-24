/**
 * Auth-storage infrastructure adapters: atomic file transactions, session-only memory storage,
 * provider refresh serialization, lease compromise signaling and rotation write preflight.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import {
	acquireFileLockSync,
	LOW_LATENCY_FILE_LOCK_OPTIONS,
	writeFileAtomic,
	writeFileAtomicSync,
} from "./util/atomic-file.ts";

type LockResult<T> = {
	result: T;
	next?: string;
};

export interface ProviderRefreshLease {
	readonly signal: AbortSignal;
	assertHeld(): void;
}

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export class AuthStorageLockCompromisedError extends Error {
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
	/** Serialize refresh I/O and expose compromise state to backends that support abortable leases. */
	withProviderRefreshLease?<T>(providerId: string, fn: (lease: ProviderRefreshLease) => Promise<T>): Promise<T>;
	/** Prepare for token rotation: durable stores prove writes; session-only stores explicitly opt in. */
	preflightRefreshPersistence?(providerId: string): Promise<void>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
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
			release?.();
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) throw new AuthStorageLockCompromisedError(lockCompromisedError);
		};
		try {
			release = await lockfile.lock(this.authPath, {
				realpath: false,
				retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10000, randomize: true },
				stale: 30000,
				onCompromised: (error) => {
					lockCompromised = true;
					lockCompromisedError = error;
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
			if (release) await release().catch(() => undefined);
		}
	}

	withProviderRefreshLock<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
		return this.withProviderRefreshLease(providerId, async () => fn());
	}

	async withProviderRefreshLease<T>(providerId: string, fn: (lease: ProviderRefreshLease) => Promise<T>): Promise<T> {
		this.ensureParentDir();
		const suffix = createHash("sha256").update(providerId).digest("hex").slice(0, 16);
		// proper-lockfile owns canonical targets, so this must differ from authPath while the
		// refresh callback takes short authPath transactions.
		const refreshTarget = `${this.authPath}.${suffix}.refresh`;
		const compromised = new AbortController();
		let compromiseError: AuthStorageLockCompromisedError | undefined;
		const assertHeld = () => {
			if (compromiseError) throw compromiseError;
		};
		const release = await lockfile.lock(refreshTarget, {
			realpath: false,
			retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10000, randomize: true },
			stale: 30000,
			onCompromised: (error) => {
				compromiseError = new AuthStorageLockCompromisedError(error);
				compromised.abort(compromiseError);
			},
		});
		try {
			assertHeld();
			return await fn({ signal: compromised.signal, assertHeld });
		} finally {
			await release().catch(() => undefined);
		}
	}

	async preflightRefreshPersistence(providerId: string): Promise<void> {
		this.ensureParentDir();
		const suffix = createHash("sha256").update(providerId).digest("hex").slice(0, 16);
		const probePath = `${this.authPath}.${suffix}.refresh-write-probe`;
		try {
			await writeFileAtomic(probePath, "{}", AUTH_FILE_WRITE_OPTIONS);
			chmodSync(probePath, 0o600);
		} finally {
			if (existsSync(probePath)) unlinkSync(probePath);
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
			if (next !== undefined) this.value = next;
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
			if (next !== undefined) this.value = next;
			return result;
		} finally {
			this.locked = false;
			released.resolve();
		}
	}

	withProviderRefreshLock<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
		return this.withProviderRefreshLease(providerId, async () => fn());
	}

	async withProviderRefreshLease<T>(providerId: string, fn: (lease: ProviderRefreshLease) => Promise<T>): Promise<T> {
		const previous = this.providerRefreshes.get(providerId) ?? Promise.resolve();
		const released = Promise.withResolvers<void>();
		this.providerRefreshes.set(providerId, released.promise);
		await previous;
		try {
			const signal = new AbortController().signal;
			return await fn({ signal, assertHeld: () => signal.throwIfAborted() });
		} finally {
			released.resolve();
			if (this.providerRefreshes.get(providerId) === released.promise) this.providerRefreshes.delete(providerId);
		}
	}

	async preflightRefreshPersistence(_providerId: string): Promise<void> {
		// This backend is intentionally session-only; there is no durable state to preflight.
	}
}
