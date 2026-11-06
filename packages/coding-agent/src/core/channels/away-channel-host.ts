/**
 * The daemon's channels while no session is open: one headless session per `channels.<name>.awayCwd` the owner wrote in
 * the global settings, serving those channels through the same `SessionChannels` an open session runs.
 *
 * The session reads and reports, as every run away does: it is a child session (no memory, no routines, no proactive
 * work, no owner decisions), System One is off, and its tools are read-only and reach only its working directory, never
 * the agent directory or the private paths every lane is denied (`privatePathScope`). A channel's message is a third party's
 * words there exactly as in an open session: the origin gate applies, and the reply waits as a draft unless the owner
 * set `replyMode: "auto"`. Drafts wait for the owner's next session, which is told of them.
 *
 * An open session takes a channel over at once (`SessionChannels.takeHold`); this host stops its provider, and a turn
 * it was running ends as a draft. When the session gives the channel up, the journal's change wakes this host
 * (a watch on the journal directory, and the daemon's tick for a session whose process ended), which takes it back.
 *
 * Every turn is bounded twice: by the channel's own daily bounds and by the away spend bound the daemon's routines run
 * under (`routines.away.maxUsdPerRun` per turn, `routines.away.maxUsdPerDay` across both). A host that cannot serve
 * (no priced model, no provider, routines away off) leaves the messages with their transport.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentSession } from "../agent-session.ts";
import type { AuthStorage } from "../auth-storage.ts";
import type { ChannelProvider } from "../gateways/channel-provider.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { isProcessAlive } from "../process-liveness.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { type RoutineOccurrence, routineAwaySpendRoom } from "../routines/routine-contract.ts";
import { createAgentSession } from "../sdk.ts";
import { SettingsManager } from "../settings-manager.ts";
import type { TimerSource } from "../util/timer-port.ts";
import { AWAY_CHANNEL_SPEND_REFUSAL, type AwayChannel, awayChannels, readAwayChannelCharges } from "./away-channels.ts";
import { ChannelJournal } from "./channel-journal.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import { SessionChannels } from "./session-channels.ts";

/** The tools a channel turn away may call: it reads the working directory and answers. */
const AWAY_CHANNEL_TOOLS = ["read", "grep", "find", "ls"];

