/**
 * Expert Capacity Service.
 * Tracks concurrent active worker slots and leases per expert, model, provider, and local runtime.
 * Implements COST_LOAD_LOCALITY.md, schemas/expert-capacity-lease.schema.json, and HM11-030..035.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import type { ExpertBinding, ExpertCapacityLease, WorkerCapabilityRequest } from "./contracts.ts";

export interface CapacityLimits {
	maxSlotsPerExpert?: number;
	maxSlotsPerModel?: number;
	maxSlotsPerProvider?: number;
	maxSlotsPerLocalRuntime?: number;
	defaultTtlMs?: number;
}

export class CapacityExhaustedError extends Error {
	readonly dimension: string;
	readonly entity: string;
	readonly limit: number;

	constructor(dimension: string, entity: string, limit: number) {
		super(`Capacity limit reached for ${dimension} '${entity}' (max concurrent: ${limit}).`);
		this.name = "CapacityExhaustedError";
		this.dimension = dimension;
		this.entity = entity;
		this.limit = limit;
	}
}

export class ExpertCapacityService {
	private readonly activeLeases = new Map<string, ExpertCapacityLease>();
	private readonly maxSlotsPerExpert: number;
	private readonly maxSlotsPerModel: number;
	private readonly maxSlotsPerProvider: number;
	private readonly maxSlotsPerLocalRuntime: number;
	private readonly defaultTtlMs: number;
	private fencingCounter = 0;
	private readonly filePath?: string;

	constructor(limits?: CapacityLimits, filePath?: string) {
		this.maxSlotsPerExpert = limits?.maxSlotsPerExpert ?? 10;
		this.maxSlotsPerModel = limits?.maxSlotsPerModel ?? 20;
		this.maxSlotsPerProvider = limits?.maxSlotsPerProvider ?? 30;
		this.maxSlotsPerLocalRuntime = limits?.maxSlotsPerLocalRuntime ?? 5;
		this.defaultTtlMs = limits?.defaultTtlMs ?? 300_000; // 5 minutes
		this.filePath = filePath;

		if (filePath && existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, "utf8");
				const parsed = JSON.parse(content);
				if (Array.isArray(parsed)) {
					for (const lease of parsed) {
						if (lease && typeof lease.lease_id === "string") {
							this.activeLeases.set(lease.lease_id, lease);
							if (lease.fencing_token && lease.fencing_token > this.fencingCounter) {
								this.fencingCounter = lease.fencing_token;
							}
						}
					}
				}
			} catch {
				// Corrupted file, start clean
			}
		}

		this.reconcileStaleLeases();
	}

	private _persist(): void {
		if (!this.filePath) return;
		try {
			const dir = dirname(this.filePath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			const data = Array.from(this.activeLeases.values());
			writeFileAtomicSync(this.filePath, JSON.stringify(data, null, 2));
		} catch {
			// Best-effort persistence
		}
	}

	/**
	 * Removes expired leases and returns the count of purged leases.
	 */
	reconcileStaleLeases(): number {
		const now = Date.now();
		let purged = 0;
		for (const [leaseId, lease] of this.activeLeases.entries()) {
			if (Date.parse(lease.expires_at) <= now) {
				this.activeLeases.delete(leaseId);
				purged++;
			}
		}
		if (purged > 0) {
			this._persist();
		}
		return purged;
	}

	/**
	 * Atomically verifies and reserves capacity for all team bindings.
	 * If any binding exceeds limits, none are reserved.
	 */
	async reserve(
		bindings: readonly ExpertBinding[],
		request: WorkerCapabilityRequest,
		options?: { attemptId?: string; ttlMs?: number; runtimeKey?: string | null },
	): Promise<readonly ExpertCapacityLease[]> {
		this.reconcileStaleLeases();

		const attemptId = options?.attemptId ?? request.task_id;
		const ttlMs = options?.ttlMs ?? this.defaultTtlMs;
		const expiresAt = new Date(Date.now() + ttlMs).toISOString();

		// Calculate current usage across dimensions
		const expertCounts = new Map<string, number>();
		const modelCounts = new Map<string, number>();
		const providerCounts = new Map<string, number>();
		const runtimeCounts = new Map<string, number>();

		for (const lease of this.activeLeases.values()) {
			expertCounts.set(lease.expert_id, (expertCounts.get(lease.expert_id) ?? 0) + 1);
			modelCounts.set(lease.model_ref, (modelCounts.get(lease.model_ref) ?? 0) + 1);
			providerCounts.set(lease.provider, (providerCounts.get(lease.provider) ?? 0) + 1);
			if (lease.runtime_key) {
				runtimeCounts.set(lease.runtime_key, (runtimeCounts.get(lease.runtime_key) ?? 0) + 1);
			}
		}

		// 1. Validation pass (all-or-none atomicity)
		const candidateExpertCounts = new Map(expertCounts);
		const candidateModelCounts = new Map(modelCounts);
		const candidateProviderCounts = new Map(providerCounts);
		const candidateRuntimeCounts = new Map(runtimeCounts);

		for (const binding of bindings) {
			const modelRef = `${binding.provider}/${binding.model_id}`;
			const runtimeKey = options?.runtimeKey ?? null;

			// Check expert
			const nextExp = (candidateExpertCounts.get(binding.expert_id) ?? 0) + 1;
			if (nextExp > this.maxSlotsPerExpert) {
				throw new CapacityExhaustedError("expert", binding.expert_id, this.maxSlotsPerExpert);
			}
			candidateExpertCounts.set(binding.expert_id, nextExp);

			// Check model
			const nextModel = (candidateModelCounts.get(modelRef) ?? 0) + 1;
			if (nextModel > this.maxSlotsPerModel) {
				throw new CapacityExhaustedError("model", modelRef, this.maxSlotsPerModel);
			}
			candidateModelCounts.set(modelRef, nextModel);

			// Check provider
			const nextProv = (candidateProviderCounts.get(binding.provider) ?? 0) + 1;
			if (nextProv > this.maxSlotsPerProvider) {
				throw new CapacityExhaustedError("provider", binding.provider, this.maxSlotsPerProvider);
			}
			candidateProviderCounts.set(binding.provider, nextProv);

			// Check local runtime if specified
			if (runtimeKey) {
				const nextRt = (candidateRuntimeCounts.get(runtimeKey) ?? 0) + 1;
				if (nextRt > this.maxSlotsPerLocalRuntime) {
					throw new CapacityExhaustedError("local_runtime", runtimeKey, this.maxSlotsPerLocalRuntime);
				}
				candidateRuntimeCounts.set(runtimeKey, nextRt);
			}
		}

		// 2. Issuance pass
		const leases: ExpertCapacityLease[] = [];
		for (const binding of bindings) {
			const lease: ExpertCapacityLease = {
				schema_version: "1.0",
				lease_id: `lease_${randomUUID().slice(0, 12)}`,
				selection_id: binding.selection_id,
				attempt_id: attemptId,
				expert_id: binding.expert_id,
				model_ref: `${binding.provider}/${binding.model_id}`,
				provider: binding.provider,
				runtime_key: options?.runtimeKey ?? null,
				fencing_token: ++this.fencingCounter,
				expires_at: expiresAt,
			};
			this.activeLeases.set(lease.lease_id, lease);
			leases.push(lease);
		}

		this._persist();
		return leases;
	}

	/**
	 * Convenience method to reserve all team bindings atomically.
	 */
	async reserveTeam(input: {
		selectionId: string;
		attemptId: string;
		bindings: readonly ExpertBinding[];
		ttlMs?: number;
		runtimeKey?: string | null;
	}): Promise<readonly ExpertCapacityLease[]> {
		const dummyReq = { task_id: input.attemptId } as WorkerCapabilityRequest;
		return this.reserve(input.bindings, dummyReq, {
			attemptId: input.attemptId,
			ttlMs: input.ttlMs,
			runtimeKey: input.runtimeKey,
		});
	}

	/**
	 * Convenience method to release all team leases.
	 */
	async releaseTeam(leases: readonly (ExpertBinding | ExpertCapacityLease)[]): Promise<void> {
		this.release(leases);
	}

	/**
	 * Releases active leases by lease or binding reference.
	 */
	release(bindingsOrLeases: readonly (ExpertBinding | ExpertCapacityLease)[]): void {
		let changed = false;
		for (const item of bindingsOrLeases) {
			if ("lease_id" in item) {
				if (this.activeLeases.delete(item.lease_id)) {
					changed = true;
				}
			} else {
				// Find first matching lease for this binding's expert_id or selection_id
				for (const [id, lease] of this.activeLeases.entries()) {
					if (lease.selection_id === item.selection_id || lease.expert_id === item.expert_id) {
						this.activeLeases.delete(id);
						changed = true;
						break;
					}
				}
			}
		}
		if (changed) {
			this._persist();
		}
	}

	getActiveCount(expertId: string): number {
		this.reconcileStaleLeases();
		let count = 0;
		for (const lease of this.activeLeases.values()) {
			if (lease.expert_id === expertId) {
				count++;
			}
		}
		return count;
	}

	getInFlightCount(expertId: string): number {
		return this.getActiveCount(expertId);
	}

	getAvailableSlots(expertId: string): number {
		return Math.max(0, this.maxSlotsPerExpert - this.getActiveCount(expertId));
	}

	getModelActiveCount(modelRef: string): number {
		this.reconcileStaleLeases();
		let count = 0;
		for (const lease of this.activeLeases.values()) {
			if (lease.model_ref === modelRef) {
				count++;
			}
		}
		return count;
	}

	getProviderActiveCount(provider: string): number {
		this.reconcileStaleLeases();
		let count = 0;
		for (const lease of this.activeLeases.values()) {
			if (lease.provider === provider) {
				count++;
			}
		}
		return count;
	}

	getAllActiveLeases(): readonly ExpertCapacityLease[] {
		this.reconcileStaleLeases();
		return Array.from(this.activeLeases.values());
	}
}
