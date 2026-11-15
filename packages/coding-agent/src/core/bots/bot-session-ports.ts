/**
 * What a bot's session reads from the main session: its settings manager (the bot's follows the same storage), its System One as it is now (on or off, provider, transport), and, as the
 * worker admission reads them, the model rules for an explicitly requested model (one predicate,
 * `worker-authority-resolver`), a profile compiled by the resolution a fresh worker of it takes (`compileBotSession`), the spend bound a worker's budget carries, and the cost view the main session keeps for
 * spawned work. Composed here so the lane controller only hands over its
 * dependencies, and attaches to its process's bot session host with them (`attachBotSessions`).
 */

import { join } from "node:path";
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import { ExhaustedProviderRegistry } from "../billing-failover-controller.ts";
import { classifyCustomEntryPersisted, deliverSpawnedUsageReceipt } from "../cost/spawned-usage-receipt.ts";
import { BOT_SESSION_USAGE_LABEL, SPAWNED_USAGE_CUSTOM_TYPE } from "../cost/usage-records.ts";
import { botWorkerStart } from "../delegation/bot-worker-start.ts";
import type { PersistentBotRecord } from "../delegation/persistent-bot-team-store.ts";
import { meteredModelRefusalFacts } from "../delegation/worker-authority-resolver.ts";
import type { WorkerDelegationController } from "../delegation/worker-delegation-controller.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelExhaustion } from "../provider-admission/gate.ts";
import { providerAdmissionDir } from "../provider-admission/ledger.ts";
import {
	allowanceExhaustion,
	heldModelExhaustion,
	type SubscriptionAllowancePort,
} from "../provider-admission/subscription-allowance.ts";
import { usageScope } from "../session-analytics.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { BotModelRefusal } from "./bot-model-refusal.ts";
import { attachBotSessionHost, type BotSessionAttachment, type BotSessionRootPorts } from "./bot-session-registry.ts";
import type { BotSpendCeiling } from "./bot-session-turns.ts";

/**
 * The quota exhaustions every process shares (`state/provider-admission/exhausted/`), on the provider admission clock: an
 * exhaustion with a reset time is recorded there (one with none lasts for the process that met it).
 */
function sharedExhaustions(deps: BackgroundLaneControllerDeps): ExhaustedProviderRegistry {
	const clock = deps.getTimers().port("provider-admission");
	return new ExhaustedProviderRegistry(join(providerAdmissionDir(deps.getAgentDir()), "exhausted"), () => clock.now());
}

/** The quota exhaustion recorded with a reset time for `model`; undefined when none is. */
function recordedExhaustion(
	deps: BackgroundLaneControllerDeps,
	model: { provider: string; id: string },
): ModelExhaustion | undefined {
	return sharedExhaustions(deps).exhaustion(`${model.provider}/${model.id}`);
}

/**
 * Why the worker admission refuses the bot's own model now, in the owner's words, with when the refusal ends when that is
 * known (a quota exhaustion's recorded reset); undefined when it may run.
 */
function botModelRefusal(
	deps: BackgroundLaneControllerDeps,
	allowance: SubscriptionAllowancePort,
	record: PersistentBotRecord,
	model: Parameters<BotSessionRootPorts["modelRefusal"]>[1],
): BotModelRefusal | undefined {
	const words = interfaceText().botTeam;
	const metered = meteredModelRefusalFacts({
		authority: {
			model: { provider: record.provider, modelId: record.modelId },
			// The owner's own choice of this bot's model is honoured as given; a root's or a leader's is held to the subscription rule.
			...(record.createdBy === "owner" ? { modelChosenBy: "owner" as const } : {}),
		},
		modelRegistry: deps.getModelRegistry(),
		foregroundModel: deps.getModel(),
		accountRouting: deps.getSettingsManager().getWorkerAccountRouting(),
		modelUnusableCause: (candidate) => deps.modelUnusableCause(candidate),
		...(deps.isModelAllowed ? { isModelAllowed: (candidate) => deps.isModelAllowed?.(candidate) === true } : {}),
	});
	if (metered)
		return {
			cause: "model_metered",
			reason: words.botModelMetered(metered.ref, metered.alternatives, metered.provider),
		};
	// Out of quota (a recorded refusal, or the used-up usage windows of its subscription) or refused for the account: the
	// bot waits for its own model, never moved to another, until the exhaustion that holds longer resets.
	const spent = allowanceExhaustion(allowance, model);
	const unusable = deps.modelUnusableCause(model) ?? (spent ? "model_quota_exhausted" : undefined);
	if (unusable) {
		const clearsAt =
			unusable === "model_quota_exhausted"
				? heldModelExhaustion(recordedExhaustion(deps, model), spent)?.until
				: undefined;
		return {
			cause: unusable,
			reason: words.botModelUnusable(`${model.provider}/${model.id}`, unusable),
			...(clearsAt !== undefined ? { clearsAt } : {}),
		};
	}
	return deps.isModelAllowed && !deps.isModelAllowed(model)
		? { cause: "model_not_allowed", reason: words.botModelNotAllowed(`${model.provider}/${model.id}`) }
		: undefined;
}

/** What the lane controller hands over of its own: the bot store, its warnings and its worker profile resolution. */
interface BotSessionOwnPorts extends Pick<BotSessionRootPorts, "store" | "warn"> {
	/** The lane controller's reading of the usage a model's subscription account reports. */
	allowance(): SubscriptionAllowancePort;
	workerController(): Pick<WorkerDelegationController, "compileBotSession">;
}

