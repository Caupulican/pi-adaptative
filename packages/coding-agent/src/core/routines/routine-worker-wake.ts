/**
 * Waking the worker runtime that armed a watch: the event's text goes to the runtime through the session root's follow-up, a
 * running runtime is steered with it and a finished one is continued with it. The outcome is typed so the caller decides what
 * a refusal means (retry for a while, then tell the session instead) and a runtime that cannot be woken never holds the
 * session's other deliveries.
 */

import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import { workerRuntimeLive } from "./worker-watch-liveness.ts";

/** Longest plan a wake carries to a worker: a worker's steer is an ordinary mailbox message, bounded far below a routine prompt. */
export const WORKER_WAKE_PLAN_CHARS = 600;
/** How long a worker that cannot take a wake is retried before the session is told instead. */
export const WORKER_WAKE_RETRY_MS = 120_000;

export type WorkerWake =
	/** The message is in the worker's mailbox: it steers or starts the runtime once it can take it. */
	| { readonly kind: "sent"; readonly messageId: string }
	/** Nobody to wake: no text, or the runtime was retired, cancelled or is gone. */
	| { readonly kind: "void" }
	/** The runtime did not take it now, in plain words. */
	| { readonly kind: "refused"; readonly reason: string };

/** What waking a runtime reads and asks of the worker runtime. */
export interface WorkerWakeHost {
	snapshot(): Pick<TaskRuntimeProjection, "agents" | "attempts">;
	followUp(
		runtimeId: string,
		text: string,
		idempotencyKey: string,
		origin?: TurnOriginRecord,
	): { messageId: string; skipReason?: string };
}

/** The line a session reads before a watch event its worker armed but could not take: the event is the session's to act on or pass on. */
export function workerUnreachableLine(runtimeId: string, reason: string): string {
	return `Worker ${runtimeId} armed this watch but could not be woken by it (${reason}), so it reaches you instead: act on it, or pass it to the worker yourself.`;
}

/**
 * The line a session reads before a note of the host's about a worker's own calls that asks for action (a subject left
 * unwatched) and that the worker did not take: the arming finished after its attempt stopped reading its mailbox, the
 * attempt ended before taking the note, or its runtime did not take it. A runtime whose attempt ended takes no more notes,
 * since one would start it a new task, so the note is the session's to act on or pass on.
 */
export function workerUntakenNoteLine(runtimeId: string): string {
	return `Worker ${runtimeId} did not take this note of the host's about its calls (its attempt had ended, or it could not take it), so it reaches you instead: act on it, or pass it to the worker yourself.`;
}

/** Sends one wake; `key` makes a redelivery the same message. */
export function wakeWorkerRuntime(
	host: WorkerWakeHost,
	runtimeId: string,
	text: string | undefined,
	key: string,
	origin?: TurnOriginRecord,
): WorkerWake {
	if (text === undefined || !workerRuntimeLive(host.snapshot(), runtimeId)) return { kind: "void" };
	try {
		const sent = host.followUp(runtimeId, text, key, origin);
		// A message id means the message was accepted into the mailbox, even when starting its turn waits for capacity.
		if (sent.messageId !== "") return { kind: "sent", messageId: sent.messageId };
		return { kind: "refused", reason: sent.skipReason ?? "the runtime did not accept it" };
	} catch (error) {
		return {
			kind: "refused",
			reason: boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ?? "refused",
		};
	}
}
