import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { StringEnum } from "@caupulican/pi-ai/typebox-helpers";
import { type Static, Type } from "typebox";
import type { WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import { parseWorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import {
	CI_TERMINAL_CONCLUSIONS,
	type CiAttemptTerminalEvent,
	type CiTerminalConclusion,
	createGithubThreadEvent,
	GITHUB_THREAD_EVENT_KINDS,
	type GithubThreadEvent,
	type GithubThreadEventKind,
	githubBranchName,
	githubLogin,
	isCiAttemptEvent,
	parseCiAttemptTerminalEvent,
	parseGithubThreadEvent,
} from "../events/host-event-contract.ts";
import {
	type GithubThreadInterest,
	githubInterestMatches,
	HOST_EVENT_LISTENER_LIMITS,
	type HostEventScopeKey,
	hostEventListenerRefusal,
} from "../events/host-event-kinds.ts";
import { workerReceiptOriginFromValue } from "../orchestration/worker-receipt-origin.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import {
	canonicalCalendarCron,
	canonicalCalendarTimeZone,
	isCalendarTimeZone,
	isCalendarTimeZoneName,
	latestCalendarSlotAtOrBefore,
	MAX_CALENDAR_CRON_CHARS,
	MAX_CALENDAR_MISSED_COUNT,
	MAX_CALENDAR_TIME_ZONE_CHARS,
	nextCalendarSlotAfter,
} from "./calendar-schedule.ts";

export const MIN_ROUTINE_INTERVAL_MS = 10_000;
export const MAX_ROUTINE_ID_CHARS = 128;
export const MAX_ROUTINE_COMMAND_ID_CHARS = 64;
export const MAX_ROUTINE_PROMPT_CHARS = 8_000;
export const MAX_ROUTINE_OCCURRENCES = 256;
/**
 * Journal entries one routine may hold that cannot be pruned (active runs, undelivered results, uncertain runs still
 * reconciled). A routine at its share starts no further run until one settles, so no routine can fill the journal.
 */
export const ROUTINE_JOURNAL_SHARE = 32;
/**
 * How long an uncertain run whose uncertainty was delivered stays reconciled against its worker. Past it, the journal
 * prunes it under pressure like a delivered result: a run still unknown after a week will not be found any more.
 */
export const ROUTINE_UNCERTAIN_RETENTION_MS = 7 * 86_400_000;
/** Failed results in a row after which the store pauses the routine in the same write as the last of them. */
export const ROUTINE_FAILURE_PAUSE_THRESHOLD = 3;
/** Consumed manual and event occurrence ids kept after their journal entry is pruned, so neither replays. */
export const MAX_ROUTINE_REPLAY_TOMBSTONES = 2_048;
/** Bound on superseded or coalesced CI attempts one event run reports as missed. */
export const MAX_ROUTINE_EVENT_MISSED_COUNT = 100_000;
export const MAX_ROUTINE_WORKFLOW_PATH_CHARS = 2_048;
export const MAX_ROUTINE_SUMMARY_CHARS = 1_000;
export const MAX_ROUTINE_INSTANT_MS = 8_640_000_000_000_000;
/** `nextRunAt` of a routine with no slot left to place: an event routine, or a schedule that has run out of slots. It is not an instant. */
export const ROUTINE_NO_NEXT_RUN_AT = Number.MAX_SAFE_INTEGER;
export const MAX_ROUTINE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$";
/** Shortest start window: timer and claim latency must never close a window by themselves. */
export const MIN_ROUTINE_START_WINDOW_MS = 60_000;
export const MAX_ROUTINE_LATENESS_MS = 366 * 86_400_000;
/** Consumed owner-intake origins kept after their routine is deleted, so a replay never recreates it. */
export const MAX_ROUTINE_INTAKE_ORIGINS = 2_048;
/** Routines the harness creates from one session's owner turns within {@link ROUTINE_INTAKE_CAP_WINDOW_MS}. */
export const ROUTINE_INTAKE_WINDOW_CAP = 3;
export const ROUTINE_INTAKE_CAP_WINDOW_MS = 86_400_000;
/** Live harness-created routines one session may hold at once. */
export const ROUTINE_INTAKE_LIVE_CAP = 10;
/** Sessions whose intake state is kept; the least recently written leaves first and restarts from the newest source. */
export const MAX_ROUTINE_INTAKE_SESSIONS = 256;
/** Owner sources one intake pass reads at most; later sources wait for the next pass. */
export const MAX_ROUTINE_INTAKE_BATCH_SOURCES = 4;
/** Requests one owner source can yield; more would only meet the session's daily cap. */
export const MAX_ROUTINE_INTAKE_SOURCE_REQUESTS = 2;
/** Host-chosen timing parts recorded per intake request and routine origin, and the bound of each description. */
const MAX_ROUTINE_INTAKE_DEFAULTS = 4;
export const MAX_ROUTINE_INTAKE_TEXT_CHARS = 300;
/** Owner sources routine tool saves answered, kept per session (the newest stay) so intake never reads them. */
export const MAX_ROUTINE_INTAKE_ANSWERED = 64;
/** Decided intake notices one session keeps until its transcript accepted them; the oldest leaves first. */
export const MAX_ROUTINE_INTAKE_UNANNOUNCED = 16;
/** Bound of the owner's words a retained notice shows; the routine itself keeps the whole prompt. */
export const MAX_ROUTINE_INTAKE_NOTICE_PROMPT_CHARS = 600;
/** Every intake spend is accounted under this operation prefix, one operation per pass. */
export const ROUTINE_INTAKE_OPERATION_PREFIX = "routine-intake:";
const MAX_ROUTINE_SOURCE_ID_CHARS = 512;

const expiresAtField = Type.Optional(
	Type.Integer({
		minimum: 0,
		maximum: MAX_ROUTINE_INSTANT_MS,
		description:
			"Optional UTC epoch-ms end, in the future. No new slot or CI attempt is taken at or after it; once work already admitted has finished and been delivered, the routine is removed and the owner is told once. Send a later value to extend it.",
	}),
);

const intervalSchema = Type.Object(
	{
		kind: Type.Literal("interval"),
		intervalMs: Type.Integer({ minimum: MIN_ROUTINE_INTERVAL_MS, maximum: MAX_ROUTINE_INSTANT_MS }),
		expiresAt: expiresAtField,
	},
	{ additionalProperties: false },
);
const onceSchema = Type.Object(
	{
		kind: Type.Literal("once"),
		/** Absolute UTC instant in epoch milliseconds. */
		at: Type.Integer({ minimum: 0, maximum: MAX_ROUTINE_INSTANT_MS }),
		notAfter: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: MAX_ROUTINE_INSTANT_MS,
				description:
					"Optional UTC epoch-ms start deadline, at least one minute after at. If the routine has not started by then it is cancelled and reported instead of run late.",
			}),
		),
	},
	{ additionalProperties: false },
);

const calendarSchema = Type.Object(
	{
		kind: Type.Literal("calendar"),
		cron: Type.String({
			minLength: 9,
			maxLength: MAX_CALENDAR_CRON_CHARS,
			description:
				"Five fields: minute hour day-of-month month day-of-week (0 or 7 is Sunday). Numbers, *, ranges a-b, steps /n and comma lists only. A day field starting with * (including */n) is unrestricted; when neither day field starts with *, either may match, otherwise both must.",
		}),
		timeZone: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_CALENDAR_TIME_ZONE_CHARS,
				description:
					"IANA time zone such as Europe/Lisbon. Omitted: this host's zone on create, the saved zone on update.",
			}),
		),
		maxLatenessMs: Type.Optional(
			Type.Integer({
				minimum: MIN_ROUTINE_START_WINDOW_MS,
				maximum: MAX_ROUTINE_LATENESS_MS,
				description:
					"Optional bound on how late a slot may start. A slot that cannot start within it is skipped and counted as missed by the next run.",
			}),
		),
		expiresAt: expiresAtField,
	},
	{ additionalProperties: false },
);

const eventSchema = Type.Object(
	{
		kind: Type.Literal("event"),
		source: Type.Literal("ci", {
			description: "Completed CI attempts of the checked-out revision.",
		}),
		conclusions: Type.Optional(
			Type.Array(StringEnum(CI_TERMINAL_CONCLUSIONS), {
				minItems: 1,
				maxItems: CI_TERMINAL_CONCLUSIONS.length,
				uniqueItems: true,
				description: 'Attempt conclusions that start a run. Default ["failure"].',
			}),
		),
		workflowPath: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_ROUTINE_WORKFLOW_PATH_CHARS,
				description: "Only attempts of this workflow file, for example .github/workflows/ci.yml.",
			}),
		),
		stopAfterFirstRun: Type.Optional(
			Type.Literal(true, {
				description:
					"Run for the next matching attempt only, for a one-time 'tell me when CI finishes'; the routine is removed once that run's result is delivered.",
			}),
		),
		expiresAt: expiresAtField,
	},
	{ additionalProperties: false },
);

const githubEventSchema = Type.Object(
	{
		kind: Type.Literal("event"),
		source: Type.Literal("github", {
			description:
				"Pull request and issue occurrences of the checked-out repository on GitHub, read through the signed-in gh login.",
		}),
		kinds: Type.Array(StringEnum(GITHUB_THREAD_EVENT_KINDS), {
			minItems: 1,
			maxItems: HOST_EVENT_LISTENER_LIMITS.maxKinds,
			uniqueItems: true,
			description:
				"Occurrences that start a run. Comments, review comments, submitted reviews, merges and closes need a pull request, branch, ownPullRequests or authors scope; review requests and assignments name the signed-in login and need none.",
		}),
		pullRequest: Type.Optional(Type.Integer({ minimum: 1, description: "Only this pull request number." })),
		branch: Type.Optional(
			Type.String({ minLength: 1, maxLength: 255, description: "Only pull requests whose head is this branch." }),
		),
		ownPullRequests: Type.Optional(
			Type.Literal(true, { description: "Only pull requests the signed-in gh login opened." }),
		),
		authors: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 44 }), {
				minItems: 1,
				maxItems: HOST_EVENT_LISTENER_LIMITS.maxAuthors,
				description: "Only occurrences these GitHub logins wrote or did.",
			}),
		),
		stopAfterFirstRun: Type.Optional(
			Type.Literal(true, {
				description:
					"Run for the next matching occurrences only; the routine is removed once that run is delivered.",
			}),
		),
		expiresAt: expiresAtField,
	},
	{ additionalProperties: false },
);

/** Only schedules the host can execute are accepted; calendar rules are validated by the calendar owner. */
export const routineScheduleInputSchema = Type.Union([
	intervalSchema,
	onceSchema,
	calendarSchema,
	eventSchema,
	githubEventSchema,
]);

/** Model-facing authoring input. Recipient and compiled authority are host-owned and absent from this schema. */
export const routineAuthoringSchema = Type.Object(
	{
		routineId: Type.String({ minLength: 1, maxLength: MAX_ROUTINE_ID_CHARS, pattern: MAX_ROUTINE_ID_PATTERN }),
		prompt: Type.String({ minLength: 1, maxLength: MAX_ROUTINE_PROMPT_CHARS }),
		schedule: routineScheduleInputSchema,
	},
	{ additionalProperties: false },
);

export type RoutineScheduleInput = Static<typeof routineScheduleInputSchema>;
export type RoutineAuthoringInput = Static<typeof routineAuthoringSchema>;
export type RoutineCursor =
	| { readonly kind: "interval"; readonly nextIndex: number }
	| { readonly kind: "once"; readonly consumed: boolean }
	/**
	 * Next slot computed when the previous one was claimed; null once no slot is representable.
	 * `skipped` counts slots passed over for lateness since the last run, carried into its missed count.
	 */
	| { readonly kind: "calendar"; readonly nextAt: number | null; readonly skipped?: number }
	/**
	 * Host events up to `throughOrdinal` are decided. `replayGaps` is the digest of the sources' last replay gaps
	 * when last decided; `skipped` counts matching attempts superseded before a decision and `historyGap` records a
	 * new replay gap, both carried into the next run.
	 */
	| {
			readonly kind: "event";
			readonly throughOrdinal: number;
			readonly replayGaps: string;
			readonly skipped?: number;
			readonly historyGap?: true;
			/** A `stopAfterFirstRun` routine has taken its one run. */
			readonly spent?: true;
	  };

export type PersistentRoutineTarget =
	| { readonly kind: "bot"; readonly agentId: string }
	| { readonly kind: "team"; readonly teamId: string }
	| { readonly kind: "session"; readonly parentSessionId: string };

/** Session-only execution snapshot created by the host after authority and knowledge admission. */
export interface RoutineExecutionSnapshot {
	readonly parentSessionId: string;
	/** Opaque, bounded parent-branch anchor captured with the routine; never refreshed from a later branch. */
	readonly parentBranchAnchor: string;
	readonly profileId?: string;
	readonly savedIntent: WorkerSavedIntent;
}

/** Explicit schedule. The cursor is mutable independently of immutable routine revision. */
export type RoutineSchedule =
	/** `expiresAt`: no new slot or attempt is taken at or after it; the routine is retired once its runs are delivered. */
	| { readonly kind: "interval"; readonly intervalMs: number; readonly anchorAt: number; readonly expiresAt?: number }
	| { readonly kind: "once"; readonly at: number; readonly notAfter?: number }
	/** Slots strictly after anchorAt (the authoring instant) in the stored zone. */
	| {
			readonly kind: "calendar";
			readonly cron: string;
			readonly timeZone: string;
			readonly anchorAt: number;
			readonly maxLatenessMs?: number;
			readonly expiresAt?: number;
	  }
	/** Root-applicable CI attempts accepted into the session ledger after `anchorOrdinal`. */
	| {
			readonly kind: "event";
			readonly source: "ci";
			readonly conclusions: readonly CiTerminalConclusion[];
			readonly workflowPath?: string;
			readonly stopAfterFirstRun?: true;
			readonly expiresAt?: number;
			readonly anchorOrdinal: number;
			readonly anchorReplayGaps: string;
	  }
	/**
	 * GitHub occurrences accepted into the session ledger after `anchorOrdinal` that happened at or after `anchorAt` (the
	 * instant the filter was saved, kept while it is unchanged). Kinds are in contract order, authors lowercase.
	 */
	| RoutineGithubSchedule;

