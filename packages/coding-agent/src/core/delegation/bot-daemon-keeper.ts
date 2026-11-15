/**
 * A root session's keeping of the detached bot daemon (`bot-daemon.ts`): brings it up by itself, with no command, while
 * there is away work for it and no daemon holds the lease (or the one holding it is of an older build: an upgrade
 * replaces it), re-ensures it when the lease it last saw would stop being held, with a backoff after a failed ensure,
 * reconciles the always-on install where the session owns the host duties, and starts or stops it on the owner's
 * command. A reason the daemon cannot start is reported once until it changes. Only a root session whose routine runtime
 * runs in the session scope keeps a daemon; a worker process and a session whose channels the daemon serves never do.
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import { awayChannels, awayChannelsKey } from "../channels/away-channels.ts";
import type { AwayService } from "../routines/away-service.ts";
import { getSessionRole } from "../session-role.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { alarmAt, type TimerPort, type WallAlarm } from "../util/timer-port.ts";
import { type BotDaemonLaunchResult, launchDetachedBotDaemon } from "./bot-daemon-launch.ts";
import { type BotDaemonStopResult, stopDetachedBotDaemon } from "./bot-daemon-stop.ts";
import { DAEMON_STALE_MS, daemonRecheckAt, isOlderDaemonBuild, OWN_DAEMON_BUILD } from "./bot-team-routine-helpers.ts";
import type { PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

/** What the keeper reads from its root session; every port is read when used, never at construction. */
export interface BotDaemonKeeperPorts {
	/** The bot store once the session built it; an ensure never builds it. */
	builtStore(): PersistentBotTeamStore | undefined;
	/** The bot store, built on first use: a start or stop goes through it. */
	store(): PersistentBotTeamStore;
	settings(): SettingsManager;
	/** The routines' clock: the lease is read and the re-ensure armed on it. */
	clock(): TimerPort;
	cwd(): string;
	isDisposed(): boolean;
	/** Whether the session's routine runtime runs in the session scope (a root's), the only one that keeps a daemon. */
	keepsDaemon(): boolean;
	/** The daemon's channel host serves this session's channels: it never launches or reconciles the daemon. */
	channelsHostedByDaemon(): boolean;
	/** Whether the session's standing owns the host duties: only then is the always-on install reconciled. */
	ownsHostDuties(): boolean;
	awayService(): AwayService;
	warn(message: string): void;
}

export class BotDaemonKeeper {
	private readonly ports: BotDaemonKeeperPorts;
	/** The routine revision the daemon was last ensured for: a save moves it, the store's other writes do not. */
	private revision: number | undefined;
	/** The last reason the daemon could not be started by itself, reported once until it changes. */
	private startFailure: string | undefined;
	/** The lease token of the daemon this runtime last launched: one it never replaces for its build. */
	private launchedToken: string | undefined;
	/** The one alarm that re-ensures the daemon when the lease this session last saw would no longer be held. */
	private recheck: WallAlarm | undefined;
	/** Consecutive ensures that could not bring the daemon up: the backoff of the next re-ensure. */
	private ensureFailures = 0;
	/** The channels served away (name and directory) the daemon was last ensured for: a settings change naming others ensures it again. */
	private channelsKey: string | undefined;

	constructor(ports: BotDaemonKeeperPorts) {
		this.ports = ports;
	}

	/** Whether a routine was saved, by this session or any other process, since the daemon was last ensured. */
	routinesChanged(): boolean {
		return this.ports.builtStore()?.getRoutineRevision() !== this.revision;
	}

	/** Whether the channels served away changed since the daemon was last ensured. */
	awayChannelsChanged(): boolean {
		return awayChannelsKey(this.ports.settings()) !== this.channelsKey;
	}

