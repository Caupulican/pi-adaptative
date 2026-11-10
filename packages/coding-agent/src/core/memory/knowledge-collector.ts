/** Idle original-owner learning, with durable claims and one extraction/admission spending allowance. */
import { createHash, randomUUID } from "node:crypto";
import type { Api, Model } from "@caupulican/pi-ai";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../agent-session-contracts.ts";
import { isRequestSpendRefusal, RequestSpendBudget, RequestSpendRefusal } from "../cost/request-spend-budget.ts";
import type { SessionSemanticUsageDelivery } from "../cost/semantic-usage-delivery.ts";
import type { ConfidenceProvenance } from "../decision/confidence.ts";
import type { DecisionOptions, SemanticDecisionEngine } from "../decision/engine.ts";
import { resolveAutoLearnSettings } from "../learning/auto-learn-settings.ts";
import type { OwnerEvidenceDescriptor, OwnerEvidenceLedger } from "../learning/owner-evidence-ledger.ts";
import { logProviderLanePark, providerAdmissionRefusalOf } from "../provider-admission/refusal.ts";
import type { LaneModelResolver } from "../research/lane-model-resolver.ts";
import type {
	AutoLearnSettings,
	AutonomySettings,
	ResolvedLearningPolicySettings,
} from "../settings/settings-schema.ts";
import { canonicalDigest, strictCanonicalDigest } from "../steering/canonical.ts";
import type { TimerPort } from "../util/timer-port.ts";
import {
	judgeDecision,
	type KnowledgeAdmissionPort,
	type KnowledgeChange,
	parseKnowledgeChange,
} from "./knowledge-admission.ts";
import { EMPTY_CHANGE_DIGEST, type KnowledgeChangeDigest, withAppliedChange } from "./knowledge-announcement.ts";
import { type KnowledgeCollectionClaim, knowledgeCollectionSourceIdentity } from "./knowledge-collection-journal.ts";
import { extractKnowledgeCandidates, KnowledgeExtractionRefusal } from "./knowledge-extractor.ts";
import { type KnowledgeRecord, type KnowledgeScope, knowledgeId, MAX_KNOWLEDGE_PAGE_SIZE } from "./knowledge-record.ts";
import type { KnowledgeStore } from "./knowledge-store.ts";
import type { KnowledgeReadSource } from "./knowledge-tool.ts";
import { KnowledgeWorkUnresolved } from "./knowledge-work-journal.ts";
import { countOwnerCommitsAfter, REPOSITORY_HISTORY_ORIGIN, readOwnerHistory } from "./repository-history.ts";
import { mineTasteFromHistory, type TasteHistoryMiningResult } from "./taste-history-miner.ts";

const EXTRACTOR_VERSION = "owner-knowledge-v1";
export const KNOWLEDGE_COLLECTION_OPERATION_PREFIX = "knowledge-collection:";
const MAX_SCANNED_PER_PASS = 128;
const PASS_DEADLINE_MS = 120_000;
const RETRY_DELAY_MS = 60_000;
/** Resumptions from a paying hold before a source waits for a configuration change. */
const MAX_SOURCE_RETRIES = 4;
/** The output limit of one bounded reading: the model's own limit, capped. */
const MAX_READING_OUTPUT_TOKENS = 4_096;
/** Looks that threw a request error after which the look is decided, so a failing request is asked twice, not on every pass. */
const MAX_HISTORY_LOOK_ATTEMPTS = 2;
/** Owner commits after a recorded history cursor that make a new look worth paying for. */
const HISTORY_LOOK_COMMITS = 50;
/** Commits a sample must hold before a look is worth a request. */
const MIN_HISTORY_SAMPLE_COMMITS = 5;

class CollectionDeadline extends Error {}
/** The owner moved on. It stops the pass from starting requests and never aborts a request already sent. */
class CollectionYield extends Error {}

interface CollectionProgress {
	sources: number;
	applied: number;
	rejected: number;
	held: number;
	changes: KnowledgeChangeDigest;
}

export interface KnowledgeCollectionOutcome {
	readonly id: string;
	readonly status: "completed" | "held" | "cancelled" | "failed";
	readonly sources: number;
	readonly applied: number;
	readonly rejected: number;
	readonly held: number;
}

export interface KnowledgeCollectionHandoff {
	readonly retained: boolean;
	readonly reason?: string;
}

/** The memory generation owns this binding and closes its store only after stop() joins. */
export interface KnowledgeCollectionBinding {
	readonly store: KnowledgeStore;
	readonly scope: KnowledgeScope;
	isCurrent(): boolean;
	getKnowledge(): KnowledgeReadSource | undefined;
	getAdmission(request: Pick<DecisionOptions, "budget" | "origin">): KnowledgeAdmissionPort | undefined;
}

