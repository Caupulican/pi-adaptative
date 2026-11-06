/**
 * The session's automatic work at one instant, read from each owner's own accessors: routines, the away daemon,
 * host-event sources, acting ahead, proactive review, channels, outward drafts, harness notices, knowledge collection,
 * standing grants with the run's authority, System One's configuration, and the recent runs' tool manifests. It is a
 * projection, never a source of truth: it builds no owner, writes nothing, takes nothing a model reported, and decides
 * nothing. A section whose owner is not loaded, or whose read fails, is `unavailable` with the reason; every list is
 * bounded with an omitted count.
 */

import { existsSync } from "node:fs";
import type { SessionEntry, SessionManager } from "../../kernel/node.ts";
import { parentInputOriginalDetails } from "../../kernel/session/parent-input-ledger.ts";
import { outwardDraftStates } from "../agent-session-edge.ts";
import type { EdgeClass, EdgeGrantSource, EdgeGrantView } from "../autonomy/edge-policy.ts";
import type { AwayChannelStatus } from "../channels/away-channels.ts";
import type { ChannelJournalSummary, ChannelRuntimeState, ChannelStateView } from "../channels/session-channels.ts";
import type { DailyUsageTotals } from "../cost/daily-usage.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import type { HostEventConnectionView } from "../events/host-event-contract.ts";
import type { HostEventProjection } from "../events/host-event-state.ts";
import type { ForegroundRecoveryController } from "../foreground-recovery-controller.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE, type HarnessNoticeController, type HarnessNoticeKind } from "../harness-notice.ts";
import type { KnowledgeCollectionStatus } from "../memory/knowledge-collector.ts";
import type { MemoryController } from "../memory-controller.ts";
import { type ActAheadPhase, actAheadRecordOf } from "../proactivity/act-ahead-record.ts";
import {
	type ProactivityDailyState,
	type ProactivityFeedbackView,
	parentTurnWakes,
} from "../proactivity/proactivity-controller.ts";
import type { AwayServiceInspection } from "../routines/away-service.ts";
import {
	ROUTINE_NO_NEXT_RUN_AT,
	type RoutineAwayCharge,
	type RoutineDefinitionView,
	type RoutineOccurrence,
	routineAwaySpendRoom,
	routineEnded,
	routineOpensAt,
} from "../routines/routine-contract.ts";
import type { RoutineIntakeStatus } from "../routines/routine-intake.ts";
import { routineGithubInterests } from "../routines/routine-scheduler-controller.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import type { SessionSemanticPlaneController } from "../session-semantic-plane-controller.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { TurnAuthority, TurnOriginKind } from "../turn-origin.ts";
import type { RunToolManifest } from "./tool-manifest.ts";

/** Items each list keeps; the rest are counted in its `omitted`. */
export const AUTONOMY_STATUS_LIST_LIMIT = 16;

export type StatusSection<T> =
	| { readonly status: "available"; readonly value: T }
	| { readonly status: "unavailable"; readonly reason: string };

export interface BoundedList<T> {
	readonly items: readonly T[];
	readonly omitted?: number;
}

/** Used against its limit over the rolling 24 hours the gate counts. */
export interface DayCount {
	readonly used: number;
	readonly max: number;
}

export interface RoutineStatusItem {
	readonly routineId: string;
	/** `paused-after-failures`: the host paused it; `paused`: the owner did; `ended`: it is never claimed again. */
	readonly state: "enabled" | "paused" | "paused-after-failures" | "ended";
	readonly ended?: "spent" | "condition" | "expired";
	readonly schedule: RoutineDefinitionView["schedule"]["kind"];
	/** Absent for an event routine, an ended one, and a schedule with no slot left. */
	readonly nextRunAt?: number;
	/** The start a `readyBy` window gives `nextRunAt`'s run, when earlier than the slot (no earlier run unfinished). */
	readonly startsFrom?: number;
	readonly lastRunAt?: number;
	readonly lastStatus?: RoutineDefinitionView["lastStatus"];
	readonly awayRefusal?: { readonly reason: string; readonly at: number };
	readonly failurePause?: { readonly after: number; readonly at: number; readonly lastError?: string };
}

