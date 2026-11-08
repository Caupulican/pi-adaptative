/**
 * The room formula's combination step: room is the minimum over its terms, and the binding term (the first term, in the
 * caller's order, that leaves no room) is what a waiting node is indexed under and what a status view names.
 */

import type { FleetRoomDecision, RoomTerm } from "../fleet-types.ts";

export function decideRoom(terms: readonly RoomTerm[]): FleetRoomDecision {
	let room = Number.POSITIVE_INFINITY;
	for (const term of terms) {
		if (term.room < 1) return { ok: false, term };
		room = Math.min(room, term.room);
	}
	return { ok: true, room };
}

/** The tightest term, for a room snapshot's `limitedBy`; undefined when nothing bounds the room. */
export function bindingTerm(terms: readonly RoomTerm[]): RoomTerm | undefined {
	let binding: RoomTerm | undefined;
	for (const term of terms) {
		if (!Number.isFinite(term.room)) continue;
		if (!binding || term.room < binding.room) binding = term;
	}
	return binding;
}

/** A safety-ceiling term: `limit` minus what already holds it. */
export function ceilingTerm(kind: "running" | "writers", used: number, limit: number): RoomTerm {
	return {
		reason: "safety_ceiling",
		room: Math.max(0, limit - used),
		waitKey: `ceiling:${kind}`,
		detail: kind === "running" ? `${used} running of ${limit} allowed` : `${used} writing of ${limit} allowed`,
	};
}