export interface KnowledgeCollectionRuntime {
	readonly models: Pick<LaneModelResolver, "resolveModel" | "capabilityProfile">;
	readonly time: TimerPort;
	engine(): SemanticDecisionEngine | undefined;
	isForegroundBusy(): boolean;
	subscribeForegroundActivity(listener: () => void): () => void;
	maxEstimatedUsd(): number | undefined;
	/** Persist the bounded handoff and notify the parent, even after cancellation. */
	onTerminal(
		outcome: KnowledgeCollectionOutcome,
		handoff?: KnowledgeCollectionHandoff,
		changes?: KnowledgeChangeDigest,
	): void;
	/** Called after an idle pass that claimed nothing: it writes no terminal, so this is its only signal. Nothing persists. */
	onIdlePass?(): void;
	/** Where a pass may read this repository's history, and how the owner hears what a look offered. */
	readonly history?: KnowledgeHistoryLook;
}

/** One repository a collector may read, and the one line its owner gets for what a look offered. */
export interface KnowledgeHistoryLook {
	/** The working directory whose repository is read, by its configured identity. */
	readonly cwd: string;
	/** One owner-facing count of what a look offered; zero says nothing. */
	announce(offered: number): void;
}

/** Why automatic collection starts no requests; explicit owner changes through the knowledge tool stay available. */
export type KnowledgeCollectionInactiveReason =
	| "disabled"
	| "invalid_settings"
	| "configuration_unreadable"
	| "no_model"
	| "model_unpriced"
	| "no_engine"
	| "budget_exhausted"
	| "accounting_unresolved"
	| "ephemeral_session"
	| "child_session"
	| "memory_unavailable";

/** The owner-visible state of automatic collection, derived from its configuration and session spending. */
export interface KnowledgeCollectionStatus {
	readonly state: "active" | "inactive";
	readonly reason?: KnowledgeCollectionInactiveReason;
	readonly engine?: { readonly id: string; readonly model: string; readonly provenance: ConfidenceProvenance };
	readonly spentUsd?: number;
	readonly sessionMaxUsd?: number;
	readonly last?: KnowledgeCollectionOutcome;
	/** The latest pass, when it completed without a new source. A later pass that ends clears it, so it is newer than `last`. */
	readonly lastIdlePass?: { readonly id: string; readonly at: number };
}

export interface KnowledgeCollectionHost {
	readonly time: TimerPort;
	evidence(): OwnerEvidenceLedger;
	/** System One when bound, otherwise this session's own model as a structured judge. */
	engine(): SemanticDecisionEngine | undefined;
	/**
	 * The spending allowance of one explicit knowledge-tool change judged by the session model, under the
	 * collection's per-change and per-session limits; undefined for any other engine. Throws when exhausted.
	 */
	explicitRequest(engine: SemanticDecisionEngine | undefined): Pick<DecisionOptions, "budget" | "origin"> | undefined;
	captureGuard(): () => string | undefined;
	/** Whether the current session measured this request's usage; releases knowledge work a crashed process left. */
	hasUsageReceipt(requestId: string): boolean;
	/** True while the session is not persisted: no collector can retain its terminal handoffs there. */
	ephemeral(): boolean;
	createCollector(binding: KnowledgeCollectionBinding): KnowledgeCollector | undefined;
}

export interface KnowledgeCollectorSettings {
	getAutoLearnSettings(): AutoLearnSettings;
	getAutonomySettings(): Required<AutonomySettings>;
	getLearningPolicySettings(): ResolvedLearningPolicySettings;
	subscribeChanges(listener: () => void): () => void;
}

