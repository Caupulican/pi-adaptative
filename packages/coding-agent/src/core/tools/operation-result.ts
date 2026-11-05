/**
 * A plain text tool result. A refusal is the operation's outcome, not a tool failure: its reason reaches the model
 * verbatim (errorKind `operation_outcome`).
 */
export function operationTextResult(text: string, refused = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		...(refused ? { isError: true, errorKind: "operation_outcome" as const } : {}),
	};
}
