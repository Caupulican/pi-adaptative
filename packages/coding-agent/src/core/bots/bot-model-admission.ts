/**
 * Whether a bot's own model may run now, by the worker admission's rules for an explicitly requested model, read from the
 * facts of the process hosting the bot: a root session's (its foreground model, its model access, its subscription
 * allowance reading and its conversation's model policy) or the bot daemon's (the owner's default model, its own account
 * listing and allowance reading, and no conversation's policy). One rule for both hosts; only the facts differ.
 */

import { join } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { ExhaustedProviderRegistry } from "../billing-failover-controller.ts";
import type { PersistentBotRecord } from "../delegation/persistent-bot-team-store.ts";
import { meteredModelRefusalFacts } from "../delegation/worker-authority-resolver.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { OrchestrationModelUnusableCause } from "../orchestration/model-binding.ts";
import { providerAdmissionDir } from "../provider-admission/ledger.ts";
import {
	allowanceExhaustion,
	heldModelExhaustion,
	type SubscriptionAllowancePort,
} from "../provider-admission/subscription-allowance.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { TimerSource } from "../util/timer-port.ts";
import type { BotModelRefusal } from "./bot-model-refusal.ts";

/** What the rules read of the process hosting the bot. */
export interface BotModelFacts {
	agentDir(): string;
	timers(): TimerSource;
	modelRegistry(): ModelRegistry;
	/** The model the owner works on in this process (a root's foreground model): its provider is the owner's choice. */
	foregroundModel(): Model<Api> | undefined;
	accountRouting(): ReturnType<SettingsManager["getWorkerAccountRouting"]>;
	/** Why the model cannot take work now (its quota is exhausted, the account does not offer it); undefined when it can. */
	modelUnusableCause(model: Model<Api>): OrchestrationModelUnusableCause | undefined;
	/** The process's reading of the usage a model's subscription account reports. */
	allowance(): SubscriptionAllowancePort;
	/** The owner's model policy for this process; absent allows every model. */
	isModelAllowed?(model: Model<Api>): boolean;
}

/**
 * The quota exhaustions every process shares (`state/provider-admission/exhausted/`), on the provider admission clock: an
 * exhaustion with a reset time is recorded there (one with none lasts for the process that met it).
 */
export function sharedExhaustions(agentDir: string, timers: TimerSource): ExhaustedProviderRegistry {
	const clock = timers.port("provider-admission");
	return new ExhaustedProviderRegistry(join(providerAdmissionDir(agentDir), "exhausted"), () => clock.now());
}

/**
 * Why the worker admission refuses the bot's own model now, in the owner's words, with when the refusal ends when that is
 * known (a quota exhaustion's recorded reset, or the reset of its subscription's used-up usage windows); undefined when
 * it may run.
 */
export function botModelRefusal(
	facts: BotModelFacts,
	record: PersistentBotRecord,
	model: Model<Api>,
): BotModelRefusal | undefined {
	const metered = meteredModelRefusalFacts({
		authority: {
			model: { provider: record.provider, modelId: record.modelId },
			// The owner's own choice of this bot's model is honoured as given; a root's or a leader's is held to the subscription rule.
			...(record.createdBy === "owner" ? { modelChosenBy: "owner" as const } : {}),
		},
		modelRegistry: facts.modelRegistry(),
		foregroundModel: facts.foregroundModel(),
		accountRouting: facts.accountRouting(),
		modelUnusableCause: (candidate) => facts.modelUnusableCause(candidate),
		...(facts.isModelAllowed ? { isModelAllowed: (candidate) => facts.isModelAllowed?.(candidate) === true } : {}),
	});
	if (metered)
		return {
			cause: "model_metered",
			words: (text) => text.botTeam.botModelMetered(metered.ref, metered.alternatives, metered.provider),
		};
	// Out of quota (a recorded refusal, or the used-up usage windows of its subscription) or refused for the account: the
	// bot waits for its own model, never moved to another, until the exhaustion that holds longer resets.
	const spent = allowanceExhaustion(facts.allowance(), model);
	const unusable = facts.modelUnusableCause(model) ?? (spent ? "model_quota_exhausted" : undefined);
	if (unusable) {
		const recorded = () =>
			sharedExhaustions(facts.agentDir(), facts.timers()).exhaustion(`${model.provider}/${model.id}`);
		const clearsAt = unusable === "model_quota_exhausted" ? heldModelExhaustion(recorded(), spent)?.until : undefined;
		return {
			cause: unusable,
			words: (text) => text.botTeam.botModelUnusable(`${model.provider}/${model.id}`, unusable),
			...(clearsAt !== undefined ? { clearsAt } : {}),
		};
	}
	return facts.isModelAllowed && !facts.isModelAllowed(model)
		? {
				cause: "model_not_allowed",
				words: (text) => text.botTeam.botModelNotAllowed(`${model.provider}/${model.id}`),
			}
		: undefined;
}
