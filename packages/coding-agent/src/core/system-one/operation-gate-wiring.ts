/**
 * The session's bindings for the operation gate's durable side: the decision ledger holds the effect
 * readings and every gate decision. Kept out of the session class; the gate itself knows no ledger.
 */

import type { ToolCallStartContext } from "../../kernel/index.ts";
import { type EdgeGrantView, isEdgeOperationGranted } from "../autonomy/edge-policy.ts";
import type { DecisionLedgerStore } from "../operator-projection/decision-ledger-store.ts";
import type { OperationEffectDurableStore } from "./operation-effect-cache.ts";
import {
	type OperationCaller,
	OperationGate,
	type OperationGateDecisionRecord,
	type OperationGateDeps,
} from "./operation-gate.ts";

/**
 * A session's operation gate: standing authority is the branch's `operation.irreversible` grant, and the ledger keeps
 * effect readings and decisions. Its inputs are readers plus `notify`, so a parent opened away builds the same gate for
 * its workers; owner-word settling and the operator question are the foreground's, and a worker never reaches the latter.
 */
export function createSessionOperationGate(
	input: Pick<
		OperationGateDeps,
		"getEngine" | "getRequest" | "getTurnKey" | "notify" | "settleOwnerPolicy" | "askOperator"
	> & {
		getCwd(): string;
		getSessionId(): string;
		getLedger(): DecisionLedgerStore | undefined;
		/** The session's grants, or with `standingOnly` the owner's standing grants alone. */
		getEdgeGrants(standingOnly: boolean): readonly EdgeGrantView[];
	},
): OperationGate {
	const { settleOwnerPolicy, askOperator } = input;
	return new OperationGate({
		...(settleOwnerPolicy ? { settleOwnerPolicy: (signal?: AbortSignal) => settleOwnerPolicy(signal) } : {}),
		getEngine: () => input.getEngine(),
		getRequest: () => input.getRequest(),
		getScopeCwd: () => input.getCwd(),
		getTurnKey: () => input.getTurnKey(),
		isGranted: (standingOnly) =>
			isEdgeOperationGranted(
				{ class: "operation.irreversible", operation: "", reason: "" },
				input.getEdgeGrants(standingOnly),
			),
		...(askOperator ? { askOperator } : {}),
		notify: (message) => input.notify(message),
		...operationGateLedgerBindings(input),
	});
}

export function operationGateLedgerBindings(input: {
	getLedger(): DecisionLedgerStore | undefined;
	getSessionId(): string;
	getCwd(): string;
}): {
	getEffectStore(): OperationEffectDurableStore | undefined;
	recordDecision(decision: OperationGateDecisionRecord): void;
} {
	return {
		getEffectStore() {
			const ledger = input.getLedger();
			if (!ledger) return undefined;
			return {
				read: (cacheKey, notBefore) => ledger.readOperationEffects(cacheKey, notBefore),
				write: (cacheKey, model, readings, now) =>
					ledger.writeOperationEffects(cacheKey, model, readings, now, input.getSessionId()),
			};
		},
		recordDecision(decision) {
			input.getLedger()?.recordOperationGateDecision({
				sessionId: input.getSessionId(),
				cwd: input.getCwd(),
				decidedAt: Date.now(),
				...decision,
			});
		},
	};
}

/** Judges the calls of one assistant message ahead of their gate checks (see {@link OperationGate.prewarm}). */
export function prewarmOperationGate(
	gate: OperationGate,
	calls: readonly ToolCallStartContext[],
	defaultCwd: string,
	caller: OperationCaller,
	signal?: AbortSignal,
): void {
	gate.prewarm(
		calls.map((call) => ({
			toolName: call.toolName,
			args: call.args,
			cwd: call.executionContext?.cwd ?? defaultCwd,
		})),
		caller,
		signal,
	);
}
