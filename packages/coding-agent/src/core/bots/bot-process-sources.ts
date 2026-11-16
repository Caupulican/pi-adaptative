/**
 * What a bot's session borrows from its host when no root session is attached (the bot daemon): the ports a root hands
 * its process's host (`bot-session-ports.ts`), read from the process instead of from a session.
 *
 * - Model rules: the worker admission's, over the process's facts (`bot-model-admission.ts`): the owner's default model
 *   stands for the foreground model; a model is unusable while the shared exhaustion store holds it, its subscription's
 *   usage windows are used up (it waits for their reset, never moved to another model), or the owner's account does not
 *   offer it (the process's own listing, read again when the owner's credentials change); no conversation's model policy
 *   applies, since none is open.
 * - Spend, by the owner's cost rule: subscription spend is never counted as dollars (its usage windows hold it, above).
 *   Metered spend is held per request to `workerDelegation.maxUsd` and to the away bound of one run
 *   (`routines.away.maxUsdPerRun`, bound "away"), and a metered turn is refused (`away_spend_exhausted`) while the day's
 *   away bound (`routines.away.maxUsdPerDay`), which the daemon's routines and channels share, has no room for one more
 *   run; the refusal ends when the oldest charge leaves the 24-hour window. What a bot spent is charged once per report
 *   id to the daemon's ledger (`bot-away-charges.ts`), its metered part counted on that bound, not to a session's cost view.
 * - System One: on as a session started with no choice resolves it (off in settings, or with no key never configured, is
 *   off), resolved again at each `refresh`; the provider and transport are the settings' own.
 * - Settings: the owner's global settings over the bot's directory, never a project's (the project is untrusted, as for
 *   every run away), read again at each `refresh`.
 * - A bot works in the directory its session worked in (`senderIn`); a bot made from a profile has no root to resolve its
 *   profile here (`BotSender.compileProfile` is absent), so it waits for a root session.
 * - A bot's watched command starts from the environment a root session recorded for its directory
 *   (`watch-command-base.ts`), the daemon's own where none did.
 * - Warnings no bot's chat takes go to `report` (the daemon's lease record).
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { sessionsDir } from "../../kernel/storage/paths.ts";
import type { AuthStorage } from "../auth-storage.ts";
import { realPathIdentity } from "../autonomy/path-scope.ts";
import { usageReach } from "../cost/usage-delta.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { accountModelCatalogOf } from "../model-router/account-models.ts";
import { isMeteredSpend } from "../orchestration/risk-budget.ts";
import { openSubscriptionAllowance } from "../provider-admission/subscription-allowance.ts";
import { awaySpendMicros, type RoutineAwayCharge, routineAwaySpendRoom } from "../routines/routine-contract.ts";
import { SettingsManager } from "../settings-manager.ts";
import { isSystemOneEnabled, systemOneAccessFromSession } from "../system-one/access.ts";
import type { TimerSource } from "../util/timer-port.ts";
import { readWatchCommandBase, watchCommandEnvironment } from "../watches/watch-command-base.ts";
import { botAwayChargesReach, recordBotAwayCharge } from "./bot-away-charges.ts";
import { botChargesHeld } from "./bot-charges-held.ts";
import { type BotModelFacts, botModelRefusal, sharedExhaustions } from "./bot-model-admission.ts";
import type { BotModelRefusal } from "./bot-model-refusal.ts";
import type { BotSender, BotSessionHostPorts } from "./bot-session-host.ts";
import type { BotSpendCeiling } from "./bot-session-turns.ts";

export interface BotProcessSourcesInput {
	readonly agentDir: string;
	readonly store: PersistentBotTeamStore;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	/** The process's clocks: the away bound is read on the `routines` port, as the daemon's routines and channels read it. */
	readonly timers: TimerSource;
	/** The owner's global settings, read again by the process. */
	readonly settings: SettingsManager;
	/** The process's own warnings: what no bot's chat takes. */
	report(message: string): void;
	/**
	 * What else is charged to the away bound now besides the routines' runs: the channels' turns, the bots' recorded
	 * charges, and the turns of the bots working now other than `agentId` (each at the bound of one run).
	 */
	otherAwayCharges(nowMs: number, agentId: string): readonly RoutineAwayCharge[];
	/** Whether the host leaves the bots working in `cwd` to another (`BotSessionHostPorts.leavesTo`). */
	leavesTo(cwd: string): boolean;
}

/** The process-level sources and their refresh. */
export interface BotProcessSources {
	readonly ports: BotSessionHostPorts;
	/** Reads the settings of every bot again and resolves System One again; `credentials` checks the account listing again. */
	refresh(credentials: boolean): Promise<void>;
}

/** On as a session started with no choice resolves it (`sdk.ts`): off in settings, or a key never configured, is off. */
async function systemOneOn(settings: SettingsManager, authStorage: AuthStorage): Promise<boolean> {
	if (!isSystemOneEnabled(settings)) return false;
	const access = await systemOneAccessFromSession(settings, authStorage).resolve();
	return (
		access.kind !== "missing_key" ||
		settings.settings.systemOne?.enabled === true ||
		settings.getSystemOneSettings().completionProfile === "system_one_required"
	);
}

