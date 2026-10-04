/** How hard a reducer may cut. The capability tier decides; `standard` is the frontier default. */
export type OutputReductionLevel = "standard" | "compact";

/** What a reduction did, persisted in the tool result's `details.outputReduction` for the census. */
export interface OutputReductionDetails {
	/** Reducer name (`search`, `diagnostics`, `generic`, `rule:<name>`); `+generic` when the generic stage also cut lines. */
	kind: string;
	/** Command family label the reducer was chosen for (`rg`, `git diff`, `cargo check`). */
	family: string;
	inputBytes: number;
	outputBytes: number;
	inputLines: number;
	outputLines: number;
	omittedLines: number;
	/** Path of the persisted raw output when the caller stored it. */
	rawPath?: string;
	/** A command prefix that projects the raw output (`jq -c '.items[] | {id,status}'`); the notice appends the path. */
	recoveryHint?: string;
	/**
	 * Whether the caller should persist the raw output and append the recovery notice: true when a
	 * family or rule reducer reshaped the output or the generic stage dropped lines, and the cut is
	 * large enough to be worth a file. Pure cleaning (ANSI, whitespace, resolved progress frames)
	 * leaves it false: nothing to recover.
	 */
	persistRaw: boolean;
}
