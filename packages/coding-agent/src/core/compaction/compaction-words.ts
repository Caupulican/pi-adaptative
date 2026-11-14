/**
 * The owner's clauses for how a compaction ended, by the closed codes the compaction loop and the economics verdict
 * give. The raw codes stay in the harness log.
 */

/** The owner's clause for a checkpoint cause (the loop's closed cause codes); the raw code stays in the harness log. */
const COMPACTION_CAUSE_WORDS: Partial<Record<string, string>> = {
	"auth-failed": "the summary model had no usable credentials or quota",
	"gate-failed": "the summary failed its quality check",
	"length-stop": "the summary ran past its length limit",
	"input-overflow": "the history was too large for the summary model",
	"provider-failure": "the summary model returned an error",
	"deterministic-required": "the summary would not fit the space reserved for it",
	"effect-not-restored": "the compaction did not free enough room",
	"unknown-failure": "the summary failed for an unknown reason",
	"deterministic-only": "the run was set to skip the written summary",
	"max-llm-cycles": "the written summary was tried as many times as allowed",
};

export function compactionCauseWords(cause: string): string {
	return COMPACTION_CAUSE_WORDS[cause] ?? "the summary could not be written";
}

/** The owner's clause for a retry ladder that ended without a checkpoint; the raw reason stays in the harness log. */
export function compactionFailureWords(reason: string): string {
	if (reason === "exhausted-compaction-cycles") return "the summary could not be made to fit after several attempts";
	if (reason.startsWith("effect-not-restored")) return "the compaction did not free enough room";
	return "the run could not be finished";
}

/** The owner's clause for why an early compaction waits (the economics verdict's closed reasons). */
export const EARLY_COMPACTION_DEFERRAL_WORDS: Readonly<
	Record<"insufficient_evidence" | "insufficient_savings", string>
> = {
	insufficient_evidence: "early compaction waits until its cost can be measured",
	insufficient_savings: "early compaction waits because resuming costs less for now",
};
