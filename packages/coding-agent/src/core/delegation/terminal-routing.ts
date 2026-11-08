/**
 * Terminal routing: which owner receives a worker's durable terminal. The chain is ordered and the first predicate
 * that claims the terminal owns it:
 *
 * 1. a node released under a plan header belongs to the plan executor;
 * 2. a node run for a delegation belongs to its leader controller;
 * 3. otherwise the terminal goes to the foreground's handoff, as before.
 *
 * Owners register their predicate when they exist; with none registered every terminal reaches the foreground. A
 * claimed terminal stays pending in the durable outbox until its owner acknowledges it, and every claim is logged so a
 * withheld result is always visible.
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import type { WorkerTerminalHandoffRecord } from "./worker-notification-coordinator.ts";

/** The structured owners a terminal can route to, in chain order. */
export type TerminalRouteOwner = "plan_executor" | "leader_controller";

const ROUTE_ORDER: readonly TerminalRouteOwner[] = ["plan_executor", "leader_controller"];

/** One owner's claim: true when the terminal belongs to it. A predicate that throws leaves the terminal unresolved. */
export type TerminalRoute = (record: WorkerTerminalHandoffRecord) => boolean;

export class TerminalRouting {
	private readonly routes = new Map<TerminalRouteOwner, TerminalRoute>();

	/** Registers an owner's predicate; the returned function removes it. One predicate per owner. */
	register(owner: TerminalRouteOwner, route: TerminalRoute): () => void {
		if (this.routes.has(owner)) throw new Error(`A terminal route is already registered for ${owner}.`);
		this.routes.set(owner, route);
		return () => {
			if (this.routes.get(owner) === route) this.routes.delete(owner);
		};
	}

	/** The structured owner of this terminal, or undefined when it goes to the foreground. */
	route(record: WorkerTerminalHandoffRecord): TerminalRouteOwner | undefined {
		for (const owner of ROUTE_ORDER) {
			const route = this.routes.get(owner);
			if (!route?.(record)) continue;
			harnessLog.info("delegation", "a worker terminal is routed to a structured owner", {
				lane: record.laneId,
				owner,
			});
			return owner;
		}
		return undefined;
	}
}
