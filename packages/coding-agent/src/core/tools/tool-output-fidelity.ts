/** Normalize producer clipping and reduction metadata before it crosses tool or persistence boundaries. */
import { getToolResultArtifactId } from "../context/context-tool-result.ts";
import { isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";
import type { OutputReductionDetails } from "./output-reduction-types.ts";

type ReductionReceipt = Pick<
	OutputReductionDetails,
	"inputBytes" | "outputBytes" | "omittedLines" | "rawPath" | "omittedItems" | "clippedStrings"
>;

export interface ToolOutputFidelity {
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
): ToolOutputFidelity | undefined {
	if (!clipped && !outputReduction && !stderrReduction) return undefined;
	return {
		...(clipped ? { clipped: true } : {}),
		...(artifactId ? { artifactId } : {}),
		...(outputReduction ? { outputReduction } : {}),
		...(stderrReduction ? { stderrReduction } : {}),
	};
}

export function parseToolOutputFidelity(value: unknown): ToolOutputFidelity | undefined {
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

export function toolOutputFidelityFromResult(tool: string, details: unknown): ToolOutputFidelity | undefined {
	if (!isPlainRecord(details)) return undefined;
	const artifactId = artifactReference(getToolResultArtifactId(details));
	const truncated = (value: unknown) => isPlainRecord(value) && value.truncated === true;
	const directory = tool === "read" && isPlainRecord(details.directory) ? details.directory : undefined;
	const clipped =
		(tool === "read" && isNonNegativeSafeInteger(details.nextOffset) && details.nextOffset > 0) ||
		(directory !== undefined &&
			isNonNegativeSafeInteger(directory.shown) &&
			isNonNegativeSafeInteger(directory.entries) &&
			directory.shown < directory.entries) ||
		(tool === "read" &&
			isPlainRecord(details.lineWindow) &&
			isNonNegativeSafeInteger(details.lineWindow.nextColumn)) ||
		artifactId !== undefined ||
		details.truncated === true ||
		details.linesTruncated === true ||
		(typeof details.matchLimitReached === "number" && details.matchLimitReached > 0) ||
		(typeof details.resultLimitReached === "number" && details.resultLimitReached > 0) ||
		truncated(details.truncation) ||
		(tool === "python" &&
			((typeof details.stdoutReducedDisplayTruncated === "boolean"
				? details.stdoutReducedDisplayTruncated
				: truncated(details.stdoutTruncation)) ||
				(typeof details.stderrReducedDisplayTruncated === "boolean"
					? details.stderrReducedDisplayTruncated
					: truncated(details.stderrTruncation))));
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

/** A read can resume at a producer-owned source position, even when its returned text has a footer. */
export function readOutputContinuation(details: unknown): string | undefined {
	if (!isPlainRecord(details)) return undefined;
	const window = details.lineWindow;
	if (
		isPlainRecord(window) &&
		isNonNegativeSafeInteger(window.line) &&
		window.line > 0 &&
		isNonNegativeSafeInteger(window.nextColumn) &&
		window.nextColumn > 0
	) {
		return `read the same path with offset=${window.line} column=${window.nextColumn}`;
	}
	return isNonNegativeSafeInteger(details.nextOffset) && details.nextOffset > 0
		? `read it again with offset=${details.nextOffset}`
		: undefined;
}
