/**
 * A session's prompt-cache controller: the foreground's side of the lane guard (`CacheLaneGuard` holds custody,
 * knowledge, observations and worker conversations' guard), cold-moment transitions, and cache-priced objective
 * executor selection.
 */

import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import { cleanupSessionResources } from "@caupulican/pi-ai/session-resources";
import { estimateTokens } from "../kernel/compaction/compaction.ts";
import type { SessionManager, SessionRequestSnapshotInput } from "../kernel/session/session-manager.ts";
import type { AgentMessage } from "../kernel/types.ts";
import type { WorkerDelegationRunOutcome } from "./agent-session-contracts.ts";
import {
	priceExecutor,
	resolveEffectiveModelPricing,
	switchCostUsd,
	usd,
} from "./compaction/early-compaction-economics.ts";
import type { CompactionCacheFacts } from "./compaction-controller.ts";
import type { LastSentRequest } from "./compaction-support.ts";
import type { CacheCustody } from "./context/cache-custody.ts";
import type { CacheKnowledge } from "./context/cache-knowledge.ts";
import { CacheLaneGuard } from "./context/cache-lane-guard.ts";
import { cacheLaneKey } from "./context/cache-observation-recorder.ts";
import { negligibleAgeMs } from "./context/cache-survival.ts";
import { CACHE_SURVIVAL_CALIBRATION } from "./context/cache-survival-calibration.ts";
import type { WorkerResponseObservation } from "./delegation/worker-attempt-executor.ts";
import type { WorkerDelegationRequest } from "./delegation/worker-delegation-request.ts";
import type { ContextUsage } from "./extensions/index.ts";
import { buildObjectiveRoutePrompt } from "./goals/goal-continuation-prompt.ts";
import type { GoalState } from "./goals/goal-state.ts";
import {
	formatGatheredEvidence,
	GATHERED_EVIDENCE_CUSTOM_TYPE,
	gatheringQuestions,
	gatherWithMinions,
	minionInstructions,
} from "./minion-gathering.ts";
import { sideTripBrief } from "./model-router/side-trip-brief.ts";
import { assertCurrentGoalObjective } from "./objective-execution/current-objective-execution.ts";
import type { ObjectiveRoute } from "./objective-execution/objective-route.ts";
import type { CacheDecisionRow, DecisionLedgerStore } from "./operator-projection/decision-ledger-store.ts";
import { latestRequestSnapshot } from "./request-snapshot-fingerprints.ts";
import { MAX_DELEGATE_STATUS_OUTPUT_BYTES } from "./tools/delegate-status.ts";

export interface SessionCacheControllerDeps {
	getSessionManager(): SessionManager;
	getSessionId(): string;
	getCwd(): string;
	getMessages(): readonly AgentMessage[];
	/** The lineage the foreground's requests are made on (see `historyLineage`; ICM turns are their own lineage). */
	getForegroundLineage(): string;
	setMessages(messages: AgentMessage[]): void;
	getModel(): Model<Api> | undefined;
	getContextUsage(): ContextUsage | undefined;
	getDecisionLedger(): DecisionLedgerStore | undefined;
	advancePromptDate(): boolean;
	refreshBaseSystemPrompt(): void;
	resetSanitizerPrefixHorizon(): void;
	previewWorkerModel(): Model<Api> | undefined;
	getGoalState(): GoalState | undefined;
	executeObjectiveRootRoute(route: ObjectiveRoute, signal?: AbortSignal): Promise<unknown>;
	runWorkerDelegationOnce(request: WorkerDelegationRequest): Promise<WorkerDelegationRunOutcome>;
	sendNextTurnCustomMessage(
		message: { customType: string; content: string; display: boolean },
		assertCurrent: () => void,
	): Promise<void>;
	/** Reports a host failure the session keeps running through. */
	warn(message: string): void;
}

export class SessionCacheController {
	private readonly deps: SessionCacheControllerDeps;
	/** The session's lane guard: custody, knowledge and worker conversations' guard, shared with worker request planning. */
	readonly guard: CacheLaneGuard;
	readonly custody: CacheCustody;
	readonly knowledge: CacheKnowledge;
	lastSentRequest: LastSentRequest | undefined;

	constructor(deps: SessionCacheControllerDeps) {
		this.deps = deps;
		this.guard = new CacheLaneGuard({
			getSessionId: () => this.deps.getSessionId(),
			getCwd: () => this.deps.getCwd(),
			getDecisionLedger: () => this.deps.getDecisionLedger(),
		});
		this.custody = this.guard.custody;
		this.knowledge = this.guard.knowledge;
	}

