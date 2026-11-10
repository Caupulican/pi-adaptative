import { interfaceText } from "../../../core/language/interface-text.ts";
import { isRecordObject } from "../../../core/util/value-guards.ts";

const flat = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value.replace(/\s+/g, " ").trim() : undefined;

function sentence(failureCode: string, diagnostic: string | undefined, next: string | undefined): string {
	return interfaceText().conversation.notRun(failureCode.replace(/_/g, " "), diagnostic, next);
}

/**
 * The owner's words for a call the harness bounced: the result's text is a JSON record written for the model
 * (`[harness] {"MUST":…}`), while its own fields (`piToolFailureDirective`, `piToolFailureMemory`) carry the same
 * facts, so the history reads those and never the model's text.
 */
export function toolFailureText(details: unknown): string | undefined {
	if (!isRecordObject(details)) return undefined;
	const directive = isRecordObject(details.piToolFailureDirective) ? details.piToolFailureDirective : undefined;
	const memory = isRecordObject(details.piToolFailureMemory) ? details.piToolFailureMemory : undefined;
	const failureCode = (directive ?? memory)?.failureCode;
	if (typeof failureCode !== "string") return undefined;
	return sentence(
		failureCode,
		flat((directive ?? memory)?.diagnostic),
		flat(directive ? directive.nextAction : memory?.correction),
	);
}

/** The same sentence from a bare `[harness] {json}` result text, for a result that carries no structured fields. */
export function harnessRecordText(text: string): string | undefined {
	const match = /^\s*\[harness\]\s*(\{[\s\S]*\})\s*$/.exec(text);
	if (!match) return undefined;
	let record: unknown;
	try {
		record = JSON.parse(match[1]);
	} catch {
		return undefined;
	}
	if (!isRecordObject(record) || typeof record.failure_code !== "string") return undefined;
	return sentence(record.failure_code, flat(record.diagnostic), flat(record.next_action));
}
