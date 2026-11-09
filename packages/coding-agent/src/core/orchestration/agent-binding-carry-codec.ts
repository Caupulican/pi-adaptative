/**
 * Decoding of an agent binding's context origin and retention carry (`prunedTurns`). The codecs module passes in the
 * identifier and dispatch readers it owns, so this module never imports it and no import cycle forms.
 */

import { parseTurnOriginRecord, type TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import { parseBoundedStringArray } from "./bounded-string-array.ts";
import {
	type AgentBindingContract,
	type AgentPrunedTurns,
	ATTEMPT_STATUSES,
	type AttemptStatus,
	type OrchestrationDispatchRequest,
} from "./contracts.ts";
import { exactRecord } from "./task-runtime-projection.ts";
import { DurableTaskRuntimeError } from "./task-runtime-state.ts";

/** The codec-owned readers a carry needs. */
export interface AgentBindingCarryDecoders {
	readonly identifier: (value: unknown, label: string) => string;
	readonly dispatch: (value: unknown, label: string) => OrchestrationDispatchRequest;
	/** The third-party origin a released turn admitted; a non-third-party origin is never carried this way. */
	readonly conversationTurnOrigin: (value: unknown, label: string) => TurnOriginRecord;
}

/** The immutable birth provenance of an agent binding; absent when the binding has none. */
export function contextOriginFromValue(
	value: unknown,
	label: string,
	identifier: AgentBindingCarryDecoders["identifier"],
): AgentBindingContract["contextOrigin"] | undefined {
	if (value === undefined) return undefined;
	const origin = exactRecord(value, label, ["parentSessionId", "logicalAgentId"]);
	return {
		parentSessionId: identifier(origin.parentSessionId, `${label}.parentSessionId`),
		logicalAgentId: identifier(origin.logicalAgentId, `${label}.logicalAgentId`),
	};
}

/** The carry of an agent binding whose turns retention released; absent when none were released. */
export function optionalPrunedTurns(
	value: unknown,
	label: string,
	decode: AgentBindingCarryDecoders,
): { prunedTurns?: AgentPrunedTurns } {
	if (value === undefined) return {};
	const carry = exactRecord(value, label, ["count", "conversationTurnOrigin", "last"]);
	if (typeof carry.count !== "number" || !Number.isSafeInteger(carry.count) || carry.count < 0) {
		throw new DurableTaskRuntimeError(`${label}.count is invalid.`);
	}
	const conversationTurnOrigin =
		carry.conversationTurnOrigin === undefined
			? undefined
			: decode.conversationTurnOrigin(carry.conversationTurnOrigin, `${label}.conversationTurnOrigin`);
	const last = carry.last === undefined ? undefined : lastPrunedTurnFromValue(carry.last, `${label}.last`, decode);
	return {
		prunedTurns: {
			count: carry.count,
			...(conversationTurnOrigin ? { conversationTurnOrigin } : {}),
			...(last ? { last } : {}),
		},
	};
}

function lastPrunedTurnFromValue(
	value: unknown,
	label: string,
	decode: AgentBindingCarryDecoders,
): NonNullable<AgentPrunedTurns["last"]> {
	const last = exactRecord(value, label, [
		"attemptId",
		"taskId",
		"objectiveId",
		"status",
		"ownTurnOrigin",
		"acceptanceCriterionIds",
		"dispatch",
	]);
	const status = decode.identifier(last.status, `${label}.status`);
	if (!ATTEMPT_STATUSES.some((candidate) => candidate === status)) {
		throw new DurableTaskRuntimeError(`${label}.status is invalid.`);
	}
	// Absent in a carry written before the basis carried its criteria, which reads as none. The bounds match the task's own
	// id list (`dispatchIdentifierArray` in task-runtime-codecs.ts), which this module cannot import.
	const acceptanceCriterionIds =
		last.acceptanceCriterionIds === undefined
			? []
			: parseBoundedStringArray(last.acceptanceCriterionIds, {
					invalidMessage: `${label}.acceptanceCriterionIds must be a bounded identifier array.`,
					duplicateMessage: `${label}.acceptanceCriterionIds contains duplicates.`,
					createError: (message) => new DurableTaskRuntimeError(message),
				});
	// attemptTurnOrigin(last): usually the dispatch's own origin, which is not third-party, so the generic parser applies.
	let ownTurnOrigin: TurnOriginRecord | undefined;
	if (last.ownTurnOrigin !== undefined) {
		ownTurnOrigin = parseTurnOriginRecord(last.ownTurnOrigin) ?? undefined;
		if (!ownTurnOrigin) throw new DurableTaskRuntimeError(`${label}.ownTurnOrigin is invalid.`);
	}
	return {
		attemptId: decode.identifier(last.attemptId, `${label}.attemptId`),
		taskId: decode.identifier(last.taskId, `${label}.taskId`),
		objectiveId: decode.identifier(last.objectiveId, `${label}.objectiveId`),
		status: status as AttemptStatus,
		...(ownTurnOrigin ? { ownTurnOrigin } : {}),
		acceptanceCriterionIds,
		dispatch: decode.dispatch(last.dispatch, `${label}.dispatch`),
	};
}
