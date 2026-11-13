/**
 * Claims held while delegated work can still report. An answer that ends a turn while a worker the same
 * work started is still running claims something that worker's receipts may yet back: the evidence is
 * pending, not missing. The unbacked claims are held with System One's settled reading of the answer (the
 * question is asked once) and judged again against the receipts when none of their workers is in flight.
 */

import type { AgentMessage } from "../../kernel/index.ts";
import type { AnswerClaimScope, ClaimKind, ClaimReceiptEvent } from "./claim-delivery.ts";

export interface HeldClaim {
	readonly sessionId: string;
	readonly request: string;
	readonly finalAnswer: string;
	/** System One's settled readings of the answer; only the receipts are read again. */
	readonly answers: Record<string, unknown>;
	readonly scope: AnswerClaimScope;
	/** The claim kinds no receipt backed when the answer ended. */
	readonly kinds: readonly ClaimKind[];
	/** The delegated lanes the work started that had not ended when the answer did. */
	readonly lanes: ReadonlySet<string>;
}

/** Held claims are few (one per turn that ended while workers ran); past this the oldest are judged at once. */
const MAX_HELD_CLAIMS = 32;

const LANE_STARTING_TOOLS: ReadonlySet<string> = new Set(["assign", "delegate"]);

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The lanes the window's own `assign` and `delegate` calls started, as their results report them. */
export function delegatedLaneIds(events: readonly ClaimReceiptEvent[]): Set<string> {
	const lanes = new Set<string>();
	for (const event of events) {
		if (event.kind !== "message" || event.message.role !== "toolResult") continue;
		if (!LANE_STARTING_TOOLS.has(event.message.toolName)) continue;
		const details = record(event.message.details);
		if (details?.started !== true) continue;
		if (typeof details.laneId === "string") lanes.add(details.laneId);
		const members = record(details.fanout)?.members;
		if (!Array.isArray(members)) continue;
		for (const member of members) {
			const laneId = record(member)?.laneId;
			if (typeof laneId === "string") lanes.add(laneId);
		}
	}
	return lanes;
}

/** The lanes among `lanes` that can still report. */
export function lanesInFlight(lanes: ReadonlySet<string>, inFlight: ReadonlySet<string>): Set<string> {
	return new Set([...lanes].filter((laneId) => inFlight.has(laneId)));
}

export class HeldClaims {
	private held: HeldClaim[] = [];

	get size(): number {
		return this.held.length;
	}

	/** Holds a claim; the claims the bound pushed out come back to be judged now. */
	hold(claim: HeldClaim): HeldClaim[] {
		this.held.push(claim);
		return this.held.splice(0, Math.max(0, this.held.length - MAX_HELD_CLAIMS));
	}

	/**
	 * The claims whose workers have all ended, removed from the hold. A claim whose session or request is no
	 * longer current is dropped: the owner has moved on, and a late correction would answer a different turn.
	 */
	release(inFlight: ReadonlySet<string>, isCurrent: (claim: HeldClaim) => boolean): HeldClaim[] {
		const ready: HeldClaim[] = [];
		this.held = this.held.filter((claim) => {
			if (!isCurrent(claim)) return false;
			if ([...claim.lanes].some((laneId) => inFlight.has(laneId))) return true;
			ready.push(claim);
			return false;
		});
		return ready;
	}
}

/** The messages of a claim window, for the ladder's evidence. */
export function claimEventMessages(events: readonly ClaimReceiptEvent[]): AgentMessage[] {
	return events.flatMap((event) => (event.kind === "message" ? [event.message] : []));
}
