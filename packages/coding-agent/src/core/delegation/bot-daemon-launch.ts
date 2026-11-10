/**
 * Claims the detached bot daemon's lease and launches the daemon process: shared by a session's start
 * (`BackgroundLaneController.startPersistentBotDaemon`) and the user service's start on Windows (`bot-daemon.ts`).
 *
 * The daemon is pi's own `--bot-daemon` command run through the stable self-launch target, so it outlives its starter
 * and that starter's runtime generation. Earlier-generation daemons are retired first (the store is sealed against
 * them on every platform; see `bot-daemon-legacy.ts`). The lease is claimed with a fresh token before the spawn and the
 * token travels in argv, so the daemon's identity is the lease it renews, never a pid read back from disk; the spawned
 * pid is recorded for display only (on Windows it can be a launcher wrapper's). The daemon serves the whole agent
 * directory, so it carries none of its starter's session identity.
 */
import { randomUUID } from "node:crypto";
import { spawnProcess } from "../../utils/child-process.ts";
import { configFile } from "../agent-paths.ts";
import { daemonBaselineEnvironment, daemonGhCredentialPayload } from "../daemon-environment.ts";
import { englishText, type InterfaceText } from "../language/interface-text.ts";
import { getStableSelfLaunchTarget } from "../process-matrix/self-launch-target.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { botDaemonCommandArgs } from "./bot-daemon-command.ts";
import {
	describeLegacyDaemonRetirement,
	type LegacyDaemonRetirement,
	retireLegacyBotDaemons,
} from "./bot-daemon-legacy.ts";
import {
	type BotDaemonEnd,
	describeDaemonBuild,
	describeDaemonReplacement,
	OWN_DAEMON_BUILD,
	type PersistentBotDaemonStatus,
	type ReplacedBotDaemon,
} from "./bot-team-routine-helpers.ts";
import type { PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

/** A fresh lease claimed for a daemon about to start, or the status of the daemon already holding it. */
export type BotDaemonLeaseClaim =
	| {
			readonly claimed: true;
			readonly token: string;
			/** How the previous daemon ended, read before this claim replaced the record. */
			readonly previousEnd?: BotDaemonEnd;
			/** The live daemon of an older build this claim took the lease from; it exits on observing the new lease. */
			readonly replaced?: ReplacedBotDaemon;
			/** What retiring earlier-generation daemons did, for the starter's report; nothing when there was none. */
			readonly legacy: LegacyDaemonRetirement;
	  }
	| { readonly claimed: false; readonly current: PersistentBotDaemonStatus; readonly legacy: LegacyDaemonRetirement };

/**
 * Retires earlier-generation daemons, then claims the lease with a fresh token for this process's build unless a live
 * daemon of the same or a newer build holds it; one of an older build is replaced.
 */
export function claimBotDaemonLease(store: PersistentBotTeamStore, clock: TimerPort): BotDaemonLeaseClaim {
	const legacy = retireLegacyBotDaemons(store);
	const token = randomUUID();
	const previousEnd = store.getDaemonEnd();
	const claim = store.claimDaemonLease(token, OWN_DAEMON_BUILD, clock.now());
	if (!claim.claimed) return { claimed: false, current: store.getDaemonStatus(clock.now()), legacy };
	return {
		claimed: true,
		token,
		...(previousEnd ? { previousEnd } : {}),
		...(claim.replaced ? { replaced: claim.replaced } : {}),
		legacy,
	};
}

/** The first report of a daemon whose predecessor ended on an error. */
export function previousDaemonFailureReport(end: BotDaemonEnd): string {
	return `The previous daemon stopped on an error${end.detail ? `: ${end.detail}` : ""}.`;
}

export interface BotDaemonLaunch {
	readonly store: PersistentBotTeamStore;
	readonly clock: TimerPort;
	/** The starter's project directory: its own PATH entries never reach the daemon (see daemon-environment.ts). */
	readonly cwd: string;
	/** Asynchronous launch faults (the spawn failed, stdin refused the gh credentials), reported by the starter. */
	readonly warn: (message: string) => void;
}

/**
 * What a detached daemon start did, as facts. The screen words them with the interface's words; the starter's
 * diagnostics and a launch report keep the English wording, both produced by one formatter over these entries.
 */
export type BotDaemonLaunchOutcome =
	| { readonly kind: "unavailable" }
	| {
			readonly kind: "already_starting";
			readonly pid?: number;
			readonly build: string | undefined;
			readonly sessionBuild: string | undefined;
			readonly legacy: LegacyDaemonRetirement;
	  }
	| {
			readonly kind: "already_running";
			readonly pid?: number;
			readonly build: string | undefined;
			readonly sessionBuild: string | undefined;
			readonly activeRoutines: number;
			readonly legacy: LegacyDaemonRetirement;
	  }
	| { readonly kind: "spawn_failed"; readonly legacy: LegacyDaemonRetirement }
	| {
			readonly kind: "started";
			readonly pid: number;
			readonly storeFilePath: string;
			readonly replaced?: ReplacedBotDaemon;
			readonly legacy: LegacyDaemonRetirement;
	  };

/** The words a launch report draws on: the bot-team area, and the chat area's daemon build entries. */
export interface BotDaemonLaunchWords {
	readonly botTeam: InterfaceText["botTeam"];
	readonly chat: InterfaceText["chat"];
}

/** One sentence for what a launch did, in the language of `words`. */
export function describeBotDaemonLaunch(outcome: BotDaemonLaunchOutcome, words: BotDaemonLaunchWords): string {
	switch (outcome.kind) {
		case "unavailable":
			return words.botTeam.daemonLaunchUnavailable;
		case "already_starting": {
			const build = describeDaemonBuild(outcome.build, outcome.sessionBuild, words.chat);
			return withLegacy(words.botTeam.daemonLaunchStarting(outcome.pid, build), outcome.legacy, words);
		}
		case "already_running": {
			const build = describeDaemonBuild(outcome.build, outcome.sessionBuild, words.chat);
			return withLegacy(
				words.botTeam.daemonLaunchRunning(outcome.pid, build, outcome.activeRoutines),
				outcome.legacy,
				words,
			);
		}
		case "spawn_failed":
			return withLegacy(words.botTeam.daemonLaunchSpawnFailed, outcome.legacy, words);
		case "started": {
			const replacement =
				outcome.replaced === undefined
					? ""
					: `${describeDaemonReplacement(outcome.replaced, OWN_DAEMON_BUILD, words.botTeam)} `;
			const started = words.botTeam.daemonLaunchStarted(outcome.pid, outcome.storeFilePath);
			return withLegacy(`${replacement}${started}`, outcome.legacy, words);
		}
	}
}

/** A launch sentence followed by what retiring earlier builds' daemons did, when it did anything. */
function withLegacy(detail: string, legacy: LegacyDaemonRetirement, words: BotDaemonLaunchWords): string {
	const retired = describeLegacyDaemonRetirement(legacy, words.botTeam);
	return retired === "" ? detail : `${detail} ${retired}`;
}

export interface BotDaemonLaunchResult {
	readonly started: boolean;
	/** Another daemon of the same or a newer build already holds the lease. */
	readonly held?: boolean;
	readonly pid?: number;
	/** What this launch did: the screen words it, the starter's diagnostics read `detail`. */
	readonly outcome: BotDaemonLaunchOutcome;
	readonly detail: string;
	/** A started launch: the lease token the daemon runs with, and how the daemon it replaces ended. */
	readonly token?: string;
	readonly previousEnd?: BotDaemonEnd;
	/**
	 * A started launch: settles once the daemon process spawned (true) or failed to, its claim then released (false),
	 * and its stdin has the gh handover. A starter that exits right after the launch waits for it.
	 */
	readonly handedOver?: Promise<boolean>;
}

/**
 * Claims the lease and launches the daemon detached. `held`: another daemon already holds the lease. A previous daemon
 * that ended on an error is reported once, by the start that replaces it.
 */
export function launchDetachedBotDaemon(input: BotDaemonLaunch): BotDaemonLaunchResult {
	const { store, clock, warn } = input;
	store.reload();
	const target = getStableSelfLaunchTarget();
	if (!target) return launched({ started: false }, { kind: "unavailable" });
	const claim = claimBotDaemonLease(store, clock);
	if (!claim.claimed) {
		const { current, legacy } = claim;
		const pid = current.pid !== undefined ? { pid: current.pid } : {};
		const outcome: BotDaemonLaunchOutcome =
			current.lastHeartbeatAt === undefined
				? { kind: "already_starting", ...pid, build: current.build, sessionBuild: OWN_DAEMON_BUILD, legacy }
				: {
						kind: "already_running",
						...pid,
						build: current.build,
						sessionBuild: OWN_DAEMON_BUILD,
						activeRoutines: current.activeRoutines,
						legacy,
					};
		return launched({ started: false, held: true, ...pid }, outcome);
	}
	const { token, previousEnd, replaced, legacy } = claim;
	if (previousEnd?.reason === "failed")
		warn(
			`The detached bot daemon stopped on an error${previousEnd.detail ? `: ${previousEnd.detail}` : ""}. It is started again.`,
		);
	const agentDir = store.getAgentDir();
	const args = [...target.argsPrefix, ...botDaemonCommandArgs(agentDir, token)];
	// An explicit baseline, run from the agent directory: nothing scoped to the starter's shell or project reaches a
	// daemon that serves every project (see daemon-environment.ts).
	const env: NodeJS.ProcessEnv = {
		...daemonBaselineEnvironment(process.env, input.cwd, [
			configFile(agentDir, "auth.json"),
			configFile(agentDir, "models.json"),
		]),
		...target.environment,
	};
	// gh's tokens travel on stdin, never in the daemon's environment its workers' commands could read.
	const child = spawnProcess(target.executable, args, {
		cwd: agentDir,
		detached: true,
		stdio: ["pipe", "ignore", "ignore"],
		windowsHide: true,
		env,
	});
	child.stdin?.once("error", (error) =>
		warn(`Detached bot daemon did not receive the gh credentials: ${error.message}`),
	);
	const spawned = new Promise<boolean>((resolve) => {
		child.once("spawn", () => resolve(true));
		child.once("error", () => resolve(false));
	});
	// The end callback runs once the handover is flushed, or with the error that destroyed the pipe.
	const flushed = new Promise<void>((resolve) => {
		if (child.stdin) child.stdin.end(daemonGhCredentialPayload(process.env), () => resolve());
		else resolve();
	});
	child.once("error", (error) => {
		warn(`Detached bot daemon failed to start: ${error.message}`);
		// The daemon never ran, so its claim is released now rather than left to go stale.
		try {
			store.releaseDaemonLease(token, clock.now(), { reason: "failed", detail: error.message });
		} catch (releaseError) {
			warn(
				`Detached bot daemon lease stays claimed until it goes stale: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
			);
		}
	});
	child.unref();
	const pid = child.pid;
	if (pid === undefined) {
		store.releaseDaemonLease(token, clock.now(), { reason: "failed", detail: "its process did not spawn" });
		return launched({ started: false }, { kind: "spawn_failed", legacy });
	}
	store.recordDaemonLaunchPid(token, pid);
	return launched(
		{
			started: true,
			token,
			...(previousEnd ? { previousEnd } : {}),
			handedOver: Promise.all([spawned, flushed]).then(([ok]) => ok),
			pid,
		},
		{
			kind: "started",
			pid,
			storeFilePath: store.getStoreFilePath(),
			...(replaced ? { replaced } : {}),
			legacy,
		},
	);
}

/** A launch result: the outcome, and its English wording for the starter's diagnostics. */
function launched(
	result: Omit<BotDaemonLaunchResult, "outcome" | "detail">,
	outcome: BotDaemonLaunchOutcome,
): BotDaemonLaunchResult {
	return { ...result, outcome, detail: describeBotDaemonLaunch(outcome, englishText()) };
}
