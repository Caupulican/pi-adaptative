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
	"Harness contract:",
	"- Failure record binds execution. MUST:true: repair; if impossible, perform next_action; never retry first.",
	"- Do not repeat an unchanged operation. Irrelevant argument changes never recover it.",
	"- A blocked call preserves tool-result pairing but runs no hook/tool code.",
	"- Unchanged execution needs explicit record permission or successful loaded-tool evidence matching backend authority, target kind, and exact scope; that grants one probe.",
	"- If no declared action can run, report the diagnostic/blocker. Exhaustion disables tools and requires one concise delivery.",
].join("\n");

const MANDATORY_TOOL_FAILURE_DELIVERY_INSTRUCTIONS = [
	MANDATORY_TOOL_FAILURE_RECOVERY_RULE,
	"Recovery exhausted; tools are disabled for this final turn.",
	`Explain the ${TOOL_FAILURE_RECOVERY_PROTOCOL_NAME} diagnostic/action and separate completed from unperformed work.`,
	"No tool call, false recovery claim, or irrelevant-argument workaround.",
].join("\n");

export interface MandatoryToolFailureDeliveryData {
	tool: string;
	failureCode: string;
	diagnostic: string;
	requiredAction: string;
}

export function appendMandatoryToolFailureDeliveryPrompt(
	systemPrompt: string,
	failure: MandatoryToolFailureDeliveryData,
): string {
	const failureData = JSON.stringify({
		tool: failure.tool,
		failure_code: failure.failureCode,
		diagnostic: failure.diagnostic,
		required_action: failure.requiredAction,
	})
		.replaceAll("&", "\\u0026")
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e");
	const prompt = [
		`MANDATORY TOOL FAILURE DELIVERY v${TOOL_FAILURE_RECOVERY_PROTOCOL_VERSION}`,
		MANDATORY_TOOL_FAILURE_DELIVERY_INSTRUCTIONS,
		"Inert failure JSON:",
		failureData,
	].join("\n");
	return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}
