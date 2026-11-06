import { createHash } from "node:crypto";
import { parseWorkerHostEventRecord, type WorkerHostEventRecord } from "../../kernel/host-event-stamp.ts";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH, MAX_WORKER_AUTHORITY_PATH_LENGTH } from "../orchestration/contracts.ts";

export const MAX_HOST_EVENT_SOURCES = 32;
export const MAX_HOST_EVENTS = 256;
export const MAX_HOST_EVENT_SUBSCRIPTIONS = 512;
export const MAX_HOST_EVENT_DELIVERIES = 2_048;
export const MAX_HOST_EVENT_SUBJECTS = 64;
export const MAX_HOST_EVENT_SUBSCRIPTIONS_PER_TASK = 8;
export const MAX_HOST_EVENT_TARGETS = 64;
export const MAX_HOST_EVENT_DOMAIN_BYTES = 8 * 1024 * 1024;
export const HOST_EVENT_RECALL_MS = 7 * 24 * 60 * 60 * 1000;
export const CI_TERMINAL_CONCLUSIONS = [
	"success",
	"failure",
	"cancelled",
	"skipped",
	"neutral",
	"timed_out",
	"action_required",
	"stale",
	"startup_failure",
] as const;
export type CiTerminalConclusion = (typeof CI_TERMINAL_CONCLUSIONS)[number];

export interface CiSubject {
	readonly host: string;
	readonly repositoryId: number;
	readonly workflowId: number;
	readonly headSha: string;
}

/** Captured authority for task-scoped reads and subscription changes. */
export interface HostEventWorkerScope {
	readonly agentId: string;
	readonly attemptId: string;
	readonly leaseId: string;
	readonly fencingToken: number;
}

export interface CiAttemptIdentity {
	readonly provider: "github-actions";
	readonly host: string;
	readonly repositoryId: number;
	readonly workflowId: number;
	readonly runId: number;
	readonly runAttempt: number;
	readonly runNumber: number;
}

export interface CiAttemptTerminalEvent {
	readonly version: 1;
	readonly kind: "ci-attempt-terminal";
	readonly eventId: string;
	readonly identity: CiAttemptIdentity;
	readonly headSha: string;
	readonly conclusion: CiTerminalConclusion;
	readonly workflowPath: string;
	readonly observedAt: string;
	readonly runUrl: string;
	readonly payloadDigest: string;
}

/** What a GitHub thread occurrence records. Each kind is declared in `host-event-kinds.ts`. */
export const GITHUB_THREAD_EVENT_KINDS = [
	"pull-request-comment",
	"review-comment",
	"review-submitted",
	"review-requested",
	"issue-assigned",
	"pull-request-merged",
	"pull-request-closed",
] as const;
export type GithubThreadEventKind = (typeof GITHUB_THREAD_EVENT_KINDS)[number];

export const GITHUB_REVIEW_STATES = ["approved", "changes_requested", "commented", "dismissed"] as const;
export type GithubReviewState = (typeof GITHUB_REVIEW_STATES)[number];

/** Bound of a retained comment or review body, in UTF-8 bytes. */
export const MAX_GITHUB_EVENT_BODY_BYTES = 4 * 1024;
/** GitHub's login bound; an app's login adds the `[bot]` suffix. */
export const MAX_GITHUB_LOGIN_LENGTH = 39;

/** A third party's words, cut at a character boundary: the cut is stated, never hidden. */
export interface GithubEventBody {
	readonly text: string;
	readonly truncated: boolean;
	/** UTF-8 length of the whole body as GitHub returned it. */
	readonly bytes: number;
}

/**
 * One occurrence on a pull request or issue thread. `githubId` is the comment, review or issue-event id; with the kind
 * and repository it fixes `eventId`, so a re-listed occurrence is the same event. The first observation is kept: a
 * later edit of the same comment never becomes a second event.
 */
export interface GithubThreadEvent {
	readonly version: 1;
	readonly kind: GithubThreadEventKind;
	readonly eventId: string;
	readonly githubId: number;
	readonly repository: { readonly host: string; readonly repositoryId: number };
	readonly thread: {
		readonly number: number;
		readonly pullRequest: boolean;
		/** A pull request's head branch in this repository; absent for issues and for pull requests from forks. */
		readonly branch?: string;
		/**
		 * The pull request was opened by the signed-in login: it was among that login's most recently updated pull requests
		 * when the occurrence was collected. Absent otherwise.
		 */
		readonly ownedByViewer?: true;
	};
	/** Login of who wrote the comment or review, or who acted (requested, assigned, merged, closed). */
	readonly author: string;
	readonly occurredAt: string;
	readonly url: string;
	readonly body?: GithubEventBody;
	/** A submitted review's verdict. */
	readonly state?: GithubReviewState;
	readonly payloadDigest: string;
}

export type HostEventPayload = CiAttemptTerminalEvent | GithubThreadEvent;

export function isCiAttemptEvent(event: HostEventPayload): event is CiAttemptTerminalEvent {
	return event.kind === "ci-attempt-terminal";
}

interface HostEventPosition {
	readonly sourceId: string;
	readonly sourceEpoch: string;
	readonly sourceSequence: number;
}

/** An envelope whose event is a CI attempt, the arm seals observe and deliveries carry. */
export interface CiHostEventEnvelope extends HostEventPosition {
	readonly event: CiAttemptTerminalEvent;
}

export interface GithubHostEventEnvelope extends HostEventPosition {
	readonly event: GithubThreadEvent;
}

export type HostEventEnvelope = CiHostEventEnvelope | GithubHostEventEnvelope;

