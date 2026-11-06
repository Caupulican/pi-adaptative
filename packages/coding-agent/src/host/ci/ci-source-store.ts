import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type CiAttemptTerminalEvent,
	type CiCurrentObservation,
	type CiHostEventEnvelope,
	type CiSubject,
	ciEventSubject,
	ciSubjectKey,
	type GithubThreadEvent,
	type HostEventCatchUp,
	type HostEventConsumerCheckpoint,
	type HostEventEnvelope,
	type HostEventReceipt,
	type HostEventReplayGapReason,
	type HostEventSourceRegistration,
	hostEventArray,
	hostEventDate,
	hostEventInteger,
	hostEventRecord,
	hostEventString,
	isCiEnvelope,
	isHostEventReplayGapReason,
	MAX_HOST_EVENT_SUBJECTS,
	mergeSequenceRanges,
	parseCiCurrentObservation,
	parseCiHostEventEnvelope,
	parseCiSubject,
	parseHostEventCatchUp,
	parseHostEventEnvelope,
	parseHostEventSourceRegistration,
} from "../../core/events/host-event-contract.ts";
import {
	type GithubThreadInterest,
	githubInterestScopeKey,
	HOST_EVENT_LISTENER_LIMITS,
	parseGithubThreadInterest,
} from "../../core/events/host-event-kinds.ts";
import { boundedRedactedDiagnosticText, MAX_RETAINED_DIAGNOSTIC_CHARS } from "../../core/security/secret-text.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../../core/util/atomic-file.ts";
import {
	isProcessOwnerRecord,
	judgeOwner,
	ownProcessOwner,
	type ProcessOwner,
} from "../../kernel/reliability/owner-identity.ts";
import { BoundedReadError, readBoundedTextFileSync } from "../../kernel/storage/bounded-file.ts";
import type { CiRetiredRunRange } from "./ci-provider.ts";
import type { GithubCommentCursor, GithubIdCursor } from "./github-thread-provider.ts";

export const CI_SOURCE_MAX_EVENTS = 2_048;
export const CI_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
/** A parked consumer keeps its custody this long; later it resumes through an explicit replay gap. */
export const CI_PARKED_CONSUMER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Each version has its own journal file, so a build that reads an older shape never quarantines a newer journal it
 * shares the repository's status directory with. Version 3 records departures, gap causes and connection state;
 * version 4 adds GitHub thread cursors, every consumer's GitHub interests and the away host's activation role.
 */
const CI_SOURCE_VERSION = 4;
const MAX_CONSUMERS = 64;
const MAX_RUNS = 128;
const MAX_RETIRED_RANGES = MAX_RUNS + 1;
const MAX_WORKFLOWS = 32;
/** Removed consumers remembered for their next claim's gap cause; older departures resume as `consumer_inactive`. */
const MAX_DEPARTED = 128;
/** Retained GitHub thread occurrences: their own bound inside the event list, so a burst cannot crowd out CI. */
export const CI_SOURCE_MAX_THREAD_EVENTS = 512;
const MAX_THREAD_REPOSITORIES = 8;
const MAX_REVIEW_CURSORS = 64;

/** A journal written by a newer release is never rewritten or quarantined by an older reader. */
export class CiSourceVersionError extends Error {}

/**
 * Who a consumer's activation serves: a session (no role), or the away host following a closed session's events with
 * that session's own consumer. A session's claim takes custody back from a live away activation; nothing else
 * displaces a live activation.
 */
export type CiConsumerRole = "away-host";

/** The consumer is held by another live activation this claim or call may not displace. */
export class CiConsumerHeldError extends Error {
	constructor(message = "CI source consumer is already active in another host resource.") {
		super(message);
		this.name = "CiConsumerHeldError";
	}
}

/** A connection state the away host recorded, which the session that takes its consumer back is told once. */
export interface CiAwayConnection {
	readonly state: "waiting" | "suspended";
	readonly reason: string;
	readonly text: string;
	readonly since: number;
}

interface ConsumerStart {
	registration: HostEventSourceRegistration;
	catchUp: HostEventCatchUp;
}

interface Consumer {
	id: string;
	startingSequence: number;
	acknowledged: number;
	generation: number;
	scopeVersion: number;
	subjects: CiSubject[];
	rootSubjects: CiSubject[];
	/** The last sealed current attempts; they pin their runs while the consumer is active or parked. */
	observations: CiCurrentObservation[];
	/** Persisted before the sink call; exact replay bridges either side of a crash. */
	pendingStart?: ConsumerStart;
	replayFloor: number;
	activation?: { id: string; owner: ProcessOwner; role?: CiConsumerRole };
	/** Set exactly when no live host owns the consumer. Custody stays retained until expiry. */
	parkedAt?: number;
	pendingGap?: { afterSequence: number; throughSequence: number; cause: HostEventReplayGapReason };
	/**
	 * The active host's last connection transition; absent while armed. Cleared by the next claim, except one an away
	 * activation recorded: a session's claim is handed it and keeps it until the session's own first transition.
	 */
	connection?: { state: "waiting" | "suspended"; reason: string; since: number; text?: string; role?: CiConsumerRole };
	/** The consumer's GitHub listeners, kept while it is parked: collection serves the union of every consumer's. */
	interests: GithubThreadInterest[];
}