export interface KnowledgeCollectorDeps extends KnowledgeCollectionBinding, KnowledgeCollectionRuntime {
	readonly evidence: OwnerEvidenceLedger;
	readonly settings: KnowledgeCollectorSettings;
	readonly usageOwner: SessionSemanticUsageDelivery;
	captureGuard(): () => string | undefined;
	runIsolatedCompletion(options: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	warn(message: string): void;
	/**
	 * Whether the session file is durable (a flushed session file, not a configured path). A terminal handoff is
	 * retained as a session entry, so a pass starts only once that entry can be physically retained.
	 */
	durable(): boolean;
	/**
	 * Notifies once, when the session becomes durable; the collector then re-evaluates its schedule. It must not fire for
	 * later persisted entries: the collector's own terminal entry is one, and would re-arm it on every pass that writes one.
	 */
	subscribeDurability(listener: () => void): () => void;
}

interface Configuration {
	readonly key: string;
	readonly enabled: boolean;
	readonly reason?: KnowledgeCollectionInactiveReason;
	readonly model: Model<Api> | undefined;
	readonly engine: SemanticDecisionEngine | undefined;
	readonly settings: Required<AutoLearnSettings>;
}

/**
 * No timer or listener survives stop; asynchronous tails retain accounting, never a closed store.
 *
 * A pass starts only on a durable session file. A pass that claims a source, is held, yields, is cancelled or fails ends in a
 * terminal handoff retained as a session entry; a pass that completes without a new source writes none and is kept in memory as
 * the last idle pass. A session entry is physically retained only once its file is flushed; a fresh session flushes at its first
 * owner input or reply.
 * Until then the collector schedules nothing, so no handoff exists that could be left unretained at shutdown.
 *
 * Owner activity, new owner evidence and settings changes yield the pass:
 * - it starts no further request and ends at its next boundary;
 * - a request already sent finishes, and its result is retained exactly as if nothing had happened.
 * Only stop() and the pass deadline abort a request in flight. Such a request's outcome is unknown, so it is never
 * replayed.
 */
export class KnowledgeCollector {
	private readonly deps: KnowledgeCollectorDeps;
	private active = false;
	private alarm: unknown;
	private running: Promise<void> | undefined;
	/** Hard cancellation of the running pass: shutdown and its deadline. The request signal. */
	private abort: AbortController | undefined;
	/** Cooperative stop of the running pass. Latched once raised; never reaches a provider. */
	private yielding: AbortController | undefined;
	private readonly subscriptions: Array<() => void> = [];
	private cursor: string | undefined;
	private revision = -1;
	private configurationKey = "";
	private rescan = true;
	private more = false;
	private retryAt: number | undefined;
	private pendingTerminal: KnowledgeCollectionOutcome | undefined;
	private pendingChanges: KnowledgeChangeDigest = EMPTY_CHANGE_DIGEST;
	private lastTerminal: KnowledgeCollectionOutcome | undefined;
	private lastIdlePass: { readonly id: string; readonly at: number } | undefined;
	private accountingDirty = false;
	private beganWithUnresolvedAccounting = false;
	/** One look at the repository's history is decided per collector: looked, not due, or nothing to read. */
	private historyDecided = false;
	/** Looks whose request threw: the look is decided after {@link MAX_HISTORY_LOOK_ATTEMPTS} of them. */
	private historyAttempts = 0;

	constructor(deps: KnowledgeCollectorDeps) {
		this.deps = deps;
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.subscriptions.push(
			this.deps.evidence.subscribe(() => this.invalidate()),
			this.deps.settings.subscribeChanges(() => this.invalidate()),
			this.deps.usageOwner.subscribeSpending(() => {
				// Our own serial receipts need no new pass. A late response wakes held work after settlement.
				if (this.running) {
					this.accountingDirty = true;
					return;
				}
				this.rescan = true;
				this.schedule();
			}),
			this.deps.subscribeDurability(() => this.schedule()),
			this.deps.subscribeForegroundActivity(() => {
				if (this.deps.isForegroundBusy()) this.yieldPass();
				else this.schedule();
			}),
		);
		this.schedule();
	}

	stop(): Promise<void> {
		this.active = false;
		for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
		this.yieldPass();
		// Shutdown never waits on a paid request indefinitely. The aborted request's outcome is unknown, so its work
		// cell keeps refusing replay.
		this.abort?.abort(new Error("Knowledge collection stopped"));
		return (this.running ?? Promise.resolve()).then(() => {
			this.flushTerminal();
			if (this.pendingTerminal)
				throw new Error(`Knowledge collection handoff remains unretained: ${this.pendingTerminal.id}`);
		});
	}

	/** Resolves when no pass is running. The running pass's own promise is the barrier: no timer and no poll. */
	settled(): Promise<void> {
		return this.running ?? Promise.resolve();
	}

	/** Reads configuration and the session spending projection only; never starts or schedules work. */
	status(): KnowledgeCollectionStatus {
		let config: Configuration;
		try {
			config = this.configuration();
		} catch {
			// schedule() starts no pass on the same failed read; the owner sees that cause instead of an audit failure.
			return {
				state: "inactive",
				reason: "configuration_unreadable",
				...(this.lastTerminal ? { last: this.lastTerminal } : {}),
				...(this.lastIdlePass ? { lastIdlePass: this.lastIdlePass } : {}),
			};
		}
		const engine = config.engine
			? {
					id: config.engine.id,
					model: config.engine.model,
					provenance: config.engine.capabilities().confidenceProvenance,
				}
			: undefined;
		const spending = this.deps.usageOwner.spending(
			KNOWLEDGE_COLLECTION_OPERATION_PREFIX,
			KNOWLEDGE_COLLECTION_OPERATION_PREFIX,
		);
		// A zero per-source limit refuses every source before its first request, exactly like an exhausted session.
		const reason =
			config.reason ??
			(spending.unresolved
				? "accounting_unresolved"
				: Math.min(
							config.settings.knowledgeMaxUsd,
							config.settings.knowledgeSessionMaxUsd - spending.totalUsd,
							this.deps.maxEstimatedUsd() ?? Number.POSITIVE_INFINITY,
						) <= 0
					? "budget_exhausted"
					: undefined);
		return {
			state: reason ? "inactive" : "active",
			...(reason ? { reason } : {}),
			...(engine ? { engine } : {}),
			spentUsd: spending.totalUsd,
			sessionMaxUsd: config.settings.knowledgeSessionMaxUsd,
			...(this.lastTerminal ? { last: this.lastTerminal } : {}),
			...(this.lastIdlePass ? { lastIdlePass: this.lastIdlePass } : {}),
		};
	}

