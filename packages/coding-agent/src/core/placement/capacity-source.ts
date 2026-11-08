/**
 * What the fleet scheduler reads for a non-local placement: a remote machine's or a bot's free slots, and a signal when
 * they change. Event-driven only: the scheduler never re-reads a source on a timer, it re-reads when the source says so.
 */

import type { FleetWaitReason } from "../fleet/fleet-types.ts";

export interface PlacementCapacitySource {
	readonly key: `machine:${string}` | `bot:${string}`;
	room(): { slots: number; retryAt?: number; reason?: FleetWaitReason };
	/** Calls `onChange` whenever `room()` may answer differently; the returned function stops it. */
	subscribe(onChange: () => void): () => void;
}
