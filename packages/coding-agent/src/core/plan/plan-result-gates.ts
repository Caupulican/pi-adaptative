/**
 * The R3 gates a plan's executor reads (S5): the settled steps whose results a dependent waits on, the reviews those waits
 * start, and the readings that release or hold each step. A review gates a release only until it is decided, and a
 * decided hold (`R3a`) keeps the dependent from releasing until the executor records it. The gates live in memory: a restart
 * re-asks every review a step still waits on. A review is current only for the outcome and the spec version it was asked
 * about; `refresh` drops the gates no current fact calls for, so a superseded answer is never read.
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { OperationEffectEngine } from "../system-one/operation-classifier.ts";
import {
	type ConflictReading,
	type DependentReview,
	reviewDependents,
	reviewFindingPairs,
	unaskedDependentReview,
	unaskedPairReview,
} from "../system-one/plan-result-review.ts";
import {
	type FindingPair,
	findingPairs,
	type PacketReport,
	planNodePacket,
	type ResultPacket,
} from "./plan-evidence.ts";
import {
	isPlanFromNewerBuild,
	type PlanNodeSpec,
	type PlanRecord,
	type PlanRuntimeState,
	planNodeEdges,
} from "./plan-graph.ts";
import { planNodeOutcome, planNodeReleasable } from "./plan-view.ts";

/** The most dependents of one settled step that are reviewed; the rest release without review (`review_cap`). */
export const PLAN_RESULT_REVIEW_CAP = 8;

export interface PlanResultGatesDeps {
	readonly engine: () => OperationEffectEngine | undefined;
	/** The executor's abort: a review in flight ends with it. */
	readonly signal: AbortSignal;
	/** Holds a dependent for re-planning. The caller checks the step is still the one reviewed before it writes. */
	readonly hold: (planId: string, nodeId: string, since: number, detail: string) => void;
	/** Asks for a drain: a settled review may release the step it gated. */
	readonly drain: () => void;
}

/** One dependent's review of one settled predecessor, asked about one outcome and one spec version. */
interface DependentGate {
	readonly key: string;
	readonly dependentId: string;
	readonly predecessorId: string;
	readonly since: number;
	readonly basis: string;
	reading?: DependentReview;
}

/** A reduce step's finding pairs, asked about one set of member outcomes; `readings` is set once they are decided. */
interface FindingGate {
	readonly basis: string;
	readonly pairs: readonly FindingPair[];
	readings?: ReadonlyMap<string, ConflictReading>;
}

/** The findings a reduce step settles against: its pairs and the reading of each. */
export interface FindingsOfStep {
	readonly pairs: readonly FindingPair[];
	readonly readings: ReadonlyMap<string, ConflictReading>;
}

/** A settled result that can change a dependent's work: it succeeded or partly did, and it names something open. */
function triggersReview(packet: ResultPacket): boolean {
	return (
		(packet.status === "succeeded" || packet.status === "partial") &&
		(packet.uncovered.length > 0 || packet.remaining.length > 0 || packet.findings.length > 0)
	);
}

function plansMap<T>(all: Map<string, Map<string, T>>, planId: string): Map<string, T> {
	let found = all.get(planId);
	if (!found) {
		found = new Map();
		all.set(planId, found);
	}
	return found;
}

/** Drops every gate whose key the current facts do not name. */
function pruneTo<T>(gates: Map<string, T>, live: ReadonlySet<string>): void {
	for (const key of [...gates.keys()]) if (!live.has(key)) gates.delete(key);
}