	/** Unarms a pending pass and yields a running one. Its next pass, after the idle delay, scans again from the start. */
	private yieldPass(): void {
		if (this.alarm !== undefined) this.deps.time.clearTimeout(this.alarm);
		this.alarm = undefined;
		this.yielding?.abort(new CollectionYield("Knowledge collection yielded to the owner"));
		this.rescan = true;
	}

	private invalidate(): void {
		this.yieldPass();
		this.schedule();
	}

	private configuration(): Configuration {
		const settings = resolveAutoLearnSettings(
			this.deps.settings.getAutonomySettings().mode,
			this.deps.settings.getAutoLearnSettings(),
		);
		const model = this.deps.models.resolveModel(settings.model === "active" ? undefined : settings.model);
		const engine = this.deps.engine();
		const cap = this.deps.maxEstimatedUsd();
		const valid =
			Number.isFinite(settings.knowledgeMaxUsd) &&
			settings.knowledgeMaxUsd >= 0 &&
			typeof settings.history === "boolean" &&
			Number.isFinite(settings.historyMaxUsd) &&
			settings.historyMaxUsd >= 0 &&
			Number.isFinite(settings.knowledgeSessionMaxUsd) &&
			settings.knowledgeSessionMaxUsd >= 0 &&
			Number.isSafeInteger(settings.knowledgeIdleDelayMs) &&
			settings.knowledgeIdleDelayMs >= 0 &&
			Number.isSafeInteger(settings.knowledgeMaxSourcesPerPass) &&
			settings.knowledgeMaxSourcesPerPass > 0 &&
			settings.knowledgeMaxSourcesPerPass <= 32 &&
			(cap === undefined || (Number.isFinite(cap) && cap >= 0));
		// An unpriced model is refused by every bounded completion, so collection never starts on it.
		const reason: KnowledgeCollectionInactiveReason | undefined = !settings.enabled
			? "disabled"
			: !valid
				? "invalid_settings"
				: !model
					? "no_model"
					: model.costDefaulted
						? "model_unpriced"
						: engine?.capabilities().requestBudget !== true
							? "no_engine"
							: undefined;
		return {
			settings,
			model,
			engine,
			enabled: reason === undefined,
			...(reason ? { reason } : {}),
			key: canonicalDigest({
				settings,
				cap: cap ?? null,
				learning: this.deps.settings.getLearningPolicySettings(),
				model: model ?? null,
				engine: engine ? { id: engine.id, model: engine.model, capabilities: engine.capabilities() } : null,
			}),
		};
	}

	private schedule(): void {
		if (
			!this.active ||
			this.running ||
			this.alarm !== undefined ||
			!this.deps.isCurrent() ||
			this.deps.isForegroundBusy() ||
			!this.deps.durable()
		)
			return;
		try {
			if (!this.flushTerminal()) return;
			const config = this.configuration();
			if (!config.enabled) return;
			const revision = this.deps.store.revision();
			if (config.key !== this.configurationKey || revision !== this.revision) this.rescan = true;
			this.configurationKey = config.key;
			this.revision = revision;
			this.alarm = this.deps.time.setTimeout(
				() => {
					this.alarm = undefined;
					if (!this.active || !this.deps.isCurrent() || this.deps.isForegroundBusy() || !this.deps.durable())
						return;
					this.running = this.run(config).finally(() => {
						this.running = undefined;
						this.abort = undefined;
						this.yielding = undefined;
						if (
							this.active &&
							this.accountingDirty &&
							this.beganWithUnresolvedAccounting &&
							!this.deps.usageOwner.spending(
								KNOWLEDGE_COLLECTION_OPERATION_PREFIX,
								KNOWLEDGE_COLLECTION_OPERATION_PREFIX,
							).unresolved
						)
							this.rescan = true;
						if (this.more || this.rescan || this.retryAt !== undefined) this.schedule();
					});
				},
				Math.max(
					config.settings.knowledgeIdleDelayMs,
					(this.more || this.rescan ? 0 : (this.retryAt ?? 0)) - this.deps.time.now(),
				),
			);
		} catch {
			this.deps.warn("Automatic knowledge collection could not read its configuration.");
		}
	}

