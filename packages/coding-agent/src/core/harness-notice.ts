import { createHash } from "node:crypto";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import { captureWorkerReceiptOrigin } from "./delegation/worker-receipt-origin.ts";
import type { ParentInputDelivery, ParentInputReceipt } from "./parent-input-delivery.ts";
import { boundedRedactedDiagnosticText } from "./security/secret-text.ts";

export const HARNESS_NOTICE_CUSTOM_TYPE = "harness-notice";

/** Episodes of one state a session can be told about; past it the state is still visible in its status command. */
const MAX_NOTICE_GENERATIONS = 32;

/**
 * The automatic capabilities whose owner-actionable inactive states the harness reports by itself. A kind is part of
 * the delivery id, so a name never changes once shipped; its reasons are free stable strings chosen by the capability.
 */
export type HarnessNoticeKind = "knowledge-collection" | "proactive-review" | "routine-intake";

/** One owner-actionable state: `reason` is its stable identity, `text` the one line the owner reads. */
export interface HarnessNotice {
	readonly reason: string;
	readonly text: string;
}

/**
 * What a capability's owner observed at one of its own detection points: a kept state, or proof that the capability
 * works again. A state that is normal flow, transient or the owner's own switch is not observed at all.
 */
export type HarnessNoticeObservation = HarnessNotice | "clear";

export interface HarnessNoticeDeps {
	getSessionManager(): SessionManager;
	isChildSession(): boolean;
	/** The session's durable parent-input owner; `next-owner-turn` inputs never start a turn. */
	deliver(input: ParentInputDelivery): Promise<ParentInputReceipt>;
	warn(message: string): void;
}

interface KindState {
	/** The state this runtime last observed for the kind, or `clear`; absent until the first observation. */
	observed?: string;
	/** The reason whose notice is saved, in flight or already carried for the current episode. */
	covered?: string;
	/** The current episode's own notice is not saved (no durable channel yet, or its save failed); retried as a recurrence. */
	unsaved?: boolean;
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
 * Tells the owner once, with their next turn, that an automatic capability stopped for a reason they can act on. It
 * never wakes a turn and never calls a model. Each (session, kind, reason) episode has one durable notice: a second
 * detection or a replay finds the saved input and adds nothing. A new notice for the same reason needs this runtime to
 * have observed the state end (clear or another reason) and return, and the previous notice to have reached the owner.
 */
export class HarnessNoticeController {
	private readonly deps: HarnessNoticeDeps;
	private readonly kinds = new Map<HarnessNoticeKind, KindState>();
	private readonly inFlight = new Set<string>();
	private sessionId: string | undefined;
	private closed = false;

	constructor(deps: HarnessNoticeDeps) {
		this.deps = deps;
	}

	/**
	 * Called only from a capability's existing detection points with a reader of its current state (undefined: nothing
	 * the owner is told about). Delivery is deferred past the caller's stack, and a state or notice that cannot be read
	 * or saved is reported, never thrown into the capability that observed it.
	 */
	observe(kind: HarnessNoticeKind, read: () => HarnessNoticeObservation | undefined): void {
		if (this.closed || this.deps.isChildSession()) return;
		try {
			const observation = read();
			if (observation !== undefined) this.record(kind, observation);
		} catch (error) {
			this.report(kind, error);
		}
	}

	close(): void {
		this.closed = true;
	}

	private record(kind: HarnessNoticeKind, observation: HarnessNoticeObservation): void {
		const manager = this.deps.getSessionManager();
		const sessionId = manager.getSessionId();
		if (sessionId !== this.sessionId) {
			this.sessionId = sessionId;
			this.kinds.clear();
		}
		let state = this.kinds.get(kind);
		if (!state) {
			state = {};
			this.kinds.set(kind, state);
		}
		const firstObservation = state.observed === undefined;
		if (observation === "clear") {
			state.observed = "clear";
			state.covered = undefined;
			state.unsaved = false;
			return;
		}
		const { reason } = observation;
		const recurred = state.unsaved === true || (!firstObservation && state.observed !== reason);
		state.observed = reason;
		state.unsaved = false;
		if (state.covered === reason && !recurred) return;
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
			return;
		}
		const generation = latest + 1;
		if (generation >= MAX_NOTICE_GENERATIONS) {
			state.covered = reason;
			return;
		}
		const text = boundedRedactedDiagnosticText(observation.text);
		const leafId = manager.getLeafId();
		// The durable channel is a persisted root transcript with a persisted anchor; until then the next signal retries.
		if (
			!text ||
			!manager.isPersisted() ||
			!manager.getSessionFile() ||
			!leafId ||
			!manager.isEntryPersisted(leafId)
		) {
			state.unsaved = recurred;
			return;
		}
		const deliveryId = harnessNoticeDeliveryId(sessionId, kind, reason, generation);
		state.covered = reason;
		if (this.inFlight.has(deliveryId)) return;
		this.inFlight.add(deliveryId);
		void Promise.resolve()
			.then(() => {
				// A closed runtime or a switched session has no owner left for this episode.
				if (this.closed || this.deps.getSessionManager() !== manager) return undefined;
				const message = {
					customType: HARNESS_NOTICE_CUSTOM_TYPE,
					display: true,
					content: `Harness notice: ${text}\nThe owner sees this notice directly; mention it only if it bears on what they ask.`,
					details: { kind, reason, generation },
				};
				return this.deps.deliver({
					deliveryId,
					payloadDigest: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
					message,
					origin: captureWorkerReceiptOrigin(manager),
					mode: "next-owner-turn",
				});
			})
			.then(
				() => this.inFlight.delete(deliveryId),
				(error: unknown) => {
					this.inFlight.delete(deliveryId);
					// An unsaved notice leaves its episode open: the capability's next signal tries it again. The attempt's own
					// foreground release notifies synchronously, while this attempt still covers the reason, so that echo
					// starts nothing; a branch navigation during a busy turn is the usual cause.
					if (state.covered === reason && state.observed === reason) {
						state.covered = undefined;
						state.unsaved = true;
					}
					if (!this.closed) this.report(kind, error);
				},
			);
	}

	private report(kind: HarnessNoticeKind, error: unknown): void {
		const detail = boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error));
		try {
			this.deps.warn(`A harness notice (${kind}) was not saved${detail ? `: ${detail}` : "."}`);
		} catch {
			// A diagnostic never fails the capability that observed the state.
		}
	}
}
