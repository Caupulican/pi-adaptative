/**
 * What a bot session host (`bot-session-host.ts`) reads from where it runs: the ports of its coordinator (a root
 * session's, `bot-session-ports.ts`, or the bot daemon's, `bot-process-sources.ts`), the root session a bot's message came
 * from (`BotSender`), and what its process keeps across the hosts that replace one another (`bot-session-registry.ts`).
 */

import type { Api, Model, Usage } from "@caupulican/pi-ai";
import type { SpawnedUsageReceiptDisposition } from "../cost/spawned-usage-receipt.ts";
import type { BotSessionCompilation } from "../delegation/bot-session-compile.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SystemOneHostSource } from "../system-one/session-source.ts";
import type { TimerSource } from "../util/timer-port.ts";
import type { BotChargesHeld } from "./bot-charges-held.ts";
import type { BotHostKind } from "./bot-host-state.ts";
import type { BotInboxFrom } from "./bot-inbox-send.ts";
import type { LinkedSessionNotices } from "./bot-link-notices.ts";
import type { BotModelRefusal } from "./bot-model-refusal.ts";
import type { SavedUsageResumeRules } from "./bot-owed-ledgers.ts";
import type { BotSpendCeiling } from "./bot-session-turns.ts";
import type { BotChargeReport } from "./bot-spend-ledger.ts";
import type { UnrecordedBotStops } from "./bot-stop.ts";

/**
 * What a process keeps for an agent directory across the bot session hosts that replace one another there
 * (`bot-session-registry.ts`: a new, resumed or forked root session stops the old host before the next one starts).
 */
export interface BotHostProcessKeeps {
	/** The owner's stops the process could not record. */
	readonly unrecorded: UnrecordedBotStops;
	/** What the owner was told of the work a stop or a release left behind a symbolic link. */
	readonly links: LinkedSessionNotices;
	/** Why each bot's session state was told as kept in the owner's home (`BotSessionLoadPorts.toldNotMoved`). */
	readonly notMoved: Set<string>;
}

/** What the host reads from and asks of the coordinator. */
export interface BotSessionHostPorts {
	agentDir(): string;
	/** The root session a bot works for when no delivery names one (a wake, a stop): the one attached last. */
	sender(): BotSender;
	/** An attached root session working in `cwd`, which a bot whose session worked there is opened again for. */
	senderIn(cwd: string): BotSender | undefined;
	store(): PersistentBotTeamStore;
	modelRegistry(): ModelRegistry;
	/** The main session's System One as it is now: a bot's session follows it at each use, as the main session runs it. */
	systemOne(): SystemOneHostSource;
	timers(): TimerSource;
	/** An owner-facing warning that no bot turn's sender owns (a session that did not close cleanly, a lost watch). */
	warn(message: string): void;
	/** Why the worker admission refuses the bot's model now, with when that ends when known; undefined when it may run. */
	modelRefusal(record: PersistentBotRecord, model: Model<Api>): BotModelRefusal | undefined;
	/**
	 * The root's dollar ceilings over metered spend, as a worker's budget holds it: the owner's worker bound and the main
	 * session's autonomy ceiling (`costCeilingUsd`); empty when none is set.
	 */
	spendCeilings(): readonly BotSpendCeiling[];
	/** What reads when a closed bot's saved session continues what a usage limit stopped (`savedUsageResumeAt`). */
	usageRules(): SavedUsageResumeRules;
	/** What kind of process hosts the bots: a root session's, or the bot daemon's (`host-state.json`). */
	hostKind(): BotHostKind;
	/**
	 * Present on a host whose wider spend bound holds the bots' metered workers (the daemon's away day bound,
	 * `routines.away.maxUsdPerDay`): whether the metered run `runId` of bot `agentId` (`BotMeteredRuns`) fits it now, its
	 * own reservation aside. Absent: none holds them.
	 */
	meteredRunFits?(agentId: string, runId: string): boolean;
	/**
	 * Whether a root session of another process that hosts bots works in `cwd`: this host (the daemon's) leaves the bots
	 * that work there to it, opening none for that directory and closing an idle one (`leaveIdleToRoots`). Absent: none is left.
	 */
	leavesTo?(cwd: string): boolean;
	/** Bots let go, for the daemon (`botsOwed`): another host released them, or (`detaching`) the last root left. */
	botsLetGo?(detaching: boolean): void;
}

/**
 * The root session a bot's message came from: the owner's project directory a bot it loads works in, what a bot made from
 * a profile compiles to and the settings a bot reads there, the pi session named as its host, and where its turns' spend
 * goes. Once that root detaches, the root attached last answers. What the bot's own session raises for the owner goes to
 * the bot's chat instead (`bot-notices.ts`).
 */
export interface BotSender {
	cwd(): string;
	/**
	 * What a bot made from a profile compiles to for this root, by the resolution a fresh worker of it takes
	 * (`bot-session-compile.ts`); absent with no root session (the daemon), where such a bot waits for one.
	 */
	compileProfile?(record: PersistentBotRecord & { readonly profileId: string }): BotSessionCompilation;
	/**
	 * A settings manager of the bot's own over the storage this root reads (`SettingsManager.sibling`), reading again each
	 * change an attached root's manager makes until `release`.
	 */
	settings(): { readonly settings: SettingsManager; release(): void };
	/** The pi session that hosts the bot, named to the owner of a message another process sends it; none in the daemon. */
	hostSessionId(): string | undefined;
	/** Whether that session keeps a session file (none with `--no-session` or an in-memory SDK session). */
	hostKeepsFile(): boolean;
	/** An owner-facing warning about this root's own record of the bot's turn (its spend could not be recorded). */
	warn(message: string): void;
	/** The environment a watched command of the bot's session starts from (`commandBase`); absent: its process's. */
	watchCommandBase?(): NodeJS.ProcessEnv;
	/**
	 * Delivers a charge of the bot's spend to the root session's cost view, once per `reportId`: `persisted` once the
	 * root's file holds it.
	 */
	reportUsage(usage: Usage, report: BotChargeReport): SpawnedUsageReceiptDisposition;
	/**
	 * How far the root sessions of the process hold the charges of file instance `instance` of bot session `sessionId` in
	 * the files changed since `since`, and the charges they hold unwritten (`botChargesHeld`).
	 */
	chargesHeld(sessionId: string, instance: string, since: number): Promise<BotChargesHeld>;
	/**
	 * Calls `listener` with the bot charges (their report ids) the root session's file holds, as each write lands, with
	 * the session written to; returns the unsubscribe.
	 */
	chargesPersisted(listener: (rootSessionId: string, reportIds: readonly string[]) => void): () => void;
}

/** Who a message or stop written to a bot's inbox came from: the sender's directory, and its session when it has one. */
export function inboxSender(sender: BotSender): BotInboxFrom {
	const sessionId = sender.hostSessionId();
	return { ...(sessionId !== undefined ? { sessionId } : {}), cwd: sender.cwd() };
}