export interface RoutinesStatus {
	readonly routines: BoundedList<RoutineStatusItem>;
	/** Routine results delivered as a parent turn, against `routines.maxResultWakesPerDay`. */
	readonly resultWakes: DayCount;
	readonly intake?: RoutineIntakeStatus;
}

export interface AwayDaemonStatusView {
	readonly running: boolean;
	readonly pid?: number;
	readonly lastHeartbeatAt?: number;
	readonly lastTickAt?: number;
	readonly activeRoutines: number;
	readonly dueRoutines: number;
	readonly awayRefusals: BoundedList<{ readonly routineId: string; readonly reason: string; readonly at: number }>;
	readonly lastEnd?: {
		readonly reason: "released" | "signal" | "failed";
		readonly at: number;
		readonly detail?: string;
	};
	/**
	 * `routines.away` as this session resolves it, and the away spend its store records. The daemon itself reads the
	 * global settings only, so a project or profile layer of this session can disagree with the bounds it applies.
	 */
	readonly settings: {
		readonly enabled: boolean;
		readonly maxUsdPerRun: number;
		readonly maxUsdPerDay: number;
		readonly maxParentHosts: number;
	};
	/** Routine runs away and channel turns the daemon delivered while no session was open, on the same bound. */
	readonly spentUsd: number;
	readonly hostedParents: StatusSection<number>;
	/** The channels the global settings name an `awayCwd` for: who serves each now, and the drafts written away. */
	readonly channels: BoundedList<AwayChannelStatus>;
	/** The opt-in always-on service that starts the daemon at login, read from the filesystem. */
	readonly service: StatusSection<AwayServiceInspection>;
}

/**
 * A source is listed only while its runtime runs on one of this session's open bindings and after its first report;
 * `armed`: its last report cleared its wait.
 */
export type HostEventConnectionStatus = HostEventConnectionView;

export interface HostEventLedgerStatus {
	readonly sources: BoundedList<{
		readonly sourceId: string;
		readonly acceptedThrough: number;
		readonly replayFloor: number;
		readonly replayGap: boolean;
		readonly ended?: string;
	}>;
	readonly subscriptions: number;
	readonly deliveries: { readonly reserved: number; readonly pending: number };
}

export interface HostEventsStatus {
	readonly connections: BoundedList<HostEventConnectionStatus>;
	readonly ledger: StatusSection<HostEventLedgerStatus>;
	/** GitHub threads this session's routines ask the CI source to collect. */
	readonly githubInterests: StatusSection<number>;
}

export interface ActAheadStatus {
	readonly enabled: boolean;
	readonly attempts: DayCount;
	readonly spend: DayCount;
	/** Episodes on this branch, newest first, with their latest phase. */
	readonly episodes: BoundedList<{ readonly episode: string; readonly phase: ActAheadPhase; readonly at: string }>;
	/** Patches the episodes saved, with whether the file is still there (nothing records that a patch was applied). */
	readonly readyPatches: BoundedList<{
		readonly episode: string;
		readonly at: string;
		readonly ageMs: number;
		readonly present: boolean;
	}>;
}

export interface ProactiveReviewStatus {
	readonly enabled: boolean;
	readonly delivery: "note" | "turn";
	/** Proactive notes and host events delivered as a parent turn, against `proactivity.maxTurnWakesPerDay`. */
	readonly turnWakes: DayCount;
	readonly reviewSpend: DayCount;
	readonly lastSkipReason?: string;
	readonly daily: ProactivityDailyState;
	/** Topics the owner's replies set aside, each with when it ends: a set-aside topic starts no review. */
	readonly setAside: BoundedList<{ readonly topic: string; readonly label: string; readonly until: number }>;
}