export interface RoutineGithubSchedule {
	readonly kind: "event";
	readonly source: "github";
	readonly kinds: readonly GithubThreadEventKind[];
	readonly pullRequest?: number;
	readonly branch?: string;
	readonly ownPullRequests?: true;
	readonly authors?: readonly string[];
	readonly stopAfterFirstRun?: true;
	readonly expiresAt?: number;
	readonly anchorOrdinal: number;
	readonly anchorReplayGaps: string;
	readonly anchorAt: number;
}

export type RoutineEventSchedule = Extract<RoutineSchedule, { kind: "event" }>;

/** Host-owned ledger position an event routine is authored at: later events only. */
export interface RoutineEventAnchor {
	readonly ordinal: number;
	readonly replayGaps: string;
}

/** One retained host event as the owning session decides it; never a copy of ledger custody. */
export interface RoutineHostEventFact {
	readonly acceptedOrdinal: number;
	readonly sourceSequence: number;
	readonly event: CiAttemptTerminalEvent | GithubThreadEvent;
	/** This live session has sealed the event's source frontier. */
	readonly ready: boolean;
	/** The event is the completed observation of its subject in the source's current seal. */
	readonly current: boolean;
	/**
	 * A CI attempt's subject is one of the source's current root subjects (the checked-out revision); a GitHub
	 * occurrence always applies, its routine's filter scopes it.
	 */
	readonly rootApplicable: boolean;
}

export interface RoutineHostEventFeed {
	readonly events: readonly RoutineHostEventFact[];
	readonly replayGaps: string;
}

/** How a routine came to exist when the host, not a tool call, created it. Fixed at creation. */
export interface RoutineOrigin {
	readonly kind: "owner-intake";
	/** The owner-evidence source whose words asked for the routine. */
	readonly sourceId: string;
	/** Timing parts the owner left open that the host filled with its fixed defaults, as announced. */
	readonly defaults?: readonly string[];
	/** The end the owner stated, in their own words, for a request meant only until something happens; told to each run. */
	readonly endCondition?: string;
}

/** The identity of one owner request the host turned into a routine: consumed once, never recreated. */
export interface RoutineIntakeOrigin {
	/**
	 * Canonical digest of the session, the source, its digest and the original offsets of the owner's grounded
	 * instruction and timing words, so a re-extraction that finds the same words meets the same identity.
	 */
	readonly key: string;
	readonly sourceId: string;
	/** Host-chosen timing parts, recorded on the routine's origin; not part of the identity. */
	readonly defaults?: readonly string[];
	/** The owner's stated end, recorded on the routine's origin; not part of the identity. */
	readonly endCondition?: string;
}

/** One owner request an intake pass extracted and grounded, decided at most once. */
export interface RoutineIntakeRequest {
	readonly key: string;
	readonly sourceId: string;
	/** The owner's verbatim words for what to do: the routine prompt. */
	readonly prompt: string;
	/** The host-compiled schedule. */
	readonly schedule: RoutineScheduleInput;
	/** The schedule in plain words and the routine's own zone, as the judge and the owner read it. */
	readonly cadence: string;
	/** Timing parts the owner left open that the host filled with its fixed defaults. */
	readonly defaults?: readonly string[];
	/** The owner's stated end of a request meant only until something happens, in their own words. */
	readonly endCondition?: string;
	/**
	 * The decision, written in the same store write that makes it final (a creation writes it with its routine); a
	 * decided request is never judged again.
	 */
	readonly outcome?: RoutineIntakeDecision;
}

/** How one intake request ended: a routine, a refusal the owner is told about, or nothing to tell (no request). */
export type RoutineIntakeDecision =
	| { readonly kind: "created"; readonly routineId: string }
	| { readonly kind: "refused"; readonly reason: string }
	| { readonly kind: "passed" };

/** A request the extraction found in the owner's stated words that the host could not compile; the owner is told. */
export interface RoutineIntakeDrop {
	readonly key: string;
	readonly sourceId: string;
	/** The owner's instruction words, bounded for display. */
	readonly excerpt: string;
	readonly reason: string;
}

/**
 * One decided request the owner is told about, kept until the transcript accepted its notice. Its delivery identity
 * and payload derive from this record alone, so every redelivery is the same input.
 */
export interface RoutineIntakeNoticeRecord {
	readonly key: string;
	readonly sourceId: string;
	/** The owner's words for the work, bounded for display. */
	readonly prompt: string;
	/** Timing parts the host chose, told with a creation. */
	readonly defaults?: readonly string[];
	readonly outcome:
		| { readonly kind: "created"; readonly routineId: string; readonly cadence: string }
		| { readonly kind: "refused" | "dropped"; readonly reason: string };
}

/** The intake pass in flight, retained so a restart neither re-reads its sources nor spends on them twice. */
export interface RoutineIntakeBatch {
	readonly operationId: string;
	readonly sourceIds: readonly string[];
	/** The owner-evidence instant the session's intake reaches once this batch ends. */
	readonly through: number;
	/** Present once extraction and grounding finished: the retained result the pass decides from. */
	readonly requests?: readonly RoutineIntakeRequest[];
	/** Requests the same extraction found but the host could not compile, retained with the requests. */
	readonly dropped?: readonly RoutineIntakeDrop[];
}

/** One consumed intake origin, kept for replay refusal and the per-session window cap. */
export interface RoutineIntakeConsumption {
	readonly key: string;
	readonly parentSessionId: string;
	readonly at: number;
}

/** One session's routine-intake state in the routine store. */
export interface RoutineIntakeSession {
	readonly parentSessionId: string;
	/**
	 * Owner sources that were in the model's context when a routine tool create or update of this session was saved,
	 * oldest first, bounded by {@link MAX_ROUTINE_INTAKE_ANSWERED}. The model already handled them; intake never reads them.
	 */
	readonly answered?: readonly string[];
	/** Instant (ms, owner-evidence clock) of the newest owner source intake has finished with; it never reads older ones. */
	readonly through?: number;
	readonly batch?: RoutineIntakeBatch;
	/** Decided requests whose notices the session's transcript has not accepted yet, oldest first. */
	readonly unannounced?: readonly RoutineIntakeNoticeRecord[];
	readonly updatedAt: number;
}

/** One write of a session's intake state; its parts apply together. */
export interface RoutineIntakeChange {
	/** The newest owner source intake finished with; never moved back. */
	readonly through?: number;
	/** The pass in flight; `null` ends it. */
	readonly batch?: RoutineIntakeBatch | null;
	/** Notices kept until accepted, appended in order; a request already kept is not repeated. */
	readonly announce?: readonly RoutineIntakeNoticeRecord[];
	/** Request keys whose notices the transcript accepted. */
	readonly announced?: readonly string[];
}

/** A host intake creation whose parent branch changed after its request was judged; nothing was written. */
export class RoutineIntakeBranchChanged extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoutineIntakeBranchChanged";
	}
}

/** Why the store refused a host intake creation; anything else thrown is not a refusal and may be retried. */
export type RoutineIntakeRefusalReason = "consumed" | "window_cap" | "live_cap";

export class RoutineIntakeRefusal extends Error {
	readonly reason: RoutineIntakeRefusalReason;

	constructor(reason: RoutineIntakeRefusalReason, message: string) {
		super(message);
		this.name = "RoutineIntakeRefusal";
		this.reason = reason;
	}
}

/**
 * A host's admission guard refused a routine dispatch (its session opened, its away host closed, its origin left the
 * branch). When no execution of the run exists, nothing was handed to an executor and the run returns to pending.
 */
export class RoutineAdmissionRefused extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "RoutineAdmissionRefused";
	}
}

