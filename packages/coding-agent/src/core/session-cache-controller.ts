/**
 * Prompt-cache custody, survival observation recording, cold-moment transitions, worker
 * early-compaction economics, and cache-priced objective executor selection for a session.
 */

import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { cleanupSessionResources } from "@caupulican/pi-ai/session-resources";
import { estimateTokens } from "../kernel/compaction/compaction.ts";
import type { SessionManager, SessionRequestSnapshotInput } from "../kernel/session/session-manager.ts";
import type { AgentMessage } from "../kernel/types.ts";
import type { WorkerDelegationRunOutcome } from "./agent-session-contracts.ts";
import {
	type CompactionEconomicsVerdict,
	compactionPricingFor,
	compactionVerdictDecision,
	priceCompaction,
	priceExecutor,
	resolveEffectiveModelPricing,
	switchCostUsd,
	usd,
} from "./compaction/early-compaction-economics.ts";
import type { LastSentRequest } from "./compaction-support.ts";
import { CacheCustody } from "./context/cache-custody.ts";
import { CacheKnowledge } from "./context/cache-knowledge.ts";
import {
	CacheObservationRecorder,
	cacheLaneKey,
	historyLineage,
	idleHolder,
} from "./context/cache-observation-recorder.ts";
import { negligibleAgeMs } from "./context/cache-survival.ts";
import { CACHE_SURVIVAL_CALIBRATION } from "./context/cache-survival-calibration.ts";
import type { WorkerResponseObservation } from "./delegation/worker-attempt-executor.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
import type { ContextUsage } from "./extensions/index.ts";
import { buildObjectiveRoutePrompt } from "./goals/goal-continuation-prompt.ts";
import {
	formatGatheredEvidence,
	GATHERED_EVIDENCE_CUSTOM_TYPE,
	gatheringQuestions,
	gatherWithMinions,
	minionInstructions,
} from "./minion-gathering.ts";
import { sideTripBrief } from "./model-router/side-trip-brief.ts";
import type { ObjectiveRoute } from "./objective-execution/objective-route.ts";
import type { CacheDecisionRow, DecisionLedgerStore } from "./operator-projection/decision-ledger-store.ts";
import { latestRequestSnapshot } from "./request-snapshot-fingerprints.ts";
import { MAX_DELEGATE_STATUS_OUTPUT_BYTES } from "./tools/delegate-status.ts";

/** The messages a reply's request carried since the previous reply (see `idleHolder`). */
export function sincePreviousReply(messages: readonly AgentMessage[], reply: AgentMessage): readonly AgentMessage[] {
	const end = messages.lastIndexOf(reply);
	const before = end >= 0 ? messages.slice(0, end) : messages;
	let start = before.length;
	while (start > 0 && before[start - 1]?.role !== "assistant") start--;
	return before.slice(start);
}

export interface SessionCacheControllerDeps {
	getSessionManager(): SessionManager;
	getSessionId(): string;
	getCwd(): string;
	getMessages(): readonly AgentMessage[];
	setMessages(messages: AgentMessage[]): void;
	getModel(): Model<Api> | undefined;
	getContextUsage(): ContextUsage | undefined;
	getDecisionLedger(): DecisionLedgerStore | undefined;
	advancePromptDate(): boolean;
	refreshBaseSystemPrompt(): void;
	resetSanitizerPrefixHorizon(): void;
	previewWorkerModel(): Model<Api> | undefined;
	getGoalUserGoal(): string | undefined;
	executeObjectiveRootRoute(route: ObjectiveRoute, signal?: AbortSignal): Promise<unknown>;
	runWorkerDelegationOnce(request: WorkerDelegationRequest): Promise<WorkerDelegationRunOutcome>;
	sendNextTurnCustomMessage(message: { customType: string; content: string; display: boolean }): Promise<void>;
}

export class SessionCacheController {
	private readonly deps: SessionCacheControllerDeps;
	readonly custody = new CacheCustody();
	readonly knowledge: CacheKnowledge;
	private readonly observations: CacheObservationRecorder;
	private readonly workerEarlyVerdicts = new Map<string, string>();
	lastSentRequest: LastSentRequest | undefined;