/** Whether `child` is `parent` or inside it. */
function isWithin(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The transport of a channel the daemon serves; undefined when it has none for that name. */
export type AwayChannelProviderFactory = (
	channel: string,
	policy: ResolvedChannelPolicy,
	deps: { readonly agentDir: string; readonly warn: (message: string) => void },
) => ChannelProvider | undefined;

export interface AwayChannelHostsInput {
	readonly agentDir: string;
	/** The daemon's global-only settings, reloaded by its tick: the channel policies and the away bounds. */
	readonly settings: SettingsManager;
	readonly timers: TimerSource;
	readonly providers: AwayChannelProviderFactory;
	/** The routine runs away charged on the same bound. */
	routineOccurrences(): Iterable<RoutineOccurrence>;
	readonly authStorage?: AuthStorage;
	readonly modelRegistry?: ModelRegistry;
	/** Diagnostics, once per cause. */
	report(message: string): void;
}

/** One working directory's headless session and the channels it serves. */
interface AwayChannelHost {
	readonly cwd: string;
	readonly session: AgentSession;
	readonly channels: SessionChannels;
	readonly registered: Set<string>;
	readonly unsubscribe: () => void;
	/** Who held each served channel when last read: a change is what starts or stops a provider. */
	holders: string;
}

export class AwayChannelHosts {
	private readonly input: AwayChannelHostsInput;
	private readonly hosts = new Map<string, AwayChannelHost>();
	/** Working directories whose host is being opened, so a sync during the open opens none twice; a close joins them. */
	private readonly opening = new Map<string, Promise<void>>();
	/** Why a directory's host was refused, with the model setting that refusal was for. */
	private readonly refused = new Map<string, { readonly model: string; readonly reason: string }>();
	private readonly reported = new Set<string>();
	private watcher: FSWatcher | undefined;
	private closed = false;

	constructor(input: AwayChannelHostsInput) {
		this.input = input;
	}

	private report(message: string): void {
		if (this.reported.has(message)) return;
		this.reported.add(message);
		this.input.report(message);
	}

	/** The away spend bound's reason to deliver no turn now, across routine runs and every channel's turns away. */
	private capReason(nowMs: number): string | undefined {
		const away = this.input.settings.getRoutineAwaySettings();
		const room = routineAwaySpendRoom(
			this.input.routineOccurrences(),
			{
				maxUsdPerRun: away.maxUsdPerRun,
				maxUsdPerDay: away.maxUsdPerDay,
				otherCharges: readAwayChannelCharges(this.input.agentDir, away.maxUsdPerRun, nowMs),
			},
			nowMs,
		);
		return room.fits(0) ? undefined : AWAY_CHANNEL_SPEND_REFUSAL;
	}

	/** The configured model a refusal is for: a change of it is worth another open. */
	private modelSetting(): string {
		return `${this.input.settings.getDefaultProvider() ?? ""}/${this.input.settings.getDefaultModel() ?? ""}`;
	}

	/**
	 * Follow the settings and the journals: open a host for each configured directory, close one no channel names any
	 * more, register providers for newly named channels, and re-read holders that changed. Called at start and on each
	 * daemon tick after the settings reload.
	 */
	sync(): void {
		if (this.closed) return;
		const wanted = new Map<string, AwayChannel[]>();
		for (const channel of awayChannels(this.input.settings)) {
			const group = wanted.get(channel.cwd) ?? [];
			group.push(channel);
			wanted.set(channel.cwd, group);
		}
		if (wanted.size > 0) this.ensureWatch();
		for (const [cwd, host] of this.hosts)
			if (!wanted.has(cwd)) {
				this.hosts.delete(cwd);
				this.closeHost(host).catch((error: unknown) =>
					this.input.report(
						`Channels away in ${cwd}: the session did not close cleanly (${error instanceof Error ? error.message : String(error)}).`,
					),
				);
			}
		for (const [cwd, channels] of wanted) {
			const host = this.hosts.get(cwd);
			if (host) {
				this.registerProviders(host, channels);
				this.refreshHolders(host);
				continue;
			}
			const refusal = this.refused.get(cwd);
			if (refusal && refusal.model === this.modelSetting()) continue;
			if (!this.opening.has(cwd))
				this.opening.set(
					cwd,
					this.openHost(cwd, channels).finally(() => this.opening.delete(cwd)),
				);
		}
	}

	/** Who holds each of the host's channels now; a holder's process ending counts as a change. */
	private holderKey(host: AwayChannelHost): string {
		return [...host.registered]
			.map((name) => {
				const holder = new ChannelJournal(this.input.agentDir, name).read().result.holder;
				return holder ? `${name}=${holder.sessionId}:${holder.pid}:${isProcessAlive(holder.pid)}` : `${name}=`;
			})
			.join(",");
	}

	private refreshHolders(host: AwayChannelHost): void {
		const key = this.holderKey(host);
		if (key === host.holders) return;
		host.holders = key;
		host.channels.refresh();
	}

	private ensureWatch(): void {
		if (this.watcher || this.closed) return;
		const dir = join(this.input.agentDir, "channels");
		try {
			mkdirSync(dir, { recursive: true });
			this.watcher = watch(dir, { persistent: false }, () => {
				for (const host of this.hosts.values()) this.refreshHolders(host);
			});
			// A watch that fails later leaves the daemon's tick, which re-reads the holders within one interval.
			this.watcher.on("error", () => {
				this.watcher?.close();
				this.watcher = undefined;
			});
		} catch (error) {
			this.report(
				`Channels away: the journal directory cannot be watched (${error instanceof Error ? error.message : String(error)}); a session closing is seen at the next daemon tick.`,
			);
		}
	}

	private registerProviders(host: AwayChannelHost, channels: readonly AwayChannel[]): void {
		for (const { name, policy } of channels) {
			if (host.registered.has(name)) continue;
			let provider: ChannelProvider | undefined;
			try {
				provider = this.input.providers(name, policy, {
					agentDir: this.input.agentDir,
					warn: (message) => this.input.report(`Channel ${name}: ${message}`),
				});
			} catch (error) {
				this.report(
					`Channel ${name} is not served while no session is open: its transport could not be built (${error instanceof Error ? error.message : String(error)}).`,
				);
				continue;
			}
			if (!provider) {
				this.report(
					`Channel ${name} is not served while no session is open: the daemon has no transport for it; its messages wait for an open session.`,
				);
				continue;
			}
			host.registered.add(name);
			host.channels.registerChannel(provider);
		}
	}

	/** Never rejects: a failure is reported and refused until the model setting changes. */
	private async openHost(cwd: string, channels: readonly AwayChannel[]): Promise<void> {
		const { agentDir, timers } = this.input;
		const model = this.modelSetting();
		let session: AgentSession | undefined;
		const sessionManager = SessionManager.inMemory(cwd);
		try {
			// The directory's own owner-written layers decide the session's model, as for a parent opened away.
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				installMissingPackages: false,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			session = (
				await createAgentSession({
					cwd,
					agentDir,
					...(this.input.authStorage ? { authStorage: this.input.authStorage } : {}),
					...(this.input.modelRegistry ? { modelRegistry: this.input.modelRegistry } : {}),
					settingsManager,
					resourceLoader,
					sessionManager,
					isChildSession: true,
					disableSystemOne: true,
					tools: AWAY_CHANNEL_TOOLS,
					// A third party's turn reads the working directory only, never the harness's own storage (credentials,
					// settings, memory, sessions, channel tokens and journals), wherever the directory is.
					privatePathScope: {
						allowedPaths: [cwd],
						deniedPaths: isWithin(agentDir, cwd) ? [] : [agentDir],
					},
					timers,
					onClosingWarnings: (warnings) => {
						for (const warning of warnings) this.input.report(`Channels away: ${warning}`);
					},
				})
			).session;
			const sessionModel = session.model;
			const refusal = !sessionModel
				? "no model is configured"
				: sessionModel.costDefaulted
					? `the model ${sessionModel.provider}/${sessionModel.id} has no price, so its spend cannot be bounded`
					: undefined;
			if (refusal || this.closed) {
				await session.disposeAndWait();
				if (refusal) {
					this.refused.set(cwd, { model, reason: refusal });
					this.report(
						`Channels ${channels.map((channel) => channel.name).join(", ")} are not served while no session is open: ${refusal}. Their messages wait for an open session.`,
					);
				}
				return;
			}
			this.refused.delete(cwd);
			this.hosts.set(cwd, this.startHost(cwd, session, sessionManager, channels));
		} catch (error) {
			if (session) await session.disposeAndWait().catch(() => undefined);
			this.refused.set(cwd, { model, reason: error instanceof Error ? error.message : String(error) });
			this.report(
				`Channels away in ${cwd} could not open a session (${error instanceof Error ? error.message : String(error)}); their messages wait for an open session.`,
			);
		}
	}

	private startHost(
		cwd: string,
		session: AgentSession,
		sessionManager: SessionManager,
		channels: readonly AwayChannel[],
	): AwayChannelHost {
		const { agentDir, settings } = this.input;
		const activity = new Set<() => void>();
		let turnUsd = 0;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") turnUsd = 0;
			else if (event.type === "message_end" && event.message.role === "assistant") {
				// One turn's spend bound, as one run away's: past it the turn ends and its conversation gets no reply.
				turnUsd += event.message.usage?.cost?.total ?? 0;
				const perRun = settings.getRoutineAwaySettings().maxUsdPerRun;
				if (turnUsd > perRun)
					void session.abort(`a channel turn away spent past routines.away.maxUsdPerRun ($${perRun.toFixed(2)})`);
			} else if (event.type === "agent_end") for (const listener of activity) listener();
		});
		const notices = new Map<string, string>();
		const channelsHost = new SessionChannels({
			getAgentDir: () => agentDir,
			getSessionManager: () => sessionManager,
			getChannelPolicies: () => {
				const served = new Set(
					awayChannels(settings)
						.filter((channel) => channel.cwd === cwd)
						.map((channel) => channel.name),
				);
				return new Map([...settings.getAwayChannelPolicies()].filter(([name]) => served.has(name)));
			},
			subscribeSettings: (listener) => settings.subscribeChanges(listener),
			subscribeForegroundActivity: (listener) => {
				activity.add(listener);
				return () => activity.delete(listener);
			},
			sendUserMessage: (text, options) => session.sendUserMessage(text, options),
			// No owner reads this session: what it would tell them goes to the daemon's reports, once per state.
			observeNotice: (kind, read) => {
				const observation = read();
				if (!observation || observation === "clear") return;
				const scoped = "scope" in observation ? observation : { scope: "", state: observation };
				if (scoped.state === "clear") return;
				const key = `${kind}:${scoped.scope}`;
				if (notices.get(key) === scoped.state.reason) return;
				notices.set(key, scoped.state.reason);
				this.input.report(scoped.state.text);
			},
			warn: (message) => this.input.report(message),
			isDisposed: () => this.closed,
			isChildSession: () => false,
			away: { capReason: (nowMs) => this.capReason(nowMs) },
		});
		const host: AwayChannelHost = {
			cwd,
			session,
			channels: channelsHost,
			registered: new Set(),
			unsubscribe,
			holders: "",
		};
		this.registerProviders(host, channels);
		channelsHost.start();
		host.holders = this.holderKey(host);
		return host;
	}

	private async closeHost(host: AwayChannelHost): Promise<void> {
		try {
			await host.channels.stop();
		} finally {
			host.unsubscribe();
			await host.session.disposeAndWait();
		}
	}

	/** Stop every provider, give every channel back and close the sessions. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.watcher?.close();
		this.watcher = undefined;
		await Promise.all(this.opening.values());
		const hosts = [...this.hosts.values()];
		this.hosts.clear();
		const failures: unknown[] = [];
		for (const host of hosts) {
			try {
				await this.closeHost(host);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "The daemon's channel hosts did not close cleanly.");
	}
}
