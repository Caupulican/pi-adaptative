/**
 * Cache custody: the provider-visible surface of each lane (system prompt, tools, reasoning, and the
 * messages already sent) changes only through a gate, and every request is classified against it.
 *
 * - The guard classifies each request: a pure append; a `sanctioned` break (the gate issued a token for
 *   this lane's next request: a priced GC pack, a compaction, an owner action); or an `unsanctioned`
 *   break at a kind and index. Unsanctioned breaks are recorded, never repaired silently: each one is
 *   a harness defect that cost a cache write nobody priced.
 * - The gate is the only way to change the surface. Mandatory kinds (owner actions, authority or safety
 *   removals) pass at once; a priced kind passes when its price admits it; anything else waits in the
 *   queue for a cold moment (the lane's cache is gone anyway, or a compaction rewrote it), when all
 *   waiting breaks apply together.
 * - Reasoning is surface too: a lane's reasoning level is pinned to what it last sent. The owner's own
 *   change passes, and so does the owner's cost ceiling; a host adjustment passes only when it is free,
 *   otherwise the pinned level is kept.
 */

export type CacheBreakClassification =
	| { readonly classification: "append" }
	| { readonly classification: "first" }
	| { readonly classification: "sanctioned"; readonly kind: string; readonly reason: string }
	| { readonly classification: "unsanctioned"; readonly kind: string; readonly index?: number };

/** What the guard reads of one request (the request snapshot's own fields). */
export interface CustodyRequestFacts {
	readonly lane: string;
	readonly prefixIntact?: boolean | "unknown";
	readonly firstDivergentKind?: string;
	readonly firstDivergentIndex?: number;
	readonly reasoning?: string;
}

export interface DeferredBreak {
	readonly kind: string;
	readonly reason: string;
	/** Makes the change when the break is allowed; called once. */
	readonly apply: () => void;
}

/** Any lane: a token not bound to one lane (a compaction rewrites every lane's history). */
const ANY_LANE = "*";

export class CacheCustody {
	private readonly tokens = new Map<string, { kind: string; reason: string }[]>();
	private readonly queue: DeferredBreak[] = [];
	private readonly reasoning = new Map<string, { sent: string | undefined; base: string | undefined }>();
	/** The reasoning each lane's last request sent: a change breaks the cache as surely as a rewrite. */
	private readonly lastSentReasoning = new Map<string, string | undefined>();

	/** Issue a token: the next request on `lane` (or any lane) may break the prefix for `kind`. */
	sanction(kind: string, reason: string, lane: string = ANY_LANE): void {
		const list = this.tokens.get(lane) ?? [];
		list.push({ kind, reason });
		this.tokens.set(lane, list);
	}

	/**
	 * The gate for a change that would break the surface. Mandatory changes and admitted prices apply
	 * now and are sanctioned; the rest wait for `flushColdMoment`, the latest of each kind.
	 */
	request(
		input: DeferredBreak & { readonly mandatory?: boolean; readonly admitted?: boolean; readonly lane?: string },
	): "applied" | "deferred" {
		if (input.mandatory || input.admitted) {
			this.sanction(input.kind, input.reason, input.lane);
			input.apply();
			return "applied";
		}
		// One waiting change per kind: a newer request of the same kind supersedes the one waiting.
		const waiting = this.queue.findIndex((pending) => pending.kind === input.kind);
		if (waiting >= 0) this.queue.splice(waiting, 1);
		this.queue.push({ kind: input.kind, reason: input.reason, apply: input.apply });
		return "deferred";
	}

	/** A cold moment: every waiting break applies together, sanctioned for the next request. */
	flushColdMoment(reason: string): string[] {
		const flushed = this.queue.splice(0);
		for (const pending of flushed) {
			this.sanction(pending.kind, `${pending.reason} (at a cold moment: ${reason})`);
			pending.apply();
		}
		return flushed.map((pending) => pending.kind);
	}

	/** The surface already is what a waiting change of `kind` wanted to reach, or it is no longer wanted. */
	withdraw(kind: string): void {
		const waiting = this.queue.findIndex((pending) => pending.kind === kind);
		if (waiting >= 0) this.queue.splice(waiting, 1);
	}

	get deferredCount(): number {
		return this.queue.length;
	}

	/**
	 * The reasoning a request on `lane` sends. `base` is the session's own level (the owner's choice),
	 * `adjusted` what the host's per-request policies made of it. A lane keeps sending the level it last
	 * sent unless the owner changed the base, the request returns to the base, or `isFree()` says the change
	 * costs no cache.
	 */
	admitReasoning(
		lane: string,
		base: string | undefined,
		adjusted: string | undefined,
		isFree: () => boolean,
	): string | undefined {
		const state = this.reasoning.get(lane);
		const send = (value: string | undefined, sanctionReason?: string) => {
			if (sanctionReason !== undefined && state && value !== state.sent)
				this.sanction("reasoning", sanctionReason, lane);
			this.reasoning.set(lane, { sent: value, base });
			return value;
		};
		if (!state || adjusted === state.sent) return send(adjusted);
		if (base !== state.base) return send(adjusted, "the owner changed the reasoning level");
		// The owner's own level is authoritative: a lane an earlier host adjustment left elsewhere returns to it.
		if (adjusted === base) return send(adjusted, "the lane returned to the owner's reasoning level");
		if (isFree()) return send(adjusted, "the lane's cache is already gone");
		return send(state.sent);
	}

	/**
	 * A mandatory reasoning change after the gate (the owner's cost ceiling downgrading the level): it
	 * passes, sanctioned, and becomes what the lane last sent.
	 */
	overrideReasoning(lane: string, value: string | undefined, reason: string): void {
		const state = this.reasoning.get(lane);
		if (!state || state.sent === value) return;
		this.sanction("reasoning", reason, lane);
		this.reasoning.set(lane, { sent: value, base: state.base });
	}

	/** The guard: classify one request against the lane's surface, consuming the lane's tokens. */
	classify(facts: CustodyRequestFacts): CacheBreakClassification {
		const firstOnLane = !this.lastSentReasoning.has(facts.lane);
		const reasoningChanged = !firstOnLane && this.lastSentReasoning.get(facts.lane) !== facts.reasoning;
		this.lastSentReasoning.set(facts.lane, facts.reasoning);
		const laneTokens = this.tokens.get(facts.lane) ?? [];
		const anyTokens = this.tokens.get(ANY_LANE) ?? [];
		this.tokens.delete(facts.lane);
		this.tokens.delete(ANY_LANE);
		const token = laneTokens[0] ?? anyTokens[0];
		const unknownPrefix = facts.prefixIntact === "unknown" || facts.prefixIntact === undefined;
		// Nothing to compare against: the lane's first request in this process.
		if (firstOnLane && unknownPrefix) return { classification: "first" };
		const rewritten = facts.prefixIntact === false;
		if (!rewritten && !reasoningChanged) return { classification: "append" };
		if (token) return { classification: "sanctioned", kind: token.kind, reason: token.reason };
		return rewritten
			? {
					classification: "unsanctioned",
					kind: facts.firstDivergentKind ?? "unknown",
					...(facts.firstDivergentIndex !== undefined ? { index: facts.firstDivergentIndex } : {}),
				}
			: { classification: "unsanctioned", kind: "reasoning", index: -1 };
	}
}
