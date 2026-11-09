/**
 * Steer waits over the pending-input queues: which live queues of this process serve a session, how an owner steer that
 * arrives while a wait runs ends that wait, and how long a steer's admission decision may take before the wait returns.
 * The queues register here on construction and unregister when they close; the waits reach them only through `SteerParticipant`.
 */
import type { SteerDecision, SteerWake, WaitStatusEvent } from "./util/wait.ts";

/** The queue surface a steer wait reads: every live `PendingInputQueueController` satisfies it. */
export interface SteerParticipant {
	matchesSessionId(sessionId: string): boolean;
	onSteerQueued(listener: () => void): () => void;
	hasUnreadSteer(): boolean;
	waitForPendingSteerDecision(signal?: AbortSignal, report?: (event: WaitStatusEvent) => void): Promise<SteerDecision>;
}

const activeControllers = new Set<SteerParticipant>();

/** A queue joins the steer waits of this process when it is constructed. */
export function registerSteerParticipant(controller: SteerParticipant): void {
	activeControllers.add(controller);
}

/** A queue leaves the steer waits of this process when it closes. */
export function unregisterSteerParticipant(controller: SteerParticipant): void {
	activeControllers.delete(controller);
}

function sessionControllers(sessionId: string | undefined): SteerParticipant[] {
	return [...activeControllers].filter((controller) => !sessionId || controller.matchesSessionId(sessionId));
}

export function subscribeSessionSteerQueued(sessionId: string | undefined, listener: () => void): () => void {
	const unsubscribes = sessionControllers(sessionId).map((controller) => controller.onSteerQueued(listener));
	return () => {
		for (const unsubscribe of unsubscribes) unsubscribe();
	};
}

/**
 * Lets every undecided steer of the session reach its admission decision, and says how that ended: `timed_out` when
 * any decision outlived its reported deadline, `aborted` when `signal` ended it, else `decided`.
 */
export async function waitForSessionSteerAdmission(
	sessionId: string | undefined,
	signal?: AbortSignal,
	report?: (event: WaitStatusEvent) => void,
): Promise<SteerDecision> {
	let decision: SteerDecision = "decided";
	for (const controller of sessionControllers(sessionId)) {
		const settled = await controller.waitForPendingSteerDecision(signal, report);
		if (settled === "aborted") return "aborted";
		if (settled === "timed_out") decision = "timed_out";
	}
	return decision;
}

/** Abort reason of a wait the owner's queued steer ended: never an abort of the waiter itself. */
export const OWNER_STEER_QUEUED = new Error("The owner queued input while the wait ran.");

/**
 * The owner's steer as a wait's built-in wake (`owner.steer`): a steer queued while the wait runs ends it, a steer
 * already queued and not yet read by the session's model ends it at once, and `settle` lets that steer's admission
 * settle so the waiter's next steering poll already reads it.
 */
export function ownerSteerWake(sessionId: string | undefined, report?: (event: WaitStatusEvent) => void): SteerWake {
	return {
		id: "owner.steer",
		subscribe: (onSteer) => subscribeSessionSteerQueued(sessionId, onSteer),
		pending: () => sessionControllers(sessionId).some((controller) => controller.hasUnreadSteer()),
		settle: (signal) => waitForSessionSteerAdmission(sessionId, signal, report),
	};
}

/**
 * The owner-steer wake for a wait that ends on an abort signal: a steer aborts the returned signal (with
 * `OWNER_STEER_QUEUED`), and `finalize` then settles that steer's admission and returns its decision. An abort of
 * `signal` itself is passed through unchanged and is never a steer: `finalize` returns `undefined` then, as it does
 * when no steer arrived.
 */
export function createSteerAwareWait(
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	report?: (event: WaitStatusEvent) => void,
): { readonly signal: AbortSignal; readonly finalize: () => Promise<SteerDecision | undefined> } {
	const wake = ownerSteerWake(sessionId, report);
	const controller = new AbortController();
	let steered = false;
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) {
		controller.abort(signal.reason);
	} else {
		signal?.addEventListener("abort", onAbort, { once: true });
	}
	const onSteer = (): void => {
		if (controller.signal.aborted) return;
		steered = true;
		controller.abort(OWNER_STEER_QUEUED);
	};
	const unsubscribeSteer = wake.subscribe(onSteer);
	if (wake.pending()) onSteer();
	return {
		signal: controller.signal,
		finalize: async () => {
			unsubscribeSteer();
			signal?.removeEventListener("abort", onAbort);
			if (!steered || signal?.aborted) return undefined;
			return wake.settle ? wake.settle(signal) : "none";
		},
	};
}

/**
 * How long a wait a steer ended lets that steer's admission decide before it returns anyway, reported as `timed_out`.
 * Twice the System One stage deadline (5 s, system-one/controller.ts), so one judgment lands with margin. A decision
 * that takes longer (inputs queued ahead of it are judged first, in order) still ends the wait at this bound; the
 * steer is then read at the first steering poll after its admission, as it would be with no wait at all.
 */
export const STEER_DECISION_DEADLINE_MS = 10_000;
