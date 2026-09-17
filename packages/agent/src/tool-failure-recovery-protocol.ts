export const TOOL_FAILURE_RECOVERY_PROTOCOL_NAME = "mandatory_tool_failure_recovery";
export const TOOL_FAILURE_RECOVERY_PROTOCOL_VERSION = 1;
export const MANDATORY_TOOL_FAILURE_RECOVERY_RULE = "MANDATORY AND NON-NEGOTIABLE.";
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
	`MANDATORY TOOL FAILURE RECOVERY v${TOOL_FAILURE_RECOVERY_PROTOCOL_VERSION}`,
	MANDATORY_TOOL_FAILURE_RECOVERY_RULE,
	"MANDATORY: blocked/rejected means not executed.",
	TOOL_FAILURE_RETRY_MODEL_RULE,
	"- Apply repair/next_action first.",
	"- Cosmetic edits do not repair; refused calls keep result pairing and run no hooks/tools.",
	"- Only that operation is refused; tools and run continue.",
].join("\n");
