export const TOOL_FAILURE_RECOVERY_PROTOCOL_NAME = "mandatory_tool_failure_recovery";
export const TOOL_FAILURE_RECOVERY_PROTOCOL_VERSION = 1;
export const MANDATORY_TOOL_FAILURE_RECOVERY_RULE = "MANDATORY AND NON-NEGOTIABLE.";
export const TOOL_FAILURE_READMISSION_RULE =
	"The operation is readmitted after another tool succeeds or a new user turn.";
export const TOOL_FAILURE_RETRY_MODEL_RULE = `Do not immediately replay the unchanged operation. ${TOOL_FAILURE_READMISSION_RULE}`;

export function mandatoryToolFailureRecoveryMetadata(): {
	MUST: true;
} {
	return {
		MUST: true,
	};
}

export const MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT = [
	`MANDATORY TOOL FAILURE RECOVERY v${TOOL_FAILURE_RECOVERY_PROTOCOL_VERSION}`,
	MANDATORY_TOOL_FAILURE_RECOVERY_RULE,
	"MANDATORY: blocked/rejected means not executed.",
	"Harness contract:",
	`- MUST:true: ${TOOL_FAILURE_RETRY_MODEL_RULE}`,
	"- Follow repair or next_action before retrying that operation; unrelated tools remain available.",
	"- Irrelevant argument changes never recover it; blocked call preserves tool-result pairing but runs no hook/tool code.",
	"- Refusal is only ever this one operation. Every other tool stays available, and nothing here stops the run.",
].join("\n");
