/**
 * A root session's keeping of the detached bot daemon (`bot-daemon.ts`): brings it up by itself, with no command, while
 * there is away work for it (enabled routines, channels served away, and bots owed work no process hosts while away work
 * is on) and no daemon holds the lease (or the one holding it is of an older build: an upgrade replaces it), re-ensures it
 * when the lease it last saw would stop being held, with a backoff after a failed ensure, and when bots are let go (by
 * another host, or every bot its process hosted at its detach), reconciles the always-on install where the session owns
 * the host duties, records the environment its directory's watched commands start from for the daemon
 * (`watch-command-base.ts`), reports its status, and starts or stops it on the owner's command. A reason the daemon
 * cannot start is reported once until it changes. Only a root session whose routine runtime runs in the session scope
 * keeps a daemon; a worker process and a session whose channels the daemon serves never do.
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import { errorText } from "../bots/bot-error-text.ts";
import { botFailureCause } from "../bots/bot-failure-words.ts";
import { awayChannels, awayChannelsKey } from "../channels/away-channels.ts";
import { interfaceText } from "../language/interface-text.ts";
import { readHubConfig } from "../remote/registry.ts";
import type { AwayService } from "../routines/away-service.ts";
import { getSessionRole } from "../session-role.ts";
import { resolveAutonomySettings } from "../settings/autonomy-edge-settings.ts";
import { resolveRoutineAwaySettings } from "../settings/proactivity-lane-settings.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { alarmAt, type TimerPort, type WallAlarm } from "../util/timer-port.ts";
import { recordWatchCommandBase } from "../watches/watch-command-base.ts";
import { type BotDaemonLaunchResult, launchDetachedBotDaemon } from "./bot-daemon-launch.ts";
import { type BotDaemonStopResult, stopDetachedBotDaemon } from "./bot-daemon-stop.ts";
import {
	DAEMON_STALE_MS,
	type DaemonBotsOwed,
	daemonRecheckAt,
	isOlderDaemonBuild,
	OWN_DAEMON_BUILD,
} from "./bot-team-routine-helpers.ts";
import type { PersistentBotDaemonStatus, PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

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
	/**
	 * How many bots no process hosts are owed work the daemon takes up (`BotSessionHost.botsOwed`), read from the host the
	 * session attached to; throws when the bots do not list.
	 */
	botsOwed(goalsContinue: boolean): number;
	warn(message: string): void;
}

export class BotDaemonKeeper {
	private readonly ports: BotDaemonKeeperPorts;
	/** The routine revision the daemon was last ensured for: a save moves it, the store's other writes do not. */
	private revision: number | undefined;
	/** The last reason the daemon could not be started by itself, reported once until it changes. */
	private startFailure: string | undefined;
	/** Why the bots owed work last did not count (`botFailureCause`), told once until they count or the cause changes. */
	private countFailure: string | undefined;
	/** The lease token of the daemon this runtime last launched: one it never replaces for its build. */
	private launchedToken: string | undefined;
	/** The one alarm that re-ensures the daemon when the lease this session last saw would no longer be held. */
	private recheck: WallAlarm | undefined;
	/** Consecutive ensures that could not bring the daemon up: the backoff of the next re-ensure. */
	private ensureFailures = 0;
	/** The channels served away (name and directory) the daemon was last ensured for: a settings change naming others ensures it again. */
	private channelsKey: string | undefined;
	private awayEnabled: boolean | undefined;
	/** Whether the owner was told the bots' owed work waits for a session because away work is off: once, until none is owed. */
	private awayOffTold = false;
	/** An ensure is queued for the bots another host let go: one for the whole batch. */
	private letGoQueued = false;

	constructor(ports: BotDaemonKeeperPorts) {
		this.ports = ports;
	}

	/** Whether a routine was saved, by this session or any other process, since the daemon was last ensured. */
	routinesChanged(): boolean {
		return this.ports.builtStore()?.getRoutineRevision() !== this.revision;
	}

