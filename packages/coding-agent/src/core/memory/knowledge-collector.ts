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
import type { LaneModelResolver } from "../research/lane-model-resolver.ts";
import type {
	AutoLearnSettings,
	AutonomySettings,
	ResolvedLearningPolicySettings,
} from "../settings/settings-schema.ts";
import { canonicalDigest } from "../steering/canonical.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { type KnowledgeAdmissionPort, type KnowledgeChange, parseKnowledgeChange } from "./knowledge-admission.ts";
import { type KnowledgeCollectionClaim, knowledgeCollectionSourceIdentity } from "./knowledge-collection-journal.ts";
import { extractKnowledgeCandidates, KnowledgeExtractionRefusal } from "./knowledge-extractor.ts";
import type { KnowledgeScope } from "./knowledge-record.ts";
import type { KnowledgeStore } from "./knowledge-store.ts";
import type { KnowledgeReadSource } from "./knowledge-tool.ts";

const EXTRACTOR_VERSION = "owner-knowledge-v1";
export const KNOWLEDGE_COLLECTION_OPERATION_PREFIX = "knowledge-collection:";
const MAX_SCANNED_PER_PASS = 128;
const PASS_DEADLINE_MS = 120_000;
const RETRY_DELAY_MS = 60_000;
/** Resumptions from a paying hold before a source waits for a configuration change. */
const MAX_SOURCE_RETRIES = 4;

class CollectionDeadline extends Error {}

interface CollectionProgress {
	sources: number;
	applied: number;
	rejected: number;
	held: number;
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
	onTerminal(outcome: KnowledgeCollectionOutcome, handoff?: KnowledgeCollectionHandoff): void;
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
}

interface Configuration {
	readonly key: string;
	readonly enabled: boolean;
	readonly reason?: KnowledgeCollectionInactiveReason;
	readonly model: Model<Api> | undefined;
	readonly engine: SemanticDecisionEngine | undefined;
	readonly settings: Required<AutoLearnSettings>;
}

/** No timer or listener survives stop; asynchronous tails retain accounting, never a closed store. */
export class KnowledgeCollector {
	private readonly deps: KnowledgeCollectorDeps;
	private active = false;
	private alarm: unknown;
	private running: Promise<void> | undefined;
	private abort: AbortController | undefined;
	private readonly subscriptions: Array<() => void> = [];
	private cursor: string | undefined;
	private revision = -1;
	private configurationKey = "";
	private rescan = true;
	private more = false;
	private retryAt: number | undefined;
	private pendingTerminal: KnowledgeCollectionOutcome | undefined;
	private lastTerminal: KnowledgeCollectionOutcome | undefined;
	private accountingDirty = false;
	private beganWithUnresolvedAccounting = false;

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
			this.deps.subscribeForegroundActivity(() => {
				if (this.deps.isForegroundBusy()) this.cancel();
				else this.schedule();
			}),
		);
		this.schedule();
	}

	stop(): Promise<void> {
		this.active = false;
		for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
		this.cancel();
		return (this.running ?? Promise.resolve()).then(() => {
			this.flushTerminal();
			if (this.pendingTerminal)
				throw new Error(`Knowledge collection handoff remains unretained: ${this.pendingTerminal.id}`);
		});
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
		};
	}

	private cancel(): void {
		if (this.alarm !== undefined) this.deps.time.clearTimeout(this.alarm);
		this.alarm = undefined;
		this.abort?.abort(new Error("Knowledge collection context changed"));
		this.rescan = true;
	}

	private invalidate(): void {
		this.cancel();
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
			this.deps.isForegroundBusy()
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
					if (!this.active || !this.deps.isCurrent() || this.deps.isForegroundBusy()) return;
					this.running = this.run(config).finally(() => {
						this.running = undefined;
						this.abort = undefined;
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
		this.abort = controller;
		const outcome = {
			id: `${KNOWLEDGE_COLLECTION_OPERATION_PREFIX}${randomUUID()}`,
			sources: 0,
			applied: 0,
			rejected: 0,
			held: 0,
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
			const assertCurrent = (): void => {
				controller.signal.throwIfAborted();
				if (
					!this.active ||
					!this.deps.isCurrent() ||
					this.deps.isForegroundBusy() ||
					guard() ||
					this.configuration().key !== config.key
				)
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
			if (outcome.held > 0) status = "held";
		} catch {
			status = controller.signal.aborted ? "cancelled" : "failed";
			if (status === "failed" || controller.signal.reason instanceof CollectionDeadline) {
				this.rescan = false;
				this.more = false;
				this.retryWhen(this.deps.time.now() + RETRY_DELAY_MS);
			}
		} finally {
			this.deps.time.clearTimeout(deadline);
			this.pendingTerminal = { ...outcome, status };
			this.flushTerminal();
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
			this.deps.onTerminal(this.pendingTerminal);
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
		return canonicalDigest({
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
		// configuration changes; configuration, accounting and deadline holds are not counted.
		const hold = (code: string, retryAt?: number): void => {
			const limited =
				claim.retries >= MAX_SOURCE_RETRIES &&
				!code.startsWith("configuration:") &&
				!code.startsWith("accounting:") &&
				!code.startsWith("time:");
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
			const budget = new RequestSpendBudget(remaining);
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
					const workId = canonicalDigest({
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
								maxTokens: Math.min(config.model!.maxTokens, 4_096),
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
							// An extraction that ended without a retained submission (failure, abort, owner typing) releases its
							// cell; the usage owner's unresolved spending refuses a retry until that request's charge is known.
							if (begun) this.deps.store.work.discard(workId);
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
					const operation = journal.operation(claim, plan, index);
					const admitted = await admission.change(candidate.change!, signal, operation);
					if (admitted.status === "applied") {
						journal.acknowledge(claim, operation, "applied");
						progress.applied++;
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
				if (signal.reason instanceof CollectionDeadline)
					hold("time:deadline", this.deps.time.now() + RETRY_DELAY_MS);
				throw error;
			}
			assertCurrent();
			if (isRequestSpendRefusal(error)) hold("configuration:spending");
			else if (error instanceof KnowledgeExtractionRefusal) hold(`configuration:${error.code}`);
			// A failed request may be transient: it is tried again after a delay, within the retry bound.
			else hold("context:collection_failed", this.deps.time.now() + RETRY_DELAY_MS);
			return false;
		} finally {
			journal.release(claim);
		}
	}
}
