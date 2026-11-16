/**
 * Model access for the session coordinator: a model the owner's account refuses or does not offer is replaced
 * for the session or for the routed turn it refused, the request auth a provider call needs is resolved here, and
 * the conversation's talker (the model the owner's messages run on) is adopted, moved and recorded here too.
 */

import type { Api, AssistantMessage, Model } from "@caupulican/pi-ai";
import type { Agent } from "../kernel/agent.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { ThinkingLevel } from "../kernel/types.ts";
import type { AgentSessionEvent } from "./agent-session-contracts.ts";
import { formatNoApiKeyFoundMessage } from "./auth-guidance.ts";
import type { RouteDecision } from "./autonomy/contracts.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import type { ForegroundRecoveryController } from "./foreground-recovery-controller.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { AccountModelCatalog } from "./model-router/account-models.ts";
import { formatModelRouterModel, type ModelRouterController } from "./model-router-controller.ts";
import type { ModelSelectionController } from "./model-selection-controller.ts";
import type { OrchestrationModelUnusableCause } from "./orchestration/model-binding.ts";
import { isMeteredSpend } from "./orchestration/risk-budget.ts";
import { CONVERSATION_TALKER_CUSTOM_TYPE, type ConversationTalkerRecord } from "./reply-route.ts";
import type { RequestAuth } from "./request-auth.ts";

export interface AgentSessionModelAccessPorts {
	foregroundRecovery(): ForegroundRecoveryController;
	accountModels(): AccountModelCatalog;
	modelRegistry(): ModelRegistry;
	modelRouter(): ModelRouterController;
	modelSelection(): ModelSelectionController;
	sessionManager(): SessionManager;
	agent(): Agent;
	model(): Model<Api> | undefined;
	emit(event: AgentSessionEvent): void;
	switchSessionModel(model: Model<Api>, options: { persistSettings?: boolean }): Promise<void>;
	extensionRunner(): ExtensionRunner;
}

/**
 * How a move to a metered model is reserved: `admit` only while the host's bound has room (false: nothing is reserved and
 * the work does not move); `charge` for a move made whatever the gate says (an explicit model choice), reserved whether
 * or not the bound has room (false: the reservation was not written).
 */
export type MeteredMoveMode = "admit" | "charge";

/**
 * What a host holds a session's moves to metered (API) models to (the daemon's channel host: a subscription turn away
 * reserves nothing on the away day bound until it moves to a metered model). Consulted only for a metered target.
 */
export interface MeteredMoveGate {
	/** Whether the work may move to a metered model now: its move is reserved already, or the host's bound has room. */
	fits(): boolean;
	/** Reserves the move before the metered model's first request (`MeteredMoveMode`; `admit` when absent). */
	reserve(mode?: MeteredMoveMode): boolean;
}

export class AgentSessionModelAccess {
	private readonly ports: AgentSessionModelAccessPorts;
	/** The session never leaves its model (`pinnedModel`): an unusable model is its host's to refuse, never replaced. */
	pinned = false;
	/** The hosts' holds on moves to metered models (`MeteredMoveGate`); none: they are not held. */
	private readonly meteredMoves = new Set<MeteredMoveGate>();

	constructor(ports: AgentSessionModelAccessPorts) {
		this.ports = ports;
	}

	/** Why a model cannot take work now: its quota is exhausted, or the owner's account does not offer it. */
	unusableCause(model: Model<Api>): OrchestrationModelUnusableCause | undefined {
		if (this.ports.foregroundRecovery().isModelExhausted(`${model.provider}/${model.id}`))
			return "model_quota_exhausted";
		return this.ports.accountModels().unavailableCause(model);
	}

	isUnusable(model: Model<Api>): boolean {
		return this.unusableCause(model) !== undefined;
	}

