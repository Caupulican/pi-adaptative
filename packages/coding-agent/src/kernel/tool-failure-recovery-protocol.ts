export const TOOL_FAILURE_RECOVERY_PROTOCOL_NAME = "mandatory_tool_failure_recovery";
export const TOOL_FAILURE_RECOVERY_PROTOCOL_VERSION = 1;
export const TOOL_FAILURE_READMISSION_RULE =
	"The operation is readmitted after another tool succeeds or a new user turn.";
export const TOOL_FAILURE_RETRY_MODEL_RULE =
	"Retry unchanged only with an unspent harness allowance, any later tool success, or a new user turn.";

export function mandatoryToolFailureRecoveryMetadata(): {
	MUST: true;
} {
	return {
		MUST: true,
	};
}

export const MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT = [
	`MANDATORY TOOL FAILURE RECOVERY v${TOOL_FAILURE_RECOVERY_PROTOCOL_VERSION}, non-negotiable: blocked/rejected means not executed; apply repair/next_action first.`,
	TOOL_FAILURE_RETRY_MODEL_RULE,
	"Cosmetic edits do not repair; a refused call keeps result pairing and runs no hooks or tools, and only that operation is refused.",
].join(" ");
