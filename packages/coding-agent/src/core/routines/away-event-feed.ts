/**
 * A closed parent's host event feed, held by the away host (the detached daemon) while nobody has the session open, so
 * the parent's event routines are decided while it is closed.
 *
 * - The parent's own event consumer is used: the same consumer id its session uses, over the parent's own task ledger.
 *   The CI journal admits one live activation per consumer; the away host's activation is marked as such, and a
 *   reopening session's claim takes custody back from it. The feed then hands back: its sources stop (a session holds
 *   the consumer, or its ledger refuses them once the session opened) and the supervisor closes it with one report.
 *   The connection state the away host recorded is told once by the reopening session.
 * - Readiness is process-local: the feed's own source lifetime registers, catches up and SEALS before anything is
 *   decided, exactly as a session does. Accepting an event is idempotent per event and consumer, and the ledger
 *   checkpoint is read on every claim, so a handover loses or repeats nothing.
 * - It delivers nothing and writes no transcript: root deliveries stay pending for the session, and a decided attempt
 *   is a pending routine occurrence (`decideAwayEventRoutines`) the away host's claim admits under the away rules, or the
 *   session runs once it opens.
 * - It holds no bundle lease: every ledger append takes bundle admission itself, so the owner can still delete the
 *   closed session; the supervisor closes the feed when the session file is gone.
 * - A source the away host cannot follow (gh missing, unauthenticated, GitHub unreachable) is recorded on the parent's
 *   event routines as their away refusal, once per reason, and cleared when it is followed again.
 */

import { type ReadonlySessionManager, SessionManager } from "../../kernel/session/session-manager.ts";
import { type CiSubject, HostEventError, type HostEventSource } from "../events/host-event-contract.ts";
import { DeliveryLane, HostEventSessionController } from "../events/host-event-session-controller.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import { type WorkerReceiptOrigin, workerReceiptOriginFromValue } from "../orchestration/worker-receipt-origin.ts";
import type { TimerSource } from "../util/timer-port.ts";
import { routineHostEventFeed } from "./routine-scheduler-controller.ts";
import type { RoutineStorePort } from "./routine-store-port.ts";

/** What the away host gives a source factory for one closed parent's checkout. */
export interface AwayEventSourceRequest {
	/** The parent session's working directory, read from its transcript. */
	readonly cwd: string;
	/** Aborted when the feed closes; a factory that fails owns cleanup of what it has not returned. */
	readonly signal: AbortSignal;
	onDiagnostic(message: string): void;
	getSubscribedSubjects(): readonly CiSubject[];
	subscribeSubjects(listener: () => void): () => void;
	/** A source found the parent's consumer held by its session and stopped following. */
	onHeld(): void;
}

/**
 * Builds the event sources a closed parent's checkout has, in the away role: none for a directory without a CI
 * workflow. Injected by the process entry, since core never builds a host source itself.
 */
export type AwayEventSourceFactory = (request: AwayEventSourceRequest) => Promise<readonly HostEventSource[]>;

export interface AwayEventFeedInput {
	readonly agentDir: string;
	readonly parentSessionId: string;
	readonly sessionFile: string;
	readonly timers: TimerSource;
	readonly store: RoutineStorePort;
	readonly sources: AwayEventSourceFactory;
	/** Whether a session holds the parent (the away host's own holds never count): a session open anywhere owns its events. */
	isParentOpen(): boolean;
	/** The parent's event routines the away host may decide now. */
	eventRoutineIds(): readonly string[];
	report(message: string): void;
	/** The parent's session took its events back, so this feed follows nothing more: its owner closes it. */
	handedBack(): void;
}

/** Why a feed did not open: the parent's checkout has no event source the away host can follow. */
export class AwayEventFeedUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AwayEventFeedUnavailable";
	}
}

