/**
 * A judgment paired with an evidence-sufficiency question, read in the `orchestration` family: the judgment
 * settles only when the evidence is sufficient (P >= 0.90). Then P >= 0.90 is yes and P <= 0.10 is no; anything
 * else, an unasked question included, is `open`, which is uncertainty, never a rejection. The caller's ordered
 * exits give each verdict its own outcome.
 */

import { type NoulReading, readNoul } from "./noul.ts";

export type PairedVerdict = "yes" | "no" | "open";

export interface PairedReading {
	readonly verdict: PairedVerdict;
	readonly judgment: NoulReading;
	readonly sufficiency: NoulReading;
}

export function readPairedJudgment(judgment: unknown, sufficiency: unknown): PairedReading {
	const judgmentReading = readNoul(judgment, "required_true", "orchestration");
	const sufficiencyReading = readNoul(sufficiency, "required_true", "orchestration");
	const verdict: PairedVerdict =
		sufficiencyReading !== "hard_pass"
			? "open"
			: judgmentReading === "hard_pass"
				? "yes"
				: judgmentReading === "hard_fail"
					? "no"
					: "open";
	return { verdict, judgment: judgmentReading, sufficiency: sufficiencyReading };
}
