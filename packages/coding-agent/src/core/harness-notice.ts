import { createHash } from "node:crypto";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import { captureWorkerReceiptOrigin } from "./delegation/worker-receipt-origin.ts";
import type { ParentInputDelivery, ParentInputReceipt } from "./parent-input-delivery.ts";
import { boundedRedactedDiagnosticText, cleanRedactBound } from "./security/secret-text.ts";
import { wrapUntrustedText } from "./security/untrusted-boundary.ts";
import { reportSessionObserverFailures } from "./session-observer-failures.ts";
import { isPlainRecord } from "./util/value-guards.ts";

export const HARNESS_NOTICE_CUSTOM_TYPE = "harness-notice";

/** Episodes of one state a session can be told about; past it the state is still visible in its status command. */
const MAX_NOTICE_GENERATIONS = 32;
/** Observed notices one runtime keeps until they are saved; each holds one bounded headline and its evidence. */
const MAX_PENDING_NOTICES = 32;
/** Failed saves of one notice before it is dropped; the capability's next signal of the state starts a new one. */
const MAX_NOTICE_SAVE_ATTEMPTS = 3;
/** The one-line headline one notice keeps for the owner and the model: wide enough for multi-clause host notices without clipping their remedy. */
export const MAX_NOTICE_HEADLINE_CHARS = 1_200;
/** The worker-written detail one notice carries for the model: fenced, and never shown on the owner's surface. */
const MAX_NOTICE_EVIDENCE_CHARS = 1_200;

/**
 * The automatic capabilities whose owner-actionable inactive states the harness reports by itself. A kind is part of
 * the delivery id, so a name never changes once shipped; its reasons are free stable strings chosen by the capability.
 */
export type HarnessNoticeKind =
	| "knowledge-collection"
	| "proactive-review"
	| "routine-intake"
	| "routine-result-wakes"
	| "routine-paused"
	| "routine-unschedulable"
	| "routine-snag"
	| "routine-away-service"
	| "host-event-gap"
	| "host-event-source"
	| "outward-action-prepared"
	| "channel-state"
	| "channel-gap"
	| "channel-reply"
	| "channel-sender"
	| "act-ahead"
	| "soul-review"
	| "system-one-engine"
	| "worker-login"
	| "fleet-spend-brake"
	| "review-backlog"
	| "orchestration-capacity";

/**
 * One owner-actionable state: `reason` is its stable identity, `text` the one line the owner reads. `evidence` is optional
 * worker-written detail the model reads fenced as data; the owner's surface never shows it, and it is not part of `reason`.
 */
export interface HarnessNotice {
	readonly reason: string;
	readonly text: string;
	readonly evidence?: string;
}

/**
 * What a capability's owner observed at one of its own detection points: a kept state, or proof that the capability
 * works again. A state that is normal flow, transient or the owner's own switch is not observed at all. A kind whose
 * subjects hold their states independently (one per routine) names the subject as `scope`; each scope has its own
 * episodes, so observing one subject never ends or repeats another's.
 */
export type HarnessNoticeObservation =
	| HarnessNotice
	| "clear"
	| { readonly scope: string; readonly state: HarnessNotice | "clear" };

export interface HarnessNoticeDeps {
	getSessionManager(): SessionManager;
	isChildSession(): boolean;
	/** The session's durable parent-input owner; `next-owner-turn` inputs never start a turn. */
	deliver(input: ParentInputDelivery): Promise<ParentInputReceipt>;
	warn(message: string): void;
}

interface KindState {
	readonly kind: HarnessNoticeKind;
	readonly scope?: string;
	/** The state this runtime last observed for the kind, or `clear`; absent until the first observation. */
	observed?: string;
	/** The reason whose notice is saved, waiting, in flight or already carried for the current episode. */
	covered?: string;
	/** The current episode's own notice was not kept (no transcript, or its saves failed); retried as a recurrence. */
	unsaved?: boolean;
}

/** One observed episode's notice, frozen at its first observation and kept in memory until it is saved. */
interface PendingNotice {
	readonly sessionId: string;
	readonly kind: HarnessNoticeKind;
	readonly key: string;
	readonly reason: string;
	readonly deliveryId: string;
	readonly payloadDigest: string;
	readonly message: ParentInputDelivery["message"];
	failures: number;
	/** The observers told when this notice is dropped unsaved; emptied once told. */
	readonly lost: (() => void)[];
}

