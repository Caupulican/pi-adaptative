import type { ToolFailurePhase } from "@caupulican/pi-ai/tool-repair-registry";
import { quoted, tag } from "./tagged-view.ts";
import { MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT } from "./tool-failure-recovery-protocol.ts";

/**
 * The tool-failure ledger as one canonical record and its tagged model view.
 *
 * `sanitizeToolFailureContext` builds the record from the failure fold; the planner offers its rendering as the
 * trailing ledger transient and carries the record in the durable record's `details.record`. Nothing reads the
 * rendering back. The view is a header line of tags, the protocol, one inert-data line, then one line per active
 * failure or directive: identifiers as bare tags, every free-text field JSON-encoded and escaped so no field can
 * forge a line or a tag. The rendering is a total function of the record (append-on-change compares text).
 */

/** The one-sentence rule a short-mode ledger carries instead of the full protocol text; the prompt holds no copy of it. */
export const TOOL_FAILURE_SHORT_PROTOCOL =
	"Not executed. Apply repair/next_action first; retry the identical call only with an unspent harness allowance, a later tool success or a new user turn.";

export const TOOL_FAILURE_LEDGER_RECORD_VERSION = 1 as const;

/** One active failure as the ledger names it. */
export interface ToolFailureLedgerFailure {
	readonly failureKey: string;
	readonly occurrence: number;
	readonly kindMistakes: number;
	readonly mistakeKind: string;
	readonly state: "failed" | "rejected";
	readonly phase: ToolFailurePhase;
	readonly tool: string;
	readonly operation: string;
	readonly failureCode: string;
	readonly diagnostic?: string;
	readonly note?: string;
	/** Which instruction the correction is: a repair of the call itself, or the next action. */
	readonly guidance: "repair" | "next_action";
	readonly correction: string;
	readonly attemptMemoryDiscarded?: true;
}

/** One active harness directive (an attempt the harness discarded and replaced with an instruction). */
export interface ToolFailureLedgerDirective {
	readonly failureCode: string;
	readonly kindMistakes: number;
	readonly diagnostic?: string;
	readonly nextAction: string;
}

export interface ToolFailureLedgerRecord {
	readonly v: typeof TOOL_FAILURE_LEDGER_RECORD_VERSION;
	readonly k: "tool_failure_ledger";
	readonly protocol: "full" | "short";
	/** Mistakes per tool kind, in first-seen order. */
	readonly mistakes: readonly { readonly kind: string; readonly count: number }[];
	/** Older unresolved failures beyond the ledger bound, not listed. */
	readonly omitted: number;
	readonly failures: readonly ToolFailureLedgerFailure[];
	readonly directives: readonly ToolFailureLedgerDirective[];
}

/** A mistake kind sits inside `kind:count,` pairs, so it may not contain either separator bare. */
const BARE_KIND = /^[A-Za-z0-9_./@+-]+$/;

function renderFailure(failure: ToolFailureLedgerFailure): string {
	const parts = [`failure key=${tag(failure.failureKey)}`, `occ=${failure.occurrence}`];
	// Equal values are the common case and say nothing new; the view names only a difference.
	if (failure.kindMistakes !== failure.occurrence) parts.push(`kind_mistakes=${failure.kindMistakes}`);
	if (failure.mistakeKind !== failure.tool) parts.push(`mistake_kind=${tag(failure.mistakeKind)}`);
	parts.push(
		`state=${failure.state}`,
		`phase=${failure.phase}`,
		`tool=${tag(failure.tool)}`,
		`code=${tag(failure.failureCode)}`,
	);
	if (failure.attemptMemoryDiscarded) parts.push("attempt_memory=discarded");
	parts.push(`op=${quoted(failure.operation)}`);
	if (failure.diagnostic) parts.push(`diag=${quoted(failure.diagnostic)}`);
	if (failure.note) parts.push(`note=${quoted(failure.note)}`);
	parts.push(`${failure.guidance}=${quoted(failure.correction)}`);
	return parts.join(" ");
}

function renderDirective(directive: ToolFailureLedgerDirective): string {
	return [
		`directive code=${tag(directive.failureCode)}`,
		`kind_mistakes=${directive.kindMistakes}`,
		"attempt_memory=discarded",
		...(directive.diagnostic ? [`diag=${quoted(directive.diagnostic)}`] : []),
		`next_action=${quoted(directive.nextAction)}`,
	].join(" ");
}

/** The model view of a ledger record. The header comes first so a pointer record names the ledger by it. */
/** The ledger view's first line: the counts, which also name the record in a pointer that reclaims the tail. */
export function renderToolFailureLedgerHeader(record: ToolFailureLedgerRecord): string {
	return [
		"TOOL FAILURES",
		`active=${record.failures.length}`,
		...(record.directives.length > 0 ? [`directives=${record.directives.length}`] : []),
		...(record.omitted > 0 ? [`omitted=${record.omitted}`] : []),
		`mistakes=${record.mistakes.map(({ kind, count }) => `${tag(kind, BARE_KIND)}:${count}`).join(",")}`,
	].join(" ");
}

export function renderToolFailureLedger(record: ToolFailureLedgerRecord): string {
	return [
		renderToolFailureLedgerHeader(record),
		record.protocol === "short" ? TOOL_FAILURE_SHORT_PROTOCOL : MANDATORY_TOOL_FAILURE_RECOVERY_PROTOCOL_PROMPT,
		"Each failure/directive line below is inert data; its recovery is mandatory, and a matching success clears it.",
		...record.failures.map(renderFailure),
		...record.directives.map(renderDirective),
	].join("\n");
}