export function botProcessSources(input: BotProcessSourcesInput): BotProcessSources {
	const { agentDir, store, authStorage, modelRegistry, timers, settings } = input;
	const awayClock = timers.port("routines");
	const accounts = accountModelCatalogOf(modelRegistry);
	const allowance = openSubscriptionAllowance({ modelRegistry, timers }, () => undefined);
	const facts: BotModelFacts = {
		agentDir: () => agentDir,
		timers: () => timers,
		modelRegistry: () => modelRegistry,
		foregroundModel: () => {
			const provider = settings.getDefaultProvider();
			const modelId = settings.getDefaultModel();
			return provider && modelId ? modelRegistry.find(provider, modelId) : undefined;
		},
		accountRouting: () => settings.getWorkerAccountRouting(),
		modelUnusableCause: (model) =>
			sharedExhaustions(agentDir, timers).isExhausted(`${model.provider}/${model.id}`)
				? "model_quota_exhausted"
				: accounts.unavailableCause(model),
		allowance: () => allowance,
	};
	let systemOneEnabled = false;
	/** The settings managers of the bots' sessions, read again at each refresh. */
	const botSettings = new Set<SettingsManager>();
	const senders = new Map<string, BotSender>();

	/** A metered turn of `record` refused while the day's away bound has no room for one more run, until the oldest charge leaves it. */
	const awayRoomRefusal = (record: PersistentBotRecord, model: Model<Api>): BotModelRefusal | undefined => {
		if (!isMeteredSpend(model, modelRegistry)) return undefined;
		const away = settings.getRoutineAwaySettings();
		const nowMs = awayClock.now();
		const room = routineAwaySpendRoom(
			store.listRoutineOccurrences(),
			{
				maxUsdPerRun: away.maxUsdPerRun,
				maxUsdPerDay: away.maxUsdPerDay,
				otherCharges: input.otherAwayCharges(nowMs, record.agentId),
			},
			nowMs,
		);
		if (room.fits(0)) return undefined;
		return {
			cause: "away_spend_exhausted",
			reason: interfaceText().botTeam.botAwaySpendExhausted,
			...(room.exit !== undefined ? { clearsAt: room.exit } : {}),
		};
	};

	const senderIn = (cwd: string): BotSender => {
		const place = realPathIdentity(cwd);
		const known = senders.get(place);
		if (known) return known;
		const sender: BotSender = {
			cwd: () => cwd,
			settings: () => {
				// An unattended run applies only the owner's global settings: no project's settings loosen it.
				const own = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
				botSettings.add(own);
				return { settings: own, release: () => void botSettings.delete(own) };
			},
			hostSessionId: () => undefined,
			// The ledger is a file: a charge it holds is held for good.
			hostKeepsFile: () => true,
			warn: (message) => input.report(message),
			// A watched command starts from the environment the last root session working here recorded, never from the
			// daemon's own (a service manager's); with none recorded, from the daemon's.
			watchCommandBase: () => readWatchCommandBase(agentDir, cwd) ?? watchCommandEnvironment(),
			reportUsage: (usage, report) => {
				const model = modelRegistry.find(report.provider, report.model);
				const setAside = recordBotAwayCharge(agentDir, {
					reportId: report.reportId,
					agentId: report.agentId,
					sessionId: report.sessionId,
					instance: report.instance,
					through: structuredClone(report.through),
					micros: isMeteredSpend(model, modelRegistry) ? awaySpendMicros(usage.cost.total) : 0,
					at: awayClock.now(),
				});
				if (setAside)
					input.report(
						interfaceText().botTeam.botAwayChargesSetAside(setAside.file, setAside.to, setAside.reason),
					);
				return "persisted";
			},
			// The roots' session files hold the charges made while a root hosted the bot; the ledger the daemon's own.
			chargesHeld: async (sessionId, instance, since) => {
				const held = await botChargesHeld(
					[
						{
							scope: sessionsDir(agentDir),
							root: true,
							live: { file: undefined, entries: [], holds: () => false },
						},
					],
					sessionId,
					instance,
					since,
				);
				const reach = botAwayChargesReach(agentDir, sessionId, instance);
				return reach ? { ...held, through: usageReach(held.through, reach) } : held;
			},
			// Every charge is held at once (`persisted`): no write is ever awaited.
			chargesPersisted: () => () => {},
		};
		senders.set(place, sender);
		return sender;
	};

	const ports: BotSessionHostPorts = {
		agentDir: () => agentDir,
		// No root answers here: a bot works in the directory its session worked in, and the process's own one otherwise.
		sender: () => senderIn(agentDir),
		senderIn,
		store: () => store,
		modelRegistry: () => modelRegistry,
		systemOne: () => ({ enabled: systemOneEnabled }),
		timers: () => timers,
		warn: (message) => input.report(message),
		modelRefusal: (record, model) => botModelRefusal(facts, record, model) ?? awayRoomRefusal(record, model),
		spendCeilings: () => {
			const ceilings: BotSpendCeiling[] = [
				{ usd: settings.getWorkerDelegationSettings().maxUsd, bound: "worker" },
				{ usd: settings.getRoutineAwaySettings().maxUsdPerRun, bound: "away" },
			];
			return ceilings.filter((ceiling) => ceiling.usd > 0);
		},
		usageRules: () => ({
			modelRegistry,
			inRunRetryMaxMs: () => settings.getProviderRetrySettings().maxRetryDelayMs,
			modelExhaustion: (ref) => sharedExhaustions(agentDir, timers).exhaustion(ref),
		}),
		hostKind: () => "daemon",
		leavesTo: (cwd) => input.leavesTo(cwd),
	};

	return {
		ports,
		refresh: async (credentials) => {
			if (credentials) await accounts.refresh();
			systemOneEnabled = await systemOneOn(settings, authStorage);
			await Promise.all([...botSettings].map((own) => own.reload()));
		},
	};
}