/** One repository's GitHub collection positions; an endpoint no interest needs has none. */
export interface GithubThreadCursor {
	key: string;
	comments?: GithubCommentCursor;
	reviewComments?: GithubCommentCursor;
	issueEvents?: GithubIdCursor;
	reviews: { pullRequest: number; cursor: GithubIdCursor }[];
}

/** Why a consumer's custody was removed while no host owned it. */
interface DepartedConsumer {
	id: string;
	cause: "consumer_expired" | "consumer_evicted";
	at: number;
}

interface RetainedRun {
	key: string;
	headSha: string;
	runNumber: number;
	throughAttempt: number;
	latest: CiHostEventEnvelope;
}

interface SourceState {
	version: typeof CI_SOURCE_VERSION;
	sourceId: string;
	sourceEpoch: string;
	nextSequence: number;
	retiredThrough: number;
	events: HostEventEnvelope[];
	runs: RetainedRun[];
	consumers: Consumer[];
	/** Run numbers whose custody was dropped. Never-seen and pending run numbers are never retired. */
	retiredRuns: { key: string; ranges: CiRetiredRunRange[] }[];
	departed: DepartedConsumer[];
	threads: GithubThreadCursor[];
}

export interface CiSourceSnapshot {
	readonly sourceId: string;
	readonly sourceEpoch: string;
	readonly nextSequence: number;
	readonly retiredThrough: number;
	readonly events: readonly HostEventEnvelope[];
	readonly runs: readonly Readonly<RetainedRun>[];
	readonly consumers: readonly Readonly<Consumer>[];
	readonly retiredRuns: readonly { readonly key: string; readonly ranges: readonly CiRetiredRunRange[] }[];
	readonly threads: readonly Readonly<GithubThreadCursor>[];
}

function workflowKey(subject: Pick<CiSubject, "host" | "repositoryId" | "workflowId">): string {
	return `${subject.host}/${subject.repositoryId}/${subject.workflowId}`;
}

function parseConsumer(value: unknown): Consumer {
	const entry = hostEventRecord(
		value,
		[
			"id",
			"startingSequence",
			"acknowledged",
			"generation",
			"scopeVersion",
			"subjects",
			"rootSubjects",
			"observations",
			"pendingStart",
			"replayFloor",
			"activation",
			"parkedAt",
			"pendingGap",
			"connection",
			"interests",
		],
		"CI consumer",
	);
	const consumer: Consumer = {
		id: hostEventString(entry.id, "consumer id"),
		startingSequence: hostEventInteger(entry.startingSequence, "starting sequence"),
		acknowledged: hostEventInteger(entry.acknowledged, "acknowledged", 0),
		generation: hostEventInteger(entry.generation, "generation", 0),
		scopeVersion: hostEventInteger(entry.scopeVersion, "scopeVersion", 0),
		subjects: hostEventArray(entry.subjects, MAX_HOST_EVENT_SUBJECTS, parseCiSubject, "consumer subjects"),
		rootSubjects: hostEventArray(entry.rootSubjects, MAX_HOST_EVENT_SUBJECTS, parseCiSubject, "root subjects"),
		observations: hostEventArray(
			entry.observations,
			MAX_HOST_EVENT_SUBJECTS,
			parseCiCurrentObservation,
			"consumer observations",
		),
		...(entry.pendingStart === undefined ? {} : { pendingStart: parseConsumerStart(entry.pendingStart) }),
		replayFloor: hostEventInteger(entry.replayFloor, "consumer replay floor"),
		...(entry.activation === undefined ? {} : { activation: parseConsumerActivation(entry.activation) }),
		...(entry.parkedAt === undefined ? {} : { parkedAt: hostEventInteger(entry.parkedAt, "parkedAt", 0) }),
		...(entry.pendingGap === undefined ? {} : { pendingGap: parseConsumerGap(entry.pendingGap) }),
		...(entry.connection === undefined ? {} : { connection: parseConsumerConnection(entry.connection) }),
		interests: hostEventArray(
			entry.interests,
			HOST_EVENT_LISTENER_LIMITS.maxListenersPerSource,
			parseGithubThreadInterest,
			"consumer GitHub interests",
		),
	};
	if ((consumer.activation === undefined) === (consumer.parkedAt === undefined))
		throw new Error("CI consumer must be either active or parked.");
	return consumer;
}

function parseConsumerActivation(value: unknown): NonNullable<Consumer["activation"]> {
	const entry = hostEventRecord(value, ["id", "owner", "role"], "CI consumer activation");
	const owner = hostEventRecord(entry.owner, ["pid", "startTime", "hostname", "machineId"], "CI consumer owner");
	if (!isProcessOwnerRecord(owner)) throw new Error("CI consumer owner is invalid.");
	return {
		id: hostEventString(entry.id, "activation id"),
		owner,
		...(entry.role === undefined ? {} : { role: parseConsumerRole(entry.role) }),
	};
}

function parseConsumerRole(value: unknown): CiConsumerRole {
	if (value !== "away-host") throw new Error("CI consumer role is unknown.");
	return value;
}

