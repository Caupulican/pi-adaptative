export const TOOL_FAILURE_RECOVERY_PROTOCOL_NAME = "mandatory_tool_failure_recovery";
export const TOOL_FAILURE_RECOVERY_PROTOCOL_VERSION = 1;
export const MANDATORY_TOOL_FAILURE_RECOVERY_RULE = "MANDATORY AND NON-NEGOTIABLE.";

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
	"CAVEMAN MODE - MANDATORY: blocked/rejected means not executed; never repeat the same call.",
	"Harness contract:",
	"- MUST:true: obey repair or next_action before another tool call.",
	"- Unchanged execution needs permission or successful loaded-tool evidence matching backend authority, target kind, and exact scope; one probe.",
	"- Irrelevant argument changes never recover it; blocked call preserves tool-result pairing but runs no hook/tool code.",
	"- Operation exhaustion closes that operation; use different tools/work. Replaying it or run exhaustion ends the run with a local diagnostic.",
].join("\n");
