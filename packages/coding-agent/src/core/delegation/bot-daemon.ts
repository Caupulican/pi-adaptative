/**
 * The detached bot daemon: queues due persistent bot and team routines across TUI restarts, runs the routines of
 * closed sessions away (`AwayRoutineSupervisor`), and serves the channels the owner named an `awayCwd` for while no
 * session is open (`AwayChannelHosts`), on the same away spend bound.
 *
 * A session claims the daemon lease with a fresh token, then launches `pi --bot-daemon <agentDir> <token>` through
 * the stable self-launch target. Sessions do this by themselves: on start while an enabled routine exists, and when a
 * routine is saved (see `BackgroundLaneController`). The owner's user service runs `pi --bot-daemon <agentDir>` at
 * login (see `away-service.ts`): that form claims the lease itself, and exits at once while another daemon holds it.
 * The daemon renews that lease while it is still its own and stops
 * as soon as it is not: released by `/bot daemon stop`, or claimed by a later start after this daemon's lease went
 * stale. Ownership changes are observed through a watch on the lease directory, and the renewal tick rechecks them.
 * Each renewal records the daemon's own process identity (pid, start time, host); the pid the starter recorded at spawn
 * may be a launcher wrapper's and is display data only. Each tick also reseals the store if an older build rewrote it
 * in the shape an earlier inline-script daemon acts on (see `bot-daemon-legacy.ts`), reloads the owner's settings and
 * wakes the away supervisor and the channel hosts, which is when a parent session's or a channel's holder can have died.
 *
 * The daemon process owns ONE credential store and ONE model registry, shared by every parent it hosts away. Each tick
 * reloads them when the owner's `auth.json` or `models.json` changed on disk; an OAuth refresh always reads the stored
 * credential under the file lock, so a long-lived store never posts a superseded refresh token.
 *
 * The daemon reports into its lease record (bounded), and every end is recorded there: `signal` when its process is
 * asked to stop, `failed` with the error that ended it, `released` by the session that stopped it. A lease another
 * start took is that daemon's, so this one exits without writing it. A stop is joined: the renewal and the watch end,
 * the supervisor closes its hosts (a run still executing is suspended and resumed later), then the lease is released.
 *
 * A lock held by another process through every bounded retry (`ELOCKED`) skips one renewal or report write: renewal
 * recurs well inside the lease's stale window, due routines stay due and reports are written on the next tick.
 */
