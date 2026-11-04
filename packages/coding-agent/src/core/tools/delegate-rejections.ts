/**
 * The refusals of the `delegate` tool as machine records.
 *
 * Every refusal is a `CommsErrRecord`: an error class, the input field, a short reason and a hint code. The
 * retry guidance that used to ride in each message now lives in the hint glossary of the root prompt, so
 * the record names the hint and the message states only the fact. Start refusals are keyed by the host's
 * `skipReason` code; a skip reason that carries a value (`code:value`) is split at its first colon.
 */

import { type CommsErrRecord, commsErr } from "../comms/comms-records.ts";
import { laneWorkerRefusalSkipRemedy } from "../model-capability.ts";
import type { CommsErrCode, CommsHintCode } from "../provider-prompt-contracts.ts";

interface RejectionShape {
	readonly c: CommsErrCode;
	readonly f?: string;
	readonly h?: CommsHintCode;
}

/** How a dispatch-level skip reason maps to an error class, field and hint. A reason absent here is a state refusal. */
const DELEGATE_REJECTION_SHAPES: Readonly<Record<string, RejectionShape>> = {
	invalid_action: { c: "E_FIELD", f: "action" },
	action_unavailable: { c: "E_STATE", f: "action" },
	action_field_forbidden: { c: "E_FIELD", h: "DROP_FIELD" },
	profile_budget_forbidden: { c: "E_AUTH", f: "budget", h: "DROP_FIELD" },
	reply_action_required: { c: "E_FIELD", f: "replyToMessageId", h: "DROP_FIELD" },
	reply_target_forbidden: { c: "E_FIELD", h: "DROP_FIELD" },
	worker_parallel_intent_invalid: { c: "E_FIELD", f: "parallelWork" },
	agent_ids_invalid: { c: "E_FIELD", f: "agentIds" },
	dependency_ids_invalid: { c: "E_FIELD", f: "dependsOn" },
	wait_mode_invalid: { c: "E_FIELD", f: "mode" },
	instructions_too_long: { c: "E_LIMIT", f: "instructions", h: "NARROW" },
	profile_id_too_long: { c: "E_LIMIT", f: "profileId", h: "NARROW" },
	agent_id_too_long: { c: "E_LIMIT", f: "agentId", h: "NARROW" },
	message_too_long: { c: "E_LIMIT", f: "message", h: "NARROW" },
	control_id_invalid: { c: "E_FIELD" },
	ack_token_invalid: { c: "E_FIELD", f: "ackToken" },
	cursor_invalid: { c: "E_FIELD", f: "cursor" },
	page_size_invalid: { c: "E_FIELD", f: "maxMessages" },
	timeout_invalid: { c: "E_FIELD", f: "timeoutMs" },
	cursor_out_of_range: { c: "E_LIMIT", f: "cursor" },
	root_only_action: { c: "E_STATE", f: "action" },
	worker_only_action: { c: "E_STATE", f: "action" },
	worker_status_unavailable: { c: "E_STATE", f: "action" },
	profile_management_unavailable: { c: "E_STATE", f: "action" },
	worker_agent_control_unavailable: { c: "E_STATE", f: "action" },
	message_replay_scope_unavailable: { c: "E_STATE", f: "action" },
	worker_agent_lane_missing: { c: "E_REF", f: "agentId", h: "USE_ID" },
	missing_ack_identity: { c: "E_FIELD", f: "messageId" },
	missing_reply_fields: { c: "E_FIELD", f: "message" },
	missing_agent_ids: { c: "E_FIELD", f: "agentIds" },
	missing_wait_mode: { c: "E_FIELD", f: "mode" },
	missing_message: { c: "E_FIELD", f: "message" },
	missing_agent_id: { c: "E_FIELD", f: "agentId" },
	missing_instructions: { c: "E_FIELD", f: "instructions" },
	goal_instructions_conflict: { c: "E_FIELD", f: "instructions", h: "DROP_FIELD" },
	brief_requires_goal: { c: "E_FIELD", h: "DROP_FIELD" },
	goal_invalid: { c: "E_FIELD", f: "goal" },
	note_invalid: { c: "E_FIELD", f: "note" },
	refs_invalid: { c: "E_FIELD", f: "refs" },
	goal_too_long: { c: "E_LIMIT", f: "goal", h: "NARROW" },
	note_too_long: { c: "E_LIMIT", f: "note", h: "NARROW" },
	refs_too_long: { c: "E_LIMIT", f: "refs", h: "NARROW" },
	worker_transcript_envelope_exceeded: { c: "E_LIMIT", f: "maxMessages", h: "NARROW" },
	fanout_agent_id_conflict: { c: "E_FIELD", f: "agentId", h: "DROP_FIELD" },
	read_only_tool_conflict: { c: "E_FIELD", f: "toolNames", h: "DROP_FIELD" },
	fanout_unavailable: { c: "E_STATE", f: "slices" },
};

