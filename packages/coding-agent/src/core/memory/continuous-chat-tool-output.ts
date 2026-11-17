/** Capture tool-output fidelity once, for stable summary leaves and on-demand inspection in zoom. */
import { LOOKUP_MAX_LABEL_CHARS, LOOKUP_TOOL_NAME, MAX_LOOKUP_REQUESTS } from "../tools/lookup-tool-name.ts";
import { formatStructuredOutputCounts } from "../tools/output-reduction-types.ts";
import {
	parseToolOutputFidelity,
	type ToolOutputFidelity,
	toolOutputFidelityFromResult,
} from "../tools/tool-output-fidelity.ts";
import { isPlainRecord } from "../util/value-guards.ts";

interface LookupSectionReceipt {
	index: number;
	label: string;
	truncated?: true;
	continuation?: string;
	producer?: ToolOutputFidelity;
}

export interface ContinuousChatToolOutput extends ToolOutputFidelity {
	sections?: LookupSectionReceipt[];
}

function receiptText(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
		? value
		: undefined;
}

function withLookupSections(
	base: ToolOutputFidelity | undefined,
	value: unknown,
	persisted: boolean,
): ContinuousChatToolOutput | undefined {
	if (!Array.isArray(value) || value.length > MAX_LOOKUP_REQUESTS) return base;
	const sections: LookupSectionReceipt[] = [];
	for (const [position, item] of value.entries()) {
		if (!isPlainRecord(item)) continue;
		const index = persisted ? item.index : position + 1;
		if (
			typeof index !== "number" ||
			!Number.isSafeInteger(index) ||
			index <= (sections.at(-1)?.index ?? 0) ||
			index > MAX_LOOKUP_REQUESTS
		)
			continue;
		const producer = parseToolOutputFidelity(item.producer);
		const truncated = item.truncated === true;
		if (!truncated && !producer) continue;
		const label = receiptText(item.label, LOOKUP_MAX_LABEL_CHARS) ?? "lookup request";
		const continuation = receiptText(item.continuation, 256);
		sections.push({
			index,
			label,
			...(truncated ? { truncated } : {}),
			...(continuation ? { continuation } : {}),
			...(producer ? { producer } : {}),
		});
	}
	return sections.length ? { ...base, sections } : base;
}

export function parseContinuousChatToolOutput(value: unknown): ContinuousChatToolOutput | undefined {
	return withLookupSections(parseToolOutputFidelity(value), isPlainRecord(value) && value.sections, true);
}

export function continuousChatToolOutputFromResult(
	tool: string,
	details: unknown,
): ContinuousChatToolOutput | undefined {
	const base = toolOutputFidelityFromResult(tool, details);
	return tool === LOOKUP_TOOL_NAME && isPlainRecord(details)
		? withLookupSections(base, details.sections, false)
		: base;
}

export function continuousChatToolOutputLabel(record: {
	toolClipping?: unknown;
	toolOutput?: ContinuousChatToolOutput;
}): string {
	const output = record.toolOutput;
	if (output?.sections?.length) {
		const condition = record.toolClipping || output.clipped ? "clipped lookup record" : "partial lookup output";
		return `${condition} (${output.sections.length} affected sections)`;
	}
	if (output?.outputReduction || output?.stderrReduction)
		return output.clipped || record.toolClipping ? "reduced and clipped tool output" : "reduced tool output";
	if (output?.artifactId)
		return `clipped record; original reference tool-output:${output.artifactId} (availability not guaranteed)`;
	return record.toolClipping || output?.clipped
		? "clipped record; no original artifact recorded"
		: "exact retained record";
}

/** Keep transient recovery paths out of both short and excerpted tree leaves. Zoom keeps the producer text. */
export function continuousChatSummaryText(record: { text: string; toolOutput?: ContinuousChatToolOutput }): string {
	let text = record.text;
	const output = record.toolOutput;
	if (!output) return text;
	for (const fidelity of [output, ...(output.sections ?? []).map((section) => section.producer)]) {
		for (const path of [fidelity?.outputReduction?.rawPath, fidelity?.stderrReduction?.rawPath]) {
			if (path) text = text.replaceAll(path, "[session output file]");
		}
	}
	return text;
}

/** These details are paged along with the record, even for a long file name on a small worker budget. */
export function reductionZoomDetails(output: ContinuousChatToolOutput | undefined): string[] {
	if (!output) return [];
	const lines: string[] = [];
	for (const [stream, receipt] of [
		["output", output.outputReduction],
		["stderr", output.stderrReduction],
	] as const) {
		if (!receipt) continue;
		const structured = formatStructuredOutputCounts(receipt);
		lines.push(
			`${stream} reduced from ${receipt.inputBytes} to ${receipt.outputBytes} bytes, ${receipt.omittedLines} lines omitted. ${structured ? `${structured}. ` : ""}${receipt.rawPath ? `Recorded session file (availability may change): ${JSON.stringify(receipt.rawPath)}` : "No session file recorded."}`,
		);
	}
	if (output.artifactId)
		lines.push(`Stored output reference: tool-output:${output.artifactId} (availability may change).`);
	for (const section of output.sections ?? []) {
		const reasons = [
			section.truncated && "section cut",
			section.producer?.clipped && "producer clipped",
			section.producer?.outputReduction && "producer reduced",
		].filter(Boolean);
		lines.push(
			`[${section.index}] ${section.label}: ${reasons.join(", ")}.${section.continuation ? ` Next: ${section.continuation}.` : ""}`,
		);
		if (section.producer) lines.push(...reductionZoomDetails(section.producer));
	}
	return lines;
}