/** The id of one episode's notice: replaying a detection, in this process or after restart, finds the saved input. */
export function harnessNoticeDeliveryId(
	sessionId: string,
	kind: HarnessNoticeKind,
	reason: string,
	generation: number,
): string {
	return `${HARNESS_NOTICE_CUSTOM_TYPE}:${createHash("sha256")
		.update(JSON.stringify([sessionId, kind, reason, generation]))
		.digest("hex")}`;
}

/**
 * The one-line headline a notice keeps for the owner and the model: cleaned, redacted and bounded to at most
 * {@link MAX_NOTICE_HEADLINE_CHARS} characters in that order (`cleanRedactBound`), so multi-clause host notices keep
 * their actionable remedy whole while a longer text keeps its head and tail around one elision without splitting a
 * secret or a path. Nothing left means no notice.
 */
function boundedRedactedNoticeHeadline(headline: string): string | undefined {
	return cleanRedactBound(headline, MAX_NOTICE_HEADLINE_CHARS) || undefined;
}

/**
 * The evidence a notice keeps for the model: cleaned, redacted and bounded to at most {@link MAX_NOTICE_EVIDENCE_CHARS}
 * characters in that order (`cleanRedactBound`, line breaks kept), so a token split by a character or cut by the bound is
 * never left unmasked. Nothing left means no evidence.
 */
function boundedRedactedNoticeEvidence(evidence: string): string | undefined {
	return cleanRedactBound(evidence, MAX_NOTICE_EVIDENCE_CHARS, { lines: true }) || undefined;
}

/**
 * The message a notice saves. `content` is what the model reads: the headline, then the evidence fenced as data. `details`
 * keeps the headline for the owner's surface, which never shows the model text. The fence nonce comes from the delivery id,
 * so a runtime that saves the same notice again writes the same bytes; the fence neutralizes that nonce wherever the
 * evidence holds it.
 */
function harnessNoticeMessage(input: {
	readonly kind: HarnessNoticeKind;
	readonly deliveryId: string;
	readonly reason: string;
	readonly generation: number;
	readonly headline: string;
	readonly evidence: string | undefined;
}): ParentInputDelivery["message"] {
	const fence =
		input.evidence === undefined
			? []
			: [
					wrapUntrustedText(input.evidence, `harness-notice:${input.kind}`, {
						nonce: createHash("sha256").update(input.deliveryId).digest("hex").slice(0, 32),
					}),
				];
	return {
		customType: HARNESS_NOTICE_CUSTOM_TYPE,
		display: true,
		content: [
			`Harness notice: ${input.headline}`,
			...fence,
			"The owner sees this notice directly; mention it only if it bears on what they ask.",
		].join("\n"),
		// The headline rides in details only when evidence follows it: without evidence the content IS the headline, so a
		// notice saved without evidence keeps the details it always had.
		details: {
			kind: input.kind,
			reason: input.reason,
			generation: input.generation,
			...(input.evidence === undefined ? {} : { headline: input.headline }),
		},
	};
}

/**
 * The owner's line of a harness notice, read from the details its saved or delivered message keeps (a delivered input keeps
 * them under the ledger's wrapper). Undefined for any other message, and for a notice saved before headlines were kept.
 */
export function harnessNoticeHeadline(message: {
	readonly customType: string;
	readonly details?: unknown;
}): string | undefined {
	if (message.customType !== HARNESS_NOTICE_CUSTOM_TYPE) return undefined;
	const details =
		isPlainRecord(message.details) && "parentInput" in message.details
			? message.details.originalDetails
			: message.details;
	return isPlainRecord(details) && typeof details.headline === "string" ? details.headline : undefined;
}

/**
 * Whether a notice observed now is saved at once: the durable channel is a persisted root transcript with a persisted
 * anchor. Before it, a notice waits in memory for the session's next saved entry and is lost if the runtime ends first.
 */