	/**
	 * Brings the detached daemon up by itself, with no command: at session start and on every routine save, while an
	 * enabled routine or a channel served away (`channels.<name>.awayCwd`) exists and no daemon holds the lease, or the
	 * one holding it is of an older build (an upgrade replaces it; one of the same or a newer build is left alone). The
	 * claim is idempotent across sessions and processes, so only one start launches. A worker process never starts one.
	 * A reason the daemon cannot start is reported once. The same points apply `routines.away.autostart` (see
	 * `away-service.ts`), for the same work.
	 *
	 * Every ensure that finds away work arms one alarm at the instant the lease it saw (or its fresh claim) stops being
	 * held; the alarm runs this again (without the always-on reconcile), so a daemon that died mid-session is relaunched
	 * by that expiry instead of waiting for a save or settings change. A failed ensure backs off on the same alarm.
	 */
	ensure(fromAlarm = false): void {
		const { ports } = this;
		const store = ports.builtStore();
		if (!store || ports.isDisposed() || getSessionRole() === "worker" || ports.channelsHostedByDaemon()) return;
		if (!ports.keepsDaemon()) return;
		this.revision = store.getRoutineRevision();
		const clock = ports.clock();
		let failure: string | undefined;
		// Enabled routines and channels served away: either keeps the daemon, and the always-on service, wanted.
		let awayWork = 0;
		// When the lease this ensure leaves behind stops being held; absent when nothing is read.
		let leaseHeldUntil: number | undefined;
		try {
			const status = store.getDaemonStatus(clock.now());
			const lastRenewedAt = status.lastHeartbeatAt ?? (status.startedAt ? Date.parse(status.startedAt) : Number.NaN);
			if (status.running && Number.isFinite(lastRenewedAt)) leaseHeldUntil = lastRenewedAt + DAEMON_STALE_MS;
			this.channelsKey = awayChannelsKey(ports.settings());
			awayWork = status.activeRoutines + awayChannels(ports.settings()).length;
			// A daemon of an older build is replaced (an upgrade), unless this runtime launched it: then the pi on disk is
			// older than this session, and a relaunch would run the same build again.
			const ownLaunch = this.launchedToken !== undefined && store.daemonLeaseBelongsTo(this.launchedToken);
			const replace = status.running && !ownLaunch && isOlderDaemonBuild(status.build, OWN_DAEMON_BUILD);
			// A current always-on install is restarted through its manager, so the new build runs supervised; when that
			// fails (reported once), or without one, the daemon is launched detached.
			const fallback = (reason: string) => {
				ports.warn(`${reason} The daemon is started detached instead.`);
				const started = this.start();
				if (!started.started && !started.held) ports.warn(started.detail);
			};
			if (awayWork > 0 && (!status.running || (replace && !ports.awayService().replaceDaemon(fallback)))) {
				const started = this.start();
				if (!started.started && !started.held) failure = started.detail;
				// A claimed lease is held from its claim until its daemon's first renewal is due.
				else leaseHeldUntil = clock.now() + DAEMON_STALE_MS;
			}
		} catch (error) {
			failure = `Detached bot daemon could not be started: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (failure !== undefined && failure !== this.startFailure) ports.warn(failure);
		this.startFailure = failure;
		this.arm(awayWork > 0 ? this.nextCheckAt(clock.now(), failure !== undefined, leaseHeldUntil) : undefined);
		if (fromAlarm) return;
		try {
			if (ports.ownsHostDuties()) ports.awayService().reconcile(awayWork);
		} catch (error) {
			ports.warn(
				`Always-on routines could not be checked: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Ends the re-ensure alarm: the session is closing. */
	stopRecheck(): void {
		this.arm(undefined);
	}

	/**
	 * Starts the detached bot daemon (see `bot-daemon-launch.ts`). `held`: another daemon already holds the lease. A
	 * previous daemon that ended on an error is reported once, by the start that replaces it.
	 */
	start(): BotDaemonLaunchResult {
		const launch = launchDetachedBotDaemon({
			store: this.ports.store(),
			clock: this.ports.clock(),
			cwd: this.ports.cwd(),
			warn: (message) => this.ports.warn(message),
		});
		if (launch.token !== undefined) this.launchedToken = launch.token;
		return launch;
	}

	/**
	 * Stops the detached daemon and reports what the stop did: the lease it renews is released, and earlier-generation
	 * daemons are retired as on start, signalling only an identity proven on this host (see `bot-daemon-stop.ts`).
	 */
	stop(): BotDaemonStopResult {
		return stopDetachedBotDaemon(this.ports.store(), this.ports.clock());
	}

	/** The instant to re-ensure the daemon: when its lease stops being held, or after a backoff when it could not be brought up. */
	private nextCheckAt(nowMs: number, failed: boolean, leaseHeldUntil: number | undefined): number {
		this.ensureFailures = failed ? this.ensureFailures + 1 : 0;
		return daemonRecheckAt(nowMs, failed, this.ensureFailures, leaseHeldUntil);
	}

	private arm(atMs: number | undefined): void {
		this.recheck?.stop();
		this.recheck = undefined;
		if (atMs === undefined || this.ports.isDisposed()) return;
		this.recheck = alarmAt(this.ports.clock(), atMs, () => {
			this.recheck = undefined;
			harnessLog.info("bots", "the bot daemon lease expiry re-ensured the daemon", {
				failures: this.ensureFailures,
			});
			this.ensure(true);
		});
	}
}