export function isCiEnvelope(envelope: HostEventEnvelope): envelope is CiHostEventEnvelope {
	return isCiAttemptEvent(envelope.event);
}

export interface HostEventSourceRegistration {
	readonly sourceId: string;
	readonly sourceEpoch: string;
	readonly scopeVersion: number;
	readonly subjects: readonly CiSubject[];
	/** Current root checkout applicability, distinct from historical task subjects. */
	readonly rootSubjects: readonly CiSubject[];
	/** First sequence this durable consumer is entitled to replay. */
	readonly startingSequence: number;
	/**
	 * Stable identity of the journal store behind the source (its location, not its content). A later source of the
	 * same store replaces this one: registering it ends every earlier source with the same identity.
	 */
	readonly storeIdentity?: string;
}

export interface HostEventCatchUp {
	readonly sourceId: string;
	readonly sourceEpoch: string;
	readonly scopeVersion: number;
	readonly generation: number;
}

export interface CiCurrentObservation {
	readonly subject: CiSubject;
	readonly runId: number;
	readonly runNumber: number;
	readonly runAttempt: number;
	readonly status: "queued" | "in_progress" | "completed";
	readonly conclusion?: CiTerminalConclusion;
	readonly eventId?: string;
}

/**
 * A sealed current observation. A completed one names its terminal occurrence by event id and by
 * the source position the source assigned it, so a consumer that already pruned the occurrence can
 * still recognise it as its own history.
 */
export interface HostEventSealObservation extends CiCurrentObservation {
	readonly sourceSequence?: number;
}

/** Absent subjects have no matching run. Failed/incomplete collection must never seal. */
export interface HostEventCatchUpSeal extends HostEventCatchUp {
	readonly throughSequence: number;
	readonly observations: readonly HostEventSealObservation[];
	/** Exact current terminal envelopes below this consumer's stream replay floor. */
	readonly snapshots?: readonly CiHostEventEnvelope[];
}

/** Snapshot payloads transfer custody once; the retained frontier references canonical events. */
export type HostEventSealedFrontier = Omit<HostEventCatchUpSeal, "snapshots">;

export function hostEventSealedFrontier(seal: HostEventCatchUpSeal): HostEventSealedFrontier {
	return {
		sourceId: seal.sourceId,
		sourceEpoch: seal.sourceEpoch,
		scopeVersion: seal.scopeVersion,
		generation: seal.generation,
		throughSequence: seal.throughSequence,
		observations: seal.observations,
	};
}

/** An inclusive run of source positions. */
export interface HostEventSequenceRange {
	readonly from: number;
	readonly through: number;
}

/**
 * Bound on a source's unaccepted ranges. Past it the two lowest ranges coalesce: the oldest positions
 * this consumer did accept between them count as unaccepted again, so a later snapshot of one of
 * them is accepted (possibly delivered twice) rather than an event never accepted being lost.
 */
export const MAX_HOST_EVENT_UNACCEPTED_RANGES = 256;

/** Position bookkeeping of one consumer's custody of a source stream. */
export interface HostEventCustodyPositions {
	readonly retiredThrough: number;
	/** Merged positions below the replay floor this consumer never accepted: before its starting
	 * sequence and inside replay gaps, minus snapshot occurrences it accepted since. */
	readonly unaccepted: readonly HostEventSequenceRange[];
}

export function hostEventSequenceUnaccepted(ranges: readonly HostEventSequenceRange[], sequence: number): boolean {
	return ranges.some((range) => sequence >= range.from && sequence <= range.through);
}

/**
 * The position is retired history of this consumer: it accepted the occurrence there (from its stream
 * or as a snapshot) and released it. A pruned occurrence named again by a later seal is recognised
 * here, so it neither fails the seal nor is accepted and delivered a second time.
 */
export function hostEventSequenceRetired(source: HostEventCustodyPositions, sequence: number): boolean {
	return sequence <= source.retiredThrough && !hostEventSequenceUnaccepted(source.unaccepted, sequence);
}

/** Past `bound` the two lowest ranges coalesce, so only the oldest history between them is blurred. */
function coalesceLowestRanges(ranges: HostEventSequenceRange[], bound: number): HostEventSequenceRange[] {
	while (ranges.length > bound) {
		const [first, second] = ranges;
		ranges.splice(0, 2, { from: first!.from, through: second!.through });
	}
	return ranges;
}

/** Adds one inclusive range to sorted ranges, merging overlapping and adjacent ones, within `bound` ranges. */
export function mergeSequenceRanges(
	ranges: readonly HostEventSequenceRange[],
	added: HostEventSequenceRange,
	bound: number,
): HostEventSequenceRange[] {
	const merged: HostEventSequenceRange[] = [];
	for (const range of [...ranges, added].sort((left, right) => left.from - right.from)) {
		const last = merged.at(-1);
		if (last && range.from <= last.through + 1)
			merged[merged.length - 1] = { from: last.from, through: Math.max(last.through, range.through) };
		else merged.push(range);
	}
	return coalesceLowestRanges(merged, bound);
}

/** Adds a replay gap's positions. */
export function hostEventUnacceptedWith(
	ranges: readonly HostEventSequenceRange[],
	added: HostEventSequenceRange,
): HostEventSequenceRange[] {
	return mergeSequenceRanges(ranges, added, MAX_HOST_EVENT_UNACCEPTED_RANGES);
}