export interface RejectionOverrides {
	readonly c?: CommsErrCode;
	readonly f?: string;
	readonly h?: CommsHintCode;
	readonly x?: string;
}

/** The refusal record for a dispatch-level `skipReason`, with its reason stated in `message`. */
export function delegateRejection(
	skipReason: string | undefined,
	message: string,
	overrides: RejectionOverrides = {},
): CommsErrRecord {
	const shape = (skipReason ? DELEGATE_REJECTION_SHAPES[skipReason] : undefined) ?? { c: "E_STATE" as const };
	const f = overrides.f ?? shape.f;
	const h = overrides.h ?? shape.h;
	return commsErr({
		c: overrides.c ?? shape.c,
		m: message,
		...(f ? { f } : {}),
		...(h ? { h } : {}),
		...(overrides.x ? { x: overrides.x } : {}),
	});
}

/** A failed release holds the specialist; `retained` says whether the host retries it. */
export interface SpecialistReleaseHold {
	readonly retained: boolean;
	readonly agentId: string;
	readonly cause: string;
}

const RELEASE_RETAINED_PREFIX = "worker_specialist_release_retained:";
const RELEASE_ABANDONED_PREFIX = "worker_specialist_release_abandoned:";

/** The failed release that holds a specialist, read back from its `specialistReleaseSkipReason` code. */
export function parseSpecialistReleaseHold(reason: string | undefined): SpecialistReleaseHold | undefined {
	if (reason === undefined) return undefined;
	const retained = reason.startsWith(RELEASE_RETAINED_PREFIX);
	if (!retained && !reason.startsWith(RELEASE_ABANDONED_PREFIX)) return undefined;
	const rest = reason.slice((retained ? RELEASE_RETAINED_PREFIX : RELEASE_ABANDONED_PREFIX).length);
	const separator = rest.indexOf(":");
	return {
		retained,
		agentId: separator < 0 ? rest : rest.slice(0, separator),
		cause: separator < 0 ? "" : rest.slice(separator + 1),
	};
}

/** A start refused because a failed release holds the specialist: the fact, the cause, then the next action. */
function specialistReleaseHoldRejection(hold: SpecialistReleaseHold): CommsErrRecord {
	const { agentId } = hold;
	const cause = hold.cause ? ` Cause: ${hold.cause}.` : "";
	return commsErr({
		c: "E_STATE",
		f: "agentId",
		h: "WAIT",
		x: agentId,
		m: hold.retained
			? `${agentId} finished its run but its resource release failed; the host retries it.${cause} Next: follow_up to ${agentId} (queued until released) or parallelWork { independentOf: [${agentId}], justification }.`
			: `${agentId} finished its run but its resource release failed; nothing retries it this session.${cause} Next: parallelWork { independentOf: [${agentId}], justification } if independent, or report it to the user.`,
	});
}

/**
 * The specialist's own state refused the start: it is still running, or a failed release holds it. The call was
 * right and the host decided it, so the refusal is an operation outcome the model reads, not a failure record.
 */
export function isSpecialistStateRefusal(reason: string | undefined): boolean {
	return reason === "worker_specialist_busy" || parseSpecialistReleaseHold(reason) !== undefined;
}

const DUPLICATE_OF_PREFIX = "worker_duplicate_of:";
const PIN_UNAVAILABLE_MARKER = "worker_model_pin_unavailable:";
const PIN_CONFLICT_MARKER = "worker_model_pin_conflict:";
const MODEL_NOT_ALLOWED_PREFIX = "worker_model_not_allowed:";
const MODEL_UNAVAILABLE_PREFIX = "orchestration_model_unavailable:";
const PROFILE_MODEL_UNAVAILABLE_PREFIX = "orchestration_profile_model_unavailable:";
const CHOICE_REQUIRED_PREFIX = "worker_specialist_choice_required";
const TOOL_UNAVAILABLE_PREFIX = "orchestration_tool_unavailable:";
const TOOL_CAPABILITY_MISSING_PREFIX = "orchestration_tool_capability_missing:";