export interface PersistentRoutineDefinition {
	readonly routineId: string;
	readonly incarnationId: string;
	readonly revision: number;
	readonly target: PersistentRoutineTarget;
	readonly prompt: string;
	readonly schedule: RoutineSchedule;
	readonly enabled: boolean;
	readonly executionSnapshot?: RoutineExecutionSnapshot;
	readonly origin?: RoutineOrigin;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** Store input is host-authored. Tool callers provide RoutineAuthoringInput, never a target or snapshot. */
export interface UpsertPersistentRoutineInput {
	readonly routineId: string;
	readonly target: PersistentRoutineTarget;
	readonly prompt: string;
	readonly schedule: RoutineScheduleInput;
	readonly enabled?: boolean;
	readonly executionSnapshot?: RoutineExecutionSnapshot;
	readonly expectedRevision?: number;
	readonly createOnly?: boolean;
	readonly nowMs?: number;
	/** Required when an event schedule is created or its rule changes; ignored otherwise. */
	readonly eventAnchor?: RoutineEventAnchor;
	/**
	 * A host intake creation: create-only, session-targeted, refused with {@link RoutineIntakeRefusal} when the
	 * origin is already consumed or the session's caps are reached, and consumed in the same write as the routine.
	 */
	readonly intakeOrigin?: RoutineIntakeOrigin;
	/**
	 * Run under the store lock before an intake creation writes anything; throws {@link RoutineIntakeBranchChanged}
	 * when the owner's branch changed since the request was judged, so a request navigated away from creates nothing.
	 */
	readonly intakeGuard?: () => void;
	/**
	 * A routine tool save: the owner sources in the model's context when it ran, recorded on the session's intake state
	 * in the same write so intake never reads them. Session targets only.
	 */
	readonly toolAnsweredSources?: readonly string[];
}

export type RoutineOccurrencePhase = "pending" | "claimed" | "dispatching" | "running" | "uncertain" | "terminal";
export type RoutineOccurrenceTrigger =
	| { readonly kind: "schedule"; readonly scheduledAt: number; readonly missedCount: number }
	| { readonly kind: "manual"; readonly commandId: string; readonly requestedAt: number }
	/**
	 * A bounded copy of the deciding event, so instructions never depend on ledger retention. A GitHub run carries a
	 * batch: `event` is its latest occurrence and `earlier` the others it carries, oldest first, at most
	 * {@link HOST_EVENT_LISTENER_LIMITS}.maxBatch in all; `missedCount` counts the ones it does not carry.
	 * `bodiesElided`: the run's result was delivered, and the occurrences' bodies were dropped from history.
	 */
	| RoutineEventTrigger
	/** The host's notice that the routine reached its `expiresAt` and was removed; recorded terminal, never run. */
	| { readonly kind: "expiry"; readonly expiresAt: number }
	/**
	 * The host's notice that a run reported the routine's stated end met and the routine was removed; recorded terminal,
	 * never run. Keyed by the reporting occurrence, so a replayed retirement writes the same notice.
	 */
	| { readonly kind: "condition"; readonly occurrenceId: string; readonly metAt: number };
export type RoutineEventTrigger =
	| {
			readonly kind: "event";
			readonly triggeredAt: number;
			readonly acceptedOrdinal: number;
			readonly missedCount: number;
			readonly historyGap?: true;
			readonly event: CiAttemptTerminalEvent;
	  }
	| {
			readonly kind: "event";
			readonly triggeredAt: number;
			readonly acceptedOrdinal: number;
			readonly missedCount: number;
			readonly historyGap?: true;
			readonly event: GithubThreadEvent;
			readonly earlier?: readonly GithubThreadEvent[];
			readonly bodiesElided?: true;
	  };
export type RoutineTerminalOutcome = "succeeded" | "failed" | "cancelled" | "uncertain";

export interface RoutineResult {
	readonly outcome: RoutineTerminalOutcome;
	readonly summary: string;
	readonly digest: string;
	readonly delivery: "pending" | "acknowledged";
	readonly recipient: string;
	readonly deliveryMarker?: string;
	/** The worker reported, and the host accepted, that this succeeded run needs no owner update now. */
	readonly ownerUpdate?: "none";
	/** The worker reported, and the host accepted, that this succeeded run found the routine's stated end reached. */
	readonly conditionMet?: true;
}

export interface RoutineOccurrence {
	readonly occurrenceId: string;
	readonly routineId: string;
	readonly routineRevision: number;
	readonly definition: PersistentRoutineDefinition;
	readonly parentOrigin: WorkerSavedIntent["receiptOrigin"];
	readonly target: PersistentRoutineTarget;
	readonly trigger: RoutineOccurrenceTrigger;
	readonly phase: RoutineOccurrencePhase;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly claim?: { readonly token: string; readonly owner: string; readonly leaseUntil: number };
	/** Native idempotency key; persisted before handing off to an executor. */
	readonly dispatchKey?: string;
	/** Exact native execution identity; needed to reconcile a terminal without polling output. */
	readonly executionRef?: { readonly taskId: string; readonly attemptId: string };
	readonly result?: RoutineResult;
	/** Preserve the original uncertain result and its independent delivery receipt after exact resolution. */
	readonly priorUncertaintyResult?: RoutineResult;
	readonly uncertainty?: string;
	/**
	 * Claimed by a host running the routine away (its session not open). Set by each claim before dispatch and fixed
	 * from dispatch on; a run returned to pending drops it. The away spend bound charges these occurrences.
	 */
	readonly executor?: "away";
	/**
	 * A dispatched run away's end: when it became terminal and what its attempts spent, read from their ledger usage
	 * (absent when unread: the run is charged its full per-run bound). Written by whichever host finished it.
	 */
	readonly awaySettlement?: { readonly at: number; readonly costUsd?: number };
}

/** The rolling window of the away spend bound. */
export const ROUTINE_AWAY_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Why a due run was not run away for lack of room under the away spend bound. */
export const ROUTINE_AWAY_SPEND_REFUSAL =
	"the away spend bound (routines.away.maxUsdPerDay) has no room for another run in the last 24 hours; this run waits for its session to open.";

/** Why a due slot was not run away while an earlier run away of its routine is not yet delivered. */
export const ROUTINE_AWAY_HELD_REASON =
	"an earlier run away of it has not been delivered to its session yet, so later slots wait for the session to open and its next run's missed count covers them.";

/** The away spend bound a claim by an away host is admitted under; the store decides it under its lock. */
export interface RoutineAwayClaimGate {
	readonly maxUsdPerRun: number;
	readonly maxUsdPerDay: number;
}

/** Whole micro-dollars: the bound's sums and comparisons are exact. */
function micros(usd: number): number {
	return Math.round(usd * 1_000_000);
}

/**
 * What one run away charges the away spend bound now, in micro-dollars, and until when (undefined: until it changes).
 * Admission, not creation, starts the charge, so a run is charged at any age:
 * - admitted and not finished (claimed, dispatching, running): its full per-run bound, until it finishes or returns to
 *   pending (which drops `executor`);
 * - uncertain: its full per-run bound, until resolved, or the spend window after the journal's uncertain retention;
 * - finished after dispatch: its settled spend (its full per-run bound when unread), for the spend window after it
 *   finished;
 * - finished without dispatch (cancelled before it started): nothing.
 */
function routineAwayCharge(
	item: RoutineOccurrence,
	maxUsdPerRun: number,
	nowMs: number,
): { readonly micros: number; readonly until?: number } | undefined {
	if (item.executor !== "away") return undefined;
	if (item.phase === "uncertain") {
		const until = item.updatedAt + ROUTINE_UNCERTAIN_RETENTION_MS + ROUTINE_AWAY_SPEND_WINDOW_MS;
		return until > nowMs ? { micros: micros(maxUsdPerRun), until } : undefined;
	}
	if (item.phase !== "terminal") return { micros: micros(maxUsdPerRun) };
	if (!item.dispatchKey) return undefined;
	const until = (item.awaySettlement?.at ?? item.updatedAt) + ROUTINE_AWAY_SPEND_WINDOW_MS;
	if (until <= nowMs) return undefined;
	return { micros: micros(item.awaySettlement?.costUsd ?? maxUsdPerRun), until };
}

/** Whether the run away is still charged the away spend bound, so the journal keeps it. */
export function routineAwayCharged(item: RoutineOccurrence, nowMs: number): boolean {
	return routineAwayCharge(item, 0, nowMs) !== undefined;
}

/**
 * The away spend bound's state: whether one more run fits (`charged + maxUsdPerRun <= maxUsdPerDay`, exact in
 * micro-dollars) and, when it does not, the earliest instant a charge ends by time (undefined when every charge ends
 * only by a store change: a run finishing or returning to pending).
 */
export function routineAwaySpendRoom(
	occurrences: Iterable<RoutineOccurrence>,
	gate: RoutineAwayClaimGate,
	nowMs: number,
): { readonly chargedMicros: number; readonly fits: (extraRuns: number) => boolean; readonly exit?: number } {
	let chargedMicros = 0;
	let exit: number | undefined;
	for (const item of occurrences) {
		const charge = routineAwayCharge(item, gate.maxUsdPerRun, nowMs);
		if (!charge) continue;
		chargedMicros += charge.micros;
		if (charge.until !== undefined) exit = Math.min(exit ?? Number.POSITIVE_INFINITY, charge.until);
	}
	const perRun = micros(gate.maxUsdPerRun);
	const perDay = micros(gate.maxUsdPerDay);
	return {
		chargedMicros,
		fits: (extraRuns) => chargedMicros + (extraRuns + 1) * perRun <= perDay,
		...(exit === undefined ? {} : { exit }),
	};
}

/**
 * Whether an away claim holds the routine's next slot: a run away of this incarnation is unfinished, or its result is
 * not yet delivered. One run away per routine waits for its session at a time; later slots stay due for the session.
 * An uncertain run whose uncertainty was delivered stops holding once the journal's uncertain retention passed, as the
 * journal then treats it as settled.
 */
export function routineAwayHeld(
	occurrences: Iterable<RoutineOccurrence>,
	routine: { readonly routineId: string; readonly incarnationId: string },
	nowMs: number,
): boolean {
	for (const item of occurrences) {
		if (
			item.executor !== "away" ||
			item.routineId !== routine.routineId ||
			item.definition.incarnationId !== routine.incarnationId
		)
			continue;
		if (item.result?.delivery === "pending" || item.priorUncertaintyResult?.delivery === "pending") return true;
		if (
			item.phase === "uncertain"
				? item.updatedAt > nowMs - ROUTINE_UNCERTAIN_RETENTION_MS
				: item.phase !== "terminal"
		)
			return true;
	}
	return false;
}

/**
 * Whether the journal may drop an entry: everything it owes was delivered, and it is finished, or uncertain past
 * {@link ROUTINE_UNCERTAIN_RETENTION_MS} since its last transition (its uncertainty was already delivered).
 */
export function routineOccurrenceSettled(item: RoutineOccurrence, nowMs: number): boolean {
	return (
		item.result?.delivery === "acknowledged" &&
		(!item.priorUncertaintyResult || item.priorUncertaintyResult.delivery === "acknowledged") &&
		(item.phase === "terminal" ||
			(item.phase === "uncertain" && item.updatedAt <= nowMs - ROUTINE_UNCERTAIN_RETENTION_MS))
	);
}

/**
 * When an entry stops holding journal room by time alone: an uncertain run whose uncertainty was delivered, once the
 * uncertain retention passes. Undefined when it settles only with a store change, or already settled.
 */
function routineSettlesAt(item: RoutineOccurrence, nowMs: number): number | undefined {
	if (
		item.phase !== "uncertain" ||
		item.result?.delivery !== "acknowledged" ||
		item.priorUncertaintyResult?.delivery === "pending"
	)
		return undefined;
	const at = item.updatedAt + ROUTINE_UNCERTAIN_RETENTION_MS;
	return at > nowMs ? at : undefined;
}

/**
 * Whether a routine may admit one more run: it holds fewer than {@link ROUTINE_JOURNAL_SHARE} unsettled entries; when
 * it may not, the earliest instant one of them settles by time (undefined: only a store change frees its share).
 */
export function routineJournalShare(
	occurrences: Iterable<RoutineOccurrence>,
	routineId: string,
	nowMs: number,
): { readonly fits: boolean; readonly exit?: number } {
	let held = 0;
	let exit: number | undefined;
	for (const item of occurrences) {
		if (item.routineId !== routineId || routineOccurrenceSettled(item, nowMs)) continue;
		held++;
		const at = routineSettlesAt(item, nowMs);
		if (at !== undefined) exit = Math.min(exit ?? Number.POSITIVE_INFINITY, at);
	}
	return held < ROUTINE_JOURNAL_SHARE ? { fits: true } : { fits: false, ...(exit === undefined ? {} : { exit }) };
}

/** Whether the journal may drop the entry now: settled, and no longer charged to the away spend bound. */
export function routineJournalRemovable(item: RoutineOccurrence, nowMs: number): boolean {
	return routineOccurrenceSettled(item, nowMs) && !routineAwayCharged(item, nowMs);
}

/**
 * Whether the journal can take one more entry (it is below capacity, or holds an entry it may drop); when it cannot,
 * the earliest instant an entry becomes droppable by time alone: its uncertain retention or away charge ending
 * (undefined: only a store change makes room). Replay tombstone capacity is the store's own concern.
 */
export function routineJournalRoom(
	occurrences: readonly RoutineOccurrence[],
	nowMs: number,
): { readonly room: boolean; readonly exit?: number } {
	if (occurrences.length < MAX_ROUTINE_OCCURRENCES) return { room: true };
	let exit: number | undefined;
	for (const item of occurrences) {
		if (routineJournalRemovable(item, nowMs)) return { room: true };
		const settledAt = routineOccurrenceSettled(item, nowMs) ? nowMs : routineSettlesAt(item, nowMs);
		if (settledAt === undefined) continue;
		const charge = routineAwayCharge(item, 0, nowMs);
		if (charge && charge.until === undefined) continue;
		const at = Math.max(settledAt, charge?.until ?? settledAt);
		if (at > nowMs) exit = Math.min(exit ?? Number.POSITIVE_INFINITY, at);
	}
	return { room: false, ...(exit === undefined ? {} : { exit }) };
}

export interface RoutineDelivery {
	readonly occurrence: RoutineOccurrence;
	readonly result: RoutineResult;
}

export interface RoutineDefinitionView extends PersistentRoutineDefinition {
	readonly cursor: RoutineCursor;
	readonly nextRunAt: number;
	readonly lastRunAt?: number;
	/** The most recently claimed occurrence's state: running until its result, then that result's outcome. */
	readonly lastStatus?: (typeof ROUTINE_LAST_STATUSES)[number];
	readonly lastSummary?: string;
	/**
	 * Why the last due run could not run away, until a claim admits the routine again. The slot stays due for the
	 * session's next open; the session reports this once, and the daemon status lists it.
	 */
	readonly awayRefusal?: { readonly reason: string; readonly at: number };
	/** Failed results in a row, below {@link ROUTINE_FAILURE_PAUSE_THRESHOLD}; a succeeded result clears it. */
	readonly failureStreak?: number;
	/**
	 * Why the host paused the routine: written with the failed result that reached the threshold, kept while the routine
	 * stays paused, dropped by the owner's write that enables it again. It never moves the revision.
	 */
	readonly failurePause?: RoutineFailurePause;
	/**
	 * The end the owner stated was reported met: written with the accepted result that reported it, for a routine with
	 * a stated end only. It ends the routine (see {@link routineEnded}); it never moves the revision, and an owner write
	 * drops it.
	 */
	readonly conditionMet?: RoutineConditionMet;
}

export interface RoutineConditionMet {
	readonly at: number;
	/** The occurrence whose result reported it. */
	readonly occurrenceId: string;
}

export interface RoutineFailurePause {
	/** Failed results in a row that paused it. */
	readonly after: number;
	readonly at: number;
	/** The occurrence whose failed result reached the threshold. */
	readonly occurrenceId: string;
	/** That result's first line, redacted and bounded. */
	readonly lastError: string;
}

export const ROUTINE_LAST_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled", "uncertain"] as const;

/** The instant a claim is attributed to: its scheduled slot, the manual request time or the event claim time. */
export function routineTriggerAt(trigger: RoutineOccurrenceTrigger): number {
	if (trigger.kind === "schedule") return trigger.scheduledAt;
	if (trigger.kind === "expiry") return trigger.expiresAt;
	if (trigger.kind === "condition") return trigger.metAt;
	return trigger.kind === "manual" ? trigger.requestedAt : trigger.triggeredAt;
}

/**
 * Whether a routine has ended at `nowMs`: its one-run event routine took its run (`spent`, whose result is the last
 * word), a run reported the end the owner stated met (`condition`, announced once), or its end time passed
 * (`expired`, announced once). An ended routine is never claimed again.
 */
export function routineEnded(
	routine: Pick<RoutineDefinitionView, "schedule" | "cursor" | "conditionMet">,
	nowMs: number,
): "spent" | "condition" | "expired" | undefined {
	const { schedule, cursor } = routine;
	if (routine.conditionMet) return "condition";
	if (schedule.kind === "once") return undefined;
	if (schedule.kind === "event" && schedule.stopAfterFirstRun && cursor.kind === "event" && cursor.spent)
		return "spent";
	return schedule.expiresAt !== undefined && nowMs >= schedule.expiresAt ? "expired" : undefined;
}

/**
 * Whether every occurrence of the routine's incarnation is past dispatch and has its results delivered, so removing
 * the routine loses no run and no result.
 */
export function routineOccurrencesSettled(
	occurrences: Iterable<RoutineOccurrence>,
	routine: Pick<PersistentRoutineDefinition, "routineId" | "incarnationId">,
): boolean {
	for (const occurrence of occurrences) {
		if (occurrence.routineId !== routine.routineId || occurrence.definition.incarnationId !== routine.incarnationId)
			continue;
		if (occurrence.phase !== "terminal" && occurrence.phase !== "uncertain") return false;
		if (occurrence.result?.delivery === "pending" || occurrence.priorUncertaintyResult?.delivery === "pending")
			return false;
	}
	return true;
}

/**
 * Whether an event satisfies an event schedule's filter: a CI attempt a CI filter, a GitHub occurrence a GitHub
 * filter. Root applicability is decided by the caller.
 */
export function routineEventMatches(
	schedule: RoutineEventSchedule,
	event: CiAttemptTerminalEvent | GithubThreadEvent,
): boolean {
	if (schedule.source === "github")
		return !isCiAttemptEvent(event) && githubInterestMatches(routineGithubInterest(schedule), event);
	return (
		isCiAttemptEvent(event) &&
		schedule.conclusions.includes(event.conclusion) &&
		(schedule.workflowPath === undefined || schedule.workflowPath === event.workflowPath)
	);
}

/** What a GitHub routine asks its session's source to collect; it starts at the instant its filter was saved. */
export function routineGithubInterest(schedule: RoutineGithubSchedule): GithubThreadInterest {
	return {
		kinds: schedule.kinds,
		...(schedule.pullRequest === undefined ? {} : { pullRequest: schedule.pullRequest }),
		...(schedule.branch === undefined ? {} : { branch: schedule.branch }),
		...(schedule.ownPullRequests ? { ownPullRequests: true as const } : {}),
		...(schedule.authors === undefined ? {} : { authors: schedule.authors }),
		since: new Date(schedule.anchorAt).toISOString(),
	};
}

/** Every event a run carries, oldest first; the deciding one last. */
export function routineTriggerEvents(
	trigger: RoutineEventTrigger,
): readonly (CiAttemptTerminalEvent | GithubThreadEvent)[] {
	return "earlier" in trigger && trigger.earlier ? [...trigger.earlier, trigger.event] : [trigger.event];
}

export interface RoutineOccurrenceClaimInput {
	readonly nowMs: number;
	readonly owner: string;
	readonly leaseMs: number;
	readonly limit: number;
	readonly parentSessionId?: string;
	readonly receiptOrigin?: WorkerSavedIntent["receiptOrigin"];
	readonly eligibleRoutineIds?: readonly string[];
	readonly eligibleOccurrenceIds?: readonly string[];
	readonly routineId?: string;
	/** Retained host events of the claiming session; event routines are decided only when present. */
	readonly hostEvents?: RoutineHostEventFeed;
	/** Present only for a host running routines away: every claim it makes is admitted under this bound. */
	readonly away?: RoutineAwayClaimGate;
}

/** A closed parent's event routines its away feed asks the store to decide; the store rechecks each under its lock. */
export interface AwayEventDecisionInput {
	readonly nowMs: number;
	readonly parentSessionId: string;
	readonly routineIds: readonly string[];
	/** The host events the away feed holds sealed for this parent. */
	readonly hostEvents: RoutineHostEventFeed;
}

export interface AwayEventDecisionResult {
	/** Pending occurrences recorded for decided attempts. */
	readonly decided: readonly string[];
	/** Routines whose earlier run away is not yet delivered: their attempts wait for the session. */
	readonly held: readonly string[];
	/** A new attempt stays undecided until delivered results make journal room. */
	readonly journalFull: boolean;
	/** Routines holding their whole journal share; their new attempts stay undecided. */
	readonly shareFull: readonly string[];
}

/** The ended routines one session asks the store to remove; the store rechecks each under its lock. */
export interface RoutineRetireInput {
	readonly nowMs: number;
	readonly owner: string;
	readonly leaseMs: number;
	readonly parentSessionId: string;
	/** The parent anchor a bot or team routine's expiry notice is delivered at; session routines use their own. */
	readonly receiptOrigin: WorkerSavedIntent["receiptOrigin"];
	readonly routineIds: readonly string[];
}

export interface RoutineClaimResult {
	readonly claimed: readonly RoutineOccurrence[];
	/**
	 * A due routine or event attempt was left due because the occurrence journal has no room for its occurrence: every
	 * entry is still active, uncertain or awaiting delivery. Nothing was consumed; delivered results make room.
	 */
	readonly journalFull: boolean;
	/**
	 * Due routines left due because each already holds {@link ROUTINE_JOURNAL_SHARE} unsettled journal entries; nothing
	 * was consumed, and the next admitted run's missed count covers the slots that passed meanwhile.
	 */
	readonly journalShareFull: readonly string[];
	/** Clock routines whose slots this runtime could not compute; each was skipped and the others still claimed. */
	readonly unschedulable: readonly { readonly routineId: string; readonly reason: string }[];
	/** Due routines an away claim left due because the away spend bound has no room for another run. */
	readonly awayRefused: readonly string[];
	/**
	 * With `awayRefused`: the earliest instant a charge ends by time, so room can return without a store change. Absent
	 * when every charge ends only by a store change (a run finishing or returning to pending).
	 */
	readonly awayRetryAt?: number;
	/**
	 * Due routines an away claim left due because an earlier run away of each is not yet delivered
	 * ({@link routineAwayHeld}); a store change (the delivery) lifts it.
	 */
	readonly awayHeld: readonly string[];
}

export interface RoutineEventDecision {
	/**
	 * The routine's cursor once these events are decided, before any occurrence is recorded: `skipped` adds the
	 * matching attempts a later observation superseded, `historyGap` a replay gap recorded since the last decision.
	 */
	readonly cursor: Extract<RoutineCursor, { kind: "event" }>;
	/** Current matching attempts, oldest first; the caller drops those already journaled or tombstoned. */
	readonly candidates: readonly RoutineHostEventFact[];
}

/**
 * Decides an event routine against the retained host events, with the root note's gate: the event's source has
 * sealed in this live session, the event is its subject's current completed observation, and the subject is a
 * current root subject. The cursor never passes a matching event whose source has not sealed.
 */
export function decideRoutineEvents(
	schedule: Extract<RoutineSchedule, { kind: "event" }>,
	cursor: Extract<RoutineCursor, { kind: "event" }>,
	feed: RoutineHostEventFeed,
): RoutineEventDecision {
	const relevant = feed.events
		.filter(
			(fact) =>
				fact.acceptedOrdinal > cursor.throughOrdinal &&
				fact.rootApplicable &&
				routineEventMatches(schedule, fact.event),
		)
		.sort(compareRoutineHostEvents);
	let throughOrdinal = cursor.throughOrdinal;
	for (const fact of feed.events) throughOrdinal = Math.max(throughOrdinal, fact.acceptedOrdinal);
	const blocked = relevant.find((fact) => !fact.ready);
	if (blocked) throughOrdinal = Math.max(cursor.throughOrdinal, Math.min(throughOrdinal, blocked.acceptedOrdinal - 1));
	const candidates: RoutineHostEventFact[] = [];
	let superseded = 0;
	for (const fact of relevant) {
		if (!fact.ready) continue;
		if (fact.current) candidates.push(fact);
		else if (fact.acceptedOrdinal <= throughOrdinal) superseded++;
	}
	const skipped = Math.min(MAX_ROUTINE_EVENT_MISSED_COUNT, (cursor.skipped ?? 0) + superseded);
	return {
		cursor: {
			kind: "event",
			throughOrdinal,
			replayGaps: feed.replayGaps,
			...(skipped > 0 ? { skipped } : {}),
			...(cursor.historyGap || feed.replayGaps !== cursor.replayGaps ? { historyGap: true as const } : {}),
		},
		candidates,
	};
}

/** Ledger order; snapshots of one seal share an ordinal and are ordered by source position, then identity. */
export function compareRoutineHostEvents(left: RoutineHostEventFact, right: RoutineHostEventFact): number {
	return (
		left.acceptedOrdinal - right.acceptedOrdinal ||
		left.sourceSequence - right.sourceSequence ||
		(left.event.eventId < right.event.eventId ? -1 : left.event.eventId > right.event.eventId ? 1 : 0)
	);
}

export interface RoutineOccurrenceListFilter {
	readonly parentSessionId?: string;
	readonly routineId?: string;
	readonly phases?: readonly RoutineOccurrencePhase[];
	readonly limit?: number;
}

export function parseRoutineAuthoringInput(value: unknown): RoutineAuthoringInput {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, ["routineId", "prompt", "schedule"]))
		throw new TypeError("Routine authoring input is invalid.");
	if (typeof value.routineId !== "string" || !isRoutineId(value.routineId))
		throw new TypeError("Routine id is invalid.");
	if (
		typeof value.prompt !== "string" ||
		value.prompt.trim().length === 0 ||
		value.prompt.length > MAX_ROUTINE_PROMPT_CHARS
	)
		throw new TypeError("Routine prompt is invalid.");
	const schedule = parseRoutineScheduleInput(value.schedule);
	return { routineId: value.routineId, prompt: value.prompt.trim(), schedule };
}

