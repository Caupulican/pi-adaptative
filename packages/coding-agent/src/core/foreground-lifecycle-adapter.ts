import type { Agent } from "@caupulican/pi-agent-core";
import type { SessionManager, SessionMessageBatchEntry } from "@caupulican/pi-agent-core/session";
import type { Message } from "@caupulican/pi-ai";
import { ForegroundLifecycleController } from "./foreground-lifecycle-controller.ts";
import type { ModelRouterController } from "./model-router-controller.ts";

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
	private pendingWarnings: string[] = [];

	constructor(agent: Agent, sessionManager: SessionManager, modelRouter: ModelRouterController) {
		this.sessionManager = sessionManager;
		this.lifecycle = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter,
			emitWarning: (message) => this.pendingWarnings.push(message),
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