/** The refusal record for a `delegate start` the host skipped, keyed by its `skipReason` code. */
export function delegateStartRejection(reason: string): CommsErrRecord {
	if (reason.startsWith(DUPLICATE_OF_PREFIX)) {
		const laneId = reason.slice(DUPLICATE_OF_PREFIX.length);
		return commsErr({
			c: "E_DUP",
			f: "instructions",
			h: "WAIT",
			x: laneId,
			m: `${laneId} is already running these same instructions; no second copy started. Use wait, status or transcript on it. To run the task twice on purpose, change the instructions to say what differs (scope, model, angle).`,
		});
	}
	if (reason === "worker_model_pins_invalid") {
		return commsErr({
			c: "E_STATE",
			f: "model",
			h: "ASK_OWNER",
			m: "worker_model_pins_invalid: owner configuration error; fresh workers are blocked. The owner must repair workerDelegation.modelPins.",
		});
	}
	if (reason.includes(PIN_UNAVAILABLE_MARKER)) {
		return commsErr({
			c: "E_STATE",
			f: "model",
			h: "ASK_OWNER",
			x: reason,
			m: "The owner-pinned model cannot be used; fail closed. Report the role so the owner can repair availability or configuration.",
		});
	}
	if (reason.includes(PIN_CONFLICT_MARKER)) {
		return commsErr({
			c: "E_AUTH",
			f: "model",
			h: "ASK_OWNER",
			x: reason,
			m: "The explicit model or thinking request conflicts with an owner pin; no different model started. Report the role so the owner can change the request or the policy.",
		});
	}
	if (reason.startsWith(MODEL_NOT_ALLOWED_PREFIX)) {
		return commsErr({
			c: "E_AUTH",
			f: "model",
			h: "ASK_OWNER",
			x: reason,
			m: "The requested model is outside the owner's model policy or favorite pool; no different model started. Report the model so the owner can pin it as a favorite, allow its provider, or choose a pooled model.",
		});
	}
	if (reason === "orchestration_profile_not_found") {
		return commsErr({
			c: "E_REF",
			f: "profileId",
			h: "RETRY_OMIT",
			m: "orchestration_profile_not_found: unknown profile. Omit profileId for adaptive authority or use an exact listed profile; never invent profile ids.",
		});
	}
	// The reason names each refusal cause, for example model_not_found or model_account_unlisted.
	if (reason.startsWith(MODEL_UNAVAILABLE_PREFIX)) {
		return commsErr({
			c: "E_REF",
			f: "model",
			h: "RETRY_OMIT",
			x: reason,
			m: "Routing refusal. Omit model to inherit, or name an exact listed model with configured credentials that supports the requested thinkingLevel; a thinking_level_unsupported(levels) refusal lists the accepted levels. Never invent model ids.",
		});
	}
	if (reason.startsWith(PROFILE_MODEL_UNAVAILABLE_PREFIX)) {
		return commsErr({
			c: "E_REF",
			f: "profileId",
			h: "RETRY_OMIT",
			x: reason,
			m: "Routing refusal. Omit profileId for adaptive authority, or select a listed preset whose model has configured credentials and is available.",
		});
	}
	if (reason === "worker_agent_session_limit_reached") {
		return commsErr({
			c: "E_LIMIT",
			h: "REUSE",
			m: "worker_agent_session_limit_reached: expected policy capacity, not instability.",
		});
	}
	if (reason === "worker_specialist_busy") {
		return commsErr({
			c: "E_STATE",
			f: "agentId",
			h: "WAIT",
			m: "A compatible worker is still running this kind of work and a second copy would duplicate it. Wait for its completion event or use status on it. If this task is independent of the running work, retry with parallelWork { independentOf: [<running worker id>], justification } to start a separate worker.",
		});
	}
	const releaseHold = parseSpecialistReleaseHold(reason);
	if (releaseHold) return specialistReleaseHoldRejection(releaseHold);
	if (reason.startsWith(CHOICE_REQUIRED_PREFIX)) {
		const candidates = reason.slice(CHOICE_REQUIRED_PREFIX.length).replace(/^:/, "");
		return commsErr({
			c: "E_REF",
			f: "agentId",
			h: "USE_ID",
			...(candidates ? { x: candidates.split(",").join(", ") } : {}),
			m: "More than one idle worker fits this task: choose the recipient (delegate list shows each one's recent work) with agentId, or pass parallelWork { independentOf, justification } to start a separate worker.",
		});
	}
	if (reason.startsWith(TOOL_UNAVAILABLE_PREFIX)) {
		// Measured live: an orchestrator asked a worker for tools outside the live parent surface, lost the turn and
		// armed the failure ledger. A parent with bash lends grep/find/ls/repo_read natively; remaining misses name the rule.
		return commsErr({
			c: "E_REF",
			f: "toolNames",
			h: "RETRY_OMIT",
			x: reason,
			m: "A worker's tools come from this session's own active tool set (a session with bash also lends grep, find, ls and repo_read); omit toolNames to inherit every compatible tool.",
		});
	}
	if (reason.startsWith(TOOL_CAPABILITY_MISSING_PREFIX)) {
		return commsErr({
			c: "E_AUTH",
			f: "toolNames",
			h: "DROP_FIELD",
			x: reason,
			m: "The compiled grant has no capability for that tool: readOnly keeps reads (read, grep, find, ls, repo_read, skill, memory query) and bash limited to commands that edit nothing, and a base profile's ceiling can exclude more. Drop the tool, drop readOnly, or choose a base profile that grants it.",
		});
	}
	const capabilityRemedy = laneWorkerRefusalSkipRemedy(reason);
	if (capabilityRemedy) {
		return commsErr({
			c: "E_STATE",
			f: "model",
			h: "ASK_OWNER",
			x: reason,
			m: `This worker model cannot carry complex agentic work; nothing ran. ${capabilityRemedy}`,
		});
	}
	return commsErr({ c: "E_STATE", x: reason, m: `delegate skipped: ${reason}` });
}