export function parseRoutineScheduleInput(value: unknown): RoutineScheduleInput {
	if (!isPlainRecord(value)) throw new TypeError("Routine schedule is invalid.");
	if (value.expiresAt !== undefined && (value.kind === "once" || !validInstant(value.expiresAt)))
		throw new TypeError("Routine end time must be a UTC epoch-ms instant on a repeating or event schedule.");
	const expiry = value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as number };
	if (
		value.kind === "interval" &&
		hasOnlyKeys(value, ["kind", "intervalMs", "expiresAt"]) &&
		Number.isSafeInteger(value.intervalMs) &&
		(value.intervalMs as number) >= MIN_ROUTINE_INTERVAL_MS &&
		(value.intervalMs as number) <= MAX_ROUTINE_INSTANT_MS
	)
		return { kind: "interval", intervalMs: value.intervalMs as number, ...expiry };
	if (
		value.kind === "once" &&
		hasOnlyKeys(value, ["kind", "at", "notAfter"]) &&
		validInstant(value.at) &&
		(value.notAfter === undefined ||
			(validInstant(value.notAfter) && value.notAfter >= value.at + MIN_ROUTINE_START_WINDOW_MS))
	)
		return { kind: "once", at: value.at, ...(value.notAfter === undefined ? {} : { notAfter: value.notAfter }) };
	if (value.kind === "calendar" && hasOnlyKeys(value, ["kind", "cron", "timeZone", "maxLatenessMs", "expiresAt"])) {
		const cron = canonicalCalendarCron(value.cron);
		if (
			value.maxLatenessMs !== undefined &&
			(!Number.isSafeInteger(value.maxLatenessMs) ||
				(value.maxLatenessMs as number) < MIN_ROUTINE_START_WINDOW_MS ||
				(value.maxLatenessMs as number) > MAX_ROUTINE_LATENESS_MS)
		)
			throw new TypeError("Calendar lateness bound must be between one minute and 366 days.");
		return {
			kind: "calendar",
			cron,
			...(value.timeZone === undefined ? {} : { timeZone: canonicalCalendarTimeZone(value.timeZone) }),
			...(value.maxLatenessMs === undefined ? {} : { maxLatenessMs: value.maxLatenessMs as number }),
			...expiry,
		};
	}
	if (
		value.kind === "event" &&
		value.source === "ci" &&
		hasOnlyKeys(value, ["kind", "source", "conclusions", "workflowPath", "stopAfterFirstRun", "expiresAt"]) &&
		(value.stopAfterFirstRun === undefined || value.stopAfterFirstRun === true)
	)
		return {
			kind: "event",
			source: "ci",
			conclusions: canonicalRoutineConclusions(value.conclusions),
			...(value.workflowPath === undefined
				? {}
				: { workflowPath: boundedString(value.workflowPath, MAX_ROUTINE_WORKFLOW_PATH_CHARS, "workflow path") }),
			...(value.stopAfterFirstRun ? { stopAfterFirstRun: true as const } : {}),
			...expiry,
		};
	if (
		value.kind === "event" &&
		value.source === "github" &&
		hasOnlyKeys(value, [
			"kind",
			"source",
			"kinds",
			"pullRequest",
			"branch",
			"ownPullRequests",
			"authors",
			"stopAfterFirstRun",
			"expiresAt",
		]) &&
		(value.stopAfterFirstRun === undefined || value.stopAfterFirstRun === true)
	)
		return {
			...githubRoutineFilter(value),
			...(value.stopAfterFirstRun ? { stopAfterFirstRun: true } : {}),
			...expiry,
		};
	throw new TypeError(
		"Routine schedule must be an executable interval, one-time UTC instant, calendar rule, CI event filter or GitHub event filter.",
	);
}

interface GithubRoutineFilter {
	kind: "event";
	source: "github";
	kinds: GithubThreadEventKind[];
	pullRequest?: number;
	branch?: string;
	ownPullRequests?: true;
	authors?: string[];
}

/**
 * The canonical GitHub filter: kinds in contract order, logins lowercase and distinct, and the kind table's listener
 * rules (a high-volume kind needs a scope that narrows it).
 */
function githubRoutineFilter(value: Record<string, unknown>): GithubRoutineFilter {
	const invalid = (reason: string) => new TypeError(`Routine GitHub filter ${reason}.`);
	const kinds = value.kinds;
	if (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== "string"))
		throw invalid("needs a list of GitHub event kinds");
	const scopes = new Set<HostEventScopeKey>();
	let pullRequest: number | undefined;
	if (value.pullRequest !== undefined) {
		if (!Number.isSafeInteger(value.pullRequest) || (value.pullRequest as number) < 1)
			throw invalid("names an invalid pull request number");
		pullRequest = value.pullRequest as number;
		scopes.add("pullRequest");
	}
	let branch: string | undefined;
	if (value.branch !== undefined) {
		try {
			branch = githubBranchName(value.branch);
		} catch {
			throw invalid("names an invalid branch");
		}
		scopes.add("branch");
	}
	if (value.ownPullRequests !== undefined) {
		if (value.ownPullRequests !== true) throw invalid("has an invalid ownPullRequests flag");
		scopes.add("ownPullRequests");
	}
	let authors: string[] | undefined;
	if (value.authors !== undefined) {
		if (
			!Array.isArray(value.authors) ||
			value.authors.length === 0 ||
			value.authors.length > HOST_EVENT_LISTENER_LIMITS.maxAuthors
		)
			throw invalid(`needs between 1 and ${HOST_EVENT_LISTENER_LIMITS.maxAuthors} authors`);
		try {
			authors = [...new Set(value.authors.map((login) => githubLogin(login).toLowerCase()))].sort();
		} catch {
			throw invalid("names an invalid GitHub login");
		}
		scopes.add("authors");
	}
	const refusal = hostEventListenerRefusal("github", kinds as string[], scopes);
	if (refusal) throw invalid(refusal);
	return {
		kind: "event",
		source: "github",
		kinds: GITHUB_THREAD_EVENT_KINDS.filter((kind) => (kinds as string[]).includes(kind)),
		...(pullRequest === undefined ? {} : { pullRequest }),
		...(branch === undefined ? {} : { branch }),
		...(value.ownPullRequests ? { ownPullRequests: true as const } : {}),
		...(authors === undefined ? {} : { authors }),
	};
}

/** Unique conclusions in contract order; an omitted filter means failed attempts only. */
function canonicalRoutineConclusions(value: unknown): CiTerminalConclusion[] {
	if (value === undefined) return ["failure"];
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		new Set(value).size !== value.length ||
		value.some((entry) => !(CI_TERMINAL_CONCLUSIONS as readonly unknown[]).includes(entry))
	)
		throw new TypeError("Routine CI conclusions must be a non-empty list of distinct terminal conclusions.");
	return CI_TERMINAL_CONCLUSIONS.filter((conclusion) => value.includes(conclusion));
}

/** Authored form of a stored schedule, without host-owned anchors. */
export function routineScheduleInputOf(schedule: RoutineSchedule): RoutineScheduleInput {
	const expiry = schedule.kind === "once" || schedule.expiresAt === undefined ? {} : { expiresAt: schedule.expiresAt };
	switch (schedule.kind) {
		case "interval":
			return { kind: "interval", intervalMs: schedule.intervalMs, ...expiry };
		case "once":
			return {
				kind: "once",
				at: schedule.at,
				...(schedule.notAfter === undefined ? {} : { notAfter: schedule.notAfter }),
			};
		case "calendar":
			return {
				kind: "calendar",
				cron: schedule.cron,
				timeZone: schedule.timeZone,
				...(schedule.maxLatenessMs === undefined ? {} : { maxLatenessMs: schedule.maxLatenessMs }),
				...expiry,
			};
		case "event":
			if (schedule.source === "github")
				return {
					...githubFilterOf(schedule),
					...(schedule.stopAfterFirstRun ? { stopAfterFirstRun: true as const } : {}),
					...expiry,
				};
			return {
				kind: "event",
				source: schedule.source,
				conclusions: [...schedule.conclusions],
				...(schedule.workflowPath === undefined ? {} : { workflowPath: schedule.workflowPath }),
				...(schedule.stopAfterFirstRun ? { stopAfterFirstRun: true as const } : {}),
				...expiry,
			};
	}
}

function githubFilterOf(
	schedule: Pick<RoutineGithubSchedule, "kinds" | "pullRequest" | "branch" | "ownPullRequests" | "authors">,
): GithubRoutineFilter {
	return {
		kind: "event",
		source: "github",
		kinds: [...schedule.kinds],
		...(schedule.pullRequest === undefined ? {} : { pullRequest: schedule.pullRequest }),
		...(schedule.branch === undefined ? {} : { branch: schedule.branch }),
		...(schedule.ownPullRequests ? { ownPullRequests: true as const } : {}),
		...(schedule.authors === undefined ? {} : { authors: [...schedule.authors] }),
	};
}

