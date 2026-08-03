/**
 * RPC emits both a tool_execution_end event and a message_end projection for one tool call.
 * Acceptance gates use only the execution event so one logical call is counted exactly once.
 */
export function successfulToolResults(events, toolName) {
	return events.filter(
		(event) => event.type === "tool_execution_end" && event.toolName === toolName && !event.isError,
	);
}

export function assistantReportedToolMarker(events, toolName, marker) {
	const successIndex = events.findIndex(
		(event) => event.type === "tool_execution_end" && event.toolName === toolName && !event.isError,
	);
	if (successIndex < 0) return false;
	return events.slice(successIndex + 1).some((event) => {
		if (!isFinalAssistantProgress(event)) return false;
		return (event.message.content ?? []).some((block) => block.type === "text" && block.text.includes(marker));
	});
}

function canonicalJson(value) {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalJson(entry)]),
	);
}

function executionSignature(event) {
	return `${event.toolName}\0${JSON.stringify(canonicalJson(event.args ?? null))}`;
}

function guardedRepeatFailure(event) {
	return event.result?.details?.piToolFailureDirective?.failureCode === "repeated_successful_call";
}

function isFinalAssistantProgress(event) {
	if (event.type !== "message_end" || event.message?.role !== "assistant") return false;
	if (["error", "aborted", "toolUse"].includes(event.message.stopReason)) return false;
	return !(event.message.content ?? []).some((block) => block.type === "toolCall");
}

export function failedToolResult(events, toolName) {
	const startSignatures = new Map();
	for (const event of events) {
		if (event.type === "tool_execution_start") {
			startSignatures.set(event.toolCallId, executionSignature(event));
		}
	}
	const successes = events.flatMap((event, index) =>
		event.type === "tool_execution_end" && !event.isError
			? [{ index, signature: startSignatures.get(event.toolCallId), toolCallId: event.toolCallId }]
			: [],
	);

	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (event.type !== "tool_execution_end" || event.toolName !== toolName || !event.isError) continue;
		if (!guardedRepeatFailure(event)) return event;
		const signature = startSignatures.get(event.toolCallId);
		const previousToolCallId = event.result?.details?.piRepeatedSuccessfulCall?.previousToolCallId;
		const repeatedKnownSuccess = previousToolCallId
			? successes.some((success) => success.index < index && success.toolCallId === previousToolCallId)
			: signature !== undefined &&
				successes.some((success) => success.index < index && success.signature === signature);
		const laterProgress =
			events.slice(index + 1).some(isFinalAssistantProgress) ||
			successes.some((success) => success.index > index && success.signature !== signature);
		if (!repeatedKnownSuccess || !laterProgress) return event;
	}
	return undefined;
}

export function toolResultJson(event) {
	return JSON.stringify(event.result);
}
