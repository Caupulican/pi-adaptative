/**
 * What a bot's session reads from the main session: its settings (a manager of the bot's own over the same storage, read
 * again on each change of the main session's), its System One as it is now (on or off, provider, transport), and, as the
 * worker admission reads them, the model rules for an explicitly requested model (one predicate,
 * `worker-authority-resolver`), a profile compiled by that admission (`compileBotSession`), the spend bound a worker's budget carries, and the cost view the main session keeps for
 * spawned work. Composed here so the lane controller only hands over its
 * dependencies, and attaches to its process's bot session host with them (`attachBotSessions`).
 */

import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import { botWorkerStart } from "../delegation/bot-worker-start.ts";
import type { PersistentBotRecord } from "../delegation/persistent-bot-team-store.ts";
import { meteredModelRefusalFacts } from "../delegation/worker-authority-resolver.ts";
import type { WorkerDelegationController } from "../delegation/worker-delegation-controller.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SpawnedUsageReporter } from "../spawned-usage.ts";
import type { BotSessionHostPorts } from "./bot-session-host.ts";
import { attachBotSessionHost, type BotSessionAttachment } from "./bot-session-registry.ts";

/** Why the worker admission refuses the bot's own model now, in the owner's words; undefined when it may run. */
function botModelRefusal(
	deps: BackgroundLaneControllerDeps,
	record: PersistentBotRecord,
	model: Parameters<BotSessionHostPorts["modelRefusal"]>[1],
): string | undefined {
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
	if (metered) return words.botModelMetered(metered.ref, metered.alternatives, metered.provider);
	return deps.isModelAllowed && !deps.isModelAllowed(model)
		? words.botModelNotAllowed(`${model.provider}/${model.id}`)
		: undefined;
}

/** What the lane controller hands over of its own: the bot store, its warnings and its worker admission. */
interface BotSessionOwnPorts extends Pick<BotSessionHostPorts, "store" | "warn"> {
	workerController(): Pick<WorkerDelegationController, "compileBotSession">;
}

/** Attaches the session to a bot session host: its process's shared one for a root session, one of its own for a child. */
export function attachBotSessions(deps: BackgroundLaneControllerDeps, own: BotSessionOwnPorts): BotSessionAttachment {
	return attachBotSessionHost(botSessionHostPorts(deps, own), !deps.isChildSession());
}

/**
 * A settings manager of the bot's own over the main session's storage that reads it again after each change the main
 * session's manager makes. A change is announced before its write is queued, so the write is awaited from the next
 * microtask, then the settings are read from the storage it reached.
 */
function followSettings(main: SettingsManager): ReturnType<BotSessionHostPorts["settings"]> {
	const settings = main.sibling();
	const reread = () => queueMicrotask(() => void main.flush().then(() => settings.reload()));
	return { settings, release: main.subscribeChanges(reread) };
}

function botSessionHostPorts(deps: BackgroundLaneControllerDeps, own: BotSessionOwnPorts): BotSessionHostPorts {
	const { workerController, ...ownPorts } = own;
	return {
		...ownPorts,
		// A bot made from a profile is compiled by the admission a worker of it would pass, from the same start request.
		compileProfile: (record) =>
			workerController().compileBotSession({
				...botWorkerStart(deps.getSettingsManager().getWorkerModelPinPolicy(), record),
				instructions: `Answer the owner as bot ${record.agentId} in a session of its own.`,
				profileId: record.profileId,
			}),
		agentDir: () => deps.getAgentDir(),
		cwd: () => deps.getCwd(),
		modelRegistry: () => deps.getModelRegistry(),
		settings: () => followSettings(deps.getSettingsManager()),
		// Whether the main session has System One at all (its settings turn it off and on again live, the bot's with them),
		// the provider it names and its transport: never its on/off of this moment, which would outlive a settings change.
		systemOne: () => {
			const source = deps.systemOne.source;
			return { enabled: source?.enabled !== false, provider: source?.provider, fetch: source?.fetch };
		},
		timers: () => deps.getTimers(),
		hostSessionId: () => deps.getSessionId(),
		modelRefusal: (record, model) => botModelRefusal(deps, record, model),
		// A worker's budget is the owner's worker bound, intersected with the main session's own ceiling; none set, none applies.
		turnSpendBound: () => {
			const bounds = [
				{ usd: deps.getSettingsManager().getWorkerDelegationSettings().maxUsd, bound: "worker" as const },
				{ usd: deps.getCapabilityEnvelope()?.maxEstimatedUsd, bound: "session" as const },
			].filter((entry): entry is { usd: number; bound: "worker" | "session" } => (entry.usd ?? 0) > 0);
			return bounds.reduce<(typeof bounds)[number] | undefined>(
				(lowest, entry) => (lowest === undefined || entry.usd < lowest.usd ? entry : lowest),
				undefined,
			);
		},
		reportUsage: (usage, report) => {
			// The session's own usage ledger takes spawned work by report id, as it takes a worker's.
			const reporter: SpawnedUsageReporter = deps;
			reporter.addSpawnedUsage(usage, {
				label: "bot-session",
				sourceSessionId: report.sessionId,
				reportId: report.reportId,
				provider: report.provider,
				model: report.model,
			});
		},
	};
}