/** Removes one position whose snapshot occurrence this consumer just accepted. */
export function hostEventUnacceptedWithout(
	ranges: readonly HostEventSequenceRange[],
	sequence: number,
): HostEventSequenceRange[] {
	return coalesceLowestRanges(
		ranges.flatMap((range) =>
			sequence < range.from || sequence > range.through
				? [range]
				: [
						...(range.from < sequence ? [{ from: range.from, through: sequence - 1 }] : []),
						...(sequence < range.through ? [{ from: sequence + 1, through: range.through }] : []),
					],
		),
		MAX_HOST_EVENT_UNACCEPTED_RANGES,
	);
}

export function parseHostEventSequenceRanges(value: unknown): HostEventSequenceRange[] {
	const ranges = hostEventArray(
		value,
		MAX_HOST_EVENT_UNACCEPTED_RANGES,
		(entry) => {
			const range = hostEventRecord(entry, ["from", "through"], "host event sequence range");
			const from = hostEventInteger(range.from, "from");
			const through = hostEventInteger(range.through, "through");
			if (through < from) throw new HostEventError("invalid", "Host event sequence range is reversed.");
			return { from, through };
		},
		"unaccepted ranges",
	);
	if (ranges.some((range, index) => index > 0 && range.from <= ranges[index - 1]!.through + 1))
		throw new HostEventError("invalid", "Unaccepted ranges must be sorted, disjoint and merged.");
	return ranges;
}

/** The source guarantees retired positions can never be replayed under a new sequence. */
export interface HostEventReplayHorizon {
	readonly sourceId: string;
	readonly sourceEpoch: string;
	readonly throughSequence: number;
}

/** Why a source ended for every consumer: its journal was unreadable or another release started a new one. */
export const HOST_EVENT_SOURCE_END_REASONS = ["journal_replaced"] as const;
export type HostEventSourceEndReason = (typeof HOST_EVENT_SOURCE_END_REASONS)[number];

/** A source no later registration may extend: its unreceived history is gone, not paused. */
export interface HostEventSourceEnd {
	readonly sourceId: string;
	readonly sourceEpoch: string;
	readonly reason: HostEventSourceEndReason;
}

/**
 * Why a consumer's replay entitlement ended: parked past its retention, removed to make room for live custody, or
 * absent from the source for a cause it did not record (a session checkpoint older than its own custody).
 */
export const HOST_EVENT_REPLAY_GAP_REASONS = ["consumer_inactive", "consumer_expired", "consumer_evicted"] as const;
export type HostEventReplayGapReason = (typeof HOST_EVENT_REPLAY_GAP_REASONS)[number];

/** Source-attested unavailable history after this consumer released its replay entitlement. */
export interface HostEventReplayGap extends HostEventCatchUp {
	readonly afterSequence: number;
	readonly throughSequence: number;
	readonly reason: HostEventReplayGapReason;
}

export function isHostEventReplayGapReason(value: unknown): value is HostEventReplayGapReason {
	return HOST_EVENT_REPLAY_GAP_REASONS.some((reason) => reason === value);
}

export interface HostEventReceipt {
	readonly consumerId: string;
	readonly sourceId: string;
	readonly sourceEpoch: string;
	readonly sourceSequence: number;
	readonly eventId: string;
	readonly payloadDigest: string;
	readonly canonicalReceiptId: string;
}

export interface HostEventConsumerCheckpoint {
	readonly registration: HostEventSourceRegistration;
	readonly acceptedThrough: number;
	readonly catchUpGeneration: number;
	readonly replayFloor: number;
	readonly lastReplayGap?: HostEventReplayGap;
}

/** A source that cannot observe its upstream right now and retries by itself. No connection state means armed. */
export interface HostEventSourceConnection {
	/** `waiting`: the upstream is unreachable; `suspended`: it is reachable but repeated reconciles failed. */
	readonly state: "waiting" | "suspended";
	/** Stable class of the cause; one owner notice is told per state and reason. */
	readonly reason: string;
	/** One owner-readable line. */
	readonly text: string;
}

/** The connection a running source last reported: `armed` when its last report cleared its wait. */
export interface HostEventConnectionView {
	readonly source: string;
	readonly state: "armed" | HostEventSourceConnection["state"];
	readonly reason?: string;
}

export interface HostEventSink {
	readonly consumerId: string;
	checkpoint(sourceId: string, signal: AbortSignal): Promise<HostEventConsumerCheckpoint | undefined>;
	register(source: HostEventSourceRegistration, signal: AbortSignal): Promise<void>;
	beginCatchUp(catchUp: HostEventCatchUp, signal: AbortSignal): Promise<void>;
	resumeGap(gap: HostEventReplayGap, signal: AbortSignal): Promise<void>;
	accept(envelope: HostEventEnvelope, signal: AbortSignal): Promise<HostEventReceipt>;
	seal(seal: HostEventCatchUpSeal, signal: AbortSignal): Promise<void>;
	retireThrough(horizon: HostEventReplayHorizon, signal: AbortSignal): Promise<void>;
	/**
	 * Revocation remains available after source cancellation. A replaced source is ended durably by the registration
	 * of its successor from the same store, not here.
	 */
	deactivate(sourceId: string): Promise<void>;
	subscribeWritable(listener: () => void): () => void;
	/** Each change of the named source's connection state; never throws into the source. */
	reportConnection(source: string, connection: HostEventSourceConnection | undefined): void;
	/**
	 * The named source's runtime stopped: its connection is no longer followed or shown. Not a recovery, so no owner
	 * notice ends or repeats. Like revocation, it remains available after source cancellation; never throws.
	 */
	endConnection(source: string): void;
}

