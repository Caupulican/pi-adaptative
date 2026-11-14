/**
 * What a session's routine scheduler does with routine work whose origin can never pass in that session
 * (`routine-origin-reach.ts`): a pending result is settled undeliverable in place of its delivery, and a routine whose own
 * saved origin is lost is handed to the store, which cancels its undispatched runs (none could ever be dispatched) and
 * retires it once none of its dispatched runs still runs or waits for delivery. The owner is told
 * by the session's notices, read from the markers and records these writes leave (`routine-state-notices.ts`).
 *
 * A session that was deleted never opens again to settle its own: the main session's startup sweep
 * (`session-bundle-retention.ts`) settles, store-wide, the pending results and retires the routines of each session no
 * process holds whose session file is gone and of which no other session file remains (`settleGoneSessionRoutines`).
 */
import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import { MAX_ROUTINE_OCCURRENCES, type RoutineDefinitionView, type RoutineOccurrence } from "./routine-contract.ts";
import { type RoutineOriginLoss, routineUndeliverableMarker, sessionFileGone } from "./routine-origin-reach.ts";
import { routineReceiptOrigin } from "./routine-save-origin.ts";
import type { RoutineStorePort } from "./routine-store-port.ts";

/** The session's result delivery, as settling an undeliverable result reaches it (`RoutineResultDelivery`). */
export interface RoutineOriginSettlementParent {
	/** Why a result addressed to `origin` can never reach this session; undefined while it may still pass. */
	originLoss(origin: WorkerReceiptOrigin): RoutineOriginLoss | undefined;
	/** Consumes the run's native worker notification, as a delivery does once its input is durable. */
	acknowledgeWorkerNotification(occurrence: RoutineOccurrence): void;
}

export interface RoutineOriginSettlementDeps {
	readonly store: Pick<RoutineStorePort, "listPendingRoutineDeliveries" | "acknowledgeRoutineDelivery">;
	readonly parent: RoutineOriginSettlementParent;
	readonly parentSessionId: string;
	now(): number;
}

/**
 * Settles each pending result of the session whose origin can never pass here as a delivery settles it, with an
 * `undeliverable:` marker naming the loss in place of a parent input. A result whose origin may still pass (another
 * branch, not yet durable) keeps waiting, and one `inFlight` (its delivery running) is left to that delivery. Each
 * settlement is one isolated step of the caller's pass (`attempt`).
 */
export function settleUndeliverableResults(
	deps: RoutineOriginSettlementDeps,
	inFlight: (occurrenceId: string) => boolean,
	attempt: (unit: string, step: () => void) => void,
): void {
	const { parent, store } = deps;
	for (const { occurrence, result } of store.listPendingRoutineDeliveries(
		deps.parentSessionId,
		2 * MAX_ROUTINE_OCCURRENCES,
	)) {
		if (inFlight(occurrence.occurrenceId)) continue;
		const loss = parent.originLoss(occurrence.parentOrigin);
		if (!loss) continue;
		attempt(`undeliverable|${occurrence.occurrenceId}`, () => {
			if (result.outcome !== "uncertain") parent.acknowledgeWorkerNotification(occurrence);
			store.acknowledgeRoutineDelivery({
				occurrenceId: occurrence.occurrenceId,
				recipient: result.recipient,
				resultDigest: result.digest,
				deliveryMarker: routineUndeliverableMarker(loss),
				nowMs: deps.now(),
			});
			harnessLog.warn("routines", "a routine result can never be delivered and was settled undeliverable", {
				routineId: occurrence.routineId,
				occurrenceId: occurrence.occurrenceId,
				loss,
			});
		});
	}
}

/**
 * The session routines among `routines` whose own saved origin can never pass where `parent` delivers, with why; none
 * without a parent delivery. The store retires each in one write once its dispatched runs are settled
 * (`retireEndedRoutines`). A routine whose origin is only waiting (another branch, not yet durable) is never among them.
 */
export function lostOriginRoutines(
	routines: readonly RoutineDefinitionView[],
	parent: Pick<RoutineOriginSettlementParent, "originLoss"> | undefined,
): { readonly routineId: string; readonly loss: RoutineOriginLoss }[] {
	if (!parent) return [];
	return routines.flatMap((routine) => {
		const origin = routine.target.kind === "session" ? routineReceiptOrigin(routine) : undefined;
		const loss = origin && parent.originLoss(origin);
		return loss ? [{ routineId: routine.routineId, loss }] : [];
	});
}

export interface GoneSessionSettlementInput {
	readonly store: Pick<
		RoutineStorePort,
		"listRoutineOccurrences" | "acknowledgeRoutineDelivery" | "listRoutines" | "retireEndedRoutines"
	>;
	/** Sessions a process still holds (this one, live or resumable peers): each settles its own results. */
	readonly protectedSessionIds: ReadonlySet<string>;
	/** The session files the agent directory holds for a session id (`<timestamp>_<id>.jsonl` names). */
	sessionFiles(sessionId: string): readonly string[];
	readonly nowMs: number;
	/**
	 * A result or routine written less than this long ago is left: a session whose process is not registered (process tracking off)
	 * or whose first entries are not on disk yet is indistinguishable from a deleted one until it has been quiet that long.
	 */
	readonly quietFloorMs: number;
}