export function transcriptKeepsNotices(
	manager: Pick<
		SessionManager,
		"isPersisted" | "isPersistenceStateUncertain" | "getSessionFile" | "getLeafId" | "isEntryPersisted"
	>,
): boolean {
	if (!manager.isPersisted()) return !manager.isPersistenceStateUncertain();
	const leafId = manager.getLeafId();
	return Boolean(manager.getSessionFile() && leafId && manager.isEntryPersisted(leafId));
}

/**
 * Tells the owner once, with their next turn, that an automatic capability stopped for a reason they can act on. It
 * never wakes a turn and never calls a model. Each (session, kind, reason) episode has one durable notice: a second
 * detection or a replay finds the saved input and adds nothing. A new notice for the same reason needs this runtime to
 * have observed the state end (clear or another reason) and return, and the previous notice to have reached the owner.
 * An observed notice is kept in memory until it is saved: a later clear does not drop it, and a session whose first
 * entry is not saved yet saves it with that entry. It is lost when this runtime ends or changes session before that
 * entry, when a newer reason of the same state supersedes it, and, with a warning, when it is the oldest one not being
 * saved past 32 waiting notices or its third save fails. An observer that passed `onLost` hears each such loss once,
 * past the caller's stack; a notice whose save is in flight is lost only if that save fails or never runs.
 */
export class HarnessNoticeController {
	private readonly deps: HarnessNoticeDeps;
	/** State per kind, or per kind and scope. */
	private readonly kinds = new Map<string, KindState>();
	/** Unsaved notices per kind, or per kind and scope, oldest first. */
	private readonly pending = new Map<string, PendingNotice>();
	private readonly inFlight = new Set<string>();
	private readonly offObserverFailures: () => void;
	private offPersisted: (() => void) | undefined;
	private retryScheduled = false;
	private sessionId: string | undefined;
	private closed = false;

	constructor(deps: HarnessNoticeDeps) {
		this.deps = deps;
		this.offObserverFailures = reportSessionObserverFailures(deps.getSessionManager(), (message) =>
			deps.warn(message),
		);
	}

	/**
	 * Called only from a capability's existing detection points with a reader of its current state (undefined: nothing
	 * the owner is told about). Delivery is deferred past the caller's stack, and a state or notice that cannot be read
	 * or saved is reported, never thrown into the capability that observed it. Returns whether the owner is told of the
	 * observed state: its notice is being saved or waits for the session's next saved entry, or one already saved tells
	 * it. False where no notice can be kept (a child session, a session that is not persisted, a closed runtime), and
	 * for a clear. `onLost` is called once if a notice this call reports kept is dropped before it is saved; never
	 * when this returns false.
	 */
	observe(kind: HarnessNoticeKind, read: () => HarnessNoticeObservation | undefined, onLost?: () => void): boolean {
		if (this.closed || this.deps.isChildSession()) return false;
		try {
			const observation = read();
			return observation === undefined ? false : this.record(kind, observation, onLost);
		} catch (error) {
			this.report(kind, error);
			return false;
		}
	}

	/**
	 * Read-only: the state this runtime last observed per kind (and scope) in the current session, `clear` included,
	 * and how many observed notices still wait to be saved. Nothing is observed, saved or retried by reading it.
	 */
	observedStates(): {
		readonly states: readonly {
			readonly kind: HarnessNoticeKind;
			readonly scope?: string;
			readonly observed: string;
		}[];
		readonly unsaved: number;
	} {
		// Observations of another session (before this runtime switched) are not this session's.
		if (this.deps.getSessionManager().getSessionId() !== this.sessionId) return { states: [], unsaved: 0 };
		const states = [...this.kinds.values()].flatMap((state) =>
			state.observed === undefined
				? []
				: [
						{
							kind: state.kind,
							...(state.scope === undefined ? {} : { scope: state.scope }),
							observed: state.observed,
						},
					],
		);
		return { states, unsaved: this.pending.size };
	}

	close(): void {
		this.closed = true;
		this.offObserverFailures();
		this.offPersisted?.();
		this.offPersisted = undefined;
		// A notice whose save is in flight is decided by that save.
		for (const notice of this.pending.values()) if (!this.inFlight.has(notice.deliveryId)) this.lose(notice);
		this.pending.clear();
	}