/**
 * Fields that place slots. Start windows and end times are excluded: changing one must neither replay nor move a slot,
 * so an end time is extended in place.
 */
export function routineSlotRule(schedule: RoutineScheduleInput): RoutineScheduleInput {
	switch (schedule.kind) {
		case "interval":
			return { kind: "interval", intervalMs: schedule.intervalMs };
		case "once":
			return { kind: "once", at: schedule.at };
		case "calendar":
			return {
				kind: "calendar",
				cron: schedule.cron,
				...(schedule.timeZone === undefined ? {} : { timeZone: schedule.timeZone }),
			};
		case "event":
			// The whole filter decides which events run it: any change re-anchors at the ledger's current position. The
			// one-run flag is part of it, so turning it off after the run starts a fresh cursor instead of a spent one.
			if (schedule.source === "github")
				return {
					...githubRoutineFilter(schedule),
					...(schedule.stopAfterFirstRun ? { stopAfterFirstRun: true as const } : {}),
				};
			return {
				kind: "event",
				source: schedule.source,
				conclusions: canonicalRoutineConclusions(schedule.conclusions),
				...(schedule.workflowPath === undefined ? {} : { workflowPath: schedule.workflowPath }),
				...(schedule.stopAfterFirstRun ? { stopAfterFirstRun: true as const } : {}),
			};
	}
}

/**
 * Why this runtime cannot place a stored schedule's slots: a calendar zone saved on a runtime whose time zone data has
 * it and missing here. Undefined for every other schedule.
 */
export function routineZoneUnsupported(schedule: RoutineSchedule): string | undefined {
	if (schedule.kind !== "calendar" || isCalendarTimeZone(schedule.timeZone)) return undefined;
	return `Calendar time zone "${schedule.timeZone}" is not supported by this runtime, so the routine's slots cannot be placed here.`;
}

/** Latest instant a scheduled occurrence may start; undefined when its schedule sets no window. */
export function routineStartDeadline(schedule: RoutineSchedule, scheduledAt: number): number | undefined {
	if (schedule.kind === "once") return schedule.notAfter;
	if (schedule.kind === "calendar" && schedule.maxLatenessMs !== undefined)
		return scheduledAt + schedule.maxLatenessMs;
	return undefined;
}

/** Cursor of a newly authored or changed schedule; a calendar rule that never matches a representable instant gets null. */
export function initialRoutineCursor(schedule: RoutineSchedule): RoutineCursor {
	switch (schedule.kind) {
		case "interval":
			return { kind: "interval", nextIndex: 1 };
		case "once":
			return { kind: "once", consumed: false };
		case "calendar":
			return { kind: "calendar", nextAt: nextCalendarSlotAfter(schedule, schedule.anchorAt) ?? null };
		case "event":
			return { kind: "event", throughOrdinal: schedule.anchorOrdinal, replayGaps: schedule.anchorReplayGaps };
	}
}

/** Cursor once the slot at `scheduledAt` is consumed (claimed, reported or already journaled). */
export function routineCursorAfter(
	schedule: Exclude<RoutineSchedule, { kind: "event" }>,
	scheduledAt: number,
): RoutineCursor {
	if (schedule.kind === "interval")
		return { kind: "interval", nextIndex: Math.floor((scheduledAt - schedule.anchorAt) / schedule.intervalMs) + 1 };
	if (schedule.kind === "calendar")
		return { kind: "calendar", nextAt: nextCalendarSlotAfter(schedule, scheduledAt) ?? null };
	return { kind: "once", consumed: true };
}

/** The slot before the cursor's next one, when one exists after the anchor; undefined for once and event schedules. */
export function routinePreviousSlot(schedule: RoutineSchedule, cursor: RoutineCursor): number | undefined {
	if (schedule.kind === "interval" && cursor.kind === "interval" && cursor.nextIndex > 1)
		return schedule.anchorAt + schedule.intervalMs * (cursor.nextIndex - 1);
	if (schedule.kind !== "calendar" || cursor.kind !== "calendar" || cursor.nextAt === null) return undefined;
	const previous = latestCalendarSlotAtOrBefore(schedule, cursor.nextAt - 1, schedule.anchorAt);
	return previous > schedule.anchorAt ? previous : undefined;
}

/**
 * A clock cursor restarted at the first slot after `nowMs`, when the slot before its next one is later than `nowMs`.
 * The cursor then moved past a slot that is still in the future: it was consumed while the clock read later than now
 * (a forward clock fault since corrected, or a step back right after a claim). Without the restart the routine would
 * stay silent until that future slot. A slot that already has its occurrence is not repeated: the claim treats it as
 * consumed. `previousSlot` is `routinePreviousSlot` of the same cursor; undefined when no restart applies.
 */
export function rebasedRoutineCursor(
	schedule: RoutineSchedule,
	cursor: RoutineCursor,
	nowMs: number,
	previousSlot: number | undefined,
): RoutineCursor | undefined {
	if (previousSlot === undefined || previousSlot <= nowMs) return undefined;
	if (schedule.kind === "interval")
		return {
			kind: "interval",
			nextIndex: Math.max(1, Math.floor((nowMs - schedule.anchorAt) / schedule.intervalMs) + 1),
		};
	if (schedule.kind !== "calendar" || cursor.kind !== "calendar") return undefined;
	return {
		kind: "calendar",
		nextAt: nextCalendarSlotAfter(schedule, Math.max(schedule.anchorAt, nowMs)) ?? null,
		...(cursor.skipped === undefined ? {} : { skipped: cursor.skipped }),
	};
}

export function parseRoutineExecutionSnapshot(value: unknown): RoutineExecutionSnapshot {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["parentSessionId", "parentBranchAnchor", "profileId", "savedIntent"])
	)
		throw new TypeError("Routine execution snapshot is invalid.");
	const parentSessionId = boundedString(value.parentSessionId, 200, "parent session id");
	const parentBranchAnchor = boundedString(value.parentBranchAnchor, 512, "parent branch anchor");
	const profileId = value.profileId === undefined ? undefined : boundedString(value.profileId, 256, "profile id");
	const savedIntent = parseWorkerSavedIntent(value.savedIntent);
	if (
		savedIntent.receiptOrigin.sessionId !== parentSessionId ||
		savedIntent.receiptOrigin.leafId !== parentBranchAnchor
	)
		throw new TypeError("Routine execution snapshot does not match its parent session.");
	return { parentSessionId, parentBranchAnchor, ...(profileId ? { profileId } : {}), savedIntent };
}

export function parseRoutineDefinition(value: unknown): PersistentRoutineDefinition | undefined {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"routineId",
			"incarnationId",
			"revision",
			"target",
			"prompt",
			"schedule",
			"enabled",
			"executionSnapshot",
			"origin",
			"createdAt",
			"updatedAt",
		])
	)
		return undefined;
	try {
		if (
			typeof value.routineId !== "string" ||
			!isRoutineId(value.routineId) ||
			typeof value.incarnationId !== "string" ||
			!/^[A-Za-z0-9_-]{16,128}$/u.test(value.incarnationId) ||
			typeof value.revision !== "number" ||
			!Number.isSafeInteger(value.revision) ||
			value.revision < 1 ||
			typeof value.prompt !== "string" ||
			!value.prompt.trim() ||
			value.prompt.length > MAX_ROUTINE_PROMPT_CHARS ||
			value.prompt !== value.prompt.trim() ||
			typeof value.enabled !== "boolean" ||
			!validIsoInstant(value.createdAt) ||
			!validIsoInstant(value.updatedAt) ||
			Date.parse(value.updatedAt) < Date.parse(value.createdAt)
		)
			return undefined;
		const target = parseRoutineTarget(value.target);
		const schedule = parseRoutineSchedule(value.schedule);
		const executionSnapshot =
			value.executionSnapshot === undefined ? undefined : parseRoutineExecutionSnapshot(value.executionSnapshot);
		if ((target.kind === "session") !== (executionSnapshot !== undefined)) return undefined;
		if (target.kind === "session" && executionSnapshot?.parentSessionId !== target.parentSessionId) return undefined;
		const origin = value.origin === undefined ? undefined : parseRoutineOrigin(value.origin);
		// Only the session that owns the source's ledger can have created a routine from it.
		if (origin && target.kind !== "session") return undefined;
		return {
			routineId: value.routineId,
			incarnationId: value.incarnationId,
			revision: value.revision,
			target,
			prompt: value.prompt,
			schedule,
			enabled: value.enabled,
			...(executionSnapshot ? { executionSnapshot } : {}),
			...(origin ? { origin } : {}),
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		};
	} catch {
		return undefined;
	}
}

export function parseRoutineDefinitionView(value: unknown): RoutineDefinitionView | undefined {
	if (!isPlainRecord(value)) return undefined;
	const {
		cursor: rawCursor,
		nextRunAt: rawNextRunAt,
		lastRunAt,
		lastStatus,
		lastSummary,
		awayRefusal: rawAwayRefusal,
		failureStreak,
		failurePause: rawFailurePause,
		conditionMet: rawConditionMet,
		...rawDefinition
	} = value;
	const definition = parseRoutineDefinition(rawDefinition);
	if (!definition) return undefined;
	try {
		const cursor = parseRoutineCursor(rawCursor);
		if (definition.schedule.kind === "interval" && cursor.kind === "interval") {
			const lastIndex = Math.floor(
				(MAX_ROUTINE_INSTANT_MS - definition.schedule.anchorAt) / definition.schedule.intervalMs,
			);
			if (cursor.nextIndex > lastIndex + 1) return undefined;
		}
		// Calendar slots are never re-derived here: zone rules may change after a slot was computed.
		if (
			definition.schedule.kind === "calendar" &&
			cursor.kind === "calendar" &&
			cursor.nextAt !== null &&
			cursor.nextAt <= definition.schedule.anchorAt
		)
			return undefined;
		if (
			definition.schedule.kind === "event" &&
			cursor.kind === "event" &&
			cursor.throughOrdinal < definition.schedule.anchorOrdinal
		)
			return undefined;
		const nextRunAt = nextRoutineAt(definition.schedule, cursor) ?? ROUTINE_NO_NEXT_RUN_AT;
		if (
			rawNextRunAt !== nextRunAt ||
			(lastRunAt !== undefined && !validInstant(lastRunAt)) ||
			(lastStatus !== undefined &&
				(typeof lastStatus !== "string" || !(ROUTINE_LAST_STATUSES as readonly string[]).includes(lastStatus))) ||
			(lastSummary !== undefined &&
				(typeof lastSummary !== "string" || lastSummary.length > MAX_ROUTINE_SUMMARY_CHARS))
		)
			return undefined;
		let awayRefusal: RoutineDefinitionView["awayRefusal"];
		if (rawAwayRefusal !== undefined) {
			if (
				!isPlainRecord(rawAwayRefusal) ||
				!hasOnlyKeys(rawAwayRefusal, ["reason", "at"]) ||
				!validInstant(rawAwayRefusal.at)
			)
				return undefined;
			awayRefusal = {
				reason: boundedString(rawAwayRefusal.reason, MAX_ROUTINE_SUMMARY_CHARS, "away refusal"),
				at: rawAwayRefusal.at,
			};
		}
		if (
			failureStreak !== undefined &&
			(typeof failureStreak !== "number" ||
				!Number.isSafeInteger(failureStreak) ||
				failureStreak < 1 ||
				failureStreak >= ROUTINE_FAILURE_PAUSE_THRESHOLD)
		)
			return undefined;
		let failurePause: RoutineFailurePause | undefined;
		if (rawFailurePause !== undefined) {
			if (
				!isPlainRecord(rawFailurePause) ||
				!hasOnlyKeys(rawFailurePause, ["after", "at", "occurrenceId", "lastError"]) ||
				typeof rawFailurePause.after !== "number" ||
				!Number.isSafeInteger(rawFailurePause.after) ||
				rawFailurePause.after < 1 ||
				!validInstant(rawFailurePause.at) ||
				definition.enabled
			)
				return undefined;
			failurePause = {
				after: rawFailurePause.after,
				at: rawFailurePause.at,
				occurrenceId: boundedString(rawFailurePause.occurrenceId, MAX_ROUTINE_SUMMARY_CHARS, "paused occurrence"),
				lastError: boundedString(rawFailurePause.lastError, MAX_ROUTINE_SUMMARY_CHARS, "pause error"),
			};
		}
		let conditionMet: RoutineConditionMet | undefined;
		if (rawConditionMet !== undefined) {
			if (
				!isPlainRecord(rawConditionMet) ||
				!hasOnlyKeys(rawConditionMet, ["at", "occurrenceId"]) ||
				!validInstant(rawConditionMet.at) ||
				definition.origin?.endCondition === undefined
			)
				return undefined;
			conditionMet = {
				at: rawConditionMet.at,
				occurrenceId: boundedString(
					rawConditionMet.occurrenceId,
					MAX_ROUTINE_SUMMARY_CHARS,
					"reporting occurrence",
				),
			};
		}
		return {
			...definition,
			cursor,
			nextRunAt,
			...(lastRunAt === undefined ? {} : { lastRunAt }),
			...(lastStatus === undefined ? {} : { lastStatus: lastStatus as RoutineDefinitionView["lastStatus"] }),
			...(lastSummary === undefined ? {} : { lastSummary }),
			...(awayRefusal ? { awayRefusal } : {}),
			...(failureStreak === undefined ? {} : { failureStreak }),
			...(failurePause ? { failurePause } : {}),
			...(conditionMet ? { conditionMet } : {}),
		};
	} catch {
		return undefined;
	}
}

