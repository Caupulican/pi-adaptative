/**
 * The fleet's ready queue: deficit-fair across flows, priority-ordered within one. A flow is an {objective, subtree}
 * pair; its weight is 2^(highest effective priority among its entries), or the weight an open share gives its subtree.
 * Each dispatch charges its flow `cost(class) / weight`; the order always serves the flow whose next dispatch leaves it
 * with the least charged service, so over any busy period each flow receives service in proportion to its weight. That
 * is deficit round robin with the deficit kept as charged service: a selection pass may admit an entry that is not the
 * head of the order (the head waits on a resource), and a classic DRR cursor would charge a flow for a turn it did not
 * run. A flow that becomes busy starts level with the least-served busy flow, so idle time banks no credit.
 *
 * Within one flow the order is effective priority (base priority aged one step per two minutes waited, plus one on the
 * critical path, at most 3), then base priority, then arrival: a verifier (priority 3) runs ahead of ordinary work and
 * never overtakes an older verifier, which is the order the dispatch queue always had.
 */

import { MinHeap } from "../util/min-heap.ts";
import { type FleetPriority, type ShareSpec, WEIGHT_CLASS_COST, type WeightClass } from "./fleet-types.ts";

/** One step of aging: an entry waiting this long ranks one priority higher, up to 3. */
export const FLEET_AGING_STEP_MS = 120_000;

export interface FleetQueueEntryInput<P> {
	readonly id: string;
	readonly payload: P;
	readonly objectiveId: string;
	readonly subtreeId: string;
	readonly priority: FleetPriority;
	readonly weight: WeightClass;
	readonly criticalPath?: boolean;
	/** When the entry first entered the queue; a restart restores it so aging survives. */
	readonly enqueuedAt?: number;
}

export interface FleetQueueEntry<P> {
	readonly id: string;
	readonly payload: P;
	readonly flowKey: string;
	readonly objectiveId: string;
	readonly subtreeId: string;
	readonly priority: FleetPriority;
	readonly weight: WeightClass;
	readonly criticalPath: boolean;
	readonly enqueuedAt: number;
	readonly seq: number;
}

interface FlowCursor<P> {
	readonly pending: readonly FleetQueueEntry<P>[];
	readonly shareWeight: number | undefined;
	index: number;
	finish: number;
}

interface Flow<P> {
	readonly key: string;
	readonly subtreeId: string;
	readonly entries: Map<string, FleetQueueEntry<P>>;
	/** Service charged so far, in cost per unit of weight. */
	served: number;
}

export interface FleetQueueOptions {
	now(): number;
	/**
	 * Called once as node `id` joins the queue: a node the restart metadata holds is claimed by it, and its first enqueue
	 * time is given back, so aging resumes from it.
	 */
	claimRestored?(id: string): number | undefined;
	/** Membership or order changed: an entry joined, left or was dispatched. */
	onChange?(): void;
	/** An entry left the queue by any path. */
	onRemove?(id: string): void;
}

export function fleetFlowKey(objectiveId: string, subtreeId: string): string {
	return `${objectiveId}\u0000${subtreeId}`;
}

function priorityWeight(priority: number): number {
	return 2 ** priority;
}

function serviceCost(weightClass: WeightClass, flowWeight: number): number {
	return WEIGHT_CLASS_COST[weightClass] / flowWeight;
}

export class FleetQueue<P> {
	private readonly options: FleetQueueOptions;
	private readonly entries = new Map<string, FleetQueueEntry<P>>();
	private readonly flows = new Map<string, Flow<P>>();
	private readonly shares = new Map<string, ShareSpec>();
	private seq = 0;

	constructor(options: FleetQueueOptions) {
		this.options = options;
	}

	get size(): number {
		return this.entries.size;
	}

	has(id: string): boolean {
		return this.entries.has(id);
	}

	get(id: string): P | undefined {
		return this.entries.get(id)?.payload;
	}

	entry(id: string): FleetQueueEntry<P> | undefined {
		return this.entries.get(id);
	}

	/** Adds an entry at the back of its flow; false when the id is already queued. */
	push(input: FleetQueueEntryInput<P>): boolean {
		if (this.entries.has(input.id)) return false;
		const restoredAt = this.options.claimRestored?.(input.id);
		const flowKey = fleetFlowKey(input.objectiveId, input.subtreeId);
		let flow = this.flows.get(flowKey);
		if (!flow) {
			flow = { key: flowKey, subtreeId: input.subtreeId, entries: new Map(), served: this.leastServed() };
			this.flows.set(flowKey, flow);
		}
		const entry: FleetQueueEntry<P> = {
			id: input.id,
			payload: input.payload,
			flowKey,
			objectiveId: input.objectiveId,
			subtreeId: input.subtreeId,
			priority: input.priority,
			weight: input.weight,
			criticalPath: input.criticalPath === true,
			enqueuedAt: input.enqueuedAt ?? restoredAt ?? this.options.now(),
			seq: this.seq++,
		};
		flow.entries.set(entry.id, entry);
		this.entries.set(entry.id, entry);
		this.options.onChange?.();
		return true;
	}