export interface ChannelsStatus {
	readonly channels: BoundedList<{
		readonly name: string;
		readonly state: ChannelRuntimeState;
		readonly detail?: string;
	}>;
	/** Wakes and spend against the daily bounds, and what waits undelivered, per channel with a policy. */
	readonly journal: StatusSection<BoundedList<ChannelJournalSummary>>;
}

export interface OutwardDraftsStatus {
	readonly pending: BoundedList<{
		readonly id: string;
		readonly toolName: string;
		readonly classes: readonly EdgeClass[];
		readonly origin: TurnOriginKind;
		readonly preparedAt: string;
	}>;
	readonly released: number;
	readonly dismissed: number;
}

export interface HarnessNoticesStatus {
	/** Saved notices that wait for the owner's next turn. */
	readonly pending: BoundedList<{ readonly kind: string; readonly reason: string }>;
	/** Observed notices this runtime has not saved yet. */
	readonly unsaved: number;
	readonly observed: BoundedList<{
		readonly kind: HarnessNoticeKind;
		readonly scope?: string;
		readonly observed: string;
	}>;
}

export interface AuthorityStatus {
	readonly run:
		| { readonly state: "idle" }
		| { readonly state: "running"; readonly authority: TurnAuthority; readonly origin?: TurnOriginKind };
	readonly edgeMode: "guarded" | "yolo";
	readonly standingGrants: BoundedList<{
		readonly class: EdgeClass;
		readonly source: EdgeGrantSource;
		readonly scopeKey?: string;
		readonly grantedAt?: string;
		readonly quote?: string;
	}>;
	/** `edge.thirdPartyAllow`: the classes a third party's words may act under. */
	readonly thirdPartyAllow: readonly EdgeClass[];
}

/**
 * Whether System One can judge in this session: `on` with a decision engine bound, `no-engine` when it is configured
 * with none (the configuration fault the POV bar shows as "no engine"), `off` when it is not configured.
 */
export interface SystemOneStatus {
	readonly state: "on" | "no-engine" | "off";
}

export interface SessionAutonomyStatus {
	readonly v: 1;
	readonly at: string;
	readonly sessionId: string;
	readonly routines: StatusSection<RoutinesStatus>;
	readonly awayDaemon: StatusSection<AwayDaemonStatusView>;
	readonly hostEvents: StatusSection<HostEventsStatus>;
	readonly actAhead: StatusSection<ActAheadStatus>;
	readonly proactiveReview: StatusSection<ProactiveReviewStatus>;
	readonly channels: StatusSection<ChannelsStatus>;
	readonly outwardDrafts: StatusSection<OutwardDraftsStatus>;
	readonly harnessNotices: StatusSection<HarnessNoticesStatus>;
	readonly knowledgeCollection: StatusSection<KnowledgeCollectionStatus>;
	readonly authority: StatusSection<AuthorityStatus>;
	readonly systemOne: StatusSection<SystemOneStatus>;
	/** The recent runs' tool manifests, newest first (`tool-manifest.ts`). */
	readonly runs: StatusSection<readonly RunToolManifest[]>;
}

type UsageWindow = Pick<
	DailyUsageTotals,
	| "proactivityCost"
	| "proactiveTurnWakes"
	| "hostEventTurnWakes"
	| "routineResultTurnWakes"
	| "actAheadAttempts"
	| "actAheadUsd"
>;