export function parseRoutineOccurrence(value: unknown): RoutineOccurrence | undefined {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"occurrenceId",
			"routineId",
			"routineRevision",
			"definition",
			"parentOrigin",
			"target",
			"trigger",
			"phase",
			"createdAt",
			"updatedAt",
			"claim",
			"dispatchKey",
			"executionRef",
			"result",
			"priorUncertaintyResult",
			"uncertainty",
			"executor",
			"awaySettlement",
		]) ||
		(value.executor !== undefined && value.executor !== "away")
	)
		return undefined;
	try {
		if (
			typeof value.occurrenceId !== "string" ||
			!value.occurrenceId ||
			value.occurrenceId.length > 256 ||
			typeof value.routineId !== "string" ||
			!isRoutineId(value.routineId) ||
			!Number.isSafeInteger(value.routineRevision) ||
			(value.routineRevision as number) < 1 ||
			!validInstant(value.createdAt) ||
			!validInstant(value.updatedAt) ||
			value.updatedAt < value.createdAt
		)
			return undefined;
		const definition = parseRoutineDefinition(value.definition);
		const target = parseRoutineTarget(value.target);
		if (
			!definition ||
			definition.routineId !== value.routineId ||
			definition.revision !== value.routineRevision ||
			!isDeepStrictEqual(definition.target, target) ||
			value.createdAt < Date.parse(definition.updatedAt)
		)
			return undefined;
		const phases: readonly RoutineOccurrencePhase[] = [
			"pending",
			"claimed",
			"dispatching",
			"running",
			"uncertain",
			"terminal",
		];
		if (typeof value.phase !== "string" || !phases.includes(value.phase as RoutineOccurrencePhase)) return undefined;
		let trigger: RoutineOccurrenceTrigger;
		if (
			isPlainRecord(value.trigger) &&
			value.trigger.kind === "schedule" &&
			hasOnlyKeys(value.trigger, ["kind", "scheduledAt", "missedCount"]) &&
			validInstant(value.trigger.scheduledAt) &&
			value.trigger.scheduledAt <= value.createdAt &&
			Number.isSafeInteger(value.trigger.missedCount) &&
			(value.trigger.missedCount as number) >= 0
		) {
			trigger = {
				kind: "schedule",
				scheduledAt: value.trigger.scheduledAt,
				missedCount: value.trigger.missedCount as number,
			};
			if (definition.schedule.kind === "event") return undefined;
			if (definition.schedule.kind === "once") {
				if (trigger.scheduledAt !== definition.schedule.at || trigger.missedCount !== 0) return undefined;
			} else if (definition.schedule.kind === "calendar") {
				if (trigger.scheduledAt <= definition.schedule.anchorAt || trigger.missedCount > MAX_CALENDAR_MISSED_COUNT)
					return undefined;
			} else {
				const index = (trigger.scheduledAt - definition.schedule.anchorAt) / definition.schedule.intervalMs;
				if (!Number.isSafeInteger(index) || index < 1 || trigger.missedCount >= index) return undefined;
			}
		} else if (
			isPlainRecord(value.trigger) &&
			value.trigger.kind === "manual" &&
			hasOnlyKeys(value.trigger, ["kind", "commandId", "requestedAt"]) &&
			validInstant(value.trigger.requestedAt) &&
			value.trigger.requestedAt === value.createdAt
		) {
			trigger = {
				kind: "manual",
				commandId: boundedString(value.trigger.commandId, MAX_ROUTINE_COMMAND_ID_CHARS, "command id"),
				requestedAt: value.trigger.requestedAt,
			};
		} else if (
			isPlainRecord(value.trigger) &&
			value.trigger.kind === "event" &&
			definition.schedule.kind === "event" &&
			hasOnlyKeys(value.trigger, [
				"kind",
				"triggeredAt",
				"acceptedOrdinal",
				"missedCount",
				"historyGap",
				"event",
				"earlier",
				"bodiesElided",
			]) &&
			validInstant(value.trigger.triggeredAt) &&
			value.trigger.triggeredAt === value.createdAt &&
			Number.isSafeInteger(value.trigger.acceptedOrdinal) &&
			(value.trigger.acceptedOrdinal as number) > definition.schedule.anchorOrdinal &&
			Number.isSafeInteger(value.trigger.missedCount) &&
			(value.trigger.missedCount as number) >= 0 &&
			(value.trigger.missedCount as number) <= MAX_ROUTINE_EVENT_MISSED_COUNT &&
			(value.trigger.historyGap === undefined || value.trigger.historyGap === true)
		) {
			const base = {
				kind: "event" as const,
				triggeredAt: value.trigger.triggeredAt,
				acceptedOrdinal: value.trigger.acceptedOrdinal as number,
				missedCount: value.trigger.missedCount as number,
				...(value.trigger.historyGap ? { historyGap: true as const } : {}),
			};
			if (definition.schedule.source === "ci") {
				if (value.trigger.earlier !== undefined || value.trigger.bodiesElided !== undefined) return undefined;
				const event = parseCiAttemptTerminalEvent(value.trigger.event);
				if (!routineEventMatches(definition.schedule, event)) return undefined;
				trigger = { ...base, event };
			} else {
				const elided = value.trigger.bodiesElided;
				if (elided !== undefined && (elided !== true || value.phase !== "terminal")) return undefined;
				const earlierValue = value.trigger.earlier;
				if (
					earlierValue !== undefined &&
					(!Array.isArray(earlierValue) ||
						earlierValue.length === 0 ||
						earlierValue.length >= HOST_EVENT_LISTENER_LIMITS.maxBatch)
				)
					return undefined;
				const event = parseGithubThreadEvent(value.trigger.event);
				const earlier = (earlierValue ?? []).map((entry: unknown) => parseGithubThreadEvent(entry));
				const carried = [...earlier, event];
				const schedule = definition.schedule;
				if (
					new Set(carried.map((entry) => entry.eventId)).size !== carried.length ||
					carried.some((entry) => !routineEventMatches(schedule, entry)) ||
					(elided && carried.some((entry) => !isElidedGithubEvent(entry)))
				)
					return undefined;
				trigger = {
					...base,
					event,
					...(earlier.length > 0 ? { earlier } : {}),
					...(elided ? { bodiesElided: true as const } : {}),
				};
			}
		} else if (
			isPlainRecord(value.trigger) &&
			value.trigger.kind === "expiry" &&
			hasOnlyKeys(value.trigger, ["kind", "expiresAt"]) &&
			definition.schedule.kind !== "once" &&
			definition.schedule.expiresAt !== undefined &&
			value.trigger.expiresAt === definition.schedule.expiresAt &&
			definition.schedule.expiresAt <= value.createdAt &&
			value.phase === "terminal" &&
			value.dispatchKey === undefined
		) {
			trigger = { kind: "expiry", expiresAt: definition.schedule.expiresAt };
		} else if (
			isPlainRecord(value.trigger) &&
			value.trigger.kind === "condition" &&
			hasOnlyKeys(value.trigger, ["kind", "occurrenceId", "metAt"]) &&
			definition.origin?.endCondition !== undefined &&
			validInstant(value.trigger.metAt) &&
			value.trigger.metAt <= value.createdAt &&
			value.phase === "terminal" &&
			value.dispatchKey === undefined
		) {
			trigger = {
				kind: "condition",
				occurrenceId: boundedString(value.trigger.occurrenceId, 256, "reporting occurrence"),
				metAt: value.trigger.metAt,
			};
		} else return undefined;
		if (target.kind !== "session" && trigger.kind === "event") return undefined;
		if (value.occurrenceId !== routineOccurrenceId(definition, trigger)) return undefined;
		const parentOrigin = workerReceiptOriginFromValue(value.parentOrigin);
		if (
			target.kind === "session" &&
			(target.parentSessionId !== parentOrigin.sessionId ||
				!isDeepStrictEqual(definition.executionSnapshot?.savedIntent.receiptOrigin, parentOrigin))
		)
			return undefined;
		let claim: RoutineOccurrence["claim"];
		if (value.claim !== undefined) {
			if (
				!isPlainRecord(value.claim) ||
				!hasOnlyKeys(value.claim, ["token", "owner", "leaseUntil"]) ||
				!validInstant(value.claim.leaseUntil) ||
				value.claim.leaseUntil <= value.createdAt
			)
				return undefined;
			claim = {
				token: boundedString(value.claim.token, 128, "claim token"),
				owner: boundedString(value.claim.owner, 256, "claim owner"),
				leaseUntil: value.claim.leaseUntil,
			};
		}
		const dispatchKey =
			value.dispatchKey === undefined ? undefined : boundedString(value.dispatchKey, 512, "dispatch key");
		if (dispatchKey !== undefined && dispatchKey !== `routine:${value.occurrenceId}`) return undefined;
		let executionRef: RoutineOccurrence["executionRef"];
		if (value.executionRef !== undefined) {
			if (!isPlainRecord(value.executionRef) || !hasOnlyKeys(value.executionRef, ["taskId", "attemptId"]))
				return undefined;
			executionRef = {
				taskId: boundedString(value.executionRef.taskId, 200, "task id"),
				attemptId: boundedString(value.executionRef.attemptId, 200, "attempt id"),
			};
		}
		const result = value.result === undefined ? undefined : parseRoutineResult(value.result, parentOrigin.sessionId);
		const priorUncertaintyResult =
			value.priorUncertaintyResult === undefined
				? undefined
				: parseRoutineResult(value.priorUncertaintyResult, parentOrigin.sessionId);
		const uncertainty =
			value.uncertainty === undefined
				? undefined
				: boundedString(value.uncertainty, MAX_ROUTINE_SUMMARY_CHARS, "uncertainty");
		const beforeDispatch = value.phase === "pending" || value.phase === "claimed";
		const afterDispatch = value.phase === "dispatching" || value.phase === "running" || value.phase === "uncertain";
		if (
			beforeDispatch &&
			(dispatchKey !== undefined || executionRef !== undefined || result !== undefined || uncertainty !== undefined)
		)
			return undefined;
		if (value.phase === "pending" && claim !== undefined) return undefined;
		if ((value.phase === "claimed" || afterDispatch || dispatchKey !== undefined) && !claim) return undefined;
		if (value.phase === "claimed" && claim!.leaseUntil <= value.updatedAt) return undefined;
		if (afterDispatch && dispatchKey === undefined) return undefined;
		if (executionRef && (target.kind !== "session" || value.phase === "dispatching")) return undefined;
		if (value.phase === "running" && target.kind === "session" && !executionRef) return undefined;
		if ((value.phase === "terminal" || value.phase === "uncertain") !== (result !== undefined)) return undefined;
		if (result && (value.phase === "uncertain") !== (result.outcome === "uncertain")) return undefined;
		if ((value.phase === "uncertain") !== (uncertainty !== undefined)) return undefined;
		if (result && !dispatchKey && (result.outcome !== "cancelled" || executionRef)) return undefined;
		// Only a dispatched run of a routine with a stated end can report that end met.
		if (
			(result?.conditionMet || priorUncertaintyResult?.conditionMet) &&
			(!dispatchKey || definition.origin?.endCondition === undefined)
		)
			return undefined;
		let awaySettlement: RoutineOccurrence["awaySettlement"];
		if (value.awaySettlement !== undefined) {
			const settlement = value.awaySettlement;
			if (
				!isPlainRecord(settlement) ||
				!hasOnlyKeys(settlement, ["at", "costUsd"]) ||
				value.executor !== "away" ||
				value.phase !== "terminal" ||
				!dispatchKey ||
				!validInstant(settlement.at) ||
				settlement.at < value.createdAt ||
				(settlement.costUsd !== undefined &&
					(typeof settlement.costUsd !== "number" ||
						!Number.isFinite(settlement.costUsd) ||
						settlement.costUsd < 0))
			)
				return undefined;
			awaySettlement = {
				at: settlement.at,
				...(typeof settlement.costUsd === "number" ? { costUsd: settlement.costUsd } : {}),
			};
		}
		if (
			priorUncertaintyResult &&
			(value.phase !== "terminal" ||
				target.kind !== "session" ||
				!executionRef ||
				!result ||
				priorUncertaintyResult.outcome !== "uncertain" ||
				result.outcome === "uncertain" ||
				priorUncertaintyResult.digest === result.digest)
		)
			return undefined;
		return {
			occurrenceId: value.occurrenceId,
			routineId: value.routineId,
			routineRevision: value.routineRevision as number,
			definition,
			parentOrigin,
			target,
			trigger,
			phase: value.phase as RoutineOccurrencePhase,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
			...(claim ? { claim } : {}),
			...(dispatchKey === undefined ? {} : { dispatchKey }),
			...(executionRef ? { executionRef } : {}),
			...(result ? { result } : {}),
			...(priorUncertaintyResult ? { priorUncertaintyResult } : {}),
			...(uncertainty === undefined ? {} : { uncertainty }),
			...(value.executor === "away" ? { executor: "away" as const } : {}),
			...(awaySettlement ? { awaySettlement } : {}),
		};
	} catch {
		return undefined;
	}
}

/** Both retained result versions obey the same payload identity and delivery contract. */
function parseRoutineResult(value: unknown, parentSessionId: string): RoutineResult {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"outcome",
			"summary",
			"digest",
			"delivery",
			"recipient",
			"deliveryMarker",
			"ownerUpdate",
			"conditionMet",
		]) ||
		typeof value.outcome !== "string" ||
		!["succeeded", "failed", "cancelled", "uncertain"].includes(value.outcome) ||
		typeof value.summary !== "string" ||
		!value.summary.trim() ||
		value.summary.length > MAX_ROUTINE_SUMMARY_CHARS ||
		typeof value.digest !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.digest) ||
		(value.delivery !== "pending" && value.delivery !== "acknowledged") ||
		(value.ownerUpdate !== undefined && (value.ownerUpdate !== "none" || value.outcome !== "succeeded")) ||
		(value.conditionMet !== undefined && (value.conditionMet !== true || value.outcome !== "succeeded"))
	)
		throw new TypeError("Routine result is invalid.");
	const recipient = boundedString(value.recipient, 200, "recipient");
	const outcome = value.outcome as RoutineTerminalOutcome;
	const deliveryMarker =
		value.deliveryMarker === undefined ? undefined : boundedString(value.deliveryMarker, 256, "delivery marker");
	if (
		(value.delivery === "acknowledged") !== (deliveryMarker !== undefined) ||
		recipient !== parentSessionId ||
		value.digest !==
			routineResultDigest(
				outcome,
				value.summary,
				recipient,
				value.ownerUpdate === "none",
				value.conditionMet === true,
			)
	)
		throw new TypeError("Routine result does not match its parent or delivery receipt.");
	return {
		outcome,
		summary: value.summary,
		digest: value.digest,
		delivery: value.delivery,
		recipient,
		...(deliveryMarker === undefined ? {} : { deliveryMarker }),
		...(value.ownerUpdate === "none" ? { ownerUpdate: "none" as const } : {}),
		...(value.conditionMet === true ? { conditionMet: true as const } : {}),
	};
}