function parseConsumerGap(value: unknown): NonNullable<Consumer["pendingGap"]> {
	const entry = hostEventRecord(value, ["afterSequence", "throughSequence", "cause"], "CI consumer pending gap");
	const afterSequence = hostEventInteger(entry.afterSequence, "gap after sequence", 0);
	const throughSequence = hostEventInteger(entry.throughSequence, "gap through sequence", 0);
	if (afterSequence >= throughSequence) throw new Error("CI consumer replay gap is empty or reversed.");
	if (!isHostEventReplayGapReason(entry.cause)) throw new Error("CI consumer replay gap cause is unknown.");
	return { afterSequence, throughSequence, cause: entry.cause };
}

function parseConsumerConnection(value: unknown): NonNullable<Consumer["connection"]> {
	const entry = hostEventRecord(value, ["state", "reason", "since", "text", "role"], "CI consumer connection");
	if (entry.state !== "waiting" && entry.state !== "suspended")
		throw new Error("CI consumer connection state is unknown.");
	return {
		state: entry.state,
		reason: hostEventString(entry.reason, "connection reason", 64),
		since: hostEventInteger(entry.since, "since", 0),
		...(entry.text === undefined
			? {}
			: { text: hostEventString(entry.text, "connection text", MAX_RETAINED_DIAGNOSTIC_CHARS) }),
		...(entry.role === undefined ? {} : { role: parseConsumerRole(entry.role) }),
	};
}

function parseDeparted(value: unknown): DepartedConsumer {
	const entry = hostEventRecord(value, ["id", "cause", "at"], "departed CI consumer");
	if (entry.cause !== "consumer_expired" && entry.cause !== "consumer_evicted")
		throw new Error("Departed CI consumer cause is unknown.");
	return { id: hostEventString(entry.id, "consumer id"), cause: entry.cause, at: hostEventInteger(entry.at, "at", 0) };
}

function parseConsumerStart(value: unknown): ConsumerStart {
	const entry = hostEventRecord(value, ["registration", "catchUp"], "CI consumer pending start");
	const registration = parseHostEventSourceRegistration(entry.registration);
	const catchUp = parseHostEventCatchUp(entry.catchUp);
	if (
		registration.sourceId !== catchUp.sourceId ||
		registration.sourceEpoch !== catchUp.sourceEpoch ||
		registration.scopeVersion !== catchUp.scopeVersion
	)
		throw new Error("CI pending start has inconsistent source identity.");
	return { registration, catchUp };
}

function parseCommentCursor(value: unknown): GithubCommentCursor {
	const entry = hostEventRecord(value, ["at", "ids"], "GitHub comment cursor");
	return {
		at: hostEventDate(entry.at, "cursor at"),
		ids: hostEventArray(entry.ids, 1_000, (id) => hostEventInteger(id, "comment id"), "cursor ids"),
	};
}

function parseIdCursor(value: unknown): GithubIdCursor {
	const entry = hostEventRecord(value, ["afterId", "since"], "GitHub id cursor");
	return { afterId: hostEventInteger(entry.afterId, "afterId", 0), since: hostEventDate(entry.since, "cursor since") };
}

function parseThreadCursor(value: unknown): GithubThreadCursor {
	const entry = hostEventRecord(
		value,
		["key", "comments", "reviewComments", "issueEvents", "reviews"],
		"GitHub thread cursor",
	);
	return {
		key: hostEventString(entry.key, "thread cursor key", 512),
		...(entry.comments === undefined ? {} : { comments: parseCommentCursor(entry.comments) }),
		...(entry.reviewComments === undefined ? {} : { reviewComments: parseCommentCursor(entry.reviewComments) }),
		...(entry.issueEvents === undefined ? {} : { issueEvents: parseIdCursor(entry.issueEvents) }),
		reviews: hostEventArray(
			entry.reviews,
			MAX_REVIEW_CURSORS,
			(review) => {
				const item = hostEventRecord(review, ["pullRequest", "cursor"], "GitHub review cursor");
				return {
					pullRequest: hostEventInteger(item.pullRequest, "pullRequest"),
					cursor: parseIdCursor(item.cursor),
				};
			},
			"GitHub review cursors",
		),
	};
}

function parseRetiredRange(value: unknown): CiRetiredRunRange {
	const range = hostEventRecord(value, ["from", "through"], "retired run range");
	const from = hostEventInteger(range.from, "from");
	const through = hostEventInteger(range.through, "through");
	if (through < from) throw new Error("CI retired run range is reversed.");
	return { from, through };
}

