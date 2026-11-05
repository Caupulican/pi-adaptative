import { createHash } from "node:crypto";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import type { RoutineDelivery } from "./routine-contract.ts";

const ROUTINE_COMPLETION_TYPE = "routine-completion";

/**
 * Host identity is separate from the worker's untrusted summary. The delivery mode comes only from the persisted
 * result, so a redelivery after restart presents the same identity: a quiet result rides with the owner's next turn,
 * every other outcome starts a parent turn.
 */
export function routineParentInput({ occurrence, result }: RoutineDelivery): ParentInputDelivery {
	const quiet = result.ownerUpdate === "none";
	const evidence = wrapUntrustedText(result.summary, `routine-result:${occurrence.occurrenceId}`, {
		nonce: result.digest,
	});
	const message = {
		customType: ROUTINE_COMPLETION_TYPE,
		display: true,
		content: quiet
			? `Routine ${occurrence.routineId} ended: succeeded with nothing for the owner.\n${evidence}\nNo owner update is needed; mention it only if it bears on what the owner asks next. Later quiet runs before the owner's next turn are recorded but not delivered.`
			: `Routine ${occurrence.routineId} ended: ${result.outcome}.\n${evidence}\nUse the saved task and this evidence to decide whether the owner needs an update or further work.`,
		details: {
			occurrenceId: occurrence.occurrenceId,
			routineId: occurrence.routineId,
			routineRevision: occurrence.routineRevision,
			outcome: result.outcome,
			resultDigest: result.digest,
			...(quiet ? { ownerUpdate: "none" as const } : {}),
		},
	};
	return {
		deliveryId: `routine:${createHash("sha256")
			.update(JSON.stringify([occurrence.occurrenceId, result.digest]))
			.digest("hex")}`,
		payloadDigest: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
		message,
		origin: occurrence.parentOrigin,
		...(quiet ? { mode: "next-owner-turn" as const } : {}),
	};
}

/** Whether a canonical parent input is a quiet result of this routine, still carried for the owner's next turn. */
export function isQuietRoutineCompletion(entry: SessionEntry | undefined, routineId: string): boolean {
	if (entry?.type !== "custom_message" || entry.customType !== ROUTINE_COMPLETION_TYPE) return false;
	const details: unknown = entry.details;
	return (
		typeof details === "object" &&
		details !== null &&
		"routineId" in details &&
		details.routineId === routineId &&
		"ownerUpdate" in details &&
		details.ownerUpdate === "none"
	);
}