/** Read migration for pre-contract bot/team interval records in `routineSchedules` or the old `routines` key. */
export function parseLegacyRoutineDefinition(value: unknown): PersistentRoutineDefinition | undefined {
	if (!isPlainRecord(value) || value.schedule !== undefined) return parseRoutineDefinition(value);
	if (
		typeof value.intervalMs !== "number" ||
		!Number.isSafeInteger(value.intervalMs) ||
		value.intervalMs < MIN_ROUTINE_INTERVAL_MS ||
		!validInstant(value.nextRunAt) ||
		!validIsoInstant(value.createdAt) ||
		!validIsoInstant(value.updatedAt)
	)
		return undefined;
	const anchorAt = value.nextRunAt - value.intervalMs;
	if (!validInstant(anchorAt)) return undefined;
	const target = value.target;
	if (!isPlainRecord(target) || (target.kind !== "bot" && target.kind !== "team")) return undefined;
	return parseRoutineDefinition({
		routineId: value.routineId,
		incarnationId: `legacy-${createHash("sha256")
			.update(JSON.stringify([value.routineId, value.createdAt]))
			.digest("hex")}`,
		revision: 1,
		target,
		prompt: typeof value.prompt === "string" ? value.prompt.trim() : value.prompt,
		schedule: { kind: "interval", intervalMs: value.intervalMs, anchorAt },
		enabled: value.enabled === undefined ? true : value.enabled,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	});
}

export function parseRoutineSchedule(value: unknown): RoutineSchedule {
	if (!isPlainRecord(value)) throw new TypeError("Routine schedule is invalid.");
	if (value.expiresAt !== undefined && (value.kind === "once" || !validInstant(value.expiresAt)))
		throw new TypeError("Persisted routine end time is invalid.");
	const expiry = value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as number };
	if (value.kind === "calendar") {
		// A stored zone is checked for shape only: canonical spellings and supported zones differ across runtimes, and a
		// zone this runtime cannot use makes that routine unschedulable here (`routineZoneUnsupported`), never the store
		// unreadable. Saving still refuses an unsupported zone (`parseRoutineScheduleInput`).
		if (
			hasOnlyKeys(value, ["kind", "cron", "timeZone", "anchorAt", "maxLatenessMs", "expiresAt"]) &&
			typeof value.cron === "string" &&
			canonicalCalendarCron(value.cron) === value.cron &&
			isCalendarTimeZoneName(value.timeZone) &&
			validInstant(value.anchorAt) &&
			(value.maxLatenessMs === undefined ||
				(Number.isSafeInteger(value.maxLatenessMs) &&
					(value.maxLatenessMs as number) >= MIN_ROUTINE_START_WINDOW_MS &&
					(value.maxLatenessMs as number) <= MAX_ROUTINE_LATENESS_MS))
		)
			return {
				kind: "calendar",
				cron: value.cron,
				timeZone: value.timeZone,
				anchorAt: value.anchorAt,
				...(value.maxLatenessMs === undefined ? {} : { maxLatenessMs: value.maxLatenessMs as number }),
				...expiry,
			};
		throw new TypeError("Persisted calendar schedule requires a canonical rule, a zone name and an anchor.");
	}
	if (value.kind === "event" && value.source === "github") {
		const { anchorOrdinal, anchorReplayGaps, anchorAt, ...rest } = value;
		if (
			Number.isSafeInteger(anchorOrdinal) &&
			(anchorOrdinal as number) >= 0 &&
			isRoutineDigest(anchorReplayGaps) &&
			validInstant(anchorAt)
		) {
			const authored = parseRoutineScheduleInput(rest);
			// Only the canonical form is stored: a filter in another order or case is not this host's record.
			if (authored.kind === "event" && authored.source === "github" && isDeepStrictEqual(authored, rest))
				return {
					...githubFilterOf(authored),
					...(authored.stopAfterFirstRun ? { stopAfterFirstRun: true as const } : {}),
					...expiry,
					anchorOrdinal: anchorOrdinal as number,
					anchorReplayGaps,
					anchorAt,
				};
		}
		throw new TypeError(
			"Persisted GitHub event schedule requires a canonical filter, a ledger anchor and its start.",
		);
	}
	if (value.kind === "event") {
		if (
			hasOnlyKeys(value, [
				"kind",
				"source",
				"conclusions",
				"workflowPath",
				"stopAfterFirstRun",
				"expiresAt",
				"anchorOrdinal",
				"anchorReplayGaps",
			]) &&
			Number.isSafeInteger(value.anchorOrdinal) &&
			(value.anchorOrdinal as number) >= 0 &&
			isRoutineDigest(value.anchorReplayGaps)
		) {
			const authored = parseRoutineScheduleInput({
				kind: value.kind,
				source: value.source,
				conclusions: value.conclusions,
				...(value.workflowPath === undefined ? {} : { workflowPath: value.workflowPath }),
				...(value.stopAfterFirstRun === undefined ? {} : { stopAfterFirstRun: value.stopAfterFirstRun }),
				...expiry,
			});
			if (
				authored.kind === "event" &&
				authored.source === "ci" &&
				isDeepStrictEqual(authored.conclusions, value.conclusions)
			)
				return {
					kind: "event",
					source: authored.source,
					conclusions: canonicalRoutineConclusions(authored.conclusions),
					...(authored.workflowPath === undefined ? {} : { workflowPath: authored.workflowPath }),
					...(authored.stopAfterFirstRun ? { stopAfterFirstRun: true as const } : {}),
					...expiry,
					anchorOrdinal: value.anchorOrdinal as number,
					anchorReplayGaps: value.anchorReplayGaps,
				};
		}
		throw new TypeError("Persisted event schedule requires a canonical filter and a ledger anchor.");
	}
	const authored = parseRoutineScheduleInput(
		value.kind === "interval" ? { kind: "interval", intervalMs: value.intervalMs, ...expiry } : value,
	);
	if (authored.kind === "once") return authored;
	if (
		authored.kind === "interval" &&
		hasOnlyKeys(value, ["kind", "intervalMs", "anchorAt", "expiresAt"]) &&
		validInstant(value.anchorAt) &&
		validInstant(value.anchorAt + authored.intervalMs)
	)
		return { ...authored, anchorAt: value.anchorAt };
	throw new TypeError("Persisted interval schedule requires a valid anchor and first occurrence.");
}

export function parseRoutineTarget(value: unknown): PersistentRoutineTarget {
	if (!isPlainRecord(value)) throw new TypeError("Routine target is invalid.");
	if (value.kind === "bot" && hasOnlyKeys(value, ["kind", "agentId"]))
		return { kind: "bot", agentId: boundedString(value.agentId, 128, "bot id") };
	if (value.kind === "team" && hasOnlyKeys(value, ["kind", "teamId"]))
		return { kind: "team", teamId: boundedString(value.teamId, 128, "team id") };
	if (value.kind === "session" && hasOnlyKeys(value, ["kind", "parentSessionId"]))
		return { kind: "session", parentSessionId: boundedString(value.parentSessionId, 200, "parent session id") };
	throw new TypeError("Routine target kind is unsupported.");
}

export function isRoutineId(value: string): boolean {
	return value.length > 0 && value.length <= MAX_ROUTINE_ID_CHARS && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value);
}

export function parseRoutineCursor(value: unknown): RoutineCursor {
	if (!isPlainRecord(value)) throw new TypeError("Routine cursor is invalid.");
	if (
		value.kind === "interval" &&
		hasOnlyKeys(value, ["kind", "nextIndex"]) &&
		Number.isSafeInteger(value.nextIndex) &&
		(value.nextIndex as number) >= 1
	)
		return { kind: "interval", nextIndex: value.nextIndex as number };
	if (value.kind === "once" && hasOnlyKeys(value, ["kind", "consumed"]) && typeof value.consumed === "boolean")
		return { kind: "once", consumed: value.consumed };
	if (
		value.kind === "calendar" &&
		hasOnlyKeys(value, ["kind", "nextAt", "skipped"]) &&
		(value.nextAt === null || validInstant(value.nextAt)) &&
		(value.skipped === undefined ||
			(Number.isSafeInteger(value.skipped) &&
				(value.skipped as number) >= 1 &&
				(value.skipped as number) <= MAX_CALENDAR_MISSED_COUNT))
	)
		return {
			kind: "calendar",
			nextAt: value.nextAt,
			...(value.skipped === undefined ? {} : { skipped: value.skipped as number }),
		};
	if (
		value.kind === "event" &&
		hasOnlyKeys(value, ["kind", "throughOrdinal", "replayGaps", "skipped", "historyGap", "spent"]) &&
		(value.spent === undefined || value.spent === true) &&
		Number.isSafeInteger(value.throughOrdinal) &&
		(value.throughOrdinal as number) >= 0 &&
		isRoutineDigest(value.replayGaps) &&
		(value.skipped === undefined ||
			(Number.isSafeInteger(value.skipped) &&
				(value.skipped as number) >= 1 &&
				(value.skipped as number) <= MAX_ROUTINE_EVENT_MISSED_COUNT)) &&
		(value.historyGap === undefined || value.historyGap === true)
	)
		return {
			kind: "event",
			throughOrdinal: value.throughOrdinal as number,
			replayGaps: value.replayGaps,
			...(value.skipped === undefined ? {} : { skipped: value.skipped as number }),
			...(value.historyGap ? { historyGap: true as const } : {}),
			...(value.spent ? { spent: true as const } : {}),
		};
	throw new TypeError("Routine cursor is invalid.");
}

function isRoutineDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function parseRoutineOrigin(value: unknown): RoutineOrigin {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["kind", "sourceId", "defaults", "endCondition"]) ||
		value.kind !== "owner-intake"
	)
		throw new TypeError("Routine origin is invalid.");
	return {
		kind: "owner-intake",
		sourceId: boundedString(value.sourceId, MAX_ROUTINE_SOURCE_ID_CHARS, "source id"),
		...parseIntakeDefaults(value.defaults),
		...parseEndCondition(value.endCondition),
	};
}

function parseEndCondition(value: unknown): { endCondition?: string } {
	return value === undefined
		? {}
		: { endCondition: boundedString(value, MAX_ROUTINE_INTAKE_TEXT_CHARS, "intake end condition") };
}

/** Optional host-chosen timing parts: a bounded, non-empty list of bounded descriptions. */
function parseIntakeDefaults(value: unknown): { defaults?: readonly string[] } {
	if (value === undefined) return {};
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROUTINE_INTAKE_DEFAULTS)
		throw new TypeError("Routine intake defaults are invalid.");
	return {
		defaults: value.map((entry: unknown) => boundedString(entry, MAX_ROUTINE_INTAKE_TEXT_CHARS, "intake default")),
	};
}

/** The host's intake identity for one creation; a malformed one is a programming error, not a refusal. */
export function parseRoutineIntakeOrigin(value: unknown): RoutineIntakeOrigin {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["key", "sourceId", "defaults", "endCondition"]) ||
		!isRoutineDigest(value.key)
	)
		throw new TypeError("Routine intake origin is invalid.");
	return {
		key: value.key,
		sourceId: boundedString(value.sourceId, MAX_ROUTINE_SOURCE_ID_CHARS, "source id"),
		...parseIntakeDefaults(value.defaults),
		...parseEndCondition(value.endCondition),
	};
}

/** The persisted consumed-origin journal, oldest first; one malformed or repeated entry rejects the whole journal. */
export function parseRoutineIntakeConsumptions(value: unknown): RoutineIntakeConsumption[] {
	if (!Array.isArray(value) || value.length > MAX_ROUTINE_INTAKE_ORIGINS)
		throw new TypeError("Routine intake journal has an invalid size.");
	const keys = new Set<string>();
	return value.map((entry: unknown) => {
		if (
			!isPlainRecord(entry) ||
			!hasOnlyKeys(entry, ["key", "parentSessionId", "at"]) ||
			!isRoutineDigest(entry.key) ||
			keys.has(entry.key) ||
			!validInstant(entry.at)
		)
			throw new TypeError("Routine intake journal contains an invalid or repeated entry.");
		keys.add(entry.key);
		return {
			key: entry.key,
			parentSessionId: boundedString(entry.parentSessionId, 200, "parent session id"),
			at: entry.at,
		};
	});
}

/** The persisted per-session intake states, least recently written first; one invalid entry rejects them all. */
export function parseRoutineIntakeSessions(value: unknown): RoutineIntakeSession[] {
	if (!Array.isArray(value) || value.length > MAX_ROUTINE_INTAKE_SESSIONS)
		throw new TypeError("Routine intake sessions have an invalid size.");
	const sessions = new Set<string>();
	return value.map((entry: unknown) => {
		// `toolAuthoredThrough` is the unreleased instant watermark `answered` replaced; it is read and dropped so a store
		// an earlier build of this release wrote still loads.
		if (
			!isPlainRecord(entry) ||
			!hasOnlyKeys(entry, [
				"parentSessionId",
				"answered",
				"toolAuthoredThrough",
				"through",
				"batch",
				"unannounced",
				"updatedAt",
			])
		)
			throw new TypeError("Routine intake session state is invalid.");
		const parentSessionId = boundedString(entry.parentSessionId, 200, "parent session id");
		if (
			sessions.has(parentSessionId) ||
			!validInstant(entry.updatedAt) ||
			(entry.toolAuthoredThrough !== undefined && !validInstant(entry.toolAuthoredThrough)) ||
			(entry.through !== undefined && !validInstant(entry.through)) ||
			(entry.answered !== undefined &&
				(!Array.isArray(entry.answered) ||
					entry.answered.length === 0 ||
					entry.answered.length > MAX_ROUTINE_INTAKE_ANSWERED)) ||
			(entry.unannounced !== undefined &&
				(!Array.isArray(entry.unannounced) ||
					entry.unannounced.length === 0 ||
					entry.unannounced.length > MAX_ROUTINE_INTAKE_UNANNOUNCED))
		)
			throw new TypeError("Routine intake session state is invalid or repeated.");
		sessions.add(parentSessionId);
		const answered = (entry.answered as unknown[] | undefined)?.map((sourceId) =>
			boundedString(sourceId, MAX_ROUTINE_SOURCE_ID_CHARS, "answered source id"),
		);
		if (answered && new Set(answered).size !== answered.length)
			throw new TypeError("Routine intake answered sources repeat.");
		const unannounced = (entry.unannounced as unknown[] | undefined)?.map(parseRoutineIntakeNoticeRecord);
		if (unannounced && new Set(unannounced.map((record) => record.key)).size !== unannounced.length)
			throw new TypeError("Routine intake notices repeat a request.");
		return {
			parentSessionId,
			...(answered === undefined ? {} : { answered }),
			...(entry.through === undefined ? {} : { through: entry.through }),
			...(entry.batch === undefined ? {} : { batch: parseRoutineIntakeBatch(entry.batch, parentSessionId) }),
			...(unannounced === undefined ? {} : { unannounced }),
			updatedAt: entry.updatedAt,
		};
	});
}