function parseState(value: unknown): SourceState {
	const entry = hostEventRecord(
		value,
		[
			"version",
			"sourceId",
			"sourceEpoch",
			"nextSequence",
			"retiredThrough",
			"events",
			"runs",
			"consumers",
			"retiredRuns",
			"departed",
			"threads",
		],
		"CI source",
	);
	if (entry.version !== CI_SOURCE_VERSION) throw new Error("Unknown CI source version.");
	const state: SourceState = {
		version: CI_SOURCE_VERSION,
		sourceId: hostEventString(entry.sourceId, "sourceId"),
		sourceEpoch: hostEventString(entry.sourceEpoch, "sourceEpoch"),
		nextSequence: hostEventInteger(entry.nextSequence, "nextSequence"),
		retiredThrough: hostEventInteger(entry.retiredThrough, "retiredThrough", 0),
		events: hostEventArray(entry.events, CI_SOURCE_MAX_EVENTS, parseHostEventEnvelope, "retained CI events"),
		runs: hostEventArray(
			entry.runs,
			MAX_RUNS,
			(value) => {
				const run = hostEventRecord(
					value,
					["key", "headSha", "runNumber", "throughAttempt", "latest"],
					"retained CI run",
				);
				return {
					key: hostEventString(run.key, "run key", 512),
					headSha: hostEventString(run.headSha, "run SHA", 64),
					runNumber: hostEventInteger(run.runNumber, "runNumber"),
					throughAttempt: hostEventInteger(run.throughAttempt, "throughAttempt"),
					latest: parseCiHostEventEnvelope(run.latest),
				};
			},
			"retained CI runs",
		),
		consumers: hostEventArray(entry.consumers, MAX_CONSUMERS, parseConsumer, "CI consumers"),
		retiredRuns: hostEventArray(
			entry.retiredRuns,
			MAX_WORKFLOWS,
			(value) => {
				const frontier = hostEventRecord(value, ["key", "ranges"], "retired CI run frontier");
				return {
					key: hostEventString(frontier.key, "workflow key", 512),
					ranges: hostEventArray(frontier.ranges, MAX_RETIRED_RANGES, parseRetiredRange, "retired run ranges"),
				};
			},
			"retired CI workflows",
		),
		departed: hostEventArray(entry.departed, MAX_DEPARTED, parseDeparted, "departed CI consumers"),
		threads: hostEventArray(entry.threads, MAX_THREAD_REPOSITORIES, parseThreadCursor, "GitHub thread cursors"),
	};
	if (
		state.nextSequence !== state.retiredThrough + state.events.length + 1 ||
		state.events.some(
			(event, index) =>
				event.sourceId !== state.sourceId ||
				event.sourceEpoch !== state.sourceEpoch ||
				event.sourceSequence !== state.retiredThrough + index + 1,
		)
	)
		throw new Error("CI source sequence is not contiguous.");
	if (
		state.runs.some(
			(run) =>
				run.latest.sourceId !== state.sourceId ||
				run.latest.sourceEpoch !== state.sourceEpoch ||
				run.latest.sourceSequence >= state.nextSequence ||
				run.latest.event.headSha !== run.headSha ||
				run.latest.event.identity.runNumber !== run.runNumber ||
				run.latest.event.identity.runAttempt !== run.throughAttempt,
		)
	)
		throw new Error("CI retained current-attempt evidence is inconsistent.");
	if (
		new Set(state.consumers.map((consumer) => consumer.id)).size !== state.consumers.length ||
		new Set(state.departed.map((consumer) => consumer.id)).size !== state.departed.length ||
		new Set(state.runs.map((run) => run.key)).size !== state.runs.length ||
		new Set(state.threads.map((cursor) => cursor.key)).size !== state.threads.length ||
		new Set(state.events.map((event) => event.event.eventId)).size !== state.events.length ||
		state.consumers.some(
			(consumer) =>
				consumer.acknowledged < state.retiredThrough ||
				consumer.acknowledged >= state.nextSequence ||
				consumer.startingSequence > consumer.acknowledged + 1 ||
				consumer.replayFloor < consumer.startingSequence ||
				consumer.replayFloor > consumer.acknowledged + 1 ||
				(consumer.pendingGap !== undefined &&
					(consumer.pendingGap.throughSequence > consumer.acknowledged ||
						consumer.pendingGap.throughSequence >= consumer.replayFloor)),
		)
	)
		throw new Error("CI source registry is inconsistent.");
	return state;
}

function sameSubjects(left: readonly CiSubject[], right: readonly CiSubject[]): boolean {
	return JSON.stringify(left.map(ciSubjectKey).sort()) === JSON.stringify(right.map(ciSubjectKey).sort());
}

function activeConsumer(state: SourceState, consumerId: string, activationId: string): Consumer {
	const consumer = state.consumers.find((entry) => entry.id === consumerId);
	if (consumer?.activation && consumer.activation.id !== activationId)
		throw new CiConsumerHeldError("CI source consumer activation was replaced by another host resource.");
	if (!consumer || consumer.activation?.id !== activationId)
		throw new Error("CI source consumer activation is absent or was replaced.");
	return consumer;
}

/** Parking keeps acknowledged custody and the sealed observations that pin current runs. */
function parkConsumer(consumer: Consumer, now: number): void {
	delete consumer.activation;
	consumer.parkedAt = now;
}

function reclaimDeadConsumers(state: SourceState, now: number): void {
	for (const consumer of state.consumers)
		if (consumer.activation && judgeOwner(consumer.activation.owner) === "dead") parkConsumer(consumer, now);
}

/** Removes a parked consumer and remembers why, so its next claim names the cause of its replay gap. */
function removeConsumer(state: SourceState, consumer: Consumer, cause: DepartedConsumer["cause"], now: number): void {
	state.consumers = state.consumers.filter((entry) => entry !== consumer);
	state.departed = [...state.departed.filter((entry) => entry.id !== consumer.id), { id: consumer.id, cause, at: now }]
		.sort((a, b) => a.at - b.at)
		.slice(-MAX_DEPARTED);
}

