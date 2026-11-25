/** Runs bounded, reusable semantic ranking for one skill discovery conversation. */
import { transientRecordDigest } from "../kernel/transient-record-decision.ts";
import type { AccountingOrigin } from "./cost/accounting-evidence.ts";
import type { SemanticDecisionEngine, SemanticEvaluationScope } from "./decision/engine.ts";
import { readNoul } from "./decision/noul.ts";
import { createDecisionProgram } from "./decision/program.ts";
import { choiceAct } from "./decision/thresholds.ts";
import { awaitPreflight } from "./preflight.ts";
import type { SkillHeader } from "./skill-header-discovery.ts";
import { withinPlanRequestBound } from "./system-one/plan-request-bound.ts";

export const SKILL_RANKING_TIMEOUT_MS = 3_000;
const OUTAGE_COOLDOWN_MS = 10_000;
const RESULT_TTL_MS = 120_000;
const MAX_RESULTS = 16;
const MAX_IN_FLIGHT = 2;

export interface SkillRankingSource {
	readonly engine: SemanticDecisionEngine;
	readonly provider?: string;
}

interface RankRequest {
	readonly source: SkillRankingSource;
	readonly query: string;
	readonly catalogDigest: string;
	readonly candidates: readonly SkillHeader[];
	readonly origin?: AccountingOrigin;
	readonly evaluationScope?: SemanticEvaluationScope;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

type DecisiveRanking = { readonly kind: "match"; readonly name: string } | { readonly kind: "no_match" };
type Ranking = DecisiveRanking | { readonly kind: "uncertain" | "unavailable" };
type RankingResult = Ranking & { readonly reused?: true };

interface Flight {
	readonly controller: AbortController;
	readonly promise: Promise<Ranking>;
	waiters: number;
}

interface RankState {
	readonly source: SkillRankingSource;
	readonly decisions: Map<string, { readonly result: DecisiveRanking; readonly expiresAt: number }>;
	readonly active: Map<string, Flight>;
	unavailableUntil: number;
}

export function sameSkillRankingSource(left: SkillRankingSource, right: SkillRankingSource | undefined): boolean {
	return right !== undefined && left.engine === right.engine && left.provider === right.provider;
}

async function evaluateSkillSearch(input: RankRequest, caller: AbortSignal): Promise<Ranking> {
	const candidates = Object.fromEntries(input.candidates.map((header, index) => [`s${index}`, header]));
	const decisions = createDecisionProgram({
		id: "skill-vault:search",
		decisions: [
			{
				kind: "boolean",
				id: "has_match",
				instruction:
					"Does at least one skill in `candidates` provide specialist guidance directly applicable to the concrete task in `query`?",
			},
			...(input.candidates.length > 1
				? [
						{
							kind: "choice",
							id: "best_match",
							instruction:
								"Which skill in `candidates` provides the most directly applicable guidance for `query`?",
							options: Object.fromEntries(
								Object.keys(candidates).map((id) => [id, { description: `Skill ${id} in candidates` }]),
							),
						} as const,
					]
				: []),
		],
	});
	const evaluation = await withinPlanRequestBound(
		(signal) =>
			input.source.engine.evaluate(
				decisions,
				{ query: input.query, candidates },
				{ signal, consequence: "low", origin: input.origin, evaluationScope: input.evaluationScope },
			),
		{ caller, timeoutMs: input.timeoutMs ?? SKILL_RANKING_TIMEOUT_MS },
	);
	if (!evaluation) return { kind: "unavailable" };
	const match = evaluation.results.has_match;
	if (match?.kind !== "boolean") return { kind: "unavailable" };
	const band = readNoul(match, "required_true", "advisory");
	if (band === "hard_fail") return { kind: "no_match" };
	if (band !== "hard_pass") return { kind: "uncertain" };
	const best = evaluation.results.best_match;
	const chosen =
		input.candidates.length === 1
			? input.candidates[0]
			: best?.kind === "choice" && Object.hasOwn(candidates, best.selected)
				? candidates[best.selected]
				: undefined;
	if (!chosen) return { kind: "unavailable" };
	if (input.candidates.length > 1 && choiceAct(best, undefined, "reversible") !== "act") return { kind: "uncertain" };
	return { kind: "match", name: chosen.name };
}

export class SkillSemanticRanking {
	private state?: RankState;
	private readonly now: () => number;

	constructor(now: () => number) {
		this.now = now;
	}

	clear(): void {
		const state = this.state;
		this.state = undefined;
		if (state) for (const flight of state.active.values()) flight.controller.abort();
	}

	async rank(input: RankRequest): Promise<RankingResult> {
		input.signal?.throwIfAborted();
		let state = this.state;
		if (!state || !sameSkillRankingSource(state.source, input.source)) {
			this.clear();
			state = { source: input.source, decisions: new Map(), active: new Map(), unavailableUntil: 0 };
			this.state = state;
		}
		const cacheKey = transientRecordDigest(
			JSON.stringify([
				input.query,
				input.catalogDigest,
				input.candidates.map((header) => header.name),
				input.evaluationScope,
			]),
		);
		const cached = state.decisions.get(cacheKey);
		if (cached && cached.expiresAt > this.now()) return { ...cached.result, reused: true };
		state.decisions.delete(cacheKey);
		const flightKey = transientRecordDigest(JSON.stringify([cacheKey, input.origin, input.timeoutMs]));
		let flight = state.active.get(flightKey);
		if (!flight) {
			if (state.unavailableUntil > this.now() || state.active.size >= MAX_IN_FLIGHT) return { kind: "unavailable" };
			flight = this.start(state, cacheKey, flightKey, input);
			state.active.set(flightKey, flight);
		}
		flight.waiters++;
		try {
			return await awaitPreflight(() => flight.promise, input.signal);
		} finally {
			flight.waiters--;
			if (flight.waiters === 0 && state.active.get(flightKey) === flight) {
				state.active.delete(flightKey);
				flight.controller.abort();
			}
		}
	}

	private start(state: RankState, cacheKey: string, flightKey: string, input: RankRequest): Flight {
		const controller = new AbortController();
		const flight: Flight = {
			controller,
			waiters: 0,
			promise: evaluateSkillSearch(input, controller.signal)
				.catch((): Ranking => ({ kind: "unavailable" }))
				.then((result) => {
					if (controller.signal.aborted || this.state !== state) return result;
					if (result.kind === "unavailable" && input.timeoutMs === undefined) {
						state.unavailableUntil = this.now() + OUTAGE_COOLDOWN_MS;
					}
					if (result.kind === "match" || result.kind === "no_match") {
						state.decisions.delete(cacheKey);
						state.decisions.set(cacheKey, { result, expiresAt: this.now() + RESULT_TTL_MS });
						if (state.decisions.size > MAX_RESULTS) {
							const oldest = state.decisions.keys().next();
							if (!oldest.done) state.decisions.delete(oldest.value);
						}
					}
					return result;
				})
				.finally(() => {
					if (state.active.get(flightKey) === flight) state.active.delete(flightKey);
				}),
		};
		return flight;
	}
}