/** One retained intake notice; a malformed one rejects the session state. */
export function parseRoutineIntakeNoticeRecord(value: unknown): RoutineIntakeNoticeRecord {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["key", "sourceId", "prompt", "defaults", "outcome"]) ||
		!isRoutineDigest(value.key) ||
		!isPlainRecord(value.outcome)
	)
		throw new TypeError("Routine intake notice is invalid.");
	const outcome = value.outcome;
	let parsed: RoutineIntakeNoticeRecord["outcome"];
	if (outcome.kind === "created" && hasOnlyKeys(outcome, ["kind", "routineId", "cadence"]))
		parsed = {
			kind: "created",
			routineId: boundedString(outcome.routineId, 128, "routine id"),
			cadence: boundedString(outcome.cadence, MAX_ROUTINE_INTAKE_TEXT_CHARS, "cadence"),
		};
	else if ((outcome.kind === "refused" || outcome.kind === "dropped") && hasOnlyKeys(outcome, ["kind", "reason"]))
		parsed = {
			kind: outcome.kind,
			reason: boundedString(outcome.reason, MAX_ROUTINE_INTAKE_TEXT_CHARS, "intake reason"),
		};
	else throw new TypeError("Routine intake notice outcome is invalid.");
	return {
		key: value.key,
		sourceId: boundedString(value.sourceId, MAX_ROUTINE_SOURCE_ID_CHARS, "source id"),
		prompt: boundedString(value.prompt, MAX_ROUTINE_INTAKE_NOTICE_PROMPT_CHARS, "intake notice words"),
		...parseIntakeDefaults(value.defaults),
		outcome: parsed,
	};
}

function parseIntakeDecision(value: unknown): RoutineIntakeDecision {
	if (isPlainRecord(value)) {
		if (value.kind === "created" && hasOnlyKeys(value, ["kind", "routineId"]))
			return { kind: "created", routineId: boundedString(value.routineId, 128, "routine id") };
		if (value.kind === "refused" && hasOnlyKeys(value, ["kind", "reason"]))
			return {
				kind: "refused",
				reason: boundedString(value.reason, MAX_ROUTINE_INTAKE_TEXT_CHARS, "intake reason"),
			};
		if (value.kind === "passed" && hasOnlyKeys(value, ["kind"])) return { kind: "passed" };
	}
	throw new TypeError("Routine intake decision is invalid.");
}

/**
 * One retained intake pass of `parentSessionId`; every source must be one of that session's. `origin` is the
 * unreleased notice anchor notices no longer use (each delivery captures its own); it is read and dropped.
 */
export function parseRoutineIntakeBatch(value: unknown, parentSessionId: string): RoutineIntakeBatch {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["operationId", "origin", "sourceIds", "through", "requests", "dropped"]) ||
		typeof value.operationId !== "string" ||
		!value.operationId.startsWith(ROUTINE_INTAKE_OPERATION_PREFIX) ||
		value.operationId.length > ROUTINE_INTAKE_OPERATION_PREFIX.length + 64 ||
		!Array.isArray(value.sourceIds) ||
		value.sourceIds.length === 0 ||
		value.sourceIds.length > MAX_ROUTINE_INTAKE_BATCH_SOURCES ||
		!validInstant(value.through) ||
		(value.requests !== undefined &&
			(!Array.isArray(value.requests) ||
				value.requests.length > MAX_ROUTINE_INTAKE_BATCH_SOURCES * MAX_ROUTINE_INTAKE_SOURCE_REQUESTS)) ||
		(value.dropped !== undefined &&
			(value.requests === undefined ||
				!Array.isArray(value.dropped) ||
				value.dropped.length === 0 ||
				value.dropped.length > MAX_ROUTINE_INTAKE_BATCH_SOURCES * MAX_ROUTINE_INTAKE_SOURCE_REQUESTS))
	)
		throw new TypeError("Routine intake batch is invalid.");
	const sourceIds = value.sourceIds.map((sourceId: unknown) =>
		boundedString(sourceId, MAX_ROUTINE_SOURCE_ID_CHARS, "source id"),
	);
	if (
		sourceIds.some((sourceId) => !sourceId.startsWith(`${parentSessionId}/`)) ||
		new Set(sourceIds).size !== sourceIds.length
	)
		throw new TypeError("Routine intake batch belongs to another session or repeats a source.");
	const keys = new Set<string>();
	const requests = (value.requests as unknown[] | undefined)?.map((entry): RoutineIntakeRequest => {
		// `done` is the unreleased marker `outcome` replaced; a decided request it marks is kept decided, with no notice.
		if (
			!isPlainRecord(entry) ||
			!hasOnlyKeys(entry, [
				"key",
				"sourceId",
				"prompt",
				"schedule",
				"cadence",
				"defaults",
				"endCondition",
				"outcome",
				"done",
			]) ||
			!isRoutineDigest(entry.key) ||
			keys.has(entry.key) ||
			typeof entry.sourceId !== "string" ||
			!sourceIds.includes(entry.sourceId) ||
			(entry.done !== undefined && (entry.done !== true || entry.outcome !== undefined))
		)
			throw new TypeError("Routine intake request is invalid or repeated.");
		keys.add(entry.key);
		const outcome = entry.done ? { kind: "passed" as const } : entry.outcome;
		return {
			key: entry.key,
			sourceId: entry.sourceId,
			prompt: boundedString(entry.prompt, MAX_ROUTINE_PROMPT_CHARS, "prompt"),
			schedule: parseRoutineScheduleInput(entry.schedule),
			cadence: boundedString(entry.cadence, MAX_ROUTINE_INTAKE_TEXT_CHARS, "cadence"),
			...parseIntakeDefaults(entry.defaults),
			...parseEndCondition(entry.endCondition),
			...(outcome === undefined ? {} : { outcome: parseIntakeDecision(outcome) }),
		};
	});
	const dropped = (value.dropped as unknown[] | undefined)?.map((entry): RoutineIntakeDrop => {
		if (
			!isPlainRecord(entry) ||
			!hasOnlyKeys(entry, ["key", "sourceId", "excerpt", "reason"]) ||
			!isRoutineDigest(entry.key) ||
			keys.has(entry.key) ||
			typeof entry.sourceId !== "string" ||
			!sourceIds.includes(entry.sourceId)
		)
			throw new TypeError("Routine intake drop is invalid or repeated.");
		keys.add(entry.key);
		return {
			key: entry.key,
			sourceId: entry.sourceId,
			excerpt: boundedString(entry.excerpt, MAX_ROUTINE_INTAKE_NOTICE_PROMPT_CHARS, "intake excerpt"),
			reason: boundedString(entry.reason, MAX_ROUTINE_INTAKE_TEXT_CHARS, "intake reason"),
		};
	});
	return {
		operationId: value.operationId,
		sourceIds,
		through: value.through,
		...(requests === undefined ? {} : { requests }),
		...(dropped === undefined ? {} : { dropped }),
	};
}

export function nextRoutineAt(schedule: RoutineSchedule, cursor: RoutineCursor): number | undefined {
	if (schedule.kind === "once") {
		if (cursor.kind !== "once") throw new TypeError("Routine cursor does not match its schedule.");
		return cursor.consumed ? undefined : schedule.at;
	}
	if (schedule.kind === "calendar") {
		if (cursor.kind !== "calendar") throw new TypeError("Routine cursor does not match its schedule.");
		return cursor.nextAt ?? undefined;
	}
	if (schedule.kind === "event") {
		if (cursor.kind !== "event") throw new TypeError("Routine cursor does not match its schedule.");
		// Host events, not a clock, decide when an event routine runs.
		return undefined;
	}
	if (cursor.kind !== "interval") throw new TypeError("Routine cursor does not match its schedule.");
	const nextAt = schedule.anchorAt + schedule.intervalMs * cursor.nextIndex;
	return Number.isSafeInteger(nextAt) && nextAt <= MAX_ROUTINE_INSTANT_MS ? nextAt : undefined;
}

function boundedString(value: unknown, maximum: number, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > maximum ||
		value.trim() !== value ||
		value.includes("\0")
	)
		throw new TypeError(`Routine ${label} is invalid.`);
	return value;
}

function validInstant(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ROUTINE_INSTANT_MS;
}

function validIsoInstant(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const instant = Date.parse(value);
	return validInstant(instant) && new Date(instant).toISOString() === value;
}

/**
 * A quiet result, and one reporting the stated end met, extend the original payload so results without them keep
 * their digest.
 */
export function routineResultDigest(
	outcome: RoutineTerminalOutcome,
	summary: string,
	recipient: string,
	quiet = false,
	conditionMet = false,
): string {
	return createHash("sha256")
		.update(
			`${outcome}\0${summary}\0${recipient}${quiet ? "\0owner-update:none" : ""}${conditionMet ? "\0condition-met" : ""}`,
		)
		.digest("hex");
}

export function routineOccurrenceId(
	definition: Pick<PersistentRoutineDefinition, "incarnationId" | "revision">,
	trigger: RoutineOccurrenceTrigger,
): string {
	let suffix: string;
	if (trigger.kind === "schedule") suffix = String(trigger.scheduledAt);
	else if (trigger.kind === "expiry") suffix = `expiry:${trigger.expiresAt}`;
	else if (trigger.kind === "condition")
		suffix = `condition:${createHash("sha256").update(trigger.occurrenceId).digest("hex")}`;
	else if (trigger.kind === "manual")
		suffix = `manual:${createHash("sha256").update(trigger.commandId).digest("hex")}`;
	else if (!isCiAttemptEvent(trigger.event))
		return githubBatchId(
			definition,
			routineTriggerEvents(trigger).map((event) => event.eventId),
		);
	else {
		// Keyed by the attempt, not the ledger position: a re-presented attempt is the same occurrence.
		const identity = trigger.event.identity;
		const key = [identity.provider, identity.host, identity.repositoryId, identity.runId, identity.runAttempt];
		suffix = `event:${createHash("sha256").update(JSON.stringify(key)).digest("hex")}`;
	}
	return `${definition.incarnationId}:${definition.revision}:${suffix}`;
}

/** A GitHub run is keyed by the occurrences it carries, as a set: a re-presented batch is the same occurrence. */
function githubBatchId(
	definition: Pick<PersistentRoutineDefinition, "incarnationId" | "revision">,
	eventIds: readonly string[],
): string {
	const key = ["github", ...[...eventIds].sort()];
	return `${definition.incarnationId}:${definition.revision}:event:${createHash("sha256").update(JSON.stringify(key)).digest("hex")}`;
}

/**
 * The replay key of one event for a routine revision: what its journal entry or, once pruned, its tombstone records.
 * A CI attempt's is its occurrence id; a GitHub occurrence's is the id a run carrying it alone would have, so every
 * occurrence a batch carries is consumed with it.
 */
export function routineEventKey(
	definition: Pick<PersistentRoutineDefinition, "incarnationId" | "revision">,
	event: CiAttemptTerminalEvent | GithubThreadEvent,
): string {
	return isCiAttemptEvent(event)
		? routineOccurrenceId(definition, { kind: "event", triggeredAt: 0, acceptedOrdinal: 0, missedCount: 0, event })
		: githubBatchId(definition, [event.eventId]);
}

/** The replay keys an occurrence consumes: its own id, and for a GitHub run every carried occurrence's key. */
export function routineOccurrenceReplayKeys(
	occurrence: Pick<RoutineOccurrence, "occurrenceId" | "trigger" | "definition">,
): readonly string[] {
	const trigger = occurrence.trigger;
	if (trigger.kind !== "event" || isCiAttemptEvent(trigger.event)) return [occurrence.occurrenceId];
	return [
		...new Set([
			occurrence.occurrenceId,
			...routineTriggerEvents(trigger).map((event) => routineEventKey(occurrence.definition, event)),
		]),
	];
}

function isElidedGithubEvent(event: GithubThreadEvent): boolean {
	return event.body === undefined || (event.body.text === "" && (event.body.truncated || event.body.bytes === 0));
}

/**
 * A delivered GitHub run's history without the third party's words: each carried body keeps only its length, the
 * rest of the occurrence stays. The same object when there is nothing to drop (not a delivered terminal GitHub run,
 * or already elided). Delivered runs are never dispatched or reconciled again, and notification ownership skips them,
 * so their brief, which no longer equals the dispatched text, is never matched against their attempts.
 */
export function elideDeliveredRoutineEventBodies(occurrence: RoutineOccurrence): RoutineOccurrence {
	const trigger = occurrence.trigger;
	if (
		trigger.kind !== "event" ||
		isCiAttemptEvent(trigger.event) ||
		("bodiesElided" in trigger && trigger.bodiesElided) ||
		occurrence.phase !== "terminal" ||
		occurrence.result?.delivery !== "acknowledged" ||
		(occurrence.priorUncertaintyResult !== undefined && occurrence.priorUncertaintyResult.delivery !== "acknowledged")
	)
		return occurrence;
	const elide = (event: GithubThreadEvent): GithubThreadEvent =>
		event.body === undefined
			? event
			: createGithubThreadEvent({
					...event,
					body: { text: "", truncated: event.body.bytes > 0, bytes: event.body.bytes },
				});
	const earlier = "earlier" in trigger && trigger.earlier ? trigger.earlier.map(elide) : undefined;
	return {
		...occurrence,
		trigger: {
			...trigger,
			event: elide(trigger.event),
			...(earlier ? { earlier } : {}),
			bodiesElided: true,
		},
	};
}