	private record(
		kind: HarnessNoticeKind,
		observed: HarnessNoticeObservation,
		onLost: (() => void) | undefined,
	): boolean {
		const manager = this.deps.getSessionManager();
		const sessionId = manager.getSessionId();
		if (sessionId !== this.sessionId) {
			this.sessionId = sessionId;
			this.kinds.clear();
			for (const notice of [...this.pending.values()]) this.dropUnsaved(notice);
		}
		const scope = typeof observed === "object" && "scope" in observed ? observed.scope : undefined;
		const observation = typeof observed === "object" && "scope" in observed ? observed.state : observed;
		const key = scope === undefined ? kind : JSON.stringify([kind, scope]);
		let state = this.kinds.get(key);
		if (!state) {
			state = { kind, ...(scope === undefined ? {} : { scope }) };
			this.kinds.set(key, state);
		}
		const firstObservation = state.observed === undefined;
		if (observation === "clear") {
			// The episode ended, but a notice observed in it and not yet saved still tells the owner it happened.
			state.observed = "clear";
			state.covered = undefined;
			state.unsaved = false;
			return false;
		}
		const { reason } = observation;
		const recurred = state.unsaved === true || (!firstObservation && state.observed !== reason);
		state.observed = reason;
		state.unsaved = false;
		// A newer state of the same subject supersedes the older one's unsaved notice.
		const superseded = this.pending.get(key);
		if (superseded && superseded.reason !== reason) this.dropUnsaved(superseded);
		if (state.covered === reason && !recurred) {
			// A notice of this episode that still waits tells this observation too, and shares its fate.
			const waiting = this.pending.get(key);
			if (onLost && waiting?.reason === reason) waiting.lost.push(onLost);
			return true;
		}
		state.covered = undefined;
		let latest = -1;
		while (latest + 1 < MAX_NOTICE_GENERATIONS) {
			if (!manager.getParentInput(harnessNoticeDeliveryId(sessionId, kind, reason, latest + 1))) break;
			latest++;
		}
		const latestId = latest >= 0 ? harnessNoticeDeliveryId(sessionId, kind, reason, latest) : undefined;
		// The saved notice already tells this state: after restart (no observed end), or while it still waits for the owner.
		if (
			latestId &&
			(!recurred ||
				this.inFlight.has(latestId) ||
				manager.getPendingParentInputs("next-owner-turn").some((input) => input.metadata.deliveryId === latestId))
		) {
			state.covered = reason;
			return true;
		}
		const generation = latest + 1;
		if (generation >= MAX_NOTICE_GENERATIONS) {
			state.covered = reason;
			return true;
		}
		const text = boundedRedactedNoticeHeadline(observation.text);
		if (!text) {
			state.unsaved = recurred;
			return false;
		}
		const deliveryId = harnessNoticeDeliveryId(sessionId, kind, reason, generation);
		state.covered = reason;
		let notice = this.pending.get(key);
		if (notice?.deliveryId !== deliveryId) {
			const message = harnessNoticeMessage({
				kind,
				deliveryId,
				reason,
				generation,
				headline: text,
				evidence:
					observation.evidence === undefined ? undefined : boundedRedactedNoticeEvidence(observation.evidence),
			});
			const payloadDigest = createHash("sha256").update(JSON.stringify(message)).digest("hex");
			notice = { sessionId, kind, key, reason, deliveryId, payloadDigest, message, failures: 0, lost: [] };
			this.keep(notice);
		}
		if (onLost) notice.lost.push(onLost);
		this.save(notice);
		return true;
	}

	private keep(notice: PendingNotice): void {
		this.pending.delete(notice.key);
		// The oldest one not being saved right now makes room.
		const oldest =
			this.pending.size >= MAX_PENDING_NOTICES
				? [...this.pending.values()].find((waiting) => !this.inFlight.has(waiting.deliveryId))
				: undefined;
		if (oldest) {
			this.pending.delete(oldest.key);
			this.reopen(oldest);
			this.lose(oldest);
			this.report(oldest.kind, `${MAX_PENDING_NOTICES} newer notices wait to be saved`, "it is dropped");
		}
		this.pending.set(notice.key, notice);
		// Retried with the session's next saved entry (the owner's next turn saves one); a notice alone never creates
		// the session file. Subscribed only while a notice waits.
		this.offPersisted ??= this.deps.getSessionManager().onEntriesPersisted(() => {
			if (this.retryScheduled) return;
			this.retryScheduled = true;
			// Past the write's stack: the write may run inside its caller's transaction.
			queueMicrotask(() => {
				this.retryScheduled = false;
				for (const waiting of [...this.pending.values()]) {
					try {
						this.save(waiting);
					} catch (error) {
						this.report(waiting.kind, error, "it is retried with the session's next saved entry");
					}
				}
			});
		});
	}

