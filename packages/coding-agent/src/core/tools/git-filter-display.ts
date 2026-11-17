/** Publish filtered Git output with one bounded display and the authoritative command-output artifact. */
import { truncateMiddle, truncateTail } from "../../kernel/utils/truncate.ts";
import { applyGitTailStage, type FilterResult, type GitTailStage } from "./git-filter.ts";
import type { OutputAccumulator, OutputSnapshot } from "./output-accumulator.ts";

export async function prepareFilteredGitDisplay(
	result: FilterResult,
	stage: GitTailStage | undefined,
	output: OutputAccumulator,
) {
	const selected = applyGitTailStage(result.output, stage);
	let display = truncateMiddle(selected);
	// Preserve the selected pipeline's output even when a single source line exceeds the whole budget.
	if (display.firstLineExceedsLimit) display = truncateTail(selected);
	// On overflow Git already owns the complete file. Re-spooling its retained head duplicates I/O
	// and would give the partial head a second, misleading recovery path.
	let raw: OutputSnapshot | undefined;
	if (result.rawBytes !== undefined) {
		output.append(result.rawBytes);
		raw = await output.publishSnapshot(display.truncated);
	}
	const fullOutputPath = raw?.fullOutputPath ?? result.fullOutputPath;
	const fullOutputError =
		raw?.fullOutputError ?? (!raw && !fullOutputPath ? "complete filtered Git output is unavailable" : undefined);
	const partial = display.truncated || !raw;
	const recovery = fullOutputPath
		? `Raw Git output: ${fullOutputPath}`
		: `Full output unavailable: ${fullOutputError ?? "no artifact recorded"}`;
	const toolText = partial ? `${display.content}\n\n[Filtered Git preview is partial. ${recovery}]` : display.content;
	return { display, raw, partial, toolText, fullOutputPath, fullOutputError };
}