	private async run(config: Configuration): Promise<void> {
		if (!config.enabled || !config.model) return;
		if (this.rescan || (this.retryAt !== undefined && this.retryAt <= this.deps.time.now())) this.cursor = undefined;
		this.rescan = false;
		this.more = false;
		if (this.retryAt !== undefined && this.retryAt <= this.deps.time.now()) this.retryAt = undefined;
		const controller = new AbortController();
		const yielding = new AbortController();
		this.abort = controller;
		this.yielding = yielding;
		const outcome = {
			id: `${KNOWLEDGE_COLLECTION_OPERATION_PREFIX}${randomUUID()}`,
			sources: 0,
			applied: 0,
			rejected: 0,
			held: 0,
			changes: EMPTY_CHANGE_DIGEST,
		};
		let status: KnowledgeCollectionOutcome["status"] = "completed";
		const deadline = this.deps.time.setTimeout(
			() => controller.abort(new CollectionDeadline("Knowledge collection deadline reached")),
			PASS_DEADLINE_MS,
		);
		try {
			this.accountingDirty = false;
			this.beganWithUnresolvedAccounting = this.deps.usageOwner.spending(
				KNOWLEDGE_COLLECTION_OPERATION_PREFIX,
				KNOWLEDGE_COLLECTION_OPERATION_PREFIX,
			).unresolved;
			const guard = this.deps.captureGuard();
			const origin = this.deps.usageOwner.captureOrigin();
			// The boundary before every step and every physical request. A busy foreground or a changed configuration
			// latches the yield even if its event has not arrived yet, so the pass ends `cancelled`, never `failed`.
			const assertCurrent = (): void => {
				controller.signal.throwIfAborted();
				if (!yielding.signal.aborted && (this.deps.isForegroundBusy() || this.configuration().key !== config.key))
					this.yieldPass();
				yielding.signal.throwIfAborted();
				if (!this.active || !this.deps.isCurrent() || guard())
					throw new Error("Knowledge collection context changed");
			};
			let scanned = 0;
			while (scanned < MAX_SCANNED_PER_PASS && outcome.sources < config.settings.knowledgeMaxSourcesPerPass) {
				assertCurrent();
				const page = this.deps.evidence.readSources(this.cursor);
				if (page.length === 0) break;
				for (const source of page) {
					assertCurrent();
					this.cursor = source.recordId;
					scanned++;
					const collectionSource = {
						sourceId: source.sourceId,
						digest: source.digest,
						createdAt: source.createdAt,
						scope: this.deps.scope,
						extractorVersion: EXTRACTOR_VERSION,
					};
					const claim = this.deps.store.collection.claim(collectionSource, (code) =>
						this.dependency(config.key, code),
					);
					if (claim) {
						outcome.sources++;
						const forgotten = await this.collect(
							source,
							claim,
							config,
							origin,
							assertCurrent,
							controller.signal,
							outcome,
						);
						if (forgotten) {
							this.rescan = true;
							break;
						}
					} else this.retryWhen(this.deps.store.collection.nextEligibleAt(collectionSource));
					if (scanned >= MAX_SCANNED_PER_PASS || outcome.sources >= config.settings.knowledgeMaxSourcesPerPass)
						break;
				}
				if (this.rescan) break;
			}
			this.more = this.deps.evidence.readSources(this.cursor).length > 0;
			this.revision = this.deps.store.revision();
			// A pass that claimed no source and finds none waiting may look at the repository's history instead.
			if (outcome.sources === 0 && !this.more)
				await this.lookAtHistory(config, origin, assertCurrent, controller.signal);
			if (outcome.held > 0) status = "held";
		} catch {
			status = controller.signal.aborted || yielding.signal.aborted ? "cancelled" : "failed";
			if (status === "failed" || controller.signal.reason instanceof CollectionDeadline) {
				this.rescan = false;
				this.more = false;
				this.retryWhen(this.deps.time.now() + RETRY_DELAY_MS);
			}
		} finally {
			this.deps.time.clearTimeout(deadline);
			const { changes, ...counts } = outcome;
			const terminal = { ...counts, status };
			// A pass that completes without claiming a source changes nothing the owner sees, so it writes no session entry and
			// no event. The status keeps it as the last idle pass; any other pass ends that state.
			if (status === "completed" && outcome.sources === 0) {
				this.lastIdlePass = { id: terminal.id, at: this.deps.time.now() };
				this.deps.onIdlePass?.();
			} else {
				this.lastIdlePass = undefined;
				this.pendingTerminal = terminal;
				this.pendingChanges = changes;
				this.flushTerminal();
			}
		}
	}

