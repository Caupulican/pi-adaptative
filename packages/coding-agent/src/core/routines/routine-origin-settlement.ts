/**
 * What a session's routine scheduler does with routine work whose origin can never pass in that session
 * (`routine-origin-reach.ts`): a pending result is settled undeliverable in place of its delivery, and a routine whose own
 * saved origin is lost is handed to the store, which settles its undispatched runs (none could ever be dispatched) and
 * retires it once none of its dispatched runs still runs or waits for delivery. The owner is told
 * by the session's notices, read from the markers and records these writes leave (`routine-state-notices.ts`).
 */
import { harnessLog } from "../../kernel/harness-log.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import { MAX_ROUTINE_OCCURRENCES, type RoutineDefinitionView, type RoutineOccurrence } from "./routine-contract.ts";
import { type RoutineOriginLoss, routineUndeliverableMarker } from "./routine-origin-reach.ts";
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
 * The session routines among `routines` whose own saved origin can never pass here, with why. The store retires each in
 * one write once its dispatched runs are settled (`retireEndedRoutines`). A routine whose origin is only waiting (another
 * branch, not yet durable) is never among them.
 */
export function lostOriginRoutines(
	routines: readonly RoutineDefinitionView[],
	originLoss: (origin: WorkerReceiptOrigin) => RoutineOriginLoss | undefined,
): { readonly routineId: string; readonly loss: RoutineOriginLoss }[] {
	return routines.flatMap((routine) => {
		const origin = routine.target.kind === "session" ? routineReceiptOrigin(routine) : undefined;
		const loss = origin && originLoss(origin);
		return loss ? [{ routineId: routine.routineId, loss }] : [];
	});
}
