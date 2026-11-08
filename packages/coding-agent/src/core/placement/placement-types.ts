/**
 * Where one unit of delegated work runs. A leaf module: the fleet scheduler, the placement decision and the remote job
 * surface all import it, and it imports nothing. `local_worker` is a lane of this session; the other kinds name a target
 * the scheduler reaches through that target's registered capacity source.
 */

export type Placement =
	| { readonly kind: "local_worker" }
	| { readonly kind: "bot"; readonly botId: string }
	/**
	 * botId absent and machineId absent: the harness appoints a goal leader here. machineId set: that machine's root
	 * session leads (botId ignored).
	 */
	| { readonly kind: "leader"; readonly botId?: string; readonly machineId?: string }
	| { readonly kind: "remote_machine"; readonly machineId: string };

/** A model's `by` is a preference; an owner's pin is a must. */
export interface PlacementPin {
	readonly target: "here" | { readonly machineId: string } | { readonly botId: string };
	readonly mode: "must" | "prefer";
}

/** The capacity-source key a placement is admitted against; undefined for a local lane and an appointed local leader. */
export function placementCapacityKey(placement: Placement): `machine:${string}` | `bot:${string}` | undefined {
	switch (placement.kind) {
		case "local_worker":
			return undefined;
		case "bot":
			return `bot:${placement.botId}`;
		case "leader":
			if (placement.machineId !== undefined) return `machine:${placement.machineId}`;
			return placement.botId !== undefined ? `bot:${placement.botId}` : undefined;
		case "remote_machine":
			return `machine:${placement.machineId}`;
	}
}