	/**
	 * One idle pass may read this repository's history once and offer taste proposals from the owner's own commits. When the
	 * look returns, it changes nothing about how the pass ends: a pass that claimed no source stays an idle pass. When its
	 * request throws, the pass fails like any other thrown request, writes its terminal and is retried after the delay, and
	 * the look stays undecided; {@link MAX_HISTORY_LOOK_ATTEMPTS} such looks decide it, so a request that fails every time
	 * is asked twice, not on every later pass.
	 */
	private async lookAtHistory(
		config: Configuration,
		origin: ReturnType<SessionSemanticUsageDelivery["captureOrigin"]>,
		assertCurrent: () => void,
		signal: AbortSignal,
	): Promise<void> {
		const history = this.deps.history;
		const model = config.model;
		if (!history || !config.settings.history || !config.engine || !model) return;
		if (this.historyDecided) return;
		// Spending first: a look nothing can pay for reads no git and asks nothing.
		const project = this.deps.scope.project;
		const operationId = `${KNOWLEDGE_COLLECTION_OPERATION_PREFIX}${REPOSITORY_HISTORY_ORIGIN}:${project}`;
		const spending = this.deps.usageOwner.spending(KNOWLEDGE_COLLECTION_OPERATION_PREFIX, operationId);
		// An unresolved charge is settled by a later pass, which may look then: this pass reads nothing and stays undecided.
		if (spending.unresolved) return;
		const remaining = Math.min(
			config.settings.historyMaxUsd - spending.operationUsd,
			config.settings.knowledgeSessionMaxUsd - spending.totalUsd,
			this.deps.maxEstimatedUsd() ?? Number.POSITIVE_INFINITY,
		);
		if (remaining <= 0) {
			this.historyDecided = true;
			return;
		}
		assertCurrent();
		const looked = this.deps.store.originLooks.last(project, REPOSITORY_HISTORY_ORIGIN);
		if (looked !== undefined) {
			const counted = await countOwnerCommitsAfter({ cwd: history.cwd, after: looked.cursor, signal });
			if (counted.status === "counted" && counted.count < HISTORY_LOOK_COMMITS) {
				this.historyDecided = true;
				return;
			}
		}
		assertCurrent();
		const sample = await readOwnerHistory({ cwd: history.cwd, signal });
		if (sample.status !== "sample" || sample.commits.length < MIN_HISTORY_SAMPLE_COMMITS) {
			this.historyDecided = true;
			return;
		}
		const budget = new RequestSpendBudget(remaining, assertCurrent);
		const request = { budget, origin: { ...origin, operationId } };
		const knownTasteTexts = this.tasteFacts().map((record) => record.text);
		this.historyAttempts += 1;
		let result: TasteHistoryMiningResult;
		try {
			result = await mineTasteFromHistory({
				sample,
				project,
				journal: this.deps.store.proposals,
				knownTasteTexts,
				// The identity a proposal would carry at this collector's own scope, which is the one the journal offers.
				hasLiveTaste: (subject, key) =>
					this.deps.store.get(knowledgeId({ kind: "taste", scope: this.deps.scope, subject, key })) !== undefined,
				model,
				maxTokens: Math.min(model.maxTokens, MAX_READING_OUTPUT_TOKENS),
				budget,
				usageOwner: this.deps.usageOwner,
				origin: request.origin,
				runIsolatedCompletion: this.deps.runIsolatedCompletion,
				assertCurrent,
				signal,
				judge: (program, state, judgedSignal) =>
					judgeDecision({ engine: config.engine, store: this.deps.store, request }, program, state, judgedSignal),
			});
		} catch (error) {
			if (this.historyAttempts >= MAX_HISTORY_LOOK_ATTEMPTS) this.historyDecided = true;
			throw error;
		}
		this.historyDecided = true;
		this.deps.store.originLooks.record(project, REPOSITORY_HISTORY_ORIGIN, sample.head);
		history.announce(result.offered);
	}

	/** The live taste facts that apply here (global and project reach), read the way `/taste` reads them. */
	private tasteFacts(): KnowledgeRecord[] {
		const records: KnowledgeRecord[] = [];
		let after: string | undefined;
		for (;;) {
			const page = this.deps.store.list(this.deps.scope, { kind: "taste", after, limit: MAX_KNOWLEDGE_PAGE_SIZE });
			records.push(...page);
			const last = page.at(-1)?.id;
			if (page.length < MAX_KNOWLEDGE_PAGE_SIZE || last === undefined) return records;
			after = last;
		}
	}

	private retryWhen(at: number | undefined): void {
		if (at !== undefined) {
			this.retryAt = Math.min(this.retryAt ?? at, at);
		}
	}

	private flushTerminal(): boolean {
		if (!this.pendingTerminal) return true;
		try {
			this.deps.onTerminal(this.pendingTerminal, undefined, this.pendingChanges);
			this.lastTerminal = this.pendingTerminal;
			this.pendingTerminal = undefined;
			return true;
		} catch {
			this.deps.warn("Knowledge collection is suspended until its terminal handoff is retained.");
			if (this.active && this.alarm === undefined) {
				this.alarm = this.deps.time.setTimeout(() => {
					this.alarm = undefined;
					this.schedule();
				}, RETRY_DELAY_MS);
			}
			return false;
		}
	}