	/** Whether the channels served away changed since the daemon was last ensured. */
	awayChannelsChanged(): boolean {
		return this.awayOn() !== this.awayEnabled || awayChannelsKey(this.ports.settings()) !== this.channelsKey;
	}

	/**
	 * Brings the detached daemon up by itself, with no command: at session start and on every routine save, while an
	 * enabled routine, a channel served away (`channels.<name>.awayCwd`) or, while away work is on, a bot owed work no
	 * process hosts (`awayBots`) exists and no daemon holds the lease, or the
	 * one holding it is of an older build (an upgrade replaces it; one of the same or a newer build is left alone). The
	 * claim is idempotent across sessions and processes, so only one start launches. A worker process never starts one.
	 * A reason the daemon cannot start is reported once. The same points apply `routines.away.autostart` (see
	 * `away-service.ts`), for the same work.
	 *
	 * Every ensure that finds away work arms one alarm at the instant the lease it saw (or its fresh claim) stops being
	 * held; the alarm runs this again (`recheck`: without the always-on reconcile), so a daemon that died mid-session is
	 * relaunched by that expiry instead of waiting for a save or settings change, and so does a host letting bots go
	 * (`botsLetGo`). A failed ensure backs off on the same alarm, and so does an ensure whose bots owed work did not count
	 * (`awayBots`), whatever else it found: the bots may be owed work, so they are counted again.
	 */
	ensure(recheck = false): void {
		const { ports } = this;
		const store = ports.isDisposed() ? undefined : this.keptStore();
		if (!store) return;
		this.revision = store.getRoutineRevision();
		const clock = ports.clock();
		const { awayWork, failure, botsUncounted, leaseHeldUntil } = this.bringUp(store, clock);
		const failed = failure !== undefined || botsUncounted;
		this.arm(awayWork > 0 || botsUncounted ? this.nextCheckAt(clock.now(), failed, leaseHeldUntil) : undefined);
		if (recheck) return;
		try {
			if (ports.ownsHostDuties()) ports.awayService().reconcile(awayWork);
		} catch (error) {
			ports.warn(
				`Always-on routines could not be checked: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * The session started its routines: the environment a watched command starts from in its directory is recorded for the
	 * daemon (`recordWatchCommandBase`; a record that could not be written is told), and the daemon ensured.
	 */
	sessionStarted(): void {
		const store = this.ports.isDisposed() ? undefined : this.keptStore();
		if (store) {
			const failure = recordWatchCommandBase(store.getAgentDir(), this.ports.cwd());
			if (failure !== undefined)
				this.ports.warn(interfaceText().botTeam.watchBaseNotRecorded(this.ports.cwd(), failure));
		}
		this.ensure();
	}

	/**
	 * Bots were let go. By another host, while this session runs: the daemon is ensured once for the whole batch, as a
	 * re-ensure (no always-on reconcile). At this session's detach (`detaching`), its process's host stopped and let every
	 * bot it hosted go: the daemon is brought up at once, with no re-ensure armed (the session is closing; a root that stays
	 * keeps re-ensuring it). Never throws.
	 */
	botsLetGo(detaching: boolean): void {
		if (detaching) {
			const store = this.keptStore();
			if (store) this.bringUp(store, this.ports.clock());
			return;
		}
		if (this.letGoQueued) return;
		this.letGoQueued = true;
		queueMicrotask(() => {
			this.letGoQueued = false;
			this.ensure(true);
		});
	}

	/**
	 * The daemon's lease and routine counts, read again from disk, with the bots owed work no process hosts and whether the
	 * daemon takes them up (away work on, `awayBots`), or why they could not be counted: the lease is shown either way.
	 */
	status(): PersistentBotDaemonStatus {
		const store = this.ports.store();
		store.reload();
		const botsOwed = this.botsOwedStatus();
		return { ...store.getDaemonStatus(this.ports.clock().now()), botsOwed };
	}

	/** The bots owed work no process hosts, counted as the daemon takes them up (`awayBots`), or why they did not count. */
	botsOwedStatus(): DaemonBotsOwed {
		const awayOn = this.awayOn();
		try {
			return { awayOn, count: this.ports.botsOwed(this.goalsContinue()) };
		} catch (error) {
			return { awayOn, unread: error instanceof Error ? error.message : String(error) };
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

	/** The built bot store, where this session keeps the daemon: a root's, not a worker's, nor one the daemon serves. */
	private keptStore(): PersistentBotTeamStore | undefined {
		const { ports } = this;
		const store = ports.builtStore();
		if (!store || getSessionRole() === "worker" || ports.channelsHostedByDaemon() || !ports.keepsDaemon())
			return undefined;
		return store;
	}

	/**
	 * Launches the daemon while there is away work and no daemon holds the lease, or the one holding it is of an older build
	 * this runtime did not launch: the away work found, the reason it could not start (told once until it changes), whether
	 * the bots owed work did not count (`awayBots`: told on its own, the rest counted all the same) and when the lease left
	 * behind stops being held (absent when nothing is read).
	 */
	private bringUp(
		store: PersistentBotTeamStore,
		clock: TimerPort,
	): { awayWork: number; failure: string | undefined; botsUncounted: boolean; leaseHeldUntil: number | undefined } {
		const { ports } = this;
		let failure: string | undefined;
		// The bots owed work are counted in a step of their own: a count that fails never keeps routines and channels down.
		const bots = this.awayBots();
		// Enabled routines, channels served away and bots owed work: any keeps the daemon, and the always-on service, wanted.
		let awayWork = 0;
		let leaseHeldUntil: number | undefined;
		try {
			const status = store.getDaemonStatus(clock.now());
			const lastRenewedAt = status.lastHeartbeatAt ?? (status.startedAt ? Date.parse(status.startedAt) : Number.NaN);
			if (status.running && Number.isFinite(lastRenewedAt)) leaseHeldUntil = lastRenewedAt + DAEMON_STALE_MS;
			this.channelsKey = awayChannelsKey(ports.settings());
			this.awayEnabled = this.awayOn();
			const hub = this.awayEnabled && readHubConfig(store.getAgentDir())?.enabled;
			awayWork = status.activeRoutines + awayChannels(ports.settings()).length + (hub ? 1 : 0) + (bots ?? 0);
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
		return { awayWork, failure, botsUncounted: bots === undefined, leaseHeldUntil };
	}

	/**
	 * The bots owed work the daemon takes up (`botsOwed`), counted only while away work is on (`routines.away.enabled`):
	 * with it off the daemon hosts no bot, none is counted, and the owner is told once, until none is owed, that their work
	 * waits for a session opening where they work. Undefined when they do not count (the bots or the root hosts' records do
	 * not list): told once per cause (`botsOwedNotCounted`), until they count again.
	 */
	private awayBots(): number | undefined {
		let owed: number;
		try {
			owed = this.ports.botsOwed(this.goalsContinue());
		} catch (error) {
			const cause = botFailureCause("count-bots-owed", "", error);
			if (cause !== this.countFailure) this.ports.warn(interfaceText().botTeam.botsOwedNotCounted(errorText(error)));
			this.countFailure = cause;
			return undefined;
		}
		this.countFailure = undefined;
		if (this.awayOn()) {
			this.awayOffTold = false;
			return owed;
		}
		if (owed > 0 && !this.awayOffTold) this.ports.warn(interfaceText().botTeam.botsOwedAwayOff(owed));
		this.awayOffTold = owed > 0;
		return 0;
	}

	/**
	 * Whether away work is on (`routines.away.enabled`) as the daemon reads it, from the owner's global settings alone: no
	 * project's settings turn the daemon's bot hosting on or off.
	 */
	private awayOn(): boolean {
		return resolveRoutineAwaySettings(this.ports.settings().getGlobalSettings()).enabled;
	}

	/**
	 * Whether the daemon continues a bot's unfinished goal on its own (`autonomy.goalAutoContinue`), read as it reads it,
	 * from the owner's global settings alone: a bot owed only its goal is counted for it only then.
	 */
	private goalsContinue(): boolean {
		return resolveAutonomySettings(this.ports.settings().getGlobalSettings()).goalAutoContinue;
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