	private drop(notice: PendingNotice): void {
		if (this.pending.get(notice.key) === notice) this.pending.delete(notice.key);
		if (this.pending.size === 0) {
			this.offPersisted?.();
			this.offPersisted = undefined;
		}
	}

	/** Drop a notice that is not saved: lost now, unless its save is in flight, which decides. */
	private dropUnsaved(notice: PendingNotice): void {
		this.drop(notice);
		if (!this.inFlight.has(notice.deliveryId)) this.lose(notice);
	}

	/** Tell the notice's observers, once and past the caller's stack, that the owner does not get it. */
	private lose(notice: PendingNotice): void {
		for (const onLost of notice.lost.splice(0))
			queueMicrotask(() => {
				try {
					onLost();
				} catch (error) {
					this.report(notice.kind, error, "its observer could not take the loss back");
				}
			});
	}

	/** A dropped notice whose state is still observed leaves its episode open: the capability's next signal retries it. */
	private reopen(notice: PendingNotice): void {
		const state = this.kinds.get(notice.key);
		if (state?.covered === notice.reason && state.observed === notice.reason) {
			state.covered = undefined;
			state.unsaved = true;
		}
	}

	private save(notice: PendingNotice): void {
		if (this.closed || this.inFlight.has(notice.deliveryId)) return;
		const manager = this.deps.getSessionManager();
		// Left behind by a session switch.
		if (manager.getSessionId() !== notice.sessionId) {
			this.dropUnsaved(notice);
			return;
		}
		// Saved already (a replay, or another runtime of this session).
		if (manager.getParentInput(notice.deliveryId)) {
			this.drop(notice);
			return;
		}
		// Until the transcript keeps it, the notice waits.
		if (!transcriptKeepsNotices(manager)) return;
		this.inFlight.add(notice.deliveryId);
		void Promise.resolve()
			.then<ParentInputReceipt | false>(() => {
				// A closed runtime or a switched session has no owner left for this episode.
				if (this.closed || this.deps.getSessionManager() !== manager) return false;
				return this.deps.deliver({
					deliveryId: notice.deliveryId,
					payloadDigest: notice.payloadDigest,
					message: notice.message,
					origin: captureWorkerReceiptOrigin(manager),
					mode: "next-owner-turn",
				});
			})
			.then(
				(receipt: ParentInputReceipt | false) => {
					this.inFlight.delete(notice.deliveryId);
					this.drop(notice);
					if (receipt !== false) return;
					this.reopen(notice);
					this.lose(notice);
				},
				(error: unknown) => {
					this.inFlight.delete(notice.deliveryId);
					if (this.closed) {
						this.lose(notice);
						return;
					}
					// The attempt's own foreground release notifies synchronously while the reason is still covered, so that
					// echo starts nothing; a branch navigation during a busy turn is the usual cause of a failed save.
					notice.failures++;
					const current = this.pending.get(notice.key) === notice;
					const retried = current && notice.failures < MAX_NOTICE_SAVE_ATTEMPTS;
					if (!retried) {
						this.drop(notice);
						this.reopen(notice);
						this.lose(notice);
					}
					this.report(
						notice.kind,
						error,
						retried
							? "it is retried with the session's next saved entry"
							: current
								? `it is dropped after ${notice.failures} failed saves`
								: "a newer state replaced it",
					);
				},
			);
	}

	private report(kind: HarnessNoticeKind, error: unknown, consequence?: string): void {
		const detail = boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error));
		const cause = detail ? `: ${detail}` : "";
		try {
			this.deps.warn(
				`A harness notice (${kind}) was not saved${cause}${consequence ? `; ${consequence}` : cause ? "" : "."}`,
			);
		} catch {
			// A diagnostic never fails the capability that observed the state.
		}
	}
}