	/**
	 * One cache observation per provider response, joined to the request snapshot that opened it (see
	 * `CacheLaneGuard.observeResponse`).
	 */
	recordObservation(
		message: AssistantMessage,
		/** A worker conversation's own history and request snapshot; omitted, the foreground's. */
		conversation?: WorkerResponseObservation,
	): void {
		if (conversation) {
			this.guard.observeWorkerResponse(message, conversation);
			return;
		}
		try {
			const foreground = latestRequestSnapshot(this.deps.getSessionManager());
			this.guard.observeResponse(message, {
				sessionId: this.deps.getSessionId(),
				snapshot: foreground,
				openedAt: foreground && Date.parse(foreground.timestamp),
				history: this.deps.getMessages(),
				lineage: this.deps.getForegroundLineage(),
			});
		} catch {
			// Telemetry only.
		}
	}

	/** The guard, once per foreground request (see `CacheLaneGuard.guardSurface`). */
	guardSurface(
		snapshot: SessionRequestSnapshotInput | undefined = latestRequestSnapshot(this.deps.getSessionManager()),
		conversation?: string,
	): void {
		this.guard.guardSurface(snapshot, conversation);
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

	/** A compaction's measured effect on the session's own lane (see `CacheLaneGuard.recordCompactionOutcome`). */
	recordCompactionOutcome(outcome: {
		readonly model: Model<Api>;
		tokensBefore: number;
		tokensAfter: number;
		outputTokens: number;
	}): void {
		this.guard.recordCompactionOutcome(outcome);
	}

	/** The learned cache facts an early compaction of the session's own lane on `model` is priced with, at `now`. */
	compactionEconomics(model: Model<Api>, now: number): CompactionCacheFacts {
		const lane = cacheLaneKey(model.api, model.provider, model.id);
		const lastResponseAt = this.knowledge.lastResponseAt(this.deps.getSessionId(), lane);
		const retained =
			lastResponseAt === undefined
				? undefined
				: this.knowledge.retainedAfter(lane, Math.max(0, now - lastResponseAt), now);
		const lineage = this.knowledge.lineage(this.deps.getSessionId(), this.deps.getForegroundLineage(), now);
		const outcome = this.knowledge.compactionOutcome(lane, now);
		return {
			retainedAt: (gapMs) => this.knowledge.retainedAfter(lane, gapMs, now),
			returnGapsMs: (holder) => this.knowledge.returnGaps(holder, now),
			gapResolutionMs: this.knowledge.gapResolution(lane, now),
			...(retained ? { retained } : {}),
			// Without a lineage that long on record, the lineage's own elapsed requests stand in.
			...(lineage ? { remainingRequests: lineage.remaining ?? lineage.elapsed } : {}),
			...(outcome ? { outcome } : {}),
		};
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
		this.guard.recordDecision(decision);
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
		// A failed release must not turn an applied compaction into a failure, but it is reported, never swallowed.
		try {
			cleanupSessionResources(this.deps.getSessionId());
		} catch (error) {
			const detail =
				error instanceof AggregateError
					? `${error.message}: ${error.errors.map((inner) => (inner instanceof Error ? inner.message : String(inner))).join("; ")}`
					: error instanceof Error
						? error.message
						: String(error);
			this.deps.warn(
				`Provider session resources were not released after compaction (the compaction stays applied): ${detail}`,
			);
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
		const goal = assertCurrentGoalObjective(route.objective_id, this.deps.getGoalState());
		const objective = goal?.userGoal ?? route.objective_id;
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
			assertCurrentGoalObjective(route.objective_id, this.deps.getGoalState());
			const run = await this.deps.runWorkerDelegationOnce({
				objectiveId: route.objective_id,
				instructions: minionInstructions(question),
				authority: { readOnly: true },
				forkTurns: "none",
				// Ordinary admission reuses a compatible idle specialist; each question is a new task,
				// not authorization to allocate an independent copy of its retained session.
			});
			if (!run.started || !run.outcome)
				return { question, accepted: false, reason: run.skipReason ?? "not started" };
			return run.outcome.accepted
				? { question, accepted: true, summary: run.outcome.claim.summary }
				: { question, accepted: false, reason: run.outcome.reasonCode };
		});
		await this.deps.sendNextTurnCustomMessage(
			{
				customType: GATHERED_EVIDENCE_CUSTOM_TYPE,
				content: formatGatheredEvidence(reports, MAX_DELEGATE_STATUS_OUTPUT_BYTES),
				display: true,
			},
			() => assertCurrentGoalObjective(route.objective_id, this.deps.getGoalState()),
		);
		return "worker";
	}
}
