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
import { getStableSelfLaunchTarget } from "../process-matrix/self-launch-target.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { botDaemonCommandArgs } from "./bot-daemon-command.ts";
import { describeLegacyDaemonRetirement, retireLegacyBotDaemons } from "./bot-daemon-legacy.ts";
import type { BotDaemonEnd, PersistentBotDaemonStatus } from "./bot-team-routine-helpers.ts";
import type { PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

/** A fresh lease claimed for a daemon about to start, or the status of the daemon already holding it. */
export type BotDaemonLeaseClaim =
	| {
			readonly claimed: true;
			readonly token: string;
			/** How the previous daemon ended, read before this claim replaced the record. */
			readonly previousEnd?: BotDaemonEnd;
			/** What retiring earlier-generation daemons did, for the starter's report; empty when nothing. */
			readonly legacy: string;
	  }
	| { readonly claimed: false; readonly current: PersistentBotDaemonStatus; readonly legacy: string };

/** Retires earlier-generation daemons, then claims the lease with a fresh token unless a live daemon holds it. */
export function claimBotDaemonLease(store: PersistentBotTeamStore, clock: TimerPort): BotDaemonLeaseClaim {
	const legacy = describeLegacyDaemonRetirement(retireLegacyBotDaemons(store));
	const token = randomUUID();
	const previousEnd = store.getDaemonEnd();
	if (!store.claimDaemonLease(token, clock.now()))
		return { claimed: false, current: store.getDaemonStatus(clock.now()), legacy };
	return { claimed: true, token, ...(previousEnd ? { previousEnd } : {}), legacy };
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

export interface BotDaemonLaunchResult {
	readonly started: boolean;
	/** Another daemon already holds the lease. */
	readonly held?: boolean;
	readonly pid?: number;
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
	if (!target) {
		return {
			started: false,
			detail: "Detached bot daemon unavailable: this host has no stable pi launch target.",
		};
	}
	const claim = claimBotDaemonLease(store, clock);
	const withLegacy = (detail: string): string => (claim.legacy ? `${detail} ${claim.legacy}` : detail);
	if (!claim.claimed) {
		const { current } = claim;
		const starting = current.lastHeartbeatAt === undefined;
		return {
			started: false,
			held: true,
			...(current.pid !== undefined ? { pid: current.pid } : {}),
			detail: withLegacy(
				starting
					? `Detached bot daemon is already starting${current.pid !== undefined ? ` (launched as pid ${current.pid})` : ""}.`
					: `Detached bot daemon is already running (pid ${current.pid ?? "unknown"}, ${current.activeRoutines} active routines).`,
			),
		};
	}
	const { token, previousEnd } = claim;
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
		return { started: false, detail: withLegacy("Failed to spawn detached bot daemon process.") };
	}
	store.recordDaemonLaunchPid(token, pid);
	return {
		started: true,
		token,
		...(previousEnd ? { previousEnd } : {}),
		handedOver: Promise.all([spawned, flushed]).then(([ok]) => ok),
		pid,
		detail: withLegacy(
			`Started detached bot daemon (pid ${pid}) watching ${store.getStoreFilePath()} across TUI restarts.`,
		),
	};
}