/** Attaches the session to a bot session host: its process's shared one where it owns the process singletons, else one of its own. */
export function attachBotSessions(deps: BackgroundLaneControllerDeps, own: BotSessionOwnPorts): BotSessionAttachment {
	return attachBotSessionHost(botSessionHostPorts(deps, own), deps.standing.ownsProcessSingletons);
}

function botSessionHostPorts(deps: BackgroundLaneControllerDeps, own: BotSessionOwnPorts): BotSessionRootPorts {
	const { workerController, allowance, ...ownPorts } = own;
	return {
		...ownPorts,
		// A bot made from a profile is compiled by the resolution a worker of it takes, from the same start request.
		compileProfile: (record) =>
			workerController().compileBotSession({
				...botWorkerStart(deps.getSettingsManager().getWorkerModelPinPolicy(), record),
				instructions: `Answer the owner as bot ${record.agentId} in a session of its own.`,
				profileId: record.profileId,
			}),
		agentDir: () => deps.getAgentDir(),
		cwd: () => deps.getCwd(),
		modelRegistry: () => deps.getModelRegistry(),
		settingsManager: () => deps.getSettingsManager(),
		// Whether the main session has System One at all (its settings turn it off and on again live, the bot's with them),
		// the provider it names and its transport: never its on/off of this moment, which would outlive a settings change.
		systemOne: () => {
			const source = deps.systemOne.source;
			return { enabled: source?.enabled !== false, provider: source?.provider, fetch: source?.fetch };
		},
		timers: () => deps.getTimers(),
		hostSessionId: () => deps.getSessionId(),
		hostKeepsFile: () => deps.getSessionManager().isPersisted(),
		modelRefusal: (record, model) => botModelRefusal(deps, allowance(), record, model),
		// A closed bot's saved usage wait is read as its own session's wake reads it, against the exhaustions every process shares.
		usageRules: () => ({
			modelRegistry: deps.getModelRegistry(),
			inRunRetryMaxMs: () => deps.getSettingsManager().getProviderRetrySettings().maxRetryDelayMs,
			modelExhaustion: (ref) => sharedExhaustions(deps).exhaustion(ref),
		}),
		// A worker's budget is the owner's worker bound, intersected with the main session's own ceilings: on all spend, and
		// on metered spend (a subscription's limit is its usage windows). None set, none applies.
		spendCeilings: () => {
			const envelope = deps.getCapabilityEnvelope();
			const ceilings: BotSpendCeiling[] = [
				{
					usd: deps.getSettingsManager().getWorkerDelegationSettings().maxUsd,
					bound: "worker",
					meteredOnly: false,
				},
				{ usd: envelope?.maxEstimatedUsd ?? 0, bound: "session", meteredOnly: false },
				{ usd: envelope?.maxMeteredEstimatedUsd ?? 0, bound: "session", meteredOnly: true },
			];
			return ceilings.filter((ceiling) => ceiling.usd > 0);
		},
		// The session's own usage ledger takes a bot's charge by report id, as it takes a worker's usage receipt: persisted
		// only once read back from its file. A session that keeps no file holds it as it holds its own spend, for as long as
		// it lives: the charge is settled when it takes it (`BotTurnAccounting`).
		reportUsage: (usage, report) =>
			deliverSpawnedUsageReceipt(deps.getSessionManager(), deps, usage, {
				parentSessionId: deps.getSessionId(),
				label: BOT_SESSION_USAGE_LABEL,
				sourceSessionId: report.sessionId,
				sourceInstance: report.instance,
				reportId: report.reportId,
				provider: report.provider,
				model: report.model,
				from: structuredClone(report.from),
				through: structuredClone(report.through),
				recordedAt: report.recordedAt,
			}),
		// Where its charges are read back: the session files of every project (or the custom session directory) and the live
		// session's entries, each held once it holds it for good.
		chargeHolder: () => {
			const session = deps.getSessionManager();
			return {
				scope: usageScope(session),
				root: session.usesDefaultSessionDir(),
				live: {
					file: session.getSessionFile(),
					entries: session.getEntries(),
					// A session that keeps no file holds a charge as it holds its own spend, while it lives; one with a file holds
					// the row its file holds as the entry was written: the same JSON.
					holds: (entry) =>
						!session.isPersisted() ||
						(entry.type === "custom" &&
							classifyCustomEntryPersisted(
								session,
								entry.id,
								entry.customType,
								(data) => JSON.stringify(data) === JSON.stringify(entry.data),
							) === "persisted"),
				},
			};
		},
		// Each write of the session's file as it lands, with the bot charges it holds; an observer never throws (none is retried).
		chargesPersisted: (listener) =>
			deps.getSessionManager().onEntriesPersisted((event) => {
				const session = deps.getSessionManager();
				const reportIds = event.entryIds.flatMap((entryId) => {
					const entry = session.getEntry(entryId);
					return entry?.type === "custom" &&
						entry.customType === SPAWNED_USAGE_CUSTOM_TYPE &&
						isPlainRecord(entry.data) &&
						entry.data.label === BOT_SESSION_USAGE_LABEL &&
						typeof entry.data.reportId === "string"
						? [entry.data.reportId]
						: [];
				});
				listener(event.sessionId, reportIds);
			}),
	};
}
