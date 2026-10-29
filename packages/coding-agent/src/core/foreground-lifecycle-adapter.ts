import type { AssistantMessage, Message } from "@caupulican/pi-ai";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentMessageOrigin,
	CustomMessage,
	ProviderRequestSnapshotContext,
	ToolCallStartContext,
} from "../kernel/index.ts";
import {
	receiptMatchesMessageBatch,
	SessionAppendCommittedError,
	type SessionAppendIdentity,
	type SessionAppendReceipt,
	SessionAppendUncertainError,
	type SessionAppendWriteIdentity,
} from "../kernel/session/session-append-receipt.ts";
import type { SessionManager, SessionMessageBatchEntry } from "../kernel/session/session-manager.ts";
import { ForegroundLifecycleController, type ProviderRetryLifecycleEvent } from "./foreground-lifecycle-controller.ts";
import type { ModelRouterController } from "./model-router-controller.ts";
import { type ProviderLimitStore, providerLimitFromFailure } from "./provider-admission/limit-state.ts";
import { ProviderCompatibilityWarnings } from "./provider-compatibility-warnings.ts";
import { truncateWithEllipsis } from "./provider-tool-text.ts";
import { runReleaseSteps } from "./util/resource-release.ts";

/**
 * Host-side adapter for the foreground lifecycle boundary.
 *
 * The lifecycle controller owns request/tool repair semantics. This adapter owns the coding-agent
 * persistence wiring around it: atomic router batches, canonical message ids, and warnings emitted
 * before the first session subscriber exists.
 */
/** Most warnings held while no listener is attached. Past it the count is disclosed instead. */
const MAX_HELD_WARNINGS = 100;
/** Longest held warning; the same bound the host warning channel applies. */
const MAX_HELD_WARNING_CHARS = 500;

export class ForegroundLifecycleAdapter {
	private readonly agent: Agent;
	private readonly lifecycle: ForegroundLifecycleController;
	private readonly sessionManager: SessionManager;
	private readonly providerLimitStore: ProviderLimitStore | undefined;
	private readonly observeMessagePersisted:
		| ((message: Message, entryId: string, publication: SessionAppendIdentity) => void)
		| undefined;
	private readonly observeMessageUncertain:
		| ((message: Message, entryId: string, publication: SessionAppendWriteIdentity) => void)
		| undefined;
	private readonly liveWarningSink: (() => ((message: string) => void) | undefined) | undefined;
	private pendingWarnings: string[] = [];
	private pendingWarningsDropped = 0;
	private readonly compatibilityWarnings = new ProviderCompatibilityWarnings();

