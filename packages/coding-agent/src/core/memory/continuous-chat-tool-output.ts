/** Capture tool-output fidelity once, for stable summary leaves and on-demand inspection in zoom. */
import { getToolResultArtifactId } from "../context/context-tool-result.ts";
import { formatStructuredOutputCounts, type OutputReductionDetails } from "../tools/output-reduction-types.ts";
import { isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";

type ReductionReceipt = Pick<
	OutputReductionDetails,
	"inputBytes" | "outputBytes" | "omittedLines" | "rawPath" | "omittedItems" | "clippedStrings"
>;

export interface ContinuousChatToolOutput {
	clipped?: true;
	artifactId?: string;
	outputReduction?: ReductionReceipt;
	stderrReduction?: ReductionReceipt;
}

function reductionReceipt(value: unknown, streamPath?: unknown): ReductionReceipt | undefined {
	if (!isPlainRecord(value)) return undefined;
	const { inputBytes, outputBytes, omittedLines, omittedItems, clippedStrings } = value;
	if (
		!isNonNegativeSafeInteger(inputBytes) ||
		!isNonNegativeSafeInteger(outputBytes) ||
		!isNonNegativeSafeInteger(omittedLines)
	)
		return undefined;
	const path = value.rawPath ?? streamPath;
	// Store the producer's actual file reference as data. Never execute its suggested recovery command.
	const rawPath =
		typeof path === "string" &&
		/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path) &&
		Buffer.byteLength(path, "utf8") <= 4096 &&
		!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(path)
			? path
			: undefined;
	return {
		inputBytes,
		outputBytes,
		omittedLines,
		...(isNonNegativeSafeInteger(omittedItems) && omittedItems > 0 ? { omittedItems } : {}),
		...(isNonNegativeSafeInteger(clippedStrings) && clippedStrings > 0 ? { clippedStrings } : {}),
		...(rawPath ? { rawPath } : {}),
	};
}

function artifactReference(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-f0-9]{24}$/.test(value) ? value : undefined;
}

function toolOutput(
	clipped: boolean,
	artifactId: string | undefined,
	outputReduction: ReductionReceipt | undefined,
	stderrReduction: ReductionReceipt | undefined,
): ContinuousChatToolOutput | undefined {
	if (!clipped && !outputReduction && !stderrReduction) return undefined;
	return {
		...(clipped ? { clipped: true } : {}),
		...(artifactId ? { artifactId } : {}),
		...(outputReduction ? { outputReduction } : {}),
		...(stderrReduction ? { stderrReduction } : {}),
	};
}

export function parseContinuousChatToolOutput(value: unknown): ContinuousChatToolOutput | undefined {
	if (!isPlainRecord(value) || (value.clipped !== undefined && value.clipped !== true)) return undefined;
	const artifactId = artifactReference(value.artifactId);
	if (value.artifactId !== undefined && !artifactId) return undefined;
	return toolOutput(
		value.clipped === true,
		artifactId,
		reductionReceipt(value.outputReduction),
		reductionReceipt(value.stderrReduction),
	);
}

export function continuousChatToolOutputFromResult(
	tool: string,
	details: unknown,
): ContinuousChatToolOutput | undefined {
	if (!isPlainRecord(details)) return undefined;
	const artifactId = artifactReference(getToolResultArtifactId(details));
	const truncated = (value: unknown) => isPlainRecord(value) && value.truncated === true;
	const clipped =
		artifactId !== undefined ||
		details.truncated === true ||
		details.linesTruncated === true ||
		(typeof details.matchLimitReached === "number" && details.matchLimitReached > 0) ||
		(typeof details.resultLimitReached === "number" && details.resultLimitReached > 0) ||
		truncated(details.truncation) ||
		(tool === "python" && (truncated(details.stdoutTruncation) || truncated(details.stderrTruncation)));
	let outputReduction: ReductionReceipt | undefined;
	let stderrReduction: ReductionReceipt | undefined;
	switch (tool) {
		case "bash":
			outputReduction =
				reductionReceipt(details.outputReduction, details.fullOutputPath) ??
				reductionReceipt(details.outputProjection, details.fullOutputPath);
			break;
		case "python":
			outputReduction = reductionReceipt(details.outputReduction, details.stdoutOutputPath);
			stderrReduction = reductionReceipt(details.stderrReduction, details.stderrOutputPath);
			break;
		case "repo_read":
			outputReduction = reductionReceipt(details.outputReduction);
			break;
	}
	return toolOutput(clipped, artifactId, outputReduction, stderrReduction);
}

export function continuousChatToolOutputLabel(record: {
	toolClipping?: unknown;
	toolOutput?: ContinuousChatToolOutput;
}): string {
	const output = record.toolOutput;
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
	if (!record.toolOutput?.outputReduction?.rawPath && !record.toolOutput?.stderrReduction?.rawPath) return text;
	for (const path of [record.toolOutput.outputReduction?.rawPath, record.toolOutput.stderrReduction?.rawPath]) {
		if (path) text = text.replaceAll(path, "[session output file]");
	}
	return text;
}

/** These details are paged along with the record, even for a long file name on a small worker budget. */
export function reductionZoomDetails(output: ContinuousChatToolOutput | undefined): string[] {
	if (!output?.outputReduction && !output?.stderrReduction) return [];
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
	return lines;
}