/**
 * The parked consumer whose custody pins the most history. Removing it is an explicit disposition:
 * its next claim records a replay gap from the session's durable checkpoint.
 */
function oldestParkedConsumer(state: SourceState): Consumer | undefined {
	return state.consumers
		.filter((consumer) => consumer.parkedAt !== undefined)
		.sort((a, b) => a.acknowledged - b.acknowledged || a.parkedAt! - b.parkedAt!)[0];
}

function addRetiredRun(state: SourceState, key: string, runNumber: number): void {
	let frontier = state.retiredRuns.find((entry) => entry.key === key);
	if (!frontier) {
		if (state.retiredRuns.length >= MAX_WORKFLOWS) throw new Error("CI retired workflow capacity reached.");
		frontier = { key, ranges: [] };
		state.retiredRuns.push(frontier);
	}
	// Past the bound, the two oldest ranges coalesce. Only the oldest history between them
	// becomes unobservable; recent never-seen or pending run numbers stay admissible.
	frontier.ranges = mergeSequenceRanges(frontier.ranges, { from: runNumber, through: runNumber }, MAX_RETIRED_RANGES);
}

/** One locked, bounded source journal owns occurrence identity and every consumer's custody. */
export class CiSourceStore {
	readonly path: string;
	private readonly onDiagnostic: (message: string) => void;
	private readonly now: () => number;

	constructor(directory: string, options: { onDiagnostic?: (message: string) => void; now?: () => number } = {}) {
		this.path = join(directory, "source", `journal-v${CI_SOURCE_VERSION}.json`);
		this.onDiagnostic = options.onDiagnostic ?? (() => {});
		this.now = options.now ?? Date.now;
	}

	private fresh(): SourceState {
		return {
			version: CI_SOURCE_VERSION,
			sourceId: `ci-source-${randomUUID()}`,
			sourceEpoch: randomUUID(),
			nextSequence: 1,
			retiredThrough: 0,
			events: [],
			runs: [],
			consumers: [],
			retiredRuns: [],
			departed: [],
			threads: [],
		};
	}

	/**
	 * Only called under the source lock: an unreadable journal of this version is moved aside (one bounded
	 * copy) and a new epoch starts; consumers then register the new source explicitly.
	 */
	private read(): { state: SourceState; text?: string } {
		let text: string;
		try {
			text = readBoundedTextFileSync(this.path, CI_SOURCE_MAX_BYTES, "CI source");
		} catch (error) {
			if (isMissingFileError(error)) return { state: this.fresh() };
			if (!(error instanceof BoundedReadError) || error.reason !== "limit") throw error;
			return { state: this.quarantine(error) };
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			return { state: this.quarantine(error) };
		}
		const version =
			value && typeof value === "object" && !Array.isArray(value)
				? (value as { version?: unknown }).version
				: undefined;
		if (typeof version === "number" && Number.isSafeInteger(version) && version > CI_SOURCE_VERSION)
			throw new CiSourceVersionError("CI source journal belongs to a newer release; CI events stay inactive here.");
		try {
			return { state: parseState(value), text };
		} catch (error) {
			return { state: this.quarantine(error) };
		}
	}

	private quarantine(error: unknown): SourceState {
		renameSync(this.path, `${this.path}.unreadable`);
		this.onDiagnostic(
			`CI source journal was unreadable (${error instanceof Error ? error.message : String(error)}); it was moved aside and a new source epoch started. Its unacknowledged events are not replayed.`,
		);
		return this.fresh();
	}

	private change<T>(operation: (state: SourceState) => T): T {
		mkdirSync(dirname(this.path), { recursive: true });
		return withFileLockSync(this.path, () => {
			const { state, text } = this.read();
			const result = operation(state);
			// The parser's canonical field order makes an unchanged journal byte-identical: no rewrite.
			const encoded = JSON.stringify(parseState(state));
			if (encoded === text) return result;
			if (Buffer.byteLength(encoded) > CI_SOURCE_MAX_BYTES)
				throw new Error("CI source is full; unacknowledged events remain retained.");
			writeFileAtomicSync(this.path, encoded, { mode: 0o600 });
			return result;
		});
	}

	identity(): { sourceId: string; sourceEpoch: string } {
		return this.change((state) => ({ sourceId: state.sourceId, sourceEpoch: state.sourceEpoch }));
	}