export interface HostEventSource {
	start(sink: HostEventSink): Promise<void>;
	stop(): Promise<void>;
}

export interface HostEventSubscriptionInput {
	readonly threadKey: string;
	readonly subject: CiSubject;
	readonly wake: "never" | "resume_same_task";
}

export type { HostEventExecutionIdentity } from "../../kernel/host-event-stamp.ts";
export type HostEventDeliveryBinding = WorkerHostEventRecord;

export interface HostEventTranscriptReceipt {
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly entryId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly messageId: string;
	readonly contentDigest: string;
	readonly bindingDigest: string;
}

export class HostEventError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "HostEventError";
		this.code = code;
	}
}

export function hostEventRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new HostEventError("invalid", `${label} must be an object.`);
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((field) => !fields.includes(field)))
		throw new HostEventError("invalid", `${label} contains an unknown field.`);
	return record;
}

export function hostEventString(
	value: unknown,
	label: string,
	maxLength = MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > maxLength ||
		value.trim() !== value ||
		value.includes("\0")
	)
		throw new HostEventError("invalid", `${label} must be a bounded canonical string.`);
	return value;
}

function sourceIdentifier(value: unknown): string {
	const id = hostEventString(value, "sourceId");
	if (Object.hasOwn(Object.prototype, id))
		throw new HostEventError("invalid", "Source identity conflicts with record storage.");
	return id;
}

export function hostEventInteger(value: unknown, label: string, minimum = 1): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		throw new HostEventError("invalid", `${label} must be a safe integer >= ${minimum}.`);
	return value;
}

export function hostEventArray<T>(value: unknown, maximum: number, parse: (entry: unknown) => T, label: string): T[] {
	if (!Array.isArray(value) || value.length > maximum)
		throw new HostEventError("invalid", `${label} exceeds its collection bound.`);
	return value.map(parse);
}

export function hostEventDigest(value: unknown, label: string): string {
	const digest = hostEventString(value, label, 64);
	if (!/^[a-f0-9]{64}$/.test(digest)) throw new HostEventError("invalid", `${label} must be SHA-256.`);
	return digest;
}

export function hostEventHash(domain: string, value: unknown): string {
	return createHash("sha256").update(domain).update("\0").update(JSON.stringify(value)).digest("hex");
}

export function hostEventDate(value: unknown, label: string): string {
	const date = hostEventString(value, label, 32);
	if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date)
		throw new HostEventError("invalid", `${label} must be canonical ISO time.`);
	return date;
}

function ciHost(value: unknown): string {
	const host = hostEventString(value, "CI host", 253);
	if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes(".."))
		throw new HostEventError("invalid", "CI host must be a lowercase hostname.");
	return host;
}

function ciSha(value: unknown): string {
	const sha = hostEventString(value, "CI head SHA", 64);
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new HostEventError("invalid", "CI head SHA is invalid.");
	return sha;
}

function ciConclusion(value: unknown): CiTerminalConclusion {
	if (!CI_TERMINAL_CONCLUSIONS.some((conclusion) => conclusion === value))
		throw new HostEventError("invalid", "Unknown CI conclusion.");
	return value as CiTerminalConclusion;
}

export function parseCiSubject(value: unknown): CiSubject {
	const entry = hostEventRecord(value, ["host", "repositoryId", "workflowId", "headSha"], "CI subject");
	return {
		host: ciHost(entry.host),
		repositoryId: hostEventInteger(entry.repositoryId, "repositoryId"),
		workflowId: hostEventInteger(entry.workflowId, "workflowId"),
		headSha: ciSha(entry.headSha),
	};
}

export function ciSubjectKey(subject: CiSubject): string {
	return hostEventHash("pi-ci-subject-v1", [subject.host, subject.repositoryId, subject.workflowId, subject.headSha]);
}

/** One workflow thread spans revisions; every delivery still checks its exact subject SHA. */
export function ciThreadKey(subject: Pick<CiSubject, "host" | "repositoryId" | "workflowId">): string {
	return `ci-thread-${hostEventHash("pi-ci-thread-v1", [subject.host, subject.repositoryId, subject.workflowId])}`;
}

export function ciEventSubject(event: CiAttemptTerminalEvent): CiSubject {
	return {
		host: event.identity.host,
		repositoryId: event.identity.repositoryId,
		workflowId: event.identity.workflowId,
		headSha: event.headSha,
	};
}

export function parseCiAttemptIdentity(value: unknown): CiAttemptIdentity {
	const entry = hostEventRecord(
		value,
		["provider", "host", "repositoryId", "workflowId", "runId", "runAttempt", "runNumber"],
		"CI attempt identity",
	);
	if (entry.provider !== "github-actions") throw new HostEventError("invalid", "Unknown CI provider.");
	return {
		provider: "github-actions",
		host: ciHost(entry.host),
		repositoryId: hostEventInteger(entry.repositoryId, "repositoryId"),
		workflowId: hostEventInteger(entry.workflowId, "workflowId"),
		runId: hostEventInteger(entry.runId, "runId"),
		runAttempt: hostEventInteger(entry.runAttempt, "runAttempt"),
		runNumber: hostEventInteger(entry.runNumber, "runNumber"),
	};
}

export function ciAttemptEventId(identity: CiAttemptIdentity): string {
	return `ci-${hostEventHash("pi-ci-attempt-v1", [identity.host, identity.repositoryId, identity.workflowId, identity.runId, identity.runAttempt])}`;
}

