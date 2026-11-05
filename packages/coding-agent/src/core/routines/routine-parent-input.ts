import { createHash } from "node:crypto";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import type { RoutineDelivery } from "./routine-contract.ts";

/** Host identity is separate from the worker's untrusted summary. */
export function routineParentInput({ occurrence, result }: RoutineDelivery): ParentInputDelivery {
	const message = {
		customType: "routine-completion",
		display: true,
		content: `Routine ${occurrence.routineId} ended: ${result.outcome}.\n${wrapUntrustedText(result.summary, `routine-result:${occurrence.occurrenceId}`, { nonce: result.digest })}\nUse the saved task and this evidence to decide whether the owner needs an update or further work.`,
		details: {
			occurrenceId: occurrence.occurrenceId,
			routineId: occurrence.routineId,
			routineRevision: occurrence.routineRevision,
			outcome: result.outcome,
			resultDigest: result.digest,
		},
	};
	return {
		deliveryId: `routine:${createHash("sha256")
			.update(JSON.stringify([occurrence.occurrenceId, result.digest]))
			.digest("hex")}`,
		payloadDigest: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
		message,
		origin: occurrence.parentOrigin,
	};
}