/** Each owner's own read; an owner that is not loaded is passed as undefined. */
export interface AutonomyStatusSources {
	readonly nowMs: number;
	readonly sessionId: string;
	readonly childSession: boolean;
	readonly sessionManager: Pick<SessionManager, "getBranch" | "getEntry" | "getPendingParentInputs">;
	readonly settings: Pick<
		SettingsManager,
		| "getRoutinesSettings"
		| "getRoutineAwaySettings"
		| "getActAheadSettings"
		| "getProactivitySettings"
		| "getEdgeSettings"
	>;
	/** The gates' rolling-24-hour usage across the owner's sessions. */
	usageWindow(): Promise<UsageWindow>;
	/** The session's loaded routine store, as its own reloads last read it; undefined while it is not loaded. */
	readonly routineStore:
		| Pick<PersistentBotTeamStore, "listRoutines" | "listRoutineOccurrences" | "getDaemonStatus">
		| undefined;
	readonly routineIntake: RoutineIntakeStatus | undefined;
	/** The worker ledger's projection; undefined while the ledger is not loaded. */
	readonly hostEventLedger: HostEventProjection | undefined;
	/** The running host event sources' connections (`HostEventSessionController.connections`). */
	hostEventConnections(): readonly HostEventConnectionView[];
	readonly proactivity: {
		readonly daily: ProactivityDailyState;
		readonly lastSkipReason?: string;
		readonly setAside: () => ProactivityFeedbackView["suppressed"];
	};
	channelStates(): readonly ChannelStateView[];
	channelJournals(): readonly ChannelJournalSummary[];
	/** The channel turns the daemon delivered away, as charges on the away spend bound (journal reads). */
	awayChannelCharges(maxUsdPerRun: number, nowMs: number): readonly RoutineAwayCharge[];
	/** The channels served while no session is open, from the global settings and the journals. */
	awayChannels(): readonly AwayChannelStatus[];
	/** The always-on service's filesystem read; undefined while the routine store it reads is not loaded. */
	readonly awayService: (() => AwayServiceInspection) | undefined;
	readonly harnessNotices: Pick<HarnessNoticeController, "observedStates">;
	readonly memory: Pick<MemoryController, "getKnowledgeCollectionStatus">;
	/** The standing grants (`/edge allow` and `edge.thirdPartyAllow`); undefined where the session supplies none. */
	readonly standingGrants: (() => readonly EdgeGrantView[]) | undefined;
	readonly foregroundRun: Pick<ForegroundRecoveryController, "turnOrigin" | "toolManifests">;
	/** Read from its live getters only: the decision ledger is never opened for it. */
	readonly systemOne: Pick<SessionSemanticPlaneController, "recordingSemanticEngine" | "configured">;
}

function bounded<T>(items: readonly T[], limit = AUTONOMY_STATUS_LIST_LIMIT): BoundedList<T> {
	return items.length > limit
		? { items: items.slice(0, limit), omitted: items.length - limit }
		: { items: [...items] };
}

function text(value: string | undefined): string | undefined {
	return value === undefined ? undefined : boundedRedactedDiagnosticText(value);
}

function available<T>(value: T): StatusSection<T> {
	return { status: "available", value };
}

function unavailable(reason: string): { readonly status: "unavailable"; readonly reason: string } {
	return { status: "unavailable", reason };
}

/** One section's own reader; a read that fails is the section's reason, never the snapshot's failure. */
async function section<T>(read: () => StatusSection<T> | Promise<StatusSection<T>>): Promise<StatusSection<T>> {
	try {
		return await read();
	} catch (error) {
		return unavailable(
			`unreadable: ${text(error instanceof Error ? error.message : String(error)) ?? "unknown error"}`,
		);
	}
}

const NO_STORE = "the routine store is not loaded in this session";