	/**
	 * Claims the consumer for one activation. A session's claim (no `role`) takes custody back from a live away
	 * activation; any other live activation holds it ({@link CiConsumerHeldError}). When a session claims, it receives the
	 * connection state an away activation left on the consumer, to tell it once.
	 */
	claim(
		consumerId: string,
		activationId: string,
		checkpoint: HostEventConsumerCheckpoint | undefined,
		role?: CiConsumerRole,
	): { awayConnection?: CiAwayConnection } {
		return this.change((state) => {
			const now = this.now();
			reclaimDeadConsumers(state, now);
			this.expire(state, now);
			const existing = state.consumers.find((entry) => entry.id === consumerId);
			if (existing?.activation) {
				if (existing.activation.id === activationId) return {};
				if (role !== undefined || existing.activation.role !== "away-host") throw new CiConsumerHeldError();
			}
			const left = existing?.connection;
			const awayConnection: CiAwayConnection | undefined =
				role === undefined && left?.role === "away-host" && left.text !== undefined
					? { state: left.state, reason: left.reason, text: left.text, since: left.since }
					: undefined;
			if (!existing) {
				while (state.consumers.length >= MAX_CONSUMERS) {
					const evicted = oldestParkedConsumer(state);
					if (!evicted) throw new Error("CI source consumer capacity reached; offline custody remains retained.");
					removeConsumer(state, evicted, "consumer_evicted", now);
				}
			}
			this.compact(state);
			if (
				checkpoint &&
				(checkpoint.registration.sourceId !== state.sourceId ||
					checkpoint.registration.sourceEpoch !== state.sourceEpoch)
			)
				throw new Error("CI source checkpoint names a different retained source.");
			// The session's durable checkpoint is authoritative on every claim, also for a parked consumer:
			// a restored session that accepted less resumes from its own position, or through an explicit gap.
			const acknowledged = checkpoint?.acceptedThrough ?? state.retiredThrough;
			if (acknowledged >= state.nextSequence) throw new Error("CI source checkpoint is ahead of retained history.");
			const departure = existing ? undefined : state.departed.find((entry) => entry.id === consumerId);
			state.departed = state.departed.filter((entry) => entry.id !== consumerId);
			const consumer: Consumer = {
				id: hostEventString(consumerId, "consumerId"),
				startingSequence: checkpoint?.registration.startingSequence ?? state.retiredThrough + 1,
				acknowledged: Math.max(acknowledged, state.retiredThrough),
				generation: checkpoint?.catchUpGeneration ?? 0,
				scopeVersion: checkpoint?.registration.scopeVersion ?? 0,
				subjects: checkpoint ? [...checkpoint.registration.subjects] : [],
				rootSubjects: checkpoint ? [...checkpoint.registration.rootSubjects] : [],
				// A parked consumer's sealed observations keep pinning their runs until its next seal.
				observations: existing?.observations ?? [],
				replayFloor:
					checkpoint && acknowledged >= state.retiredThrough ? checkpoint.replayFloor : state.retiredThrough + 1,
				...(acknowledged < state.retiredThrough
					? {
							pendingGap: {
								afterSequence: acknowledged,
								throughSequence: state.retiredThrough,
								cause: departure?.cause ?? "consumer_inactive",
							},
						}
					: {}),
				activation: {
					id: hostEventString(activationId, "activationId"),
					owner: ownProcessOwner(),
					...(role === undefined ? {} : { role }),
				},
				interests: existing?.interests ?? [],
				// The away state stays recorded until the session's own first transition replaces it, so a claim again
				// before then (a restart that did not save the notice) is told it again.
				...(awayConnection && left ? { connection: left } : {}),
			};
			state.consumers = [...state.consumers.filter((entry) => entry !== existing), consumer];
			return awayConnection ? { awayConnection } : {};
		});
	}

	/** Stop suspends custody; only expiry or capacity disposition removes a parked consumer. */
	release(consumerId: string, activationId: string): void {
		this.change((state) => {
			const consumer = state.consumers.find((entry) => entry.id === consumerId);
			if (consumer?.activation?.id !== activationId) return;
			parkConsumer(consumer, this.now());
		});
	}