	/**
	 * A provider refused the model for the owner's account: it is never routed to again this session,
	 * and the turn moves to the model that replaces it. Returns the replacement's ref, or undefined.
	 */
	async replaceUnsupportedModel(message: AssistantMessage): Promise<string | undefined> {
		const refused = this.ports.modelRegistry().find(message.provider, message.model) ?? this.ports.model();
		if (!refused) return undefined;
		this.ports.accountModels().markRefused(refused, message.errorMessage ?? "model not supported");
		if (this.pinned) return undefined;
		const from = `${refused.provider}/${refused.id}`;
		// A routed turn's model is the turn's, never the session's: its replacement stays inside the
		// routed turn, whose end restores the owner's model; the session model is never changed from here.
		if (this.ports.modelRouter().isRoutedTurnOn(refused)) {
			const routed = this.ports
				.modelRouter()
				.replaceRefusedRoutedModel(refused, this.ports.accountModels().accountDefault(refused.provider));
			if (!routed) {
				this.ports.emit({
					type: "warning",
					message: `${from} is not available on this account, and no usable model can take this routed turn over.`,
				});
				return undefined;
			}
			const to = `${routed.provider}/${routed.id}`;
			this.ports.emit({
				type: "warning",
				message: `${from} is not available on this account; this turn continues on ${to}.`,
			});
			return to;
		}
		return this.leaveUnavailableSessionModel();
	}

	/**
	 * The session's model is not offered to the owner's account: this session moves to the provider's own
	 * default for the account (the owner's saved default is left alone), with a warning naming both. Returns
	 * the replacement's ref, or undefined when there is nothing to leave or nothing to move to.
	 */
	async leaveUnavailableSessionModel(): Promise<string | undefined> {
		const current = this.ports.model();
		if (this.pinned) return undefined;
		if (!current || this.ports.accountModels().availability(current) !== "unavailable") return undefined;
		const from = `${current.provider}/${current.id}`;
		const why = this.ports.accountModels().unavailableReason(current) ?? "unavailable";
		const replacement = this.ports.accountModels().accountDefault(current.provider);
		if (!replacement) {
			// Only a fetched listing can say the account offers nothing else: without one, no alternative could be chosen at all.
			this.ports.emit({
				type: "warning",
				message: this.ports.accountModels().hasListing(current.provider)
					? `${from} is not available on this account (${why}), and the account offers no other ${current.provider} model pi knows.`
					: `${from} is not available on this account (${why}), and no ${current.provider} account model listing is available to choose a replacement from.`,
			});
			return undefined;
		}
		await this.ports.switchSessionModel(replacement, { persistSettings: false });
		this.moveTalker(replacement, `${from} unavailable on this account`);
		const to = `${replacement.provider}/${replacement.id}`;
		this.ports.emit({
			type: "warning",
			message: `${from} is not available on this account (${why}); this session continues on ${to}.`,
		});
		return to;
	}

