import type { Agent } from "@caupulican/pi-agent-core";
import type { SessionManager, SessionMessageBatchEntry } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage, Message } from "@caupulican/pi-ai";
import { ForegroundLifecycleController, type ProviderRetryLifecycleEvent } from "./foreground-lifecycle-controller.ts";
import type { ModelRouterController } from "./model-router-controller.ts";
import { type ProviderLimitStore, providerLimitFromFailure } from "./provider-admission/limit-state.ts";

/**
 * Host-side adapter for the foreground lifecycle boundary.
 *
 * The lifecycle controller owns request/tool repair semantics. This adapter owns the coding-agent
 * persistence wiring around it: atomic router batches, canonical message ids, and warnings emitted
 * before the first session subscriber exists.
 */
export class ForegroundLifecycleAdapter {
	private readonly lifecycle: ForegroundLifecycleController;
	private readonly sessionManager: SessionManager;
	private readonly providerLimitStore: ProviderLimitStore | undefined;
	private pendingWarnings: string[] = [];

	/**
	 * `getMutationScope` names the session whose group lock these emission-order announcements order
	 * (see tools/file-mutation-queue.ts). Omitted keeps the process-wide default scope.
	 */
	constructor(
		agent: Agent,
		sessionManager: SessionManager,
		modelRouter: ModelRouterController,
		getMutationScope?: () => string,
		getAnnouncer?: () => string,
		providerLimitStore?: ProviderLimitStore,
	) {
		this.sessionManager = sessionManager;
		this.providerLimitStore = providerLimitStore;
		this.lifecycle = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter,
			emitWarning: (message) => this.pendingWarnings.push(message),
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

	appendMessage(message: Message): string {
		const entryId = this.sessionManager.appendMessage(message);
		this.lifecycle.onMessagePersisted(message, entryId);
		return entryId;
	}

	recordTransportTelemetry(message: AssistantMessage): void {
		this.lifecycle.recordTransportTelemetry(message);
	}

	/**
	 * Persist the retry event and, for a rate limit or overload, publish the retry controller's
	 * delay machine-wide: it is the exact wait the provider or the backoff dictated, so sibling
	 * processes stop sending to the same account until it passes.
	 */
	recordRetryEvent(event: ProviderRetryLifecycleEvent, model?: { provider: string; id: string }): void {
		this.lifecycle.recordRetryEvent(event, model);
		if (event.type !== "auto_retry_start" || !model || !this.providerLimitStore) return;
		const now = Date.now();
		const limit = providerLimitFromFailure(model.provider, event.errorMessage, now, event.delayMs);
		if (!limit) return;
		try {
			this.providerLimitStore.record(model.provider, limit);
		} catch {
			// Shared-state bookkeeping must never fail the retry it observes.
		}
	}

	appendMessageBatch(batch: readonly SessionMessageBatchEntry[]): string[] {
		const entryIds = this.sessionManager.appendMessageBatch(batch);
		for (let index = 0; index < batch.length; index += 1) {
			const item = batch[index]!;
			if (item.kind === "message") this.lifecycle.onMessagePersisted(item.message, entryIds[index]!);
		}
		return entryIds;
	}

	drainWarnings(): string[] {
		const warnings = this.pendingWarnings;
		this.pendingWarnings = [];
		return warnings;
	}

	emitPendingWarnings(emit: (message: string) => void): void {
		for (const warning of this.drainWarnings()) emit(warning);
	}
}