	begin(
		consumerId: string,
		activationId: string,
		subjects: readonly CiSubject[],
		rootSubjects: readonly CiSubject[],
	): ConsumerStart {
		return this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			const pending = consumer.pendingStart;
			if (pending) return pending;
			const scope = hostEventArray(subjects, MAX_HOST_EVENT_SUBJECTS, parseCiSubject, "CI source scope");
			const roots = hostEventArray(rootSubjects, MAX_HOST_EVENT_SUBJECTS, parseCiSubject, "CI root scope");
			const allowed = new Set(scope.map(ciSubjectKey));
			if (roots.some((subject) => !allowed.has(ciSubjectKey(subject))))
				throw new Error("CI root subject is outside its registered scope.");
			if (!sameSubjects(consumer.subjects, scope) || !sameSubjects(consumer.rootSubjects, roots)) {
				consumer.scopeVersion++;
				consumer.subjects = scope;
				consumer.rootSubjects = roots;
			}
			consumer.generation++;
			const start: ConsumerStart = {
				registration: {
					sourceId: state.sourceId,
					sourceEpoch: state.sourceEpoch,
					scopeVersion: consumer.scopeVersion,
					subjects: consumer.subjects,
					rootSubjects: consumer.rootSubjects,
					startingSequence: consumer.startingSequence,
				},
				catchUp: {
					sourceId: state.sourceId,
					sourceEpoch: state.sourceEpoch,
					scopeVersion: consumer.scopeVersion,
					generation: consumer.generation,
				},
			};
			consumer.pendingStart = start;
			return start;
		});
	}

	confirmBegin(consumerId: string, activationId: string, start: ConsumerStart): void {
		this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			if (JSON.stringify(consumer.pendingStart) !== JSON.stringify(start))
				throw new Error("CI consumer start acknowledgement differs from its pending handshake.");
			delete consumer.pendingStart;
		});
	}

	/** Durable record of a connection transition; a replaced activation records nothing. */
	recordConnection(
		consumerId: string,
		activationId: string,
		connection:
			| { readonly state: "waiting" | "suspended"; readonly reason: string; readonly text: string }
			| undefined,
	): void {
		this.change((state) => {
			const consumer = state.consumers.find((entry) => entry.id === consumerId);
			const activation = consumer?.activation;
			if (!consumer || activation?.id !== activationId) return;
			if (!connection) {
				delete consumer.connection;
				return;
			}
			const text = boundedRedactedDiagnosticText(connection.text);
			consumer.connection = {
				state: connection.state,
				reason: connection.reason,
				since: this.now(),
				...(text === undefined ? {} : { text }),
				...(activation.role === undefined ? {} : { role: activation.role }),
			};
		});
	}

	confirmGap(consumerId: string, activationId: string, gap: NonNullable<Consumer["pendingGap"]>): void {
		this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			if (JSON.stringify(consumer.pendingGap) !== JSON.stringify(gap))
				throw new Error("CI replay gap acknowledgement differs from retained custody.");
			delete consumer.pendingGap;
		});
	}

	/**
	 * The consumer's current GitHub listeners. A listener already recorded keeps its start; a new one starts no earlier
	 * than now, so the occurrences collection skipped before the source knew it stay history.
	 */
	recordInterests(consumerId: string, activationId: string, interests: readonly GithubThreadInterest[]): void {
		this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			const now = new Date(this.now()).toISOString();
			consumer.interests = interests.map((interest) => {
				const key = githubInterestScopeKey(interest);
				const known = consumer.interests.find((entry) => githubInterestScopeKey(entry) === key);
				return parseGithubThreadInterest({
					...interest,
					since: known?.since ?? (interest.since > now ? interest.since : now),
				});
			});
		});
	}

	/**
	 * Retains one collection's thread occurrences and moves its repository's cursor in the same journal write, so a
	 * crash neither repeats nor drops an occurrence. An occurrence already retained is not appended again. Compare-and-set:
	 * when another writer moved the cursor since `expected` was read, nothing is written and `false` asks to re-collect.
	 */
	retainThreads(
		expected: GithubThreadCursor | undefined,
		cursor: GithubThreadCursor,
		events: readonly GithubThreadEvent[],
	): boolean {
		return this.change((state) => {
			const stored = state.threads.find((entry) => entry.key === cursor.key);
			if (JSON.stringify(stored) !== JSON.stringify(expected)) return false;
			this.compact(state);
			const retained = new Set(state.events.map((entry) => entry.event.eventId));
			for (const event of [...events].sort(
				(a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.githubId - b.githubId,
			)) {
				if (retained.has(event.eventId)) continue;
				this.makeRoom(state, false, true);
				state.events.push(
					parseHostEventEnvelope({
						sourceId: state.sourceId,
						sourceEpoch: state.sourceEpoch,
						sourceSequence: state.nextSequence++,
						event,
					}),
				);
				retained.add(event.eventId);
			}
			state.threads = [...state.threads.filter((entry) => entry.key !== cursor.key), cursor];
			if (state.threads.length > MAX_THREAD_REPOSITORIES) throw new Error("GitHub thread cursor capacity reached.");
			return true;
		});
	}

	retain(events: readonly CiAttemptTerminalEvent[]): void {
		if (!events.length) return;
		this.change((state) => {
			this.compact(state);
			for (const event of [...events].sort(
				(a, b) => a.identity.runNumber - b.identity.runNumber || a.identity.runAttempt - b.identity.runAttempt,
			)) {
				const known =
					state.events.filter(isCiEnvelope).find((entry) => entry.event.eventId === event.eventId)?.event ??
					state.runs.find((run) => run.latest.event.eventId === event.eventId)?.latest.event;
				if (known) {
					if (
						known.headSha !== event.headSha ||
						known.conclusion !== event.conclusion ||
						JSON.stringify(known.identity) !== JSON.stringify(event.identity)
					)
						throw new Error("CI attempt conflicts with its retained terminal outcome.");
					continue;
				}
				const identity = event.identity;
				const retired = state.retiredRuns.find((frontier) => frontier.key === workflowKey(identity));
				if (
					retired?.ranges.some((range) => identity.runNumber >= range.from && identity.runNumber <= range.through)
				)
					throw new Error(
						"CI run is outside the retained replay horizon; historical custody cannot be recreated.",
					);
				const key = `${identity.host}/${identity.repositoryId}/${identity.workflowId}/${identity.runId}`;
				let run = state.runs.find((entry) => entry.key === key);
				if (run && (run.headSha !== event.headSha || run.runNumber !== identity.runNumber))
					throw new Error("CI run identity changed.");
				if (run && identity.runAttempt <= run.throughAttempt) continue;
				if (identity.runAttempt !== (run?.throughAttempt ?? 0) + 1)
					throw new Error("CI terminal attempt history has a gap.");
				this.makeRoom(state, !run);
				const envelope = parseCiHostEventEnvelope({
					sourceId: state.sourceId,
					sourceEpoch: state.sourceEpoch,
					sourceSequence: state.nextSequence++,
					event,
				});
				if (!run) {
					run = {
						key,
						headSha: event.headSha,
						runNumber: identity.runNumber,
						throughAttempt: identity.runAttempt,
						latest: envelope,
					};
					state.runs.push(run);
				}
				run.throughAttempt = identity.runAttempt;
				run.latest = envelope;
				state.events.push(envelope);
			}
		});
	}

	/**
	 * Admission at capacity first drops an unpinned run cursor, then expires the parked consumer
	 * pinning the most history. Live consumers' custody is never evicted: that is backpressure.
	 */
	private makeRoom(state: SourceState, newRun: boolean, thread = false): void {
		for (;;) {
			this.compact(state);
			const eventsFull =
				state.events.length >= CI_SOURCE_MAX_EVENTS ||
				(thread && state.events.filter((entry) => !isCiEnvelope(entry)).length >= CI_SOURCE_MAX_THREAD_EVENTS);
			if (!eventsFull && (!newRun || state.runs.length < MAX_RUNS)) return;
			if (!eventsFull && this.dropUnpinnedRun(state)) return;
			const evicted = oldestParkedConsumer(state);
			if (!evicted) throw new Error("CI source capacity reached; cursor was retained.");
			removeConsumer(state, evicted, "consumer_evicted", this.now());
		}
	}

	/** Drops the oldest run cursor no retained event or consumer observation still needs. */
	private dropUnpinnedRun(state: SourceState): boolean {
		const observed = new Set(
			state.consumers.flatMap((consumer) =>
				consumer.observations.map((observation) => `${ciSubjectKey(observation.subject)}#${observation.runId}`),
			),
		);
		const candidate = state.runs
			.filter(
				(run) =>
					!state.events.some(
						(entry) => isCiEnvelope(entry) && entry.event.identity.runId === run.latest.event.identity.runId,
					) &&
					!observed.has(`${ciSubjectKey(ciEventSubject(run.latest.event))}#${run.latest.event.identity.runId}`),
			)
			.sort((a, b) => a.latest.sourceSequence - b.latest.sourceSequence)[0];
		if (!candidate) return false;
		addRetiredRun(state, workflowKey(candidate.latest.event.identity), candidate.runNumber);
		state.runs = state.runs.filter((run) => run !== candidate);
		return true;
	}

	/** Read under the source lock, so an unreadable journal is quarantined rather than rethrown. */
	snapshot(): CiSourceSnapshot {
		return this.change((state) => structuredClone(state));
	}

	acknowledge(consumerId: string, activationId: string, receipt: HostEventReceipt, generation: number): void {
		this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			const event = state.events.find((entry) => entry.sourceSequence === receipt.sourceSequence);
			if (
				consumer.generation !== generation ||
				!event ||
				receipt.consumerId !== consumerId ||
				receipt.sourceId !== state.sourceId ||
				receipt.sourceEpoch !== state.sourceEpoch ||
				receipt.eventId !== event.event.eventId ||
				receipt.payloadDigest !== event.event.payloadDigest ||
				!receipt.canonicalReceiptId
			)
				throw new Error("CI source acknowledgement does not match its retained event.");
			if (receipt.sourceSequence > consumer.acknowledged + 1)
				throw new Error("CI source acknowledgement skipped an event.");
			consumer.acknowledged = Math.max(consumer.acknowledged, receipt.sourceSequence);
		});
	}

	retireAcknowledged(): number {
		return this.change((state) => {
			const now = this.now();
			reclaimDeadConsumers(state, now);
			this.expire(state, now);
			return this.compact(state);
		});
	}

	private expire(state: SourceState, now: number): void {
		for (const consumer of state.consumers)
			if (consumer.parkedAt !== undefined && now - consumer.parkedAt >= CI_PARKED_CONSUMER_TTL_MS)
				removeConsumer(state, consumer, "consumer_expired", now);
	}

	/** Events retire once every registered consumer, live or parked, has acknowledged them. */
	private compact(state: SourceState): number {
		state.retiredThrough = state.consumers.length
			? Math.min(...state.consumers.map((consumer) => consumer.acknowledged))
			: state.nextSequence - 1;
		state.events = state.events.filter((event) => event.sourceSequence > state.retiredThrough);
		return state.retiredThrough;
	}

	recordSeal(
		consumerId: string,
		activationId: string,
		generation: number,
		observations: readonly CiCurrentObservation[],
	): void {
		this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			if (consumer.generation !== generation)
				throw new Error("CI source seal belongs to a superseded consumer generation.");
			consumer.observations = observations
				.filter((observation) =>
					consumer.subjects.some((subject) => ciSubjectKey(subject) === ciSubjectKey(observation.subject)),
				)
				.map(parseCiCurrentObservation);
		});
	}
}

export function ciSourceRetiredRuns(
	snapshot: CiSourceSnapshot,
	subject: Pick<CiSubject, "host" | "repositoryId" | "workflowId">,
): readonly CiRetiredRunRange[] {
	return snapshot.retiredRuns.find((frontier) => frontier.key === workflowKey(subject))?.ranges ?? [];
}

export function ciSourceRetainedAttempts(snapshot: CiSourceSnapshot): ReadonlyMap<number, number> {
	return new Map(snapshot.runs.map((run) => [run.latest.event.identity.runId, run.throughAttempt]));
}
