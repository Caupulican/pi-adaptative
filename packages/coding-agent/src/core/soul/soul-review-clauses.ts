/**
 * What each adverse decision of a soul review means, in the words the agent is told when its write is refused. A model
 * reads these, so they are English whatever the interface language is. The English interface shows the same words in
 * the owner's review listing; the other languages have their own there.
 */

/** The decisions a soul review settles. Each id names one decision. */
export type SoulReviewQuestionId = "override" | "authority" | "covert" | "external" | "identity";

export const SOUL_ADVERSE_CLAUSES: Readonly<Record<SoulReviewQuestionId, string>> = {
	override: "overrides owner instructions, safety rules or tool gates",
	authority: "grants itself authority",
	covert: "asks for covert or deceptive behavior",
	external: "reads as copied external text",
	identity: "is not a description of who the assistant is",
};

/** The reason given when a review reached no verdict on the text. */
export const SOUL_REVIEW_UNSETTLED_REASON = "the review could not settle the text";
