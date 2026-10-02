/**
 * The session's bindings for the operation gate's durable side: the decision ledger holds the effect
 * readings and every gate decision. Kept out of the session class; the gate itself knows no ledger.
 */

import type { ToolCallStartContext } from "@caupulican/pi-agent-core/types";
import type { DecisionLedgerStore } from "../operator-projection/decision-ledger-store.ts";
import type { OperationEffectDurableStore } from "./operation-effect-cache.ts";
import type { OperationGate, OperationGateDecisionRecord } from "./operation-gate.ts";

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
				write: (cacheKey, model, readings, now) => ledger.writeOperationEffects(cacheKey, model, readings, now),
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
	signal?: AbortSignal,
): void {
	gate.prewarm(
		calls.map((call) => ({
			toolName: call.toolName,
			args: call.args,
			cwd: call.executionContext?.cwd ?? defaultCwd,
		})),
		signal,
	);
}