	/** Removes an entry without charging its flow (cancelled, deferred, or handed back). */
	delete(id: string): boolean {
		return this.remove(id, false);
	}

	/** Removes an entry that is starting now and charges its flow for the service. */
	dispatch(id: string): boolean {
		return this.remove(id, true);
	}

	/** Queued ids in service order. */
	ids(): string[] {
		return this.ordered().map((entry) => entry.id);
	}

	/** Every queued entry in service order: the order a selection pass offers them to admission. */
	ordered(): FleetQueueEntry<P>[] {
		const now = this.options.now();
		const heads = new MinHeap<FlowCursor<P>>(
			(a, b) => a.finish - b.finish || a.pending[a.index]!.seq - b.pending[b.index]!.seq,
		);
		const offer = (flow: FlowCursor<P>, served: number): void => {
			const head = flow.pending[flow.index];
			if (!head) return;
			// The head has the maximum effective priority among the remaining entries.
			const weight = flow.shareWeight ?? priorityWeight(this.effectivePriority(head, now));
			flow.finish = served + serviceCost(head.weight, weight);
			if (flow.finish < Number.POSITIVE_INFINITY) heads.push(flow);
		};
		for (const flow of this.flows.values()) {
			const pending = [...flow.entries.values()].sort((a, b) => this.compareWithinFlow(a, b, now));
			offer({ pending, shareWeight: this.shareWeight(flow.subtreeId), index: 0, finish: 0 }, flow.served);
		}
		const order: FleetQueueEntry<P>[] = [];
		for (let flow = heads.pop(); flow; flow = heads.pop()) {
			order.push(flow.pending[flow.index++]!);
			offer(flow, flow.finish);
		}
		return order;
	}

	/** Queued ids that match; for a scope cancel. */
	matching(predicate: (entry: FleetQueueEntry<P>) => boolean): string[] {
		return [...this.entries.values()].filter(predicate).map((entry) => entry.id);
	}

	openShare(spec: ShareSpec): void {
		this.shares.set(spec.subtreeId, { ...spec });
		this.options.onChange?.();
	}

	/** Closes a share and returns its queued members, which the caller cancels. */
	closeShare(subtreeId: string): string[] {
		this.shares.delete(subtreeId);
		return this.matching((entry) => entry.subtreeId === subtreeId);
	}

	share(subtreeId: string): ShareSpec | undefined {
		return this.shares.get(subtreeId);
	}

	effectivePriority(entry: FleetQueueEntry<P>, now = this.options.now()): FleetPriority {
		const aged = entry.priority + Math.floor(Math.max(0, now - entry.enqueuedAt) / FLEET_AGING_STEP_MS);
		return Math.min(3, aged + (entry.criticalPath ? 1 : 0)) as FleetPriority;
	}

	private compareWithinFlow(a: FleetQueueEntry<P>, b: FleetQueueEntry<P>, now: number): number {
		return (
			this.effectivePriority(b, now) - this.effectivePriority(a, now) || b.priority - a.priority || a.seq - b.seq
		);
	}

	private shareWeight(subtreeId: string): number | undefined {
		const share = this.shares.get(subtreeId);
		return share && share.weight > 0 ? share.weight : undefined;
	}

	private flowWeight(flow: Flow<P>, now: number): number {
		const share = this.shareWeight(flow.subtreeId);
		if (share !== undefined) return share;
		let highest = 0;
		for (const entry of flow.entries.values()) highest = Math.max(highest, this.effectivePriority(entry, now));
		return priorityWeight(highest);
	}

	private leastServed(): number {
		let least: number | undefined;
		for (const flow of this.flows.values()) least = least === undefined ? flow.served : Math.min(least, flow.served);
		return least ?? 0;
	}

	private remove(id: string, charge: boolean): boolean {
		const entry = this.entries.get(id);
		if (!entry) return false;
		this.entries.delete(id);
		const flow = this.flows.get(entry.flowKey);
		if (flow) {
			if (charge) {
				const now = this.options.now();
				flow.served += serviceCost(entry.weight, this.flowWeight(flow, now));
			}
			flow.entries.delete(id);
			if (flow.entries.size === 0) this.flows.delete(flow.key);
		}
		this.options.onRemove?.(id);
		this.options.onChange?.();
		return true;
	}
}