import { type FSWatcher, statSync, watch } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { ownProcessOwner, type ProcessOwner } from "../../kernel/reliability/owner-identity.ts";
import { configFile } from "../agent-paths.ts";
import { AuthStorage } from "../auth-storage.ts";
import { AwayChannelHosts, type AwayChannelProviderFactory } from "../channels/away-channel-host.ts";
import { readAwayChannelCharges } from "../channels/away-channels.ts";
import { ModelRegistry } from "../model-registry.ts";
import type { AwayEventSourceFactory } from "../routines/away-event-feed.ts";
import { AwayRoutineSupervisor } from "../routines/away-routine-host.ts";
import { SettingsManager } from "../settings-manager.ts";
import { repeatEvery, SYSTEM_TIMER_SOURCE, type TimerSource } from "../util/timer-port.ts";
import {
	type BotDaemonLeaseClaim,
	claimBotDaemonLease,
	launchDetachedBotDaemon,
	previousDaemonFailureReport,
} from "./bot-daemon-launch.ts";
import {
	type BotDaemonEnd,
	type BotDaemonReport,
	daemonLeasePath,
	isDaemonLeaseToken,
} from "./bot-team-routine-helpers.ts";
import { PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

const DAEMON_TICK_MS = 10_000;
/** Reports waiting for a contended lease lock; older ones are dropped first. */
const MAX_PENDING_REPORTS = 20;

function isLockContention(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ELOCKED";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Size and modification time of each owner credential file, or `absent`: a changed stamp means the owner edited one. */
function credentialFilesStamp(agentDir: string): string {
	return ["auth.json", "models.json"]
		.map((name) => {
			const stat = statSync(configFile(agentDir, name), { throwIfNoEntry: false });
			return stat ? `${stat.size}:${stat.mtimeMs}` : "absent";
		})
		.join("|");
}

export interface BotDaemonInput {
	readonly agentDir: string;
	/** The lease token the starting session claimed and passed in argv: the daemon's identity. */
	readonly token: string;
	/** The daemon's clock and alarms: the lease renewal and the away supervisor run on the `routines` port. */
	readonly timers: TimerSource;
	/** The identity each renewal records. */
	readonly owner: ProcessOwner;
	/**
	 * Shared credential owners, when the host has them (the daemon process always does); otherwise each parent run away
	 * builds them as the SDK does. Shared ones are reloaded when the owner's files change.
	 */
	readonly authStorage?: AuthStorage;
	readonly modelRegistry?: ModelRegistry;
	/** The event sources a closed parent's checkout has away (the CI source); without them event routines wait. */
	readonly eventSources?: AwayEventSourceFactory;
	/** The transports of the channels served while no session is open; without them no channel is served away. */
	readonly channelProviders?: AwayChannelProviderFactory;
	/** How the daemon this one replaces ended, when its own start claimed the lease: a failure is its first report. */
	readonly previousEnd?: BotDaemonEnd;
}

export interface BotDaemonRun {
	/** Resolves with the process exit code once the daemon stopped and its stop was joined. */
	readonly exited: Promise<number>;
	/**
	 * Stops the daemon (a signal to its process, by default) and resolves with its exit code once joined. A `failed`
	 * end exits 1.
	 */
	stop(end?: Omit<BotDaemonEnd, "at">): Promise<number>;
}

/** Starts the daemon for `token`; it runs until its lease is no longer its own or it is stopped. */
export function startBotDaemon(input: BotDaemonInput): BotDaemonRun {
	const { agentDir, token, timers, owner } = input;
	const clock = timers.port("routines");
	const pending: BotDaemonReport[] = [];
	let store: PersistentBotTeamStore | undefined;
	let stopping: Promise<number> | undefined;
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const fail = (error: unknown): void => {
		void stop({ reason: "failed", detail: errorText(error) });
	};
	const flushReports = (): void => {
		if (!store || pending.length === 0) return;
		try {
			store.recordDaemonReports(token, pending);
			pending.length = 0;
		} catch (error) {
			if (!isLockContention(error)) fail(error);
		}
	};
	const report = (message: string): void => {
		pending.push({ at: clock.now(), message });
		if (pending.length > MAX_PENDING_REPORTS) pending.splice(0, pending.length - MAX_PENDING_REPORTS);
		flushReports();
	};
	const routineStore = new PersistentBotTeamStore(agentDir, (message) => report(`Routine store: ${message}`));
	store = routineStore;
	// The away bounds are the owner's global settings; no project's settings reach a daemon serving every project.
	const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
	const supervisor = new AwayRoutineSupervisor({
		store: routineStore,
		agentDir,
		timers,
		settings: () => settings.getRoutineAwaySettings(),
		report,
		...(input.authStorage ? { authStorage: input.authStorage } : {}),
		...(input.modelRegistry ? { modelRegistry: input.modelRegistry } : {}),
		...(input.eventSources ? { eventSources: input.eventSources } : {}),
		ciEvents: () => settings.getProactivitySettings().ciEvents,
		otherAwayCharges: () =>
			readAwayChannelCharges(agentDir, settings.getRoutineAwaySettings().maxUsdPerRun, clock.now()),
	});
	const channelProviders = input.channelProviders;
	const channelHosts = channelProviders
		? new AwayChannelHosts({
				agentDir,
				settings,
				timers,
				providers: channelProviders,
				routineOccurrences: () => routineStore.listRoutineOccurrences(),
				report,
				...(input.authStorage ? { authStorage: input.authStorage } : {}),
				...(input.modelRegistry ? { modelRegistry: input.modelRegistry } : {}),
			})
		: undefined;
	const leaseFile = daemonLeasePath(routineStore.getStoreFilePath());
	let watcher: FSWatcher | undefined;
	// The settings reload a tick started; it never rejects (a failure stops the daemon) and a stop joins it.
	let reloading: Promise<void> | undefined;
	let credentialStamp = credentialFilesStamp(agentDir);

	const stop = (end?: Omit<BotDaemonEnd, "at">): Promise<number> => {
		stopping ??= (async () => {
			ticker.stop();
			watcher?.close();
			watcher = undefined;
			let code = end?.reason === "failed" ? 1 : 0;
			let ended = end;
			await reloading;
			try {
				await supervisor.close();
			} catch (error) {
				code = 1;
				ended = { reason: "failed", detail: `the away supervisor did not close: ${errorText(error)}` };
			}
			try {
				await channelHosts?.close();
			} catch (error) {
				code = 1;
				ended = { reason: "failed", detail: `the channel hosts did not close: ${errorText(error)}` };
			}
			flushReports();
			// Without an end the lease is no longer this daemon's: whoever holds or released it owns the record.
			if (ended) {
				try {
					routineStore.releaseDaemonLease(token, clock.now(), ended);
				} catch (error) {
					// A contended lease lock: the unrenewed lease goes stale on its own.
					if (!isLockContention(error)) code = 1;
				}
			}
			routineStore.dispose();
			resolveExit(code);
			return code;
		})();
		return stopping;
	};

	const tick = (): void => {
		if (stopping) return;
		const now = clock.now();
		try {
			if (!routineStore.renewDaemonLease(token, owner, now)) {
				void stop();
				return;
			}
			routineStore.queueDueRoutinesForDaemon(now);
		} catch (error) {
			if (!isLockContention(error)) {
				fail(error);
				return;
			}
		}
		flushReports();
		// An owner's credential or model change applies to the next request of every hosted parent.
		const stamp = credentialFilesStamp(agentDir);
		if (stamp !== credentialStamp) {
			credentialStamp = stamp;
			input.authStorage?.reload();
			input.modelRegistry?.refresh();
		}
		// An owner's settings change applies from the next pass; a reload still running covers this tick too.
		if (reloading) return;
		reloading = settings
			.reload()
			.then(() => {
				if (stopping) return;
				supervisor.wake();
				channelHosts?.sync(credentialStamp);
			}, fail)
			.finally(() => {
				reloading = undefined;
			});
	};
	// The renewal is this process's whole life, so it alone keeps the process alive; every other alarm is unreferenced.
	const ticker = repeatEvery(clock, DAEMON_TICK_MS, tick, { keepAlive: true });
	try {
		watcher = watch(dirname(leaseFile), { persistent: false }, (_event, filename) => {
			if (filename !== null && filename.toString() !== basename(leaseFile)) return;
			if (!stopping && !routineStore.daemonLeaseBelongsTo(token)) void stop();
		});
		// A watch that fails later leaves the renewal tick, which observes a release within one interval.
		watcher.on("error", () => {
			watcher?.close();
			watcher = undefined;
		});
	} catch (error) {
		fail(error);
	}
	if (input.previousEnd?.reason === "failed") report(previousDaemonFailureReport(input.previousEnd));
	tick();
	return { exited, stop: (end = { reason: "signal" }) => stop(end) };
}

/**
 * Runs the daemon for `pi --bot-daemon <agentDir> <token>`; resolves with the process exit code once it stops. The
 * process entry supplies the event sources and the channel transports.
 *
 * `pi --bot-daemon <agentDir>` is the user service's form (see `away-service.ts`): no session started it, so it claims
 * the lease itself through the claim a session's start uses, and exits 0 at once while a live daemon holds it. On
 * POSIX it then runs the daemon in this process, which the service manager supervises. On Windows it launches the
 * daemon detached and hidden exactly as a session does and exits: the scheduled task's console process would
 * otherwise keep a console window open for the daemon's whole life.
 */
/** What the process entry composes into the daemon: core builds no host source and no channel transport. */
export interface BotDaemonCommandOptions {
	readonly eventSources?: AwayEventSourceFactory;
	readonly channelProviders?: AwayChannelProviderFactory;
}

export function runBotDaemonCommand(args: readonly string[], options: BotDaemonCommandOptions = {}): Promise<number> {
	const [agentDir, token] = args;
	if (args.length === 1 && agentDir && isAbsolute(agentDir)) return runServiceBotDaemon(agentDir, options);
	if (args.length !== 2 || !agentDir || !isAbsolute(agentDir) || !token || !isDaemonLeaseToken(token))
		return Promise.resolve(2);
	return runClaimedBotDaemon(agentDir, token, options);
}

function writeDiagnostic(message: string): void {
	process.stderr.write(`${message}\n`);
}

async function runServiceBotDaemon(agentDir: string, options: BotDaemonCommandOptions): Promise<number> {
	const clock = SYSTEM_TIMER_SOURCE.port("routines");
	const store = new PersistentBotTeamStore(agentDir, writeDiagnostic);
	if (process.platform === "win32") {
		try {
			const launch = launchDetachedBotDaemon({ store, clock, cwd: agentDir, warn: writeDiagnostic });
			if (launch.held) return 0;
			if (!launch.started) {
				writeDiagnostic(launch.detail);
				return 1;
			}
			// The claim replaced the failed end, and the daemon launched with a token gets no previous end: the failure
			// becomes its first report, as on POSIX.
			if (launch.token !== undefined && launch.previousEnd?.reason === "failed") {
				try {
					store.recordDaemonReports(launch.token, [
						{ at: clock.now(), message: previousDaemonFailureReport(launch.previousEnd) },
					]);
				} catch (error) {
					writeDiagnostic(
						`The previous daemon's failure was not recorded: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			// This process exits once it returns: the daemon must have spawned (a failed spawn releases its claim first)
			// and hold its stdin handover before then.
			return (await launch.handedOver) === false ? 1 : 0;
		} finally {
			store.dispose();
		}
	}
	let claim: BotDaemonLeaseClaim;
	try {
		claim = claimBotDaemonLease(store, clock);
	} finally {
		store.dispose();
	}
	if (!claim.claimed) return 0;
	return runClaimedBotDaemon(agentDir, claim.token, {
		...options,
		...(claim.previousEnd ? { previousEnd: claim.previousEnd } : {}),
	});
}

function runClaimedBotDaemon(
	agentDir: string,
	token: string,
	options: BotDaemonCommandOptions & { readonly previousEnd?: BotDaemonEnd },
): Promise<number> {
	// One credential owner for the whole process: every parent hosted away shares this store and registry.
	const authStorage = AuthStorage.create(configFile(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, configFile(agentDir, "models.json"));
	const run = startBotDaemon({
		agentDir,
		token,
		timers: SYSTEM_TIMER_SOURCE,
		owner: ownProcessOwner(),
		authStorage,
		modelRegistry,
		...(options.eventSources ? { eventSources: options.eventSources } : {}),
		...(options.channelProviders ? { channelProviders: options.channelProviders } : {}),
		...(options.previousEnd ? { previousEnd: options.previousEnd } : {}),
	});
	process.once("SIGTERM", () => void run.stop());
	process.once("SIGINT", () => void run.stop());
	// An error nothing caught ends the daemon with its terminal record instead of a silent exit. The handlers stay for
	// the whole stop: a second error while stopping joins the same idempotent stop instead of crashing it.
	process.on("uncaughtException", (error) => void run.stop({ reason: "failed", detail: errorText(error) }));
	process.on("unhandledRejection", (reason) => void run.stop({ reason: "failed", detail: errorText(reason) }));
	return run.exited;
}
