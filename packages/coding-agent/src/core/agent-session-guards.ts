/**
 * Guard handlers the agent loop fires into the session: a runaway stop (a bounded harness guard
 * ended a run) and a tool-validation escalation (repeated identical validation failures). They
 * were private methods of the session coordinator; they live here as functions over a small
 * dependency surface so the coordinator only wires them (decomposition ratchet: the coordinator's
 * line ceiling only ever moves down).
 */

import type { AgentRunawayStopInfo, ToolValidationEscalationEvent } from "@caupulican/pi-agent-core";
import type { Api, Model } from "@caupulican/pi-ai";
import {
	RUNAWAY_STOP_CUSTOM_TYPE,
	type RunawayStopRecord,
	TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE,
	type ToolValidationEscalationRecord,
} from "./agent-session-contracts.ts";
import type { CapabilityTierDemotion } from "./capability-tier.ts";

export interface SessionGuardDeps {
	getModel(): Model<Api> | undefined;
	/** The adaptation-store key for a model. */
	formatModel(model: Model<Api>): string;
	appendCustomEntry(customType: string, record: unknown): void;
	/** Goal recovery after a guard: true when a durable goal stays active and will continue. */
	recoverGoalFromHarnessGuard(info: AgentRunawayStopInfo): boolean;
	/** Persist the graded demotion evidence for this model. */
	setCapabilityTierDemotion(modelKey: string, demotion: CapabilityTierDemotion): void;
	/** Re-read the tier policy after a demotion and apply what changes per turn. */
	refreshCapabilityTierPolicy(): void;
	sendNextTurnMessage(customType: string, content: string, details: unknown): void;
	emitWarning(message: string): void;
	/** Local/managed models get the evidence-gated native-to-phone auto-probe. */
	findModel(provider: string, modelId: string): Model<Api> | undefined;
	isLocalOrManagedModel(model: Model<Api>): boolean;
	maybeAutoProbe(model: Model<Api>): void;
	requestValidationFailureEscalation(): void;
}

/** Persist the guard evidence, retain active work, and force the next pass onto a recovery path. */
export function handleRunawayStop(deps: SessionGuardDeps, info: AgentRunawayStopInfo): void {
	const goalRecovered = deps.recoverGoalFromHarnessGuard(info);
	const model = deps.getModel();
	const record: RunawayStopRecord = {
		reason: info.reason,
		signature: info.signature,
		repeats: info.repeats,
		model: model?.id,
		provider: model?.provider,
		at: new Date().toISOString(),
	};
	deps.appendCustomEntry(RUNAWAY_STOP_CUSTOM_TYPE, record);
	// Graded evidence: a runaway on this model demotes it to the strong tier (tighter caps and
	// guards, aliasing still gated by saving) until thirty days pass without another one.
	if (model) {
		deps.setCapabilityTierDemotion(deps.formatModel(model), {
			tier: "strong",
			reason: `runaway_stop:${info.reason}`,
			at: record.at,
		});
		deps.refreshCapabilityTierPolicy();
	}
	if (goalRecovered) {
		deps.sendNextTurnMessage(
			"runaway-recovery",
			info.reason === "stagnant_tool_cycle"
				? "A bounded harness guard ended an unchanged tool-result cycle, but the durable goal remains active and must continue automatically. Reuse the latest returned state; do not call the same status/read cycle again. Execute an available state-changing or finalization action, wait once on the true dependency, or record a concrete blocker."
				: "A bounded harness guard ended the previous agent loop, but the durable goal remains active and must continue automatically. Do not repeat the same failed operation unchanged. Inspect the recorded failure, change tool or approach, and keep working unless evidence proves a true owner/approval boundary.",
			info,
		);
	}
	const cause =
		info.reason === "provider_turn_limit"
			? `the configured provider-turn limit of ${info.repeats} requests was reached`
			: info.reason === "stagnant_tool_cycle"
				? `the same tool-call cycle returned identical results ${info.repeats} times`
				: `the model repeated the same tool call ${info.repeats} times in a row without making progress`;
	deps.emitWarning(
		`Bounded guard ended this run: ${cause}.${goalRecovered ? " The active goal remains scheduled; the next pass must use a different approach." : ""}`,
	);
}

/**
 * A repeated identical tool-argument-validation failure crossed the escalation threshold, the
 * graded evidence the capability-gate spine acts on. Always records a session-log entry, then
 * branches on the failing model's class: a local or managed model gets the evidence-gated
 * native-to-phone auto-probe (off the hot path, never awaited); a cloud model asks the router for
 * a validation-failure escalation.
 */
export function handleToolValidationEscalation(deps: SessionGuardDeps, event: ToolValidationEscalationEvent): void {
	const record: ToolValidationEscalationRecord = {
		tool: event.tool,
		signature: event.signature,
		repeats: event.repeats,
		model: event.model,
		provider: event.provider,
		at: new Date().toISOString(),
	};
	deps.appendCustomEntry(TOOL_VALIDATION_ESCALATION_CUSTOM_TYPE, record);

	const model = deps.findModel(event.provider, event.model);
	if (model && deps.isLocalOrManagedModel(model)) {
		deps.maybeAutoProbe(model);
		return;
	}
	deps.requestValidationFailureEscalation();
}
