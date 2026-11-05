/**
 * A session's prompt-cache guard over its lanes: custody of the cached prefix, the learned cache knowledge, one
 * observation per provider response, and worker conversations' request guard and early-compaction economics. It
 * reads only the session's id and directory and the decision ledger, so a parent opened away guards its worker
 * conversations the same way the foreground does.
 */

import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import type { SessionRequestSnapshotInput } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import {
	type CompactionEconomicsVerdict,
	compactionPricingFor,
	compactionVerdictDecision,
	priceCompaction,
} from "../compaction/early-compaction-economics.ts";
import type { WorkerResponseObservation } from "../delegation/worker-attempt-executor.ts";
import type { CacheDecisionRow, DecisionLedgerStore } from "../operator-projection/decision-ledger-store.ts";
import { CacheCustody } from "./cache-custody.ts";
import { CacheKnowledge } from "./cache-knowledge.ts";
import { CacheObservationRecorder, cacheLaneKey, historyLineage, idleHolder } from "./cache-observation-recorder.ts";

/** The messages a reply's request carried since the previous reply (see `idleHolder`). */
export function sincePreviousReply(messages: readonly AgentMessage[], reply: AgentMessage): readonly AgentMessage[] {
	const end = messages.lastIndexOf(reply);
	const before = end >= 0 ? messages.slice(0, end) : messages;
	let start = before.length;
	while (start > 0 && before[start - 1]?.role !== "assistant") start--;
	return before.slice(start);
}

export interface CacheLaneGuardDeps {
	getSessionId(): string;
	getCwd(): string;
	getDecisionLedger(): DecisionLedgerStore | undefined;
}

/** The request a provider response answered, on the conversation it belongs to. */
export interface CacheResponseRequest {
	readonly sessionId: string;
	readonly snapshot: SessionRequestSnapshotInput | undefined;
	readonly openedAt: number | undefined;
	readonly history: readonly AgentMessage[];
	readonly lineage: string;
}

export class CacheLaneGuard {
	private readonly deps: CacheLaneGuardDeps;
	readonly custody = new CacheCustody();
	readonly knowledge: CacheKnowledge;
	private readonly observations: CacheObservationRecorder;
	private readonly workerEarlyVerdicts = new Map<string, string>();

	constructor(deps: CacheLaneGuardDeps) {
		this.deps = deps;
		this.knowledge = new CacheKnowledge(() => this.deps.getDecisionLedger());
		this.observations = new CacheObservationRecorder((sessionId, lane) => {
			const last = this.deps.getDecisionLedger()?.latestCacheObservation(sessionId, lane);
			return last ? { respondedAt: last.observedAt, promptTokens: last.promptTokens } : undefined;
		});
	}

	/**
	 * One cache observation per provider response (see CacheObservationRecorder), joined to the request
	 * snapshot that opened it, so the cache-survival estimator can learn each lane's cache lifetime.
	 * Best effort: a ledger that cannot be written never affects the turn.
	 */
	observeResponse(message: AssistantMessage, request: CacheResponseRequest): void {
		try {
			const { snapshot, history, sessionId } = request;
			const lane = cacheLaneKey(message.api, message.provider, message.model);
			const snapshotLane = snapshot ? cacheLaneKey(snapshot.api, snapshot.provider, snapshot.modelId) : undefined;
			const matched = snapshotLane === lane ? snapshot : undefined;
			const requestOpenedAt = matched ? request.openedAt : undefined;
			const row = this.observations.observe({
				sessionId,
				lane,
				respondedAt: Date.now(),
				usage: message.usage,
				...(requestOpenedAt !== undefined ? { requestOpenedAt } : {}),
				...(matched?.prefixIntact !== undefined ? { prefixIntact: matched.prefixIntact } : {}),
				...(matched?.firstDivergentKind ? { divergenceKind: matched.firstDivergentKind } : {}),
				lineage: request.lineage,
				holder: idleHolder(sincePreviousReply(history, message)),
			});
			if (row) {
				const recorded = { ...row, sessionId, cwd: this.deps.getCwd() };
				this.deps.getDecisionLedger()?.recordCacheObservation(recorded);
				this.knowledge.noteObservation(recorded);
			}
		} catch {
			// Telemetry only.
		}
	}

	/**
	 * A worker conversation's response. Each worker conversation is its own history (the gap is measured on it), on
	 * the same provider lane.
	 */
	observeWorkerResponse(message: AssistantMessage, conversation: WorkerResponseObservation): void {
		try {
			this.observeResponse(message, {
				sessionId: `${this.deps.getSessionId()}/worker:${conversation.agentId}`,
				snapshot: conversation.snapshot,
				openedAt: conversation.requestOpenedAt,
				history: conversation.messages,
				lineage: historyLineage(conversation.messages),
			});
		} catch {
			// Telemetry only.
		}
	}