	/**
	 * What must change before a held source is worth paying for again. A new owner message never changes a judgment of
	 * this source's own candidates, so evidence and context holds wait for a knowledge change (a target revision or a
	 * fence); configuration holds wait for the configuration, and accounting holds for the spending evidence.
	 */
	private dependency(configKey: string, code?: string): string {
		return strictCanonicalDigest({
			configKey,
			...(code === "accounting:unresolved"
				? {
						spending: this.deps.usageOwner.spending(
							KNOWLEDGE_COLLECTION_OPERATION_PREFIX,
							KNOWLEDGE_COLLECTION_OPERATION_PREFIX,
						),
					}
				: {}),
			...(code?.startsWith("evidence:") || code?.startsWith("context:")
				? { revision: this.deps.store.revision() }
				: {}),
		});
	}

	private async collect(
		source: OwnerEvidenceDescriptor,
		claim: KnowledgeCollectionClaim,
		config: Configuration,
		origin: ReturnType<SessionSemanticUsageDelivery["captureOrigin"]>,
		assertContext: () => void,
		signal: AbortSignal,
		progress: CollectionProgress,
	): Promise<boolean> {
		const journal = this.deps.store.collection;
		const assertCurrent = (): void => {
			assertContext();
			journal.assertCurrent(claim);
		};
		// A source that keeps returning to a paying hold stops at a bound, whatever the model's price, until the
		// configuration changes; configuration, accounting and progressing deadline holds are not counted.
		const retainedAtClaim = this.deps.store.work.retainedCount();
		const hold = (code: string, retryAt?: number): void => {
			const limited =
				claim.retries >= MAX_SOURCE_RETRIES &&
				!code.startsWith("configuration:") &&
				!code.startsWith("accounting:") &&
				!code.startsWith("provider:") &&
				code !== "time:deadline";
			const held = limited ? "configuration:retry_limit" : code;
			journal.hold(claim, {
				code: held,
				dependency: this.dependency(config.key, held),
				...(retryAt !== undefined && !limited ? { retryAt } : {}),
			});
			if (retryAt !== undefined && !limited) this.retryWhen(retryAt);
			progress.held++;
		};
		try {
			assertCurrent();
			const operationId = KNOWLEDGE_COLLECTION_OPERATION_PREFIX + knowledgeCollectionSourceIdentity(claim.source);
			const spending = this.deps.usageOwner.spending(KNOWLEDGE_COLLECTION_OPERATION_PREFIX, operationId);
			const remaining = Math.min(
				config.settings.knowledgeMaxUsd - spending.operationUsd,
				config.settings.knowledgeSessionMaxUsd - spending.totalUsd,
				this.deps.maxEstimatedUsd() ?? Number.POSITIVE_INFINITY,
			);
			if (spending.unresolved) {
				hold("accounting:unresolved");
				return false;
			}
			if (remaining <= 0) throw new RequestSpendRefusal("Knowledge spending is held.");
			// Every physical request of this source (extraction turns, window grounding, admission and identity judgments)
			// passes the pass boundary at dispatch, before its work cell opens.
			const budget = new RequestSpendBudget(remaining, assertCurrent);
			const request = { budget, origin: { ...origin, operationId } };
			const original = this.deps.evidence.findSource(source.sourceId);
			if (!original || !source.complete) {
				hold("configuration:incomplete_source");
				return false;
			}
			if (createHash("sha256").update(original.text, "utf8").digest("hex") !== source.digest)
				throw new Error("Original knowledge source changed after discovery");
			const heldWindows = new Set<string>();
			let sourceHold: string | undefined;
			for (;;) {
				const window = journal.windows.next(claim, original);
				if (window && heldWindows.has(window.id)) {
					hold(sourceHold!);
					return false;
				}
				if (!window) {
					journal.windows.finish(claim, original.chars);
					return false;
				}
				let plan = journal.read(claim);
				if (!plan) {
					const workId = strictCanonicalDigest({
						extractor: EXTRACTOR_VERSION,
						window: window.id,
						scope: claim.source.scope,
						model: [config.model!.provider, config.model!.id],
					});
					const retained = this.deps.store.work.read(workId);
					let changes: readonly KnowledgeChange[];
					if (retained !== undefined) {
						if (
							!retained ||
							typeof retained !== "object" ||
							!("complete" in retained) ||
							!("candidates" in retained) ||
							typeof retained.complete !== "boolean" ||
							!Array.isArray(retained.candidates)
						)
							throw new Error("Invalid retained extraction");
						if (!retained.complete) {
							journal.windows.split(claim, original, window);
							continue;
						}
						changes = retained.candidates.map(parseKnowledgeChange);
					} else {
						let begun = false;
						const unsubscribe = budget.subscribeAdmission((requestId) => {
							if (!begun) {
								this.deps.store.work.beginBatch(
									[{ id: workId, owner: claim.id, window: window.id, kind: "extraction" }],
									requestId,
								);
								begun = true;
							}
						});
						try {
							changes = await extractKnowledgeCandidates({
								source: original,
								window,
								onSubmission: (submission) => {
									const barrier = this.deps.store.work.barrier();
									const retain =
										barrier === null ||
										(original.createdAt > barrier &&
											submission.candidates.every((change) =>
												change.evidence.every((citation) => citation.source === original.sourceId),
											));
									if (retain)
										this.deps.store.work.complete(
											workId,
											submission,
											submission.complete ? "complete" : "subdivide",
										);
									else this.deps.store.work.discard(workId, "forgotten");
								},
								model: config.model!,
								maxTokens: Math.min(config.model!.maxTokens, MAX_READING_OUTPUT_TOKENS),
								budget,
								origin: request.origin,
								usageOwner: this.deps.usageOwner,
								signal,
								assertCurrent,
								getKnowledge: this.deps.getKnowledge,
								runIsolatedCompletion: this.deps.runIsolatedCompletion,
							});
						} catch (error) {
							if (error instanceof KnowledgeExtractionRefusal && error.code === "source_capacity") {
								journal.windows.split(claim, original, window);
								continue;
							}
							throw error;
						} finally {
							unsubscribe();
							// An extraction whose every sent request was received and measured (a failure, or a yield before its
							// next turn) releases its cell. One aborted in flight (deadline, shutdown) may have produced a result
							// nobody received, so it is never replayed.
							if (begun && !signal.aborted) this.deps.store.work.settle(workId);
						}
					}
					assertCurrent();
					plan = journal.install(claim, window.id, changes);
				}
				let candidateHold: string | undefined;
				const batchAdmission = this.deps.getAdmission(request);
				if (!batchAdmission) {
					hold("configuration:admission_unavailable");
					return false;
				}
				await batchAdmission.prepare?.(
					plan.candidates.flatMap((candidate) =>
						candidate.outcome === "pending" && candidate.change ? [candidate.change] : [],
					),
					signal,
				);
				for (const [index, candidate] of plan.candidates.entries()) {
					if (candidate.outcome !== "pending") continue;
					assertCurrent();
					budget.assertHealthy();
					const admission = this.deps.getAdmission(request);
					if (!admission) {
						hold("configuration:admission_unavailable");
						return false;
					}
					const claimed = journal.operation(claim, plan, index);
					// Admission re-checks the pass boundary between its judgments and before it applies: a yielded pass applies
					// nothing, and its next pass reuses the retained verdicts.
					const operation = {
						...claimed,
						assertClaimCurrent: () => {
							assertContext();
							claimed.assertClaimCurrent();
						},
					};
					const admitted = await admission.change(candidate.change!, signal, operation);
					if (admitted.status === "applied") {
						journal.acknowledge(claim, operation, "applied");
						progress.applied++;
						progress.changes = withAppliedChange(progress.changes, admitted);
						if (admitted.action === "forget") return true;
					} else if (admitted.retry === "never") {
						journal.acknowledge(claim, operation, "rejected");
						progress.rejected++;
					} else if (
						!candidateHold ||
						admitted.retry === "context" ||
						candidateHold.startsWith("configuration:")
					) {
						candidateHold = `${admitted.retry}:${admitted.code}`;
					}
				}
				if (candidateHold) {
					heldWindows.add(window.id);
					sourceHold ??= candidateHold;
					journal.windows.suspend(claim, window);
					continue;
				}
				assertCurrent();
				journal.windows.complete(claim, window);
			}
		} catch (error) {
			if (signal.aborted) {
				// A deadline that retained new work resumes from it; one that retained nothing re-pays the same work, so it
				// counts toward the source's retry bound.
				if (signal.reason instanceof CollectionDeadline)
					hold(
						this.deps.store.work.retainedCount() > retainedAtClaim ? "time:deadline" : "time:stalled",
						this.deps.time.now() + RETRY_DELAY_MS,
					);
				throw error;
			}
			// A yield ends here, with no hold: the source is claimed again by the next pass.
			assertCurrent();
			// A paid attempt with an unknown outcome is never replayed: its work is keyed by model and engine, so only a
			// configuration change can give the source new work.
			const refusal = providerAdmissionRefusalOf(error);
			if (error instanceof KnowledgeWorkUnresolved) hold("configuration:unresolved_work");
			else if (isRequestSpendRefusal(error)) hold("configuration:spending");
			else if (error instanceof KnowledgeExtractionRefusal) hold(`configuration:${error.code}`);
			// A request refused at provider admission was never sent: the source waits for the time admission reopens,
			// without spending its retry bound, instead of trying again into the same refusal.
			else if (refusal) {
				logProviderLanePark("knowledge_collection", refusal);
				hold("provider:refused", refusal.retryAt);
			}
			// A failed request may be transient: it is tried again after a delay, within the retry bound.
			else hold("context:collection_failed", this.deps.time.now() + RETRY_DELAY_MS);
			return false;
		} finally {
			journal.release(claim);
		}
	}
}