	async getRequiredRequestAuth(model: Model<Api>): Promise<RequestAuth> {
		const result = await this.ports.modelRegistry().getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (this.ports.modelRegistry().canUseResolvedRequestAuth(model, result)) {
			const headers: Record<string, string> = { ...result.headers };
			await this.ports.extensionRunner().emitBeforeProviderHeaders({
				provider: model.provider,
				model: model.id,
				headers,
			});
			return {
				...result,
				headers,
			};
		}

		const isOAuth = this.ports.modelRegistry().isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	/**
	 * Router-swap gate (#27): a turn routed to a local model must not dead-end the turn just because
	 * ollama isn't up. Delegates to {@link LocalRuntimeController}; see there for the full
	 * consent-then-escalate contract (which includes the local-model readiness check itself).
	 */
	/**
	 * The opening's route becomes the conversation's talker: the session model (a recorded model change,
	 * so later turns and a resume run on it with no swap) at the judged thinking level, with the reason
	 * recorded as the conversation route.
	 */
	async adoptTalker(model: Model<Api>, decision: RouteDecision): Promise<void> {
		const current = this.ports.model();
		if (!current || current.provider !== model.provider || current.id !== model.id) {
			// A held move to a metered talker leaves the conversation on the session model, its route not adopted.
			if (!this.admitMove(model)) return;
			await this.ports.modelSelection().setModel(model, { persistSettings: false });
		}
		if (decision.thinkingLevel) {
			this.ports
				.modelSelection()
				.setThinkingLevel(decision.thinkingLevel as ThinkingLevel, { persistSettings: false });
		}
		this.recordTalker(model, decision.reasons);
		this.ports.modelRouter().recordOpeningRoute(decision, model);
	}

	/**
	 * Holds the work's moves to metered models to `gate` too, until the returned release (each host holds its own: the
	 * daemon's away bound, an owner channel's pool). A routed turn's swaps are admitted here as well (`admitMove`).
	 */
	holdMeteredMoves(gate: MeteredMoveGate): () => void {
		this.meteredMoves.add(gate);
		this.ports.modelRouter().admitMoves((model) => this.admitMove(model));
		return () => {
			this.meteredMoves.delete(gate);
		};
	}

	/** Whether a move of the work to `model` is held: it is metered and a host's gate has no room for it now. */
	private moveHeld(model: Model<Api>): boolean {
		return isMeteredSpend(model, this.ports.modelRegistry()) && [...this.meteredMoves].some((gate) => !gate.fits());
	}

	/**
	 * Admits a move of the work to `model` before its first request: a metered one is reserved on each host's gate
	 * (`MeteredMoveGate.reserve`), and one a gate refuses does not move (a gate that reserved before keeps it, the
	 * stricter reading). Every automatic move to another model passes here: a failover, an opening's talker, a routed
	 * turn's swap; a chosen one is charged instead (`chargeMove`).
	 */
	admitMove(model: Model<Api>): boolean {
		if (!isMeteredSpend(model, this.ports.modelRegistry())) return true;
		for (const gate of this.meteredMoves) if (!gate.reserve()) return false;
		return true;
	}

	/**
	 * A move of the session to `model` that is never refused (an explicit choice: `/model`, a cycle, an extension's
	 * `setModel`; an account that no longer offers the model): a metered one is charged on each host's gate, reserved
	 * while its bound has room and charged past it otherwise (`MeteredMoveGate.reserve("charge")`).
	 */
	chargeMove(model: Model<Api>): void {
		if (!isMeteredSpend(model, this.ports.modelRegistry())) return;
		for (const gate of this.meteredMoves) gate.reserve("charge");
	}

	/** Where work goes when `failed` ran out of quota (`resolveQuotaFallbackModel`): never a model whose move is held. */
	quotaFallback(failed: Model<Api>, contextTokens: number): Model<Api> | undefined {
		return this.ports.modelRouter().resolveQuotaFallbackModel(failed, {
			hasImages: false,
			contextTokens,
			admits: (model) => !this.moveHeld(model),
		});
	}

	/**
	 * A quota failover moves the session to `hop`: a routed turn's model stays inside that turn (as an unsupported model's
	 * does; the router admits the model it picks), and a pinned session stays on its model. A move to a metered model is
	 * admitted first (`admitMove`); one a gate refuses leaves the work where it is. Returns where the work continues.
	 */
	applyFailoverModel(failed: Model<Api>, hop: Model<Api>): Model<Api> | undefined {
		if (this.pinned) return undefined;
		if (this.ports.modelRouter().isRoutedTurnOn(failed))
			return this.ports.modelRouter().replaceRefusedRoutedModel(failed, hop);
		if (!this.admitMove(hop)) return undefined;
		this.ports.agent().state.model = hop;
		this.ports.sessionManager().appendModelChange(hop.provider, hop.id);
		this.moveTalker(hop, `${failed.provider}/${failed.id} out of quota`);
		return hop;
	}

	/**
	 * A hard failure (quota, an account that no longer offers the model) carries a chosen talker to the
	 * model the session moved to; before the opening there is no talker to carry.
	 */
	moveTalker(model: Model<Api>, reason: string): void {
		if (this.ports.sessionManager().getLatestCustomEntryOnBranch(CONVERSATION_TALKER_CUSTOM_TYPE) === undefined)
			return;
		this.recordTalker(model, [reason]);
	}

	/** The conversation's talker from now on: later owner messages run on it with no route judged. */
	recordTalker(model: Model<Api>, reasons: readonly string[]): void {
		const record: ConversationTalkerRecord = {
			model: formatModelRouterModel(model),
			thinkingLevel: this.ports.agent().state.thinkingLevel,
			reasons: [...reasons],
			decidedAt: Date.now(),
		};
		this.ports.sessionManager().appendCustomEntry(CONVERSATION_TALKER_CUSTOM_TYPE, record);
	}
}
