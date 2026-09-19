/**
 * Expert Capacity Service.
 * Tracks concurrent active worker slots per expert/provider and rechecks volatile capacity.
 * Implements COST_LOAD_LOCALITY.md and HMOE-093/HMOE-094.
 */

import type { ExpertBinding, WorkerCapabilityRequest } from "./contracts.ts";

export class ExpertCapacityService {
	private readonly activeSlotsByExpert: Map<string, number> = new Map();
	private readonly maxSlotsPerExpert: number;

	constructor(maxSlotsPerExpert = 10) {
		this.maxSlotsPerExpert = maxSlotsPerExpert;
	}

	/**
	 * Re-checks volatile capacity and reserves in-flight execution slots.
	 */
	async reserve(bindings: readonly ExpertBinding[], _request: WorkerCapabilityRequest): Promise<void> {
		for (const binding of bindings) {
			const current = this.activeSlotsByExpert.get(binding.expert_id) ?? 0;
			if (current >= this.maxSlotsPerExpert) {
				throw new Error(
					`Expert '${binding.expert_id}' has reached maximum concurrent capacity (${this.maxSlotsPerExpert}).`,
				);
			}
			this.activeSlotsByExpert.set(binding.expert_id, current + 1);
		}
	}

	/**
	 * Releases reserved slots when worker execution finishes.
	 */
	release(bindings: readonly ExpertBinding[]): void {
		for (const binding of bindings) {
			const current = this.activeSlotsByExpert.get(binding.expert_id) ?? 0;
			if (current > 0) {
				this.activeSlotsByExpert.set(binding.expert_id, current - 1);
			}
		}
	}

	getActiveCount(expertId: string): number {
		return this.activeSlotsByExpert.get(expertId) ?? 0;
	}

	getInFlightCount(expertId: string): number {
		return this.getActiveCount(expertId);
	}
}