function failureText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class PlanResultGates {
	private readonly dependentGates = new Map<string, Map<string, DependentGate>>();
	private readonly findingGates = new Map<string, Map<string, FindingGate>>();
	/** Each settled predecessor's packet by outcome (`null`: its result triggers no review), so its digest is read once. */
	private readonly packetMemo = new Map<string, ResultPacket | null>();
	/** Each reduce step's finding pairs by basis, so its members' digests are read once. */
	private readonly pairMemo = new Map<string, readonly FindingPair[]>();

	private readonly deps: PlanResultGatesDeps;

	constructor(deps: PlanResultGatesDeps) {
		this.deps = deps;
	}

	/**
	 * Starts the reviews the open plans' current facts call for and drops the gates they no longer name. Runs at the start
	 * of each drain pass, so a settled result is reviewed once it settles and a restart re-asks what still gates a step.
	 */
	refresh(snapshot: TaskRuntimeProjection, reportOf: PacketReport): void {
		const engine = this.deps.engine();
		if (!engine) return;
		for (const [planId, plan] of Object.entries(snapshot.plans)) {
			if (plan.closed || isPlanFromNewerBuild(plan.record)) continue;
			const record = plan.record;
			const live = new Set<string>();
			const liveFindings = new Set<string>();
			for (const predecessor of record.nodes)
				this.refreshDependents(engine, { snapshot, plan, record, reportOf, planId, live }, predecessor.id);
			for (const node of record.nodes)
				if (node.kind === "reduce")
					this.refreshFindings(engine, { snapshot, plan, record, reportOf, planId, live: liveFindings }, node);
			pruneTo(plansMap(this.dependentGates, planId), live);
			pruneTo(plansMap(this.findingGates, planId), liveFindings);
		}
	}

	/** Whether a step must not release yet: a review is pending, or a hold is decided and not yet recorded. */
	waiting(planId: string, nodeId: string): boolean {
		for (const gate of this.dependentGates.get(planId)?.values() ?? [])
			if (gate.dependentId === nodeId && (gate.reading === undefined || gate.reading.exit === "R3a_replan"))
				return true;
		const finding = this.findingGates.get(planId)?.get(nodeId);
		return finding !== undefined && finding.readings === undefined;
	}

	/** The reduce step's finding pairs System One left open: named to the step as possibly conflicting. */
	openFindings(planId: string, nodeId: string): readonly FindingPair[] {
		const gate = this.findingGates.get(planId)?.get(nodeId);
		if (gate?.readings === undefined) return [];
		const readings = gate.readings;
		return gate.pairs.filter((pair) => readings.get(pair.key) === "open");
	}

	/** The reduce step's finding pairs and readings once decided; undefined when it has none. */
	findingsOf(planId: string, nodeId: string): FindingsOfStep | undefined {
		const gate = this.findingGates.get(planId)?.get(nodeId);
		return gate?.readings === undefined ? undefined : { pairs: gate.pairs, readings: gate.readings };
	}

	/** Drops a closed plan's gates and memos. */
	forgetPlan(planId: string): void {
		this.dependentGates.delete(planId);
		this.findingGates.delete(planId);
		for (const memo of [this.packetMemo, this.pairMemo])
			for (const key of [...memo.keys()]) if (key.startsWith(`${planId}|`)) memo.delete(key);
	}

	private refreshDependents(engine: OperationEffectEngine, scope: PlanScope, predecessorId: string): void {
		const { snapshot, plan, record, planId, live } = scope;
		const runtime = plan.nodes[predecessorId];
		if (!runtime?.settled || runtime.held) return;
		const dependents = record.nodes.filter(
			(node) =>
				node.kind === "work" &&
				planNodeEdges(node).includes(predecessorId) &&
				!plan.nodes[node.id]?.release &&
				!plan.nodes[node.id]?.held,
		);
		if (dependents.length === 0) return;
		const outcome = planNodeOutcome(snapshot, plan, predecessorId);
		if (!outcome) return;
		const packet = this.packetOf(scope, predecessorId, outcome.outcomeId);
		if (!packet) return;
		const reviewed = dependents.slice(0, PLAN_RESULT_REVIEW_CAP);
		const gates = plansMap(this.dependentGates, planId);
		const group: { readonly node: PlanNodeSpec; readonly key: string; readonly basis: string }[] = [];
		for (const node of reviewed) {
			const key = `${node.id}|${predecessorId}`;
			const basis = `${outcome.outcomeId}@${node.since}`;
			live.add(key);
			if (gates.get(key)?.basis !== basis) group.push({ node, key, basis });
		}
		if (group.length === 0) return;
		const capped = dependents.length - reviewed.length;
		const facts =
			capped > 0 ? [`review_cap: ${capped} more dependents of step ${predecessorId} released without review`] : [];
		const issued = group.map(({ node, key, basis }) => {
			const gate: DependentGate = { key, dependentId: node.id, predecessorId, since: node.since, basis };
			gates.set(key, gate);
			return gate;
		});
		const settle = (reviews: ReadonlyMap<string, DependentReview>) => this.settleDependents(planId, issued, reviews);
		reviewDependents(
			engine,
			packet,
			group.map((entry) => entry.node),
			{ signal: this.deps.signal, facts },
		)
			.then(settle, (error: unknown) => {
				if (this.deps.signal.aborted) return;
				harnessLog.warn("plan", "a step's result review failed; its dependents release unjudged", {
					planId,
					predecessorId,
					error: failureText(error),
				});
				settle(new Map(issued.map((gate) => [gate.dependentId, unaskedDependentReview(failureText(error))])));
			})
			.catch((error: unknown) =>
				harnessLog.warn("plan", "a step's result review could not settle", { planId, error: failureText(error) }),
			);
	}

	private settleDependents(
		planId: string,
		issued: readonly DependentGate[],
		reviews: ReadonlyMap<string, DependentReview>,
	): void {
		const gates = this.dependentGates.get(planId);
		for (const gate of issued) {
			// A review superseded by a newer outcome or spec version is no longer the gate: its answer is dropped.
			if (gates?.get(gate.key) !== gate) continue;
			const review = reviews.get(gate.dependentId) ?? unaskedDependentReview("System One gave no answer");
			gate.reading = review;
			if (review.exit === "R3a_replan" && review.detail !== undefined)
				this.deps.hold(planId, gate.dependentId, gate.since, review.detail);
		}
		this.deps.drain();
	}

	private refreshFindings(engine: OperationEffectEngine, scope: PlanScope, node: PlanNodeSpec): void {
		const { snapshot, plan, record, planId, live } = scope;
		const runtime = plan.nodes[node.id];
		if (runtime?.settled || runtime?.held) return;
		const gates = plansMap(this.findingGates, planId);
		// A released step keeps its readings until it settles: the join's conflicts are read from them.
		if (runtime?.release) {
			if (gates.has(node.id)) live.add(node.id);
			return;
		}
		if (!planNodeReleasable(snapshot, plan, record, node)) return;
		const memberIds: string[] = [];
		for (const member of node.join?.members ?? []) {
			const outcome = plan.nodes[member]?.held ? undefined : planNodeOutcome(snapshot, plan, member);
			if (!outcome) return;
			memberIds.push(outcome.outcomeId);
		}
		const basis = `${memberIds.join(",")}@${node.since}`;
		live.add(node.id);
		if (gates.get(node.id)?.basis === basis) return;
		const pairs = this.pairsOf(scope, node, basis);
		if (pairs.length === 0) {
			gates.delete(node.id);
			return;
		}
		const gate: FindingGate = { basis, pairs };
		gates.set(node.id, gate);
		const settle = (reviews: ReadonlyMap<string, { readonly reading: ConflictReading }>) => {
			if (this.findingGates.get(planId)?.get(node.id) !== gate) return;
			gate.readings = new Map(pairs.map((pair) => [pair.key, reviews.get(pair.key)?.reading ?? "open"] as const));
			this.deps.drain();
		};
		reviewFindingPairs(engine, pairs, { signal: this.deps.signal })
			.then(settle, (error: unknown) => {
				if (this.deps.signal.aborted) return;
				harnessLog.warn("plan", "a reduce step's finding review failed; its findings stay open", {
					planId,
					nodeId: node.id,
					error: failureText(error),
				});
				settle(new Map(pairs.map((pair) => [pair.key, unaskedPairReview()] as const)));
			})
			.catch((error: unknown) =>
				harnessLog.warn("plan", "a reduce step's finding review could not settle", {
					planId,
					error: failureText(error),
				}),
			);
	}

	/** The finding pairs of a reduce step's settled members, memoized per basis. */
	private pairsOf(scope: PlanScope, node: PlanNodeSpec, basis: string): readonly FindingPair[] {
		const key = `${scope.planId}|${node.id}|${basis}`;
		const memo = this.pairMemo.get(key);
		if (memo) return memo;
		const packets: ResultPacket[] = [];
		for (const member of node.join?.members ?? []) {
			const packet = planNodePacket(scope.snapshot, scope.plan, member, scope.reportOf);
			if (packet) packets.push(packet);
		}
		const pairs = findingPairs(packets);
		this.pairMemo.set(key, pairs);
		return pairs;
	}

	/** A settled predecessor's packet when its result triggers a review; memoized per outcome. */
	private packetOf(scope: PlanScope, nodeId: string, outcomeId: string): ResultPacket | undefined {
		const key = `${scope.planId}|${nodeId}|${outcomeId}`;
		if (!this.packetMemo.has(key)) {
			const packet = planNodePacket(scope.snapshot, scope.plan, nodeId, scope.reportOf);
			this.packetMemo.set(key, packet && triggersReview(packet) ? packet : null);
		}
		return this.packetMemo.get(key) ?? undefined;
	}
}

/** What one plan's refresh reads: its projection, its record and the keys of the gates its facts keep live. */
interface PlanScope {
	readonly snapshot: TaskRuntimeProjection;
	readonly plan: PlanRuntimeState;
	readonly record: PlanRecord;
	readonly reportOf: PacketReport;
	readonly planId: string;
	readonly live: Set<string>;
}