export function createCiAttemptTerminalEvent(
	input: Omit<CiAttemptTerminalEvent, "version" | "kind" | "eventId" | "payloadDigest">,
): CiAttemptTerminalEvent {
	const identity = parseCiAttemptIdentity(input.identity);
	const event = {
		version: 1 as const,
		kind: "ci-attempt-terminal" as const,
		eventId: ciAttemptEventId(identity),
		identity,
		headSha: ciSha(input.headSha),
		conclusion: ciConclusion(input.conclusion),
		workflowPath: hostEventString(input.workflowPath, "workflowPath", 2_048),
		observedAt: hostEventDate(input.observedAt, "observedAt"),
		runUrl: hostEventString(input.runUrl, "runUrl", 2_048),
	};
	const url = new URL(event.runUrl);
	if (url.protocol !== "https:" || url.hostname !== identity.host || url.username || url.password)
		throw new HostEventError("invalid", "CI run URL does not belong to its host.");
	return { ...event, payloadDigest: hostEventHash("pi-ci-terminal-payload-v1", event) };
}

export function parseCiAttemptTerminalEvent(value: unknown): CiAttemptTerminalEvent {
	const entry = hostEventRecord(
		value,
		[
			"version",
			"kind",
			"eventId",
			"identity",
			"headSha",
			"conclusion",
			"workflowPath",
			"observedAt",
			"runUrl",
			"payloadDigest",
		],
		"CI terminal event",
	);
	if (entry.version !== 1 || entry.kind !== "ci-attempt-terminal")
		throw new HostEventError("invalid", "Unknown host event format.");
	const event = createCiAttemptTerminalEvent({
		identity: parseCiAttemptIdentity(entry.identity),
		headSha: ciSha(entry.headSha),
		conclusion: ciConclusion(entry.conclusion),
		workflowPath: hostEventString(entry.workflowPath, "workflowPath", 2_048),
		observedAt: hostEventDate(entry.observedAt, "observedAt"),
		runUrl: hostEventString(entry.runUrl, "runUrl", 2_048),
	});
	if (entry.eventId !== event.eventId || entry.payloadDigest !== event.payloadDigest)
		throw new HostEventError(
			"identity_conflict",
			"CI event identity or payload digest differs from canonical content.",
		);
	return event;
}

export function githubLogin(value: unknown): string {
	const login = hostEventString(value, "GitHub login", MAX_GITHUB_LOGIN_LENGTH + "[bot]".length);
	const base = login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : login;
	if (base.length > MAX_GITHUB_LOGIN_LENGTH || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(base))
		throw new HostEventError("invalid", "GitHub login is invalid.");
	return login;
}