	/**
	 * `getMutationScope` names the session whose group lock these emission-order announcements order
	 * (see tools/file-mutation-queue.ts). Omitted keeps the process-wide default scope.
	 * `observeMessagePersisted` sees every message this adapter persists, single or batched, with
	 * the entry id it received (owner-evidence bookkeeping hangs off it). `liveWarningSink`
	 * returns the session's warning emitter while a subscriber exists, else undefined: `warn`
	 * delivers through it or holds the message with the startup warnings for the first subscriber.
	 */
	constructor(
		agent: Agent,
		sessionManager: SessionManager,
		modelRouter: ModelRouterController,
		getMutationScope?: () => string,
		getAnnouncer?: () => string,
		providerLimitStore?: ProviderLimitStore,
		observeMessagePersisted?: (message: Message, entryId: string, publication: SessionAppendIdentity) => void,
		liveWarningSink?: () => ((message: string) => void) | undefined,
		observeProviderRequest?: (context: ProviderRequestSnapshotContext) => void,
		prewarmToolCalls?: (calls: readonly ToolCallStartContext[], signal?: AbortSignal) => void,
		observeMessageUncertain?: (message: Message, entryId: string, publication: SessionAppendWriteIdentity) => void,
	) {
		this.agent = agent;
		this.sessionManager = sessionManager;
		this.providerLimitStore = providerLimitStore;
		this.observeMessagePersisted = observeMessagePersisted;
		this.observeMessageUncertain = observeMessageUncertain;
		this.liveWarningSink = liveWarningSink;
		this.lifecycle = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter,
			emitWarning: (message) => this.warn(message),
			observeProviderRequest,
			...(prewarmToolCalls ? { prewarmToolCalls } : {}),
			...(getMutationScope ? { getMutationScope } : {}),
			...(getAnnouncer ? { getAnnouncer } : {}),
		});
	}

	install(): void {
		this.lifecycle.install();
	}

	start(): void {
		this.install();
		this.repair();
	}

	reload(): void {
		this.resetForSessionReload();
		this.repair();
	}

	repair(): void {
		this.lifecycle.repair();
	}

	resetForSessionReload(): void {
		this.lifecycle.resetForSessionReload();
	}

	commitRoutedPromptPrefix(): void {
		this.lifecycle.commitRoutedPromptPrefix();
	}

	getPersistedMessageEntryId(message: AgentMessage): string | undefined {
		return this.lifecycle.getPersistedMessageEntryId(message);
	}

	appendMessage(message: Message, origin?: AgentMessageOrigin): string {
		return this.appendMessageBatch([{ kind: "message", message, ...(origin === undefined ? {} : { origin }) }])[0]!;
	}

	/** Custom inputs share the canonical append owner, whether committed by a run or by the host. */
	appendCustomMessage(message: CustomMessage<unknown>): string {
		return this.appendMessageBatch([{ kind: "custom", message }])[0]!;
	}

	/** Commit a host turn through normal extension events, accepting only its exact durable receipt. */
	async commitCustomPrompt(
		message: CustomMessage<unknown>,
		emit: (event: Extract<AgentEvent, { type: "message_start" | "message_end" }>) => Promise<void>,
		assertCurrent: () => void,
	): Promise<void> {
		assertCurrent();
		await emit({ type: "message_start", message });
		assertCurrent();
		this.agent.appendMessage(message);
		try {
			await emit({ type: "message_end", message });
			if (!this.getPersistedMessageEntryId(message)) throw new Error("Custom-message input was not persisted.");
		} catch (error) {
			if (this.getPersistedMessageEntryId(message)) {
				this.warn(`Custom-message input was persisted, but its event failed: ${String(error)}`);
				return;
			}
			this.agent.removeMessage(message);
			throw error;
		}
	}

	recordTransportTelemetry(message: AssistantMessage): void {
		this.lifecycle.recordTransportTelemetry(message);
		const warning = this.compatibilityWarnings.read(message);
		if (warning) this.warn(warning);
	}

	/**
	 * Persist the retry event and, for a rate limit or overload, publish the retry controller's
	 * delay machine-wide: it is the exact wait the provider or the backoff dictated, so sibling
	 * processes stop sending to the same account until it passes.
	 */
	recordRetryEvent(event: ProviderRetryLifecycleEvent): void {
		const model = this.lifecycle.recordRetryEvent(event);
		if (event.type !== "auto_retry_start" || !model || !this.providerLimitStore) return;
		const now = Date.now();
		const limit = providerLimitFromFailure(model.provider, event.errorMessage, now, event.delayMs);
		if (!limit) return;
		try {
			this.providerLimitStore.record(model.accountKey, limit);
		} catch {
			// Shared-state bookkeeping must never fail the retry it observes.
		}
	}

	appendMessageBatch(
		batch: readonly SessionMessageBatchEntry[],
		attempt = Symbol("foreground session append"),
	): string[] {
		if (batch.length === 0) return [];
		const assertCurrent = this.sessionManager.captureBranchContext();
		const submitted = batch.map((item) => Object.freeze({ ...item }));
		assertCurrent();
		const publication: { receipt?: SessionAppendReceipt } = {};
		let failure: { error: unknown } | undefined;
		try {
			this.sessionManager.appendMessageBatch(
				submitted,
				(receipt) => {
					publication.receipt = receipt;
				},
				attempt,
			);
		} catch (error) {
			if (error instanceof SessionAppendCommittedError && error.receipt.attempt === attempt)
				publication.receipt = error.receipt;
			if (!publication.receipt) {
				if (
					error instanceof SessionAppendUncertainError &&
					receiptMatchesMessageBatch(error.identity, submitted, attempt)
				) {
					try {
						runReleaseSteps(
							submitted.flatMap((item, index) =>
								item.kind === "message"
									? [
											() =>
												this.observeMessageUncertain?.(
													item.message,
													error.identity.entries[index]!.id,
													error.identity,
												),
										]
									: [],
							),
							"Uncertain input notifications failed.",
							{ error },
						);
					} catch (notificationError) {
						throw new SessionAppendUncertainError(error.identity, notificationError);
					}
				}
				throw error;
			}
			failure = { error };
		}
		const receipt = publication.receipt;
		if (!receipt || !receiptMatchesMessageBatch(receipt, submitted, attempt))
			throw new Error("Session append did not return its exact publication receipt.", { cause: failure?.error });
		// The rows are canonical now. A failing lifecycle effect cannot suppress another row's delivery,
		// and the caller receives the same receipt even when one or more effects fail.
		const steps = submitted.flatMap((item, index) => {
			if (item.kind !== "message") return [];
			const entryId = receipt.entries[index]!.id;
			return [
				() => {
					assertCurrent();
					this.lifecycle.onMessagePersisted(item.message, entryId, item.origin);
				},
				() => {
					assertCurrent();
					this.observeMessagePersisted?.(item.message, entryId, receipt);
				},
			];
		});
		try {
			runReleaseSteps([assertCurrent, ...steps], "Session publication notifications failed.", failure);
		} catch (error) {
			throw new SessionAppendCommittedError(receipt, error);
		}
		if (failure) throw new SessionAppendCommittedError(receipt, failure.error);
		return receipt.entries.map((entry) => entry.id);
	}

	/**
	 * Deliver a warning now through `deliver`, or hold it with the startup warnings when the session
	 * has no subscriber yet (`deliver` undefined): the first `subscribe` flushes it. One owner for
	 * "warned before anyone listened", shared by the lifecycle repair and the memory subsystem.
	 */
	emitWarning(message: string, deliver: ((message: string) => void) | undefined): void {
		// One bound for both routes: a warning is cut (with its elision mark) whether it is delivered live or held.
		if (deliver) deliver(truncateWithEllipsis(message, MAX_HELD_WARNING_CHARS));
		else this.hold(message);
	}

	/**
	 * The one bounded queue of warnings raised while nobody listens (the lifecycle, memory, background lanes, workers, custom
	 * messages all hold here): each message is cut at {@link MAX_HELD_WARNING_CHARS}, at most {@link MAX_HELD_WARNINGS} are kept,
	 * and what is dropped past that is reported as a count by {@link drainWarnings}.
	 */
	hold(message: string): void {
		if (this.pendingWarnings.length >= MAX_HELD_WARNINGS) {
			this.pendingWarningsDropped += 1;
			return;
		}
		// A cut warning says so (elision mark, never a split surrogate pair), within the same bound.
		this.pendingWarnings.push(truncateWithEllipsis(message, MAX_HELD_WARNING_CHARS));
	}

	/**
	 * Warn through the live session sink, or hold the message when nobody listens yet: memory
	 * initializes before an SDK caller can subscribe, and its notices must reach the first subscriber.
	 */
	warn(message: string): void {
		this.emitWarning(message, this.liveWarningSink?.());
	}

	drainWarnings(): string[] {
		const warnings = this.pendingWarnings;
		this.pendingWarnings = [];
		if (this.pendingWarningsDropped > 0) {
			warnings.push(
				`${this.pendingWarningsDropped} warning(s) raised while no listener was attached were not held.`,
			);
			this.pendingWarningsDropped = 0;
		}
		return warnings;
	}

	emitPendingWarnings(emit: (message: string) => void): void {
		for (const warning of this.drainWarnings()) emit(warning);
	}
}
