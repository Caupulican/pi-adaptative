/**
 * Intentional Duplication Waiver Store.
 * Implements S1A-216, S1A-217, S1A-218.
 * Forbids implicit waivers.
 */

import type { IntentionalDuplicationWaiver, ResponsibilityStatement } from "./types.ts";

export class WaiverStore {
	private readonly waivers = new Map<string, IntentionalDuplicationWaiver>();

	registerWaiver(waiver: IntentionalDuplicationWaiver): void {
		// S1A-217: Explicit waiver required from user_objective or owner_policy; implicit waiver forbidden
		if (!waiver.source || (waiver.source !== "user_objective" && waiver.source !== "owner_policy")) {
			throw new Error(
				"Intentional duplication waiver rejected: invalid source. Must be user_objective or owner_policy.",
			);
		}
		this.waivers.set(waiver.waiver_id, waiver);
	}

	getWaiver(waiverId: string): IntentionalDuplicationWaiver | undefined {
		return this.waivers.get(waiverId);
	}

	/**
	 * Checks whether a valid explicit waiver covers the given objective, responsibility scope, and location.
	 */
	findValidWaiver(
		objectiveId: string,
		statement: ResponsibilityStatement,
		location: string,
	): IntentionalDuplicationWaiver | undefined {
		for (const waiver of this.waivers.values()) {
			if (waiver.objective_id !== objectiveId) continue;

			// Scope matching
			const scopeMatches =
				waiver.responsibility_scope === "*" ||
				statement.statement.toLowerCase().includes(waiver.responsibility_scope.toLowerCase()) ||
				waiver.responsibility_scope.toLowerCase().includes(statement.statement.toLowerCase());

			if (!scopeMatches) continue;

			// Location matching if restricted
			if (waiver.allowed_locations && waiver.allowed_locations.length > 0) {
				const locMatches = waiver.allowed_locations.some((loc) => location.includes(loc) || loc.includes(location));
				if (!locMatches) continue;
			}

			return waiver;
		}

		return undefined;
	}

	clear(): void {
		this.waivers.clear();
	}
}