function routineItem(
	routine: RoutineDefinitionView,
	nowMs: number,
	occurrences: readonly RoutineOccurrence[],
): RoutineStatusItem {
	const ended = routineEnded(routine, nowMs);
	const opensAt = routineOpensAt(routine, occurrences);
	const lastError = routine.failurePause ? text(routine.failurePause.lastError) : undefined;
	const awayReason = routine.awayRefusal ? text(routine.awayRefusal.reason) : undefined;
	return {
		routineId: routine.routineId,
		state: ended ? "ended" : routine.enabled ? "enabled" : routine.failurePause ? "paused-after-failures" : "paused",
		...(ended ? { ended } : {}),
		schedule: routine.schedule.kind,
		...(ended || routine.nextRunAt === ROUTINE_NO_NEXT_RUN_AT ? {} : { nextRunAt: routine.nextRunAt }),
		...(ended || opensAt >= routine.nextRunAt ? {} : { startsFrom: opensAt }),
		...(routine.lastRunAt !== undefined ? { lastRunAt: routine.lastRunAt } : {}),
		...(routine.lastStatus ? { lastStatus: routine.lastStatus } : {}),
		...(routine.awayRefusal && awayReason ? { awayRefusal: { reason: awayReason, at: routine.awayRefusal.at } } : {}),
		...(routine.failurePause
			? {
					failurePause: {
						after: routine.failurePause.after,
						at: routine.failurePause.at,
						...(lastError ? { lastError } : {}),
					},
				}
			: {}),
	};
}

function harnessNoticeDetails(entry: SessionEntry | undefined): { kind: string; reason: string } | undefined {
	const details = entry ? parentInputOriginalDetails(entry) : undefined;
	if (typeof details !== "object" || details === null) return undefined;
	const kind = Reflect.get(details, "kind");
	const reason = Reflect.get(details, "reason");
	return typeof kind === "string" && typeof reason === "string" ? { kind, reason } : undefined;
}