/** A GitHub branch name as a routine scope and an event's head branch: a bounded git ref name. */
export function githubBranchName(value: unknown): string {
	const branch = hostEventString(value, "GitHub branch", 255);
	if (
		!/^[\x21-\x7e]+$/.test(branch) ||
		/[~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^-/.test(branch) ||
		branch.endsWith(".")
	)
		throw new HostEventError("invalid", "GitHub branch name is invalid.");
	return branch;
}

/**
 * The body codec: any text, including surrounding whitespace, within the UTF-8 bound. Creation cuts a longer body at
 * a character boundary and records the cut; a NUL becomes U+FFFD there, so a parsed body never carries one.
 */
export function githubEventBody(text: string): GithubEventBody {
	const clean = text.replaceAll("\0", "\uFFFD");
	const bytes = Buffer.byteLength(text, "utf8");
	if (Buffer.byteLength(clean, "utf8") <= MAX_GITHUB_EVENT_BODY_BYTES) return { text: clean, truncated: false, bytes };
	let kept = "";
	let used = 0;
	for (const character of clean) {
		const size = Buffer.byteLength(character, "utf8");
		if (used + size > MAX_GITHUB_EVENT_BODY_BYTES) break;
		kept += character;
		used += size;
	}
	return { text: kept, truncated: true, bytes };
}

function parseGithubEventBody(value: unknown): GithubEventBody {
	const entry = hostEventRecord(value, ["text", "truncated", "bytes"], "GitHub event body");
	if (
		typeof entry.text !== "string" ||
		entry.text.includes("\0") ||
		Buffer.byteLength(entry.text, "utf8") > MAX_GITHUB_EVENT_BODY_BYTES ||
		typeof entry.truncated !== "boolean"
	)
		throw new HostEventError("invalid", "GitHub event body is invalid.");
	const bytes = hostEventInteger(entry.bytes, "body bytes", 0);
	const kept = Buffer.byteLength(entry.text, "utf8");
	if (entry.truncated ? bytes <= kept : bytes < kept)
		throw new HostEventError("invalid", "GitHub event body length is inconsistent.");
	return { text: entry.text, truncated: entry.truncated, bytes };
}

export function githubThreadEventId(
	repository: GithubThreadEvent["repository"],
	kind: GithubThreadEventKind,
	githubId: number,
): string {
	return `gh-${hostEventHash("pi-github-thread-v1", [repository.host, repository.repositoryId, kind, githubId])}`;
}

export function createGithubThreadEvent(
	input: Omit<GithubThreadEvent, "version" | "eventId" | "payloadDigest">,
): GithubThreadEvent {
	if (!GITHUB_THREAD_EVENT_KINDS.some((kind) => kind === input.kind))
		throw new HostEventError("invalid", "Unknown GitHub thread event kind.");
	const repository = {
		host: ciHost(input.repository.host),
		repositoryId: hostEventInteger(input.repository.repositoryId, "repositoryId"),
	};
	const githubId = hostEventInteger(input.githubId, "githubId");
	const pullRequest = input.thread.pullRequest;
	if (typeof pullRequest !== "boolean") throw new HostEventError("invalid", "GitHub thread kind is invalid.");
	if (input.thread.branch !== undefined && !pullRequest)
		throw new HostEventError("invalid", "Only a pull request has a head branch.");
	if (input.thread.ownedByViewer !== undefined && (input.thread.ownedByViewer !== true || !pullRequest))
		throw new HostEventError("invalid", "Only a pull request is owned by the signed-in login.");
	const body = input.body === undefined ? undefined : parseGithubEventBody(input.body);
	const commented = input.kind === "pull-request-comment" || input.kind === "review-comment";
	if (
		(commented && body === undefined) ||
		(input.kind !== "review-submitted" && !commented && body !== undefined) ||
		(input.kind === "review-submitted") !== (input.state !== undefined) ||
		(input.kind !== "issue-assigned" && !pullRequest)
	)
		throw new HostEventError("invalid", "GitHub thread event fields do not fit its kind.");
	if (input.state !== undefined && !GITHUB_REVIEW_STATES.some((state) => state === input.state))
		throw new HostEventError("invalid", "Unknown GitHub review state.");
	const event = {
		version: 1 as const,
		kind: input.kind,
		eventId: githubThreadEventId(repository, input.kind, githubId),
		githubId,
		repository,
		thread: {
			number: hostEventInteger(input.thread.number, "thread number"),
			pullRequest,
			...(input.thread.branch === undefined ? {} : { branch: githubBranchName(input.thread.branch) }),
			...(input.thread.ownedByViewer ? { ownedByViewer: true as const } : {}),
		},
		author: githubLogin(input.author),
		occurredAt: hostEventDate(input.occurredAt, "occurredAt"),
		url: hostEventString(input.url, "url", 2_048),
		...(body ? { body } : {}),
		...(input.state === undefined ? {} : { state: input.state }),
	};
	const url = new URL(event.url);
	if (url.protocol !== "https:" || url.hostname !== repository.host || url.username || url.password)
		throw new HostEventError("invalid", "GitHub thread URL does not belong to its host.");
	return { ...event, payloadDigest: hostEventHash("pi-github-thread-payload-v1", event) };
}

export function parseGithubThreadEvent(value: unknown): GithubThreadEvent {
	const entry = hostEventRecord(
		value,
		[
			"version",
			"kind",
			"eventId",
			"githubId",
			"repository",
			"thread",
			"author",
			"occurredAt",
			"url",
			"body",
			"state",
			"payloadDigest",
		],
		"GitHub thread event",
	);
	if (entry.version !== 1) throw new HostEventError("invalid", "Unknown host event format.");
	const repository = hostEventRecord(entry.repository, ["host", "repositoryId"], "GitHub repository");
	const thread = hostEventRecord(entry.thread, ["number", "pullRequest", "branch", "ownedByViewer"], "GitHub thread");
	const event = createGithubThreadEvent({
		kind: entry.kind as GithubThreadEventKind,
		githubId: entry.githubId as number,
		repository: { host: repository.host as string, repositoryId: repository.repositoryId as number },
		thread: {
			number: thread.number as number,
			pullRequest: thread.pullRequest as boolean,
			...(thread.branch === undefined ? {} : { branch: thread.branch as string }),
			...(thread.ownedByViewer === undefined ? {} : { ownedByViewer: thread.ownedByViewer as true }),
		},
		author: entry.author as string,
		occurredAt: entry.occurredAt as string,
		url: entry.url as string,
		...(entry.body === undefined ? {} : { body: entry.body as GithubEventBody }),
		...(entry.state === undefined ? {} : { state: entry.state as GithubReviewState }),
	});
	if (entry.eventId !== event.eventId || entry.payloadDigest !== event.payloadDigest)
		throw new HostEventError(
			"identity_conflict",
			"GitHub event identity or payload digest differs from canonical content.",
		);
	return event;
}

export function parseHostEventPayload(value: unknown): HostEventPayload {
	const kind = value && typeof value === "object" ? Reflect.get(value, "kind") : undefined;
	return kind === "ci-attempt-terminal" ? parseCiAttemptTerminalEvent(value) : parseGithubThreadEvent(value);
}

export function parseHostEventEnvelope(value: unknown): HostEventEnvelope {
	const entry = hostEventRecord(value, ["sourceId", "sourceEpoch", "sourceSequence", "event"], "host event envelope");
	const position = {
		sourceId: sourceIdentifier(entry.sourceId),
		sourceEpoch: hostEventString(entry.sourceEpoch, "sourceEpoch"),
		sourceSequence: hostEventInteger(entry.sourceSequence, "sourceSequence"),
	};
	const event = parseHostEventPayload(entry.event);
	return isCiAttemptEvent(event) ? { ...position, event } : { ...position, event };
}

/** A seal snapshot or a delivery always carries a CI attempt. */
export function parseCiHostEventEnvelope(value: unknown): CiHostEventEnvelope {
	const envelope = parseHostEventEnvelope(value);
	if (!isCiEnvelope(envelope)) throw new HostEventError("invalid", "Only a CI attempt is a seal snapshot.");
	return envelope;
}

export function parseHostEventSourceRegistration(value: unknown): HostEventSourceRegistration {
	const entry = hostEventRecord(
		value,
		["sourceId", "sourceEpoch", "scopeVersion", "subjects", "rootSubjects", "startingSequence", "storeIdentity"],
		"host event source registration",
	);
	const subjects = hostEventArray(entry.subjects, MAX_HOST_EVENT_SUBJECTS, parseCiSubject, "source subjects");
	if (subjects.length === 0 || new Set(subjects.map(ciSubjectKey)).size !== subjects.length)
		throw new HostEventError("invalid", "Source subjects must be nonempty and unique.");
	const rootSubjects = hostEventArray(entry.rootSubjects, MAX_HOST_EVENT_SUBJECTS, parseCiSubject, "root subjects");
	const subjectKeys = new Set(subjects.map(ciSubjectKey));
	if (
		new Set(rootSubjects.map(ciSubjectKey)).size !== rootSubjects.length ||
		rootSubjects.some((subject) => !subjectKeys.has(ciSubjectKey(subject)))
	)
		throw new HostEventError("invalid", "Root subjects must be a unique subset of the registered scope.");
	return {
		sourceId: sourceIdentifier(entry.sourceId),
		sourceEpoch: hostEventString(entry.sourceEpoch, "sourceEpoch"),
		scopeVersion: hostEventInteger(entry.scopeVersion, "scopeVersion"),
		subjects,
		rootSubjects,
		startingSequence: hostEventInteger(entry.startingSequence, "startingSequence"),
		// Registrations saved before stores named themselves carry none; such a source is ended by any successor
		// registration of the same repository (`hostEventSourceReplaces`).
		...(entry.storeIdentity === undefined
			? {}
			: { storeIdentity: hostEventDigest(entry.storeIdentity, "storeIdentity") }),
	};
}

export function parseHostEventSourceEnd(value: unknown): HostEventSourceEnd {
	const entry = hostEventRecord(value, ["sourceId", "sourceEpoch", "reason"], "host event source end");
	if (!HOST_EVENT_SOURCE_END_REASONS.some((reason) => reason === entry.reason))
		throw new HostEventError("invalid", "Unknown host event source end reason.");
	return {
		sourceId: sourceIdentifier(entry.sourceId),
		sourceEpoch: hostEventString(entry.sourceEpoch, "sourceEpoch"),
		reason: entry.reason as HostEventSourceEndReason,
	};
}

/**
 * Registering `next` ends `prior`: both come from one store under different source ids. A prior registration that names
 * no store predates store identities; every store now names itself, so it can only be a replaced journal of the
 * same repository.
 */
export function hostEventSourceReplaces(
	next: HostEventSourceRegistration,
	prior: HostEventSourceRegistration,
): boolean {
	if (next.storeIdentity === undefined || prior.sourceId === next.sourceId) return false;
	if (prior.storeIdentity !== undefined) return prior.storeIdentity === next.storeIdentity;
	const repositories = new Set(next.subjects.map((subject) => JSON.stringify([subject.host, subject.repositoryId])));
	return prior.subjects.some((subject) => repositories.has(JSON.stringify([subject.host, subject.repositoryId])));
}

export function parseHostEventCatchUp(value: unknown): HostEventCatchUp {
	const entry = hostEventRecord(
		value,
		["sourceId", "sourceEpoch", "scopeVersion", "generation"],
		"host event catch-up",
	);
	return {
		sourceId: sourceIdentifier(entry.sourceId),
		sourceEpoch: hostEventString(entry.sourceEpoch, "sourceEpoch"),
		scopeVersion: hostEventInteger(entry.scopeVersion, "scopeVersion"),
		generation: hostEventInteger(entry.generation, "generation"),
	};
}

export function parseCiCurrentObservation(value: unknown): CiCurrentObservation {
	const entry = hostEventRecord(
		value,
		["subject", "runId", "runNumber", "runAttempt", "status", "conclusion", "eventId"],
		"CI current observation",
	);
	if (entry.status !== "queued" && entry.status !== "in_progress" && entry.status !== "completed")
		throw new HostEventError("invalid", "Unknown CI observation status.");
	if (
		(entry.status === "completed") !== (entry.conclusion !== undefined && entry.eventId !== undefined) ||
		(entry.status !== "completed" && (entry.conclusion !== undefined || entry.eventId !== undefined))
	)
		throw new HostEventError("invalid", "CI observation terminal fields are inconsistent.");
	return {
		subject: parseCiSubject(entry.subject),
		runId: hostEventInteger(entry.runId, "runId"),
		runNumber: hostEventInteger(entry.runNumber, "runNumber"),
		runAttempt: hostEventInteger(entry.runAttempt, "runAttempt"),
		status: entry.status,
		...(entry.status === "completed"
			? { conclusion: ciConclusion(entry.conclusion), eventId: hostEventString(entry.eventId, "eventId") }
			: {}),
	};
}

/** A completed sealed observation carries its occurrence's source position; any other carries none. */
export function parseHostEventSealObservation(value: unknown): HostEventSealObservation {
	const entry = hostEventRecord(
		value,
		["subject", "runId", "runNumber", "runAttempt", "status", "conclusion", "eventId", "sourceSequence"],
		"sealed CI observation",
	);
	const { sourceSequence, ...current } = entry;
	const observation = parseCiCurrentObservation(current);
	if ((observation.status === "completed") !== (sourceSequence !== undefined))
		throw new HostEventError("invalid", "A sealed observation names a source position exactly when it is terminal.");
	return observation.status === "completed"
		? { ...observation, sourceSequence: hostEventInteger(sourceSequence, "sourceSequence") }
		: observation;
}

export function parseHostEventCatchUpSeal(value: unknown): HostEventCatchUpSeal {
	const entry = hostEventRecord(
		value,
		["sourceId", "sourceEpoch", "scopeVersion", "generation", "throughSequence", "observations", "snapshots"],
		"host event seal",
	);
	const identity = parseHostEventCatchUp({
		sourceId: entry.sourceId,
		sourceEpoch: entry.sourceEpoch,
		scopeVersion: entry.scopeVersion,
		generation: entry.generation,
	});
	const observations = hostEventArray(
		entry.observations,
		MAX_HOST_EVENT_SUBJECTS,
		parseHostEventSealObservation,
		"seal observations",
	);
	if (new Set(observations.map((observation) => ciSubjectKey(observation.subject))).size !== observations.length)
		throw new HostEventError("invalid", "Seal observations must have unique subjects.");
	const snapshots =
		entry.snapshots === undefined
			? undefined
			: hostEventArray(entry.snapshots, MAX_HOST_EVENT_SUBJECTS, parseCiHostEventEnvelope, "seal snapshots");
	if (snapshots && new Set(snapshots.map((snapshot) => snapshot.event.eventId)).size !== snapshots.length)
		throw new HostEventError("invalid", "Seal snapshot identities must be unique.");
	return {
		...identity,
		throughSequence: hostEventInteger(entry.throughSequence, "throughSequence", 0),
		observations,
		...(snapshots ? { snapshots } : {}),
	};
}

export function parseHostEventReplayHorizon(value: unknown): HostEventReplayHorizon {
	const entry = hostEventRecord(value, ["sourceId", "sourceEpoch", "throughSequence"], "host event replay horizon");
	return {
		sourceId: sourceIdentifier(entry.sourceId),
		sourceEpoch: hostEventString(entry.sourceEpoch, "sourceEpoch"),
		throughSequence: hostEventInteger(entry.throughSequence, "throughSequence", 0),
	};
}

export function parseHostEventReplayGap(value: unknown): HostEventReplayGap {
	const entry = hostEventRecord(
		value,
		["sourceId", "sourceEpoch", "scopeVersion", "generation", "afterSequence", "throughSequence", "reason"],
		"host event replay gap",
	);
	if (!isHostEventReplayGapReason(entry.reason)) throw new HostEventError("invalid", "Unknown replay gap reason.");
	const afterSequence = hostEventInteger(entry.afterSequence, "afterSequence", 0);
	const throughSequence = hostEventInteger(entry.throughSequence, "throughSequence");
	if (throughSequence <= afterSequence || throughSequence === Number.MAX_SAFE_INTEGER)
		throw new HostEventError("invalid", "Replay gap must advance to a bounded source position.");
	return {
		...parseHostEventCatchUp({
			sourceId: entry.sourceId,
			sourceEpoch: entry.sourceEpoch,
			scopeVersion: entry.scopeVersion,
			generation: entry.generation,
		}),
		afterSequence,
		throughSequence,
		reason: entry.reason,
	};
}

export function parseHostEventSubscriptionInput(value: unknown): HostEventSubscriptionInput {
	const entry = hostEventRecord(value, ["threadKey", "subject", "wake"], "host event subscription");
	if (entry.wake !== "never" && entry.wake !== "resume_same_task")
		throw new HostEventError("invalid", "Unknown host event wake policy.");
	const subject = parseCiSubject(entry.subject);
	const threadKey = hostEventString(entry.threadKey, "threadKey");
	if (threadKey !== ciThreadKey(subject))
		throw new HostEventError("invalid", "Subscription thread does not identify its CI workflow.");
	return { threadKey, subject, wake: entry.wake };
}

export function hostEventSubscriptionId(taskId: string, threadKey: string): string {
	return `hes-${hostEventHash("pi-host-event-subscription-v1", [taskId, threadKey])}`;
}

export function parseHostEventDeliveryBinding(value: unknown): HostEventDeliveryBinding {
	const binding = parseWorkerHostEventRecord(value);
	if (!binding) throw new HostEventError("invalid", "Host event delivery binding is invalid.");
	return binding;
}

export function parseHostEventTranscriptReceipt(value: unknown): HostEventTranscriptReceipt {
	const entry = hostEventRecord(
		value,
		["sessionId", "sessionFile", "entryId", "taskId", "attemptId", "messageId", "contentDigest", "bindingDigest"],
		"host event transcript receipt",
	);
	return {
		sessionId: hostEventString(entry.sessionId, "sessionId"),
		sessionFile: hostEventString(entry.sessionFile, "sessionFile", MAX_WORKER_AUTHORITY_PATH_LENGTH),
		entryId: hostEventString(entry.entryId, "entryId"),
		taskId: hostEventString(entry.taskId, "taskId"),
		attemptId: hostEventString(entry.attemptId, "attemptId"),
		messageId: hostEventString(entry.messageId, "messageId"),
		contentDigest: hostEventDigest(entry.contentDigest, "contentDigest"),
		bindingDigest: hostEventDigest(entry.bindingDigest, "bindingDigest"),
	};
}

export function assertHostEventReceiptMatchesBinding(
	receipt: HostEventTranscriptReceipt,
	binding: HostEventDeliveryBinding,
): void {
	if (
		receipt.bindingDigest !== binding.bindingDigest ||
		receipt.contentDigest !== binding.contentDigest ||
		receipt.messageId !== binding.messageId ||
		receipt.taskId !== binding.execution.taskId ||
		receipt.attemptId !== binding.execution.attemptId ||
		receipt.sessionId !== binding.execution.sessionId ||
		receipt.sessionFile !== binding.execution.sessionFile
	)
		throw new HostEventError("identity_conflict", "Transcript receipt differs from admitted binding.");
}
