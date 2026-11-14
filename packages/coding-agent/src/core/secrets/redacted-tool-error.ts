/**
 * The error a credential-guarded tool call rethrows: the thrown value rebuilt with every text it carries run through the
 * guard's redaction, keeping the kind the agent loop classifies it by (a policy refusal, a structured execution failure,
 * a plain error) and the facts the tool attached.
 */
import {
	AgentToolExecutionError,
	AgentToolPolicyDeniedError,
	describeThrownToolError,
	readAgentToolExecutionError,
	readAgentToolPolicyDeniedError,
} from "../../kernel/index.ts";
import {
	type AgentToolFailureReceipt,
	readAgentToolFailureReceipt,
	type ToolReceiptValue,
} from "../../kernel/tool-failure-receipt.ts";

/** The redacted rebuild of `error`, for the guard to throw in its place. A cancellation is the caller's to pass through. */
export function redactedThrownToolError(error: unknown, redact: (text: string) => string): Error {
	// A policy refusal is the gate's decision, not a failed run: it stays a refusal, with the policy's own next action,
	// so the loop records it as a standalone refused call's (held line, draft and release) instead of a failure.
	const denial = readAgentToolPolicyDeniedError(error);
	if (denial) {
		return new AgentToolPolicyDeniedError(
			redact(denial.message),
			denial.terminate,
			denial.correction === undefined ? undefined : redact(denial.correction),
		);
	}
	const classified = readAgentToolExecutionError(error);
	if (classified) {
		return new AgentToolExecutionError(
			redact(classified.message),
			classified.failureCode,
			classified.outputSignature,
			classified.errorKind,
			classified.details,
			redactedFailureReceipt(classified.receipt, redact),
		);
	}
	// The rebuilt error keeps the facts the tool attached, redacted the way its message is, and the class the loop reads
	// as its error class (a failure with no code of its own is classified by it), so a guarded tool's failure is
	// classified as the same throw would be unguarded.
	const { receipt, errorClass } = describeThrownToolError(error);
	const kept = { name: redact(errorClass), receipt: redactedFailureReceipt(receipt, redact) };
	if (error instanceof Error) return Object.assign(new Error(redact(error.message)), kept);
	// A thrown non-Error is the live shape of a cancellation: `signal.throwIfAborted()` throws
	// the abort REASON, and a named abort's reason is a plain string. Reporting only that the
	// value was lost left the model, the failure ledger and the operator with no cause at all.
	return Object.assign(
		new Error(`Credential-safe tool execution failed: ${describeThrownValue(error)}: ${redact(String(error))}`),
		kept,
	);
}

/**
 * A failure receipt with every string value run through the same redaction the guard applies to a message, then read back
 * under the receipt bounds: a value the redaction lengthens past a bound drops the whole receipt rather than persisting it.
 * Keys are the tool's own names and are not redacted.
 */
function redactedFailureReceipt(
	receipt: AgentToolFailureReceipt | undefined,
	redact: (text: string) => string,
): AgentToolFailureReceipt | undefined {
	if (receipt === undefined) return undefined;
	return readAgentToolFailureReceipt(redactReceiptStrings(receipt, redact));
}

function redactReceiptStrings(value: ToolReceiptValue, redact: (text: string) => string): ToolReceiptValue {
	if (typeof value === "string") return redact(value);
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item: ToolReceiptValue) => redactReceiptStrings(item, redact));
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, redactReceiptStrings(item, redact)] as const),
	);
}

/** Names a thrown non-Error precisely enough to act on: its primitive type, or its constructor. */
function describeThrownValue(error: unknown): string {
	if (error === null) return "null";
	const type = typeof error;
	if (type !== "object") return type;
	const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
	return typeof name === "string" && name.length > 0 ? name : "object";
}
