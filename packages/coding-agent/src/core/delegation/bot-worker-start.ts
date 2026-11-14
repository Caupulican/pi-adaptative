/**
 * A bot's start as the worker admission takes it, whatever then runs the bot: its model stance, soul, profile and
 * authority (`botWorkerStart`), for a worker started for it and for the session a bot made from a profile is compiled to
 * by the same admission (`BotSessionCompilation`).
 */

import type { OrchestrationProfile } from "../orchestration/contracts.ts";
import { isOrchestrationThinkingLevel } from "../orchestration/thinking-level-guard.ts";
import { botStartModelStance, type WorkerModelPinPolicy } from "../orchestration/worker-model-pins.ts";
import type { PersistentBotRecord } from "./persistent-bot-team-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import type { ResolvedWorkerProfile } from "./worker-profile-resolver.ts";

export function botWorkerStart(
	policy: WorkerModelPinPolicy,
	bot: Pick<
		PersistentBotRecord,
		"leader" | "profileId" | "soul" | "provider" | "modelId" | "createdBy" | "canWrite" | "thinkingLevel"
	>,
): Pick<WorkerDelegationRequest, "leaderRuntime" | "modelFromBotRecord" | "botSoul" | "profileId" | "authority"> {
	const stance = botStartModelStance(policy, bot);
	return {
		...stance.flags,
		// The soul is admitted into the worker's contract, so every turn of this worker generation carries it.
		...(bot.soul ? { botSoul: bot.soul } : {}),
		...(bot.profileId ? { profileId: bot.profileId } : {}),
		authority: {
			...(stance.ownModel ? { model: { provider: bot.provider, modelId: bot.modelId } } : {}),
			// The owner's own choice of this bot's model is honoured as given; a root's or a leader's is held to the subscription rule.
			...(bot.createdBy === "owner" ? { modelChosenBy: "owner" as const } : {}),
			// A chat bot answers in plain text, which only a read-only worker may do; a write-capable one reports in the claim envelope.
			readOnly: bot.canWrite !== true,
			...(stance.ownModel && isOrchestrationThinkingLevel(bot.thinkingLevel)
				? { thinkingLevel: bot.thinkingLevel }
				: {}),
		},
	};
}

/** What the worker admission compiles a bot made from a profile to, for a session of its own; or why it refused. */
export type BotSessionCompilation =
	| { readonly ok: false; readonly skipReason: string }
	| {
			readonly ok: true;
			/** The profile as its owner wrote it: the tools it names, and whether each claim needs an independent verifier. */
			readonly profile: OrchestrationProfile;
			/** The admitted worker: model and binding, compiled profile, soul (the bot's with the profile's). */
			readonly shipment: ResolvedWorkerProfile;
			/** What it may do: tools, read and write roots, read-only grant and budget. */
			readonly plan: WorkerExecutionPlan;
			/** The profile's resources as a worker's system prompt carries them; empty when it has none. */
			readonly resourceSystemPrompt: string;
	  };