	/**
	 * The guard, once per request: classify it against the lane's surface. A break the gate sanctioned is
	 * recorded as priced; one it did not is recorded as unsanctioned, with its kind and index.
	 */
	guardSurface(snapshot: SessionRequestSnapshotInput | undefined, conversation?: string): void {
		if (!snapshot) return;
		const lane = cacheLaneKey(snapshot.api, snapshot.provider, snapshot.modelId);
		const verdict = this.custody.classify({
			// A worker conversation shares a model's lane but not its prefix: it is guarded as its own.
			...(conversation ? { conversation } : {}),
			lane,
			...(snapshot.prefixIntact !== undefined ? { prefixIntact: snapshot.prefixIntact } : {}),
			...(snapshot.firstDivergentKind !== undefined ? { firstDivergentKind: snapshot.firstDivergentKind } : {}),
			...(snapshot.firstDivergentIndex !== undefined ? { firstDivergentIndex: snapshot.firstDivergentIndex } : {}),
			...(snapshot.reasoning !== undefined ? { reasoning: snapshot.reasoning } : {}),
		});
		if (verdict.classification === "append" || verdict.classification === "first") return;
		this.recordDecision({
			kind: "cache_break",
			decidedAt: Date.now(),
			admit: verdict.classification === "sanctioned",
			reason:
				verdict.classification === "sanctioned"
					? `sanctioned:${verdict.kind} (${verdict.reason})`
					: `unsanctioned:${verdict.kind}@${verdict.index ?? "?"}`,
			detail: {
				requestId: snapshot.requestId,
				model: `${snapshot.provider}/${snapshot.modelId}`,
				...(conversation ? { conversation } : {}),
			},
		});
	}

	/**
	 * A worker conversation's early compaction, priced as root's session lane prices its own: the
	 * worker lane's learned compaction outcome, its cache retained after its own idle gap, and its own
	 * lineage's remaining requests. The summarizer extends the worker's warm lane.
	 */
	admitWorkerEarlyCompaction(
		agentId: string,
		model: Model<Api>,
		contextTokens: number,
		messages: readonly AgentMessage[],
	): boolean {
		const now = Date.now();
		const conversation = `${this.deps.getSessionId()}/worker:${agentId}`;
		const lane = cacheLaneKey(model.api, model.provider, model.id);
		const outcome = this.knowledge.compactionOutcome(lane, now);
		let verdict: CompactionEconomicsVerdict;
		let remainingRequests = 1;
		if (!outcome) {
			verdict = {
				proceed: false,
				reason: "insufficient_evidence",
				detail: "no compaction on record to learn a compaction's size and cost from",
			};
		} else {
			const last = this.knowledge.lastResponseAt(conversation, lane);
			const retained =
				last === undefined ? undefined : this.knowledge.retainedAfter(lane, Math.max(0, now - last), now);
			const lineage = this.knowledge.lineage(conversation, historyLineage(messages), now);
			remainingRequests = Math.max(1, lineage ? (lineage.remaining ?? lineage.elapsed) : 1);
			verdict = priceCompaction({
				...compactionPricingFor({
					model,
					summarizer: model,
					summarizerSharesLane: true,
					prefixTokens: contextTokens,
					outcome,
					remainingRequests,
				}),
				...(retained ? { retained } : {}),
			});
		}
		const key = `${conversation}:${verdict.proceed ? "proceed" : verdict.reason}`;
		if (verdict.proceed || this.workerEarlyVerdicts.get(conversation) !== key) {
			this.workerEarlyVerdicts.set(conversation, key);
			this.recordDecision(
				compactionVerdictDecision("early_compaction", verdict, now, {
					conversation,
					prefixTokens: contextTokens,
					remainingRequests,
				}),
			);
		}
		return verdict.proceed;
	}

	/** Worker lanes pass the same cache guard, each worker conversation as its own lane; the prefix it sent is recorded. */
	observeWorkerRequest(
		agentId: string,
		snapshot: SessionRequestSnapshotInput,
		prefixTokens: number | undefined,
	): void {
		const conversation = `${this.deps.getSessionId()}/worker:${agentId}`;
		this.guardSurface(snapshot, conversation);
		if (prefixTokens === undefined) return;
		try {
			this.deps.getDecisionLedger()?.recordWorkerPrefix({
				sessionId: conversation,
				lane: cacheLaneKey(snapshot.api, snapshot.provider, snapshot.modelId),
				observedAt: Date.now(),
				prefixTokens,
			});
		} catch {
			// Telemetry only.
		}
	}

	/**
	 * A compaction's measured effect on its lane: the session's own, or with `agentId` a worker conversation's. A worker
	 * compaction replaced that worker's history, so its next request's break is sanctioned, as root's is.
	 */
	recordCompactionOutcome(
		outcome: { readonly model: Model<Api>; tokensBefore: number; tokensAfter: number; outputTokens: number },
		agentId?: string,
	): void {
		const { model, tokensBefore, tokensAfter, outputTokens } = outcome;
		const sessionId =
			agentId === undefined ? this.deps.getSessionId() : `${this.deps.getSessionId()}/worker:${agentId}`;
		if (agentId !== undefined)
			this.custody.sanction("compaction", "a worker compaction replaced its history", { conversation: sessionId });
		try {
			this.deps.getDecisionLedger()?.recordCompactionOutcome({
				sessionId,
				lane: cacheLaneKey(model.api, model.provider, model.id),
				observedAt: Date.now(),
				tokensBefore,
				tokensAfter,
				outputTokens,
			});
		} catch {
			// Telemetry only.
		}
	}

	recordDecision(decision: Omit<CacheDecisionRow, "sessionId" | "cwd">): void {
		try {
			this.deps.getDecisionLedger()?.recordCacheDecision({
				...decision,
				sessionId: this.deps.getSessionId(),
				cwd: this.deps.getCwd(),
			});
		} catch {
			// Telemetry only.
		}
	}
}