/** Reads every section; never throws, builds nothing and writes nothing. */
export async function readSessionAutonomyStatus(sources: AutonomyStatusSources): Promise<SessionAutonomyStatus> {
	const { nowMs, sessionManager, settings, standingGrants } = sources;
	let usage: Promise<UsageWindow> | undefined;
	const day = (): Promise<UsageWindow> => {
		usage ??= sources.usageWindow();
		return usage;
	};
	const store = sources.routineStore;
	const sessionRoutines = (): RoutineDefinitionView[] =>
		(store?.listRoutines() ?? []).filter(
			(routine) => routine.target.kind === "session" && routine.target.parentSessionId === sources.sessionId,
		);
	const branch = sessionManager.getBranch();
	const run = sources.foregroundRun;

	const [routines, awayDaemon, hostEvents, actAhead, proactiveReview] = await Promise.all([
		section<RoutinesStatus>(async () => {
			if (!store) return unavailable(sources.childSession ? "routines do not run in a child session" : NO_STORE);
			const wakes = (await day()).routineResultTurnWakes;
			return available({
				routines: bounded(
					sessionRoutines().map((routine) =>
						routineItem(routine, nowMs, store.listRoutineOccurrences({ routineId: routine.routineId })),
					),
				),
				resultWakes: { used: wakes, max: settings.getRoutinesSettings().maxResultWakesPerDay },
				...(sources.routineIntake ? { intake: sources.routineIntake } : {}),
			});
		}),
		section<AwayDaemonStatusView>(async () => {
			if (!store) return unavailable(NO_STORE);
			const awayService = sources.awayService;
			const service = awayService
				? await section(() => available(awayService()))
				: unavailable("the routine store is not loaded, so the service is not read");
			const daemon = store.getDaemonStatus(nowMs);
			const away = settings.getRoutineAwaySettings();
			const spend = routineAwaySpendRoom(
				store.listRoutineOccurrences(),
				{ ...away, otherCharges: sources.awayChannelCharges(away.maxUsdPerRun, nowMs) },
				nowMs,
			);
			return available({
				running: daemon.running,
				...(daemon.pid !== undefined ? { pid: daemon.pid } : {}),
				...(daemon.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: daemon.lastHeartbeatAt } : {}),
				...(daemon.lastTickAt !== undefined ? { lastTickAt: daemon.lastTickAt } : {}),
				activeRoutines: daemon.activeRoutines,
				dueRoutines: daemon.dueRoutines,
				awayRefusals: bounded(
					daemon.awayRefusals.map((refusal) => ({ ...refusal, reason: text(refusal.reason) ?? "" })),
				),
				...(daemon.lastEnd
					? {
							lastEnd: {
								reason: daemon.lastEnd.reason,
								at: daemon.lastEnd.at,
								...(daemon.lastEnd.detail ? { detail: text(daemon.lastEnd.detail) } : {}),
							},
						}
					: {}),
				settings: {
					enabled: away.enabled,
					maxUsdPerRun: away.maxUsdPerRun,
					maxUsdPerDay: away.maxUsdPerDay,
					maxParentHosts: away.maxParentHosts,
				},
				spentUsd: spend.chargedMicros / 1_000_000,
				hostedParents: unavailable("the away daemon does not record the parents it hosts"),
				channels: bounded(sources.awayChannels()),
				service,
			});
		}),
		section<HostEventsStatus>(() => {
			const connections = sources.hostEventConnections().map((connection) => {
				const reason = text(connection.reason);
				return { source: connection.source, state: connection.state, ...(reason ? { reason } : {}) };
			});
			const ledger = sources.hostEventLedger;
			const sourceStates = ledger ? Object.values(ledger.eventSources) : [];
			const deliveries = ledger ? Object.values(ledger.eventDeliveries) : [];
			return available({
				connections: bounded(connections),
				ledger: ledger
					? available({
							sources: bounded(
								sourceStates.map((source) => ({
									sourceId: source.registration.sourceId,
									acceptedThrough: source.acceptedThrough,
									replayFloor: source.replayFloor,
									replayGap: source.lastReplayGap !== undefined,
									...(source.ended ? { ended: source.ended.reason } : {}),
								})),
							),
							subscriptions: Object.keys(ledger.threadSubscriptions).length,
							deliveries: {
								reserved: deliveries.filter((delivery) => delivery.status === "reserved").length,
								pending: deliveries.filter((delivery) => delivery.status === "pending").length,
							},
						})
					: unavailable("the worker ledger is not loaded in this session"),
				githubInterests: store
					? available(routineGithubInterests(store.listRoutines(), sources.sessionId, nowMs).length)
					: unavailable(NO_STORE),
			});
		}),
		section<ActAheadStatus>(async () => {
			const configured = settings.getActAheadSettings();
			const latest = new Map<string, { phase: ActAheadPhase; at: string }>();
			const ready: { episode: string; at: string; patchPath: string }[] = [];
			for (const entry of branch) {
				const record = actAheadRecordOf(entry);
				if (!record) continue;
				latest.set(record.episode, { phase: record.phase, at: entry.timestamp });
				if (record.phase === "ready" && record.patchPath)
					ready.push({ episode: record.episode, at: entry.timestamp, patchPath: record.patchPath });
			}
			const window = await day();
			return available({
				enabled: configured.enabled,
				attempts: { used: window.actAheadAttempts, max: configured.maxAttemptsPerDay },
				spend: { used: window.actAheadUsd, max: configured.maxUsdPerDay },
				episodes: bounded([...latest].reverse().map(([episode, state]) => ({ episode, ...state }))),
				readyPatches: bounded(
					ready.reverse().map((patch) => ({
						episode: patch.episode,
						at: patch.at,
						ageMs: Math.max(0, nowMs - Date.parse(patch.at)),
						present: existsSync(patch.patchPath),
					})),
				),
			});
		}),
		section<ProactiveReviewStatus>(async () => {
			const configured = settings.getProactivitySettings();
			const window = await day();
			const skip = text(sources.proactivity.lastSkipReason);
			return available({
				enabled: configured.enabled,
				delivery: configured.delivery,
				turnWakes: { used: parentTurnWakes(window), max: configured.maxTurnWakesPerDay },
				reviewSpend: { used: window.proactivityCost, max: configured.maxUsdPerDay },
				...(skip ? { lastSkipReason: skip } : {}),
				daily: sources.proactivity.daily,
				setAside: bounded(
					sources.proactivity.setAside().map((topic) => ({
						topic: text(topic.topic) ?? "",
						label: text(topic.label) ?? "",
						until: topic.until,
					})),
				),
			});
		}),
	]);

	const [channels, outwardDrafts, harnessNotices, knowledgeCollection, authority, runs] = await Promise.all([
		section<ChannelsStatus>(async () =>
			available({
				channels: bounded(
					sources.channelStates().map((channel) => ({
						name: channel.name,
						state: channel.state,
						...(channel.detail ? { detail: text(channel.detail) } : {}),
					})),
				),
				journal: await section(() => available(bounded(sources.channelJournals()))),
			}),
		),
		section<OutwardDraftsStatus>(() => {
			const states = outwardDraftStates(branch, run.turnOrigin.origin()?.k === "owner-typed");
			const pending = states.filter((draft) => draft.state === "pending");
			return available({
				pending: bounded(
					pending.reverse().map(({ record }) => ({
						id: record.id,
						toolName: record.toolName,
						classes: [...new Set(record.operations.map((operation) => operation.class))],
						origin: record.origin.k,
						preparedAt: record.preparedAt,
					})),
				),
				released: states.filter((draft) => draft.state === "released").length,
				dismissed: states.filter((draft) => draft.state === "dismissed").length,
			});
		}),
		section<HarnessNoticesStatus>(() => {
			const pending = sessionManager
				.getPendingParentInputs("next-owner-turn")
				.filter((input) => input.metadata.deliveryId.startsWith(`${HARNESS_NOTICE_CUSTOM_TYPE}:`))
				.flatMap((input) => {
					const details = harnessNoticeDetails(sessionManager.getEntry(input.entryId));
					return details ? [{ kind: details.kind, reason: text(details.reason) ?? "" }] : [];
				});
			const observed = sources.harnessNotices.observedStates();
			return available({
				pending: bounded(pending),
				unsaved: observed.unsaved,
				observed: bounded(
					observed.states.map((state) => ({
						kind: state.kind,
						...(state.scope !== undefined ? { scope: text(state.scope) } : {}),
						observed: text(state.observed) ?? "",
					})),
				),
			});
		}),
		section<KnowledgeCollectionStatus>(() => available(sources.memory.getKnowledgeCollectionStatus())),
		section<AuthorityStatus>(() => {
			if (!standingGrants) return unavailable("the session supplies no edge grants");
			const edge = settings.getEdgeSettings();
			const origin = run.turnOrigin.origin();
			return available({
				run: run.turnOrigin.isActive()
					? { state: "running", authority: run.turnOrigin.authority(), ...(origin ? { origin: origin.k } : {}) }
					: { state: "idle" },
				edgeMode: edge.mode,
				standingGrants: bounded(
					standingGrants().map((grant) => {
						const quote = text(grant.quote);
						return {
							class: grant.class,
							source: grant.source,
							...(grant.scopeKey ? { scopeKey: grant.scopeKey } : {}),
							...(grant.grantedAt ? { grantedAt: grant.grantedAt } : {}),
							...(quote ? { quote } : {}),
						};
					}),
				),
				thirdPartyAllow: [...edge.thirdPartyAllow],
			});
		}),
		section<readonly RunToolManifest[]>(() => available(run.toolManifests.list())),
	]);
	const systemOne = await section<SystemOneStatus>(() =>
		available({
			state: sources.systemOne.recordingSemanticEngine() ? "on" : sources.systemOne.configured ? "no-engine" : "off",
		}),
	);

	return {
		v: 1,
		at: new Date(nowMs).toISOString(),
		sessionId: sources.sessionId,
		routines,
		awayDaemon,
		hostEvents,
		actAhead,
		proactiveReview,
		channels,
		outwardDrafts,
		harnessNotices,
		knowledgeCollection,
		authority,
		systemOne,
		runs,
	};
}