/** How every away refusal of a source not followed begins; a source followed again clears each one. */
const AWAY_CI_UNFOLLOWED = "the away host reported:";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class AwayEventFeed {
	private readonly input: AwayEventFeedInput;
	private readonly runtime: DurableTaskRuntime;
	private readonly controller: HostEventSessionController;
	private readonly abort = new AbortController();
	private readonly unsubscribe: (() => void)[] = [];
	private sources: readonly HostEventSource[] = [];
	/** Per connection scope, why a source is not followed now; the first one is the routines' away refusal. */
	private readonly waiting = new Map<string, string>();
	/** A source reported a connection change the store does not hold yet. */
	private refusalUnsynced = false;
	private closing: Promise<void> | undefined;
	private handBackSignalled = false;
	/** Decisions run one at a time; a change during one runs exactly one more. */
	private readonly lane = new DeliveryLane(
		async () => this.decideOnce(),
		() => this.closing === undefined,
		(error) => this.input.report(`Event routines of session ${this.input.parentSessionId} away: ${errorText(error)}`),
	);

	private constructor(input: AwayEventFeedInput, runtime: DurableTaskRuntime, origin: WorkerReceiptOrigin) {
		this.input = input;
		this.runtime = runtime;
		const { agentDir, parentSessionId } = input;
		const abort = this.abort;
		// Once the session opened, the ledger is its own: the feed's sink is closed to its sources, which stop.
		const assertCurrent = (): void => {
			if (this.closing) throw new HostEventError("closed", "The away event feed closed.");
			if (input.isParentOpen()) {
				this.handBack();
				throw new HostEventError("closed", "The session opened: its own sources follow its events.");
			}
		};
		this.controller = new HostEventSessionController({
			runtime,
			agentDir,
			sessionId: parentSessionId,
			signal: abort.signal,
			assertCurrent,
			captureOrigin: () => {
				assertCurrent();
				return origin;
			},
			// Delivery belongs to the session: root and task deliveries stay pending until it opens.
			canDeliver: () => false,
			subscribeContext: () => () => {},
			subscribeSettings: () => () => {},
			admitRootDelivery: () => Promise.reject(new Error("A closed session delivers no host event.")),
			rootDelivered: () => {},
			deliverParent: () => Promise.reject(new Error("A closed session delivers no host event.")),
			heldParentInputs: () => [],
			skipParentInput: () => false,
			deliverTask: async () => "dormant",
			reconcileTask: () => {
				throw new Error("A closed session reconciles no task delivery.");
			},
			observeNotice: (kind, read) => {
				const observed = read();
				if (observed === undefined || observed === "clear" || !("scope" in observed)) return;
				if (kind === "host-event-source") this.observeConnection(observed.scope, observed.state);
				else if (observed.state !== "clear")
					// A replay gap and a replaced journal's end are committed in the ledger, and the session tells them when it
					// opens; the daemon's report is the operator's.
					input.report(`Host events of session ${parentSessionId} away: ${observed.state.text}`);
			},
			warn: (message) => input.report(`Host events of session ${parentSessionId} away: ${message}`),
		});
	}

	/**
	 * Opens the feed: the parent's ledger runtime, its consumer and the sources the factory builds for its checkout.
	 * Throws {@link AwayEventFeedUnavailable} when the parent has nothing the away host can follow.
	 */
	static async open(input: AwayEventFeedInput): Promise<AwayEventFeed> {
		const { agentDir, parentSessionId, sessionFile } = input;
		let reader: ReadonlySessionManager;
		try {
			reader = SessionManager.openReadOnly(sessionFile, agentDir);
		} catch (error) {
			throw new AwayEventFeedUnavailable(`its session file cannot be read (${errorText(error)}).`);
		}
		const leafId = reader.getLeafId();
		if (reader.getSessionId() !== parentSessionId || !leafId)
			throw new AwayEventFeedUnavailable("its pinned session file holds no transcript of this session.");
		// Accepted events anchor at the closed transcript's leaf; nothing appends to it while the session is closed.
		const origin = Object.freeze(workerReceiptOriginFromValue({ sessionId: parentSessionId, sessionFile, leafId }));
		const clock = input.timers.port("orchestration");
		const runtime = new DurableTaskRuntime({
			store: new OrchestrationEventStore({
				agentDir: input.agentDir,
				sessionId: input.parentSessionId,
				now: () => new Date(clock.now()).toISOString(),
				sleepSync: (delayMs) => input.timers.sleepSync(delayMs),
			}),
			now: () => clock.now(),
		});
		const feed = new AwayEventFeed(input, runtime, origin);
		const { signal } = feed.abort;
		try {
			feed.sources = await input.sources({
				cwd: reader.getCwd(),
				signal,
				onDiagnostic: (message) => input.report(`Host events of session ${parentSessionId} away: ${message}`),
				getSubscribedSubjects: () => runtime.hostEvents.subscribedSubjects(),
				subscribeSubjects: (listener) => runtime.hostEvents.subscribe(listener),
				onHeld: () => feed.handBack(),
			});
			if (feed.sources.length === 0)
				throw new AwayEventFeedUnavailable("its project has no CI workflow the away host can follow.");
			feed.unsubscribe.push(
				runtime.hostEvents.subscribe(() => feed.lane.request()),
				input.store.subscribe(() => feed.lane.request()),
			);
			for (const source of feed.sources) {
				signal.throwIfAborted();
				await source.start(feed.controller.sink);
			}
			feed.lane.request();
			return feed;
		} catch (error) {
			await feed.close();
			throw error;
		}
	}

	isClosed(): boolean {
		return this.closing !== undefined;
	}

	/** Whether the parent's session took its events back from this feed (it follows nothing more). */
	isHandedBack(): boolean {
		return this.handBackSignalled;
	}

	/** Signalled once, past the caller's stack: a source or a ledger call is never re-entered by the owner's close. */
	private handBack(): void {
		if (this.handBackSignalled || this.closing) return;
		this.handBackSignalled = true;
		queueMicrotask(() => this.input.handedBack());
	}

	/** Stops the sources (parking the consumer for the session), fences the consumer and joins the last decision. */
	close(): Promise<void> {
		this.closing ??= (async () => {
			for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
			this.abort.abort(new Error("The away event feed closed."));
			const stopped = await Promise.allSettled(this.sources.map((source) => source.stop()));
			await this.controller.close();
			await this.lane.settled();
			const failed = stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			if (failed.length > 0) throw new AggregateError(failed, "The away event feed's sources did not stop.");
		})();
		return this.closing;
	}

	/** One decision pass: the refusal state a source reported, then the event routines against the sealed events. */
	private decideOnce(): void {
		const { input } = this;
		const routineIds = input.eventRoutineIds();
		if (routineIds.length === 0) return;
		if (input.isParentOpen()) {
			this.handBack();
			return;
		}
		const nowMs = input.timers.port("routines").now();
		try {
			if (this.refusalUnsynced) {
				// A refusal an earlier daemon recorded is cleared too: a source following again ends every one.
				const waiting = [...this.waiting.values()][0];
				if (waiting === undefined)
					input.store.clearRoutineAwayRefusals({ routineIds, reasonPrefix: AWAY_CI_UNFOLLOWED });
				else
					input.store.recordRoutineAwayRefusals({
						refusals: routineIds.map((routineId) => ({ routineId, reason: waiting })),
						nowMs,
					});
				this.refusalUnsynced = false;
			}
			// Readiness is this process's own: an event no source of this feed sealed stays undecided.
			input.store.decideAwayEventRoutines({
				nowMs,
				parentSessionId: input.parentSessionId,
				routineIds,
				hostEvents: routineHostEventFeed(this.runtime.getSnapshot(), (sourceId) =>
					this.runtime.hostEvents.isSourceReady(sourceId),
				),
			});
		} catch (error) {
			// Another writer holds the store: its save notifies this feed again.
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ELOCKED") return;
			input.report(`Event routines of session ${input.parentSessionId} were not decided away: ${errorText(error)}`);
		}
	}

	/** A source's connection away is the refusal of the parent's event routines while it lasts. */
	private observeConnection(scope: string, state: { readonly reason: string; readonly text: string } | "clear"): void {
		const { input } = this;
		const previous = this.waiting.get(scope);
		if (state === "clear") {
			this.waiting.delete(scope);
			if (previous !== undefined)
				input.report(`CI results of session ${input.parentSessionId} are followed away again.`);
		} else {
			const reason = `${AWAY_CI_UNFOLLOWED} ${state.text} Until then it waits for the session to open.`;
			if (previous === reason) return;
			this.waiting.set(scope, reason);
			input.report(`Event routines of session ${input.parentSessionId} were not run away: ${reason}`);
		}
		this.refusalUnsynced = true;
		this.lane.request();
	}
}
