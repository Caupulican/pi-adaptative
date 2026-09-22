/**
 * One session-owned boundary for every repository-capable tool call.
 * The ledger still owns exact typed paths. This observer owns fingerprints,
 * in-flight calls, and unexplained deltas.
 */
import { consumeProcessTreeUntracked } from "../../utils/process-group-wait.ts";
import { normalizeRepoRelativePath, type ObjectiveMutationLedger } from "./objective-mutation-ledger.ts";
import {
	captureRepoDeliveryFingerprint,
	type FingerprintHooks,
	type RepoDeliveryFingerprint,
} from "./repo-delivery-fingerprint.ts";
import type { RepositoryEffect } from "./repository-effect.ts";

export interface RepositoryObservationToken {
	readonly callId: string;
	readonly objectiveId: string;
	readonly effect: RepositoryEffect;
	readonly cwd: string;
	before?: RepoDeliveryFingerprint;
}

interface Waiter {
	readonly objectiveId: string;
	readonly wake: () => void;
}

export class RepositoryMutationObserver {
	private readonly inflight = new Map<string, RepositoryObservationToken>();
	private readonly reasons = new Map<string, string>();
	private readonly waiters = new Set<Waiter>();
	private readonly ledger: ObjectiveMutationLedger;
	private readonly hooks: FingerprintHooks | undefined;

	constructor(ledger: ObjectiveMutationLedger, hooks?: FingerprintHooks) {
		this.ledger = ledger;
		this.hooks = hooks;
	}

	async begin(input: {
		readonly callId: string;
		readonly objectiveId: string;
		readonly cwd: string;
		readonly effect: RepositoryEffect;
	}): Promise<RepositoryObservationToken> {
		const previous = this.inflight.get(input.callId);
		if (previous) this.abort(previous);
		const token: RepositoryObservationToken = {
			callId: input.callId,
			objectiveId: input.objectiveId,
			effect: input.effect,
			cwd: input.cwd,
		};
		if (input.effect === "none") return token;
		this.inflight.set(input.callId, token);
		try {
			token.before = await captureRepoDeliveryFingerprint(input.cwd, this.hooks);
			if (!token.before.ok) this.mark(input.objectiveId, token.before.reason);
		} catch {
			token.before = { ok: false, reason: "repository_fingerprint_unavailable" };
			this.mark(input.objectiveId, "repository_fingerprint_unavailable");
		}
		return token;
	}

	async finish(input: {
		readonly token: RepositoryObservationToken;
		readonly declaredOwnedPaths?: readonly string[];
		readonly operationSucceeded: boolean;
	}): Promise<void> {
		const token = input.token;
		const tracked = this.inflight.get(token.callId) === token;
		if (consumeProcessTreeUntracked(token.cwd)) this.mark(token.objectiveId, "process_tree_untracked");
		if (token.effect === "none") return;
		this.inflight.delete(token.callId);
		try {
			if (!token.before?.ok) {
				this.mark(token.objectiveId, token.before?.reason ?? "repository_fingerprint_unavailable");
				return;
			}
			const after = await captureRepoDeliveryFingerprint(token.cwd, this.hooks);
			if (!after.ok) {
				this.mark(token.objectiveId, after.reason);
				return;
			}
			if (after.digest === token.before.digest) return;
			const declared = new Set(
				(input.declaredOwnedPaths ?? [])
					.map((filePath) => normalizeRepoRelativePath(token.cwd, filePath))
					.filter((filePath): filePath is string => Boolean(filePath)),
			);
			if (declared.size > 0 || token.effect === "typed_owned_write") {
				const extra = changedPaths(token.before.entries, after.entries).filter(
					(filePath) => !declared.has(filePath),
				);
				if (extra.length > 0) {
					this.mark(token.objectiveId, "shell_mutation_unattributed");
					return;
				}
				if (input.operationSucceeded) {
					for (const filePath of declared) this.ledger.recordOwnedWrite(token.objectiveId, token.cwd, filePath);
				}
				return;
			}
			this.mark(token.objectiveId, "shell_mutation_unattributed");
		} finally {
			if (tracked) this.notify(token.objectiveId);
		}
	}

	abort(token: RepositoryObservationToken): void {
		if (!this.inflight.delete(token.callId)) return;
		this.notify(token.objectiveId);
	}

	hasInFlight(objectiveId: string): boolean {
		for (const token of this.inflight.values()) {
			if (token.objectiveId === objectiveId) return true;
		}
		return false;
	}

	waitForQuiescence(objectiveId: string, signal?: AbortSignal): Promise<void> {
		if (!this.hasInFlight(objectiveId)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				objectiveId,
				wake: () => {
					if (this.hasInFlight(objectiveId)) return;
					cleanup();
					resolve();
				},
			};
			const onAbort = (): void => {
				cleanup();
				reject(signal?.reason ?? new Error("repository quiescence aborted"));
			};
			const cleanup = (): void => {
				this.waiters.delete(waiter);
				signal?.removeEventListener("abort", onAbort);
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			this.waiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	deliveryBlockReason(objectiveId: string): string | undefined {
		if (this.hasInFlight(objectiveId)) return "repository_mutation_in_flight";
		return this.reasons.get(objectiveId) ?? this.ledger.deliveryBlockReason(objectiveId);
	}

	private mark(objectiveId: string, reason: string): void {
		if (!this.reasons.has(objectiveId)) this.reasons.set(objectiveId, reason);
		this.ledger.markShellUnsafe(objectiveId);
	}

	private notify(objectiveId: string): void {
		for (const waiter of this.waiters) {
			if (waiter.objectiveId === objectiveId) waiter.wake();
		}
	}
}

function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
	const paths = new Set<string>([...before.keys(), ...after.keys()]);
	const changed: string[] = [];
	for (const filePath of paths) {
		if (before.get(filePath) !== after.get(filePath)) changed.push(filePath);
	}
	return changed;
}