/**
 * Whether no file of session `sessionId` remains: the one `sessionFile` names is provably gone, the agent directory's
 * session files name none for it, and its own directory holds no other. A directory that cannot be read proves nothing.
 */
function sessionGone(sessionId: string, sessionFile: string, known: readonly string[]): boolean {
	if (!sessionFileGone(sessionFile) || known.length > 0) return false;
	try {
		return !readdirSync(dirname(sessionFile)).some((name) => name.endsWith(`_${sessionId}.jsonl`));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** What the startup cleanup did for deleted sessions (`settleGoneSessionRoutines`). */
export interface GoneSessionSettlement {
	/** Pending results settled undeliverable. */
	readonly settledResults: number;
	/** Routines retired as `origin-lost`. */
	readonly retiredRoutines: number;
}

/**
 * Settles, across the store, the routine work of sessions that can never open again (the session file it names gone and
 * no other file of the session left, no process holding it, the work quiet for `quietFloorMs`): each pending result is
 * settled undeliverable with the `session-file-gone` marker its own session would have written, then each routine the
 * session saved is handed to the store's retire write as `origin-lost`, which cancels its runs that never started and
 * removes it once its dispatched runs are settled. Work a session settled or changed meanwhile is left to it.
 */
export function settleGoneSessionRoutines(input: GoneSessionSettlementInput): GoneSessionSettlement {
	const gone = new Map<string, boolean>();
	const isGone = (sessionId: string, sessionFile: string): boolean => {
		const key = `${sessionId}\0${sessionFile}`;
		let known = gone.get(key);
		if (known === undefined) {
			known = sessionGone(sessionId, sessionFile, input.sessionFiles(sessionId));
			gone.set(key, known);
		}
		return known;
	};
	return { settledResults: settleGoneResults(input, isGone), retiredRoutines: retireGoneRoutines(input, isGone) };
}

function settleGoneResults(
	input: GoneSessionSettlementInput,
	isGone: (sessionId: string, sessionFile: string) => boolean,
): number {
	const marker = routineUndeliverableMarker("session-file-gone");
	let settled = 0;
	for (const occurrence of input.store.listRoutineOccurrences({ limit: MAX_ROUTINE_OCCURRENCES })) {
		const { sessionId, sessionFile } = occurrence.parentOrigin;
		if (sessionFile === undefined || input.protectedSessionIds.has(sessionId)) continue;
		if (input.nowMs - occurrence.updatedAt < input.quietFloorMs) continue;
		const results = [occurrence.priorUncertaintyResult, occurrence.result].filter(
			(result) => result?.delivery === "pending" && result.recipient === sessionId,
		);
		if (results.length === 0 || !isGone(sessionId, sessionFile)) continue;
		for (const result of results) {
			if (!result) continue;
			try {
				input.store.acknowledgeRoutineDelivery({
					occurrenceId: occurrence.occurrenceId,
					recipient: sessionId,
					resultDigest: result.digest,
					deliveryMarker: marker,
					nowMs: Math.max(input.nowMs, occurrence.updatedAt),
				});
				settled++;
				harnessLog.warn("routines", "a routine result addressed to a deleted session was settled undeliverable", {
					routineId: occurrence.routineId,
					occurrenceId: occurrence.occurrenceId,
					session: basename(sessionFile),
				});
			} catch (error) {
				harnessLog.warn("routines", "a routine result addressed to a deleted session could not be settled", {
					occurrenceId: occurrence.occurrenceId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return settled;
}

/** Hands each deleted session's routines to the store's retire write as `origin-lost`, one write per session. */
function retireGoneRoutines(
	input: GoneSessionSettlementInput,
	isGone: (sessionId: string, sessionFile: string) => boolean,
): number {
	const bySession = new Map<string, { readonly routineId: string; readonly loss: RoutineOriginLoss }[]>();
	for (const routine of input.store.listRoutines()) {
		const origin = routine.target.kind === "session" ? routineReceiptOrigin(routine) : undefined;
		if (origin?.sessionFile === undefined || routine.target.kind !== "session") continue;
		const sessionId = routine.target.parentSessionId;
		if (origin.sessionId !== sessionId || input.protectedSessionIds.has(sessionId)) continue;
		if (input.nowMs - Date.parse(routine.updatedAt) < input.quietFloorMs) continue;
		if (!isGone(sessionId, origin.sessionFile)) continue;
		const lost = bySession.get(sessionId) ?? [];
		lost.push({ routineId: routine.routineId, loss: "session-file-gone" });
		bySession.set(sessionId, lost);
	}
	let retired = 0;
	for (const [parentSessionId, lostOrigins] of bySession) {
		try {
			const removed = input.store.retireEndedRoutines({ nowMs: input.nowMs, parentSessionId, lostOrigins }).retired;
			retired += removed.length;
			for (const routineId of removed)
				harnessLog.warn("routines", "a routine of a deleted session was removed", { routineId });
		} catch (error) {
			harnessLog.warn("routines", "the routines of a deleted session could not be removed", {
				routineIds: lostOrigins.map((lost) => lost.routineId).join(","),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return retired;
}