	constructor(deps: SessionCacheControllerDeps) {
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
	recordObservation(
		message: AssistantMessage,
		/**
		 * A worker conversation's own history and request snapshot; omitted, the foreground's. Each worker
		 * conversation is its own history (the gap is measured on it), on the same provider lane.
		 */
		conversation?: WorkerResponseObservation,
	): void {
		try {
			const foreground = conversation ? undefined : latestRequestSnapshot(this.deps.getSessionManager());
			const snapshot = conversation ? conversation.snapshot : foreground;
			const history = conversation ? conversation.messages : this.deps.getMessages();
			const sessionId = conversation
				? `${this.deps.getSessionId()}/worker:${conversation.agentId}`
				: this.deps.getSessionId();
			const lane = cacheLaneKey(message.api, message.provider, message.model);
			const snapshotLane = snapshot ? cacheLaneKey(snapshot.api, snapshot.provider, snapshot.modelId) : undefined;
			const matched = snapshotLane === lane ? snapshot : undefined;
			const openedAt = conversation ? conversation.requestOpenedAt : foreground && Date.parse(foreground.timestamp);
			const requestOpenedAt = matched ? openedAt : undefined;
			const row = this.observations.observe({
				sessionId,
				lane,
				respondedAt: Date.now(),
				usage: message.usage,
				...(requestOpenedAt !== undefined ? { requestOpenedAt } : {}),
				...(matched?.prefixIntact !== undefined ? { prefixIntact: matched.prefixIntact } : {}),
				...(matched?.firstDivergentKind ? { divergenceKind: matched.firstDivergentKind } : {}),
				lineage: historyLineage(history),
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
	 * The guard, once per foreground request: classify it against the lane's surface. A break the gate
	 * sanctioned is recorded as priced; one it did not is recorded as unsanctioned, with its kind and index.
	 */
	guardSurface(
		snapshot: SessionRequestSnapshotInput | undefined = latestRequestSnapshot(this.deps.getSessionManager()),
		conversation?: string,
	): void {
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
	 * A cold moment: every surface change that waited applies, and the prompt's pinned date advances to
	 * today. Each is sanctioned for the next request.
	 */
	atColdMoment(reason: string): void {
		this.custody.flushColdMoment(reason);
		if (this.deps.advancePromptDate()) {
			this.custody.sanction("date", `the prompt's date advanced (${reason})`);
			this.deps.refreshBaseSystemPrompt();
		}
	}

	/**
	 * No warm cache the system prompt could break: the turn's lane and the talker's lane (the system prompt
	 * is shared) each have no answer yet in this session or their cache expected gone.
	 */
	isSystemPromptCold(turnModel: Model<Api> | undefined): boolean {
		const currentModel = this.deps.getModel();
		const laneCold = (model: Model<Api> | undefined) =>
			!model ||
			this.knowledge.lastResponseAt(this.deps.getSessionId(), cacheLaneKey(model.api, model.provider, model.id)) ===
				undefined ||
			this.laneCacheGone(model);
		return laneCold(turnModel ?? currentModel) && laneCold(currentModel);
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

	/** Whether the lane's cache is expected gone at the real idle gap: a surface change there costs nothing. */
	laneCacheGone(model: Model<Api>, conversation?: string): boolean {
		const lane = cacheLaneKey(model.api, model.provider, model.id);
		const now = Date.now();
		const last = this.knowledge.lastResponseAt(conversation ?? this.deps.getSessionId(), lane);
		if (last === undefined) return false;
		const estimate = this.knowledge.retainedAfter(lane, Math.max(0, now - last), now);
		return estimate !== undefined && estimate.retained + estimate.standardError <= 0;
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

	refreshAfterCompaction(): void {
		this.deps.setMessages(this.deps.getSessionManager().buildSessionContext().messages);
		// A compaction rewrites the history every lane sends: the next request's break is sanctioned, and it
		// is a cold moment for every surface change that waited.
		this.custody.sanction("compaction", "a compaction replaced the history");
		this.atColdMoment("compaction");
		// The compacted history replaces the one the sent-prefix marks were counting: none of it has been
		// sent in this form. Without the reset the monotone mark kept the pre-compaction count, so the whole
		// new history read as already sent (no context-GC packing, no sanitizer dedup) until it regrew past
		// that count. A compaction applied inside a run lowers the run's marks itself on `replan`.
		this.deps.resetSanitizerPrefixHorizon();
		try {
			cleanupSessionResources(this.deps.getSessionId());
		} catch {
			// Provider cache cleanup is best-effort and must not turn an applied compaction into a failure.
		}
	}

	/**
	 * A side-trip model approval: switch cost against the prefix read tokens, when prices exist.
	 * always does. Without prices on either side there is no evidence, and the talker answers.
	 */
	sideTripApproves(model: Model<Api>, text: string): boolean {
		const prefixTokens = this.deps.getContextUsage()?.tokens ?? 0;
		const messages = this.deps.getMessages();
		const briefTokens =
			sideTripBrief(messages, messages.length).reduce((sum, message) => sum + estimateTokens(message), 0) +
			estimateTokens({ role: "user", content: text, timestamp: 0 });
		const cost = switchCostUsd(model, prefixTokens, briefTokens);
		if (cost === undefined) return false;
		if (cost === 0) return true;
		const talker = this.deps.getModel();
		const pricing = talker ? resolveEffectiveModelPricing(talker, prefixTokens) : undefined;
		return pricing !== undefined && cost < usd(prefixTokens, pricing.cacheRead);
	}

	/**
	 * The root (the talker) or a minion fan-out for a retrieve route (`priceExecutor`). The talker's
	 * cost is its learned requests for this route kind reading its prefix; every independent worker pays
	 * its own actual brief and bounded report. The workers are priced on the model admission would use
	 * now (the owner's pin for the role, account routing, or the session model).
	 */
	chooseObjectiveExecutor(route: ObjectiveRoute): "root" | "worker" {
		const briefTokens = estimateTokens({
			role: "user",
			content: buildObjectiveRoutePrompt(route).text,
			timestamp: 0,
		});
		return this.priceObjectiveExecutor(route, briefTokens, 1);
	}

	/** Price a retrieve route against the exact immutable question fan-out execution will consume. */
	chooseRetrieveExecutor(route: ObjectiveRoute, questions: readonly string[]): "root" | "worker" {
		const briefTokens = Math.max(
			0,
			...questions.map((question) =>
				estimateTokens({ role: "user", content: minionInstructions(question), timestamp: 0 }),
			),
		);
		return this.priceObjectiveExecutor(route, briefTokens, questions.length);
	}

	/** One cache-economic owner for discretionary root-versus-worker objective execution. */
	priceObjectiveExecutor(route: ObjectiveRoute, briefTokens: number, workers: number): "root" | "worker" {
		const model = this.deps.getModel();
		const prefixTokens = this.deps.getContextUsage()?.tokens ?? 0;
		const pricing = model ? resolveEffectiveModelPricing(model, prefixTokens) : undefined;
		const workerModel = this.deps.previewWorkerModel() ?? model;
		const workerPrefixTokens = this.deps
			.getDecisionLedger()
			?.medianWorkerPrefixTokens(Date.now() - negligibleAgeMs(CACHE_SURVIVAL_CALIBRATION.halfLifeMs));
		const verdict = priceExecutor({
			talkerPrefixTokens: prefixTokens,
			briefTokens,
			reportTokens: estimateTokens({
				role: "user",
				content: " ".repeat(MAX_DELEGATE_STATUS_OUTPUT_BYTES),
				timestamp: 0,
			}),
			workers,
			requests: this.deps.getDecisionLedger()?.learnedRootRouteRequests(route.route),
			workerPrefixTokens,
			talker: pricing,
			worker: workerModel
				? resolveEffectiveModelPricing(workerModel, (workerPrefixTokens ?? 0) + briefTokens)
				: undefined,
		});
		this.recordDecision({
			kind: "executor",
			decidedAt: Date.now(),
			admit: verdict.executor === "worker",
			reason: verdict.reason,
			detail: {
				route: route.route,
				prefixTokens,
				briefTokens,
				workers,
				...(workerModel ? { workerModel: `${workerModel.provider}/${workerModel.id}` } : {}),
			},
		});
		return verdict.executor;
	}

	/**
	 * The objective loop's retrieve route: the talker reads on its warm prefix, or minions (read-only
	 * workers, no forked turns) each gather one question on a small brief (`priceExecutor` decides, as
	 * for any route the root may take). Only accepted reports reach the talker, as one bounded evidence
	 * record on its next turn.
	 */
	async retrieveForObjective(route: ObjectiveRoute, signal?: AbortSignal): Promise<"root" | "worker"> {
		const objective = this.deps.getGoalUserGoal() ?? route.objective_id;
		const questions = gatheringQuestions(objective, route.target_requirement_ids ?? []);
		const executor = this.chooseRetrieveExecutor(route, questions);
		// Recorded before the route runs, so an interrupted route still teaches its request count.
		this.deps.getDecisionLedger()?.noteRouteExecutor(this.deps.getSessionId(), route.cycle_id, executor);
		if (executor === "root") {
			await this.deps.executeObjectiveRootRoute(route, signal);
			return "root";
		}
		const reports = await gatherWithMinions(questions, async (question) => {
			signal?.throwIfAborted();
			const run = await this.deps.runWorkerDelegationOnce({
				instructions: minionInstructions(question),
				authority: { readOnly: true },
				forkTurns: "none",
				// Each question is its own brief: minions never share one specialist's context.
				parallelWork: { independentOf: [], justification: "one atomic gathering question per read-only minion" },
			});
			if (!run.started || !run.outcome)
				return { question, accepted: false, reason: run.skipReason ?? "not started" };
			return run.outcome.accepted
				? { question, accepted: true, summary: run.outcome.claim.summary }
				: { question, accepted: false, reason: run.outcome.reasonCode };
		});
		await this.deps.sendNextTurnCustomMessage({
			customType: GATHERED_EVIDENCE_CUSTOM_TYPE,
			content: formatGatheredEvidence(reports, MAX_DELEGATE_STATUS_OUTPUT_BYTES),
			display: true,
		});
		return "worker";
	}
}
