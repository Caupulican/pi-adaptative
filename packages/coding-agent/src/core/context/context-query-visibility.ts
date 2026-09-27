import { CURATION_RELEVANCE_MIN_CONFIDENCE } from "./brain-curator.ts";

export const CONTEXT_VISIBILITY_SHORT_CHARS = 640;
export const CONTEXT_VISIBILITY_LONG_CHARS = 4_000;

export type ContextVisibility = "hidden" | "short" | "long" | "full";
export type ContextVisibilityReason =
	| "absolute_floor"
	| "recent_window"
	| "legacy_stale"
	| "judgment_missing"
	| "query_relevant"
	| "query_uncertain"
	| "query_irrelevant";

export type ContextVisibilityAdvisory = "brain_irrelevant" | "brain_relevant" | "brain_uncertain";

export interface ContextRelevanceVerdict {
	relevant: boolean;
	confidence: number;
}

export interface ContextVisibilityDecision {
	selected: ContextVisibility;
	reason: ContextVisibilityReason;
	advisory?: ContextVisibilityAdvisory;
	candidates: readonly ContextVisibility[];
}

const ALL_VISIBILITIES = ["hidden", "short", "long", "full"] as const;
const FULL_ONLY = ["full"] as const;

/**
 * Bounded head/tail evidence view. The relevance scorer and provider projection call this same
 * owner, so a verdict never selects bytes outside the evidence revision it actually judged.
 */
export function contextVisibilityExcerpt(text: string, maxChars: number): string {
	const bound = Math.max(0, Math.floor(maxChars));
	if (text.length <= bound) return text;
	if (bound === 0) return "";
	const separator = "\n…\n";
	if (bound <= separator.length) return text.slice(0, bound);
	const contentChars = bound - separator.length;
	const headChars = Math.ceil(contentChars / 2);
	const tailChars = contentChars - headChars;
	return `${text.slice(0, headChars)}${separator}${text.slice(text.length - tailChars)}`;
}

/**
 * Select one bounded visibility candidate. Deterministic recency and confidence gates own the
 * decision; the semantic verdict only classifies the exact query/evidence scope it was given.
 * Missing query-aware judgment fails open to full evidence. The legacy no-curator path retains its
 * existing stale-artifact stub behavior.
 */
export function selectContextVisibility(input: {
	insideAbsoluteFloor: boolean;
	insideRecentWindow: boolean;
	originalChars: number;
	queryAware: boolean;
	verdict: ContextRelevanceVerdict | undefined;
}): ContextVisibilityDecision {
	if (input.insideAbsoluteFloor) {
		return { selected: "full", reason: "absolute_floor", candidates: FULL_ONLY };
	}
	if (!input.queryAware) {
		return input.insideRecentWindow
			? { selected: "full", reason: "recent_window", candidates: ALL_VISIBILITIES }
			: { selected: "hidden", reason: "legacy_stale", candidates: ALL_VISIBILITIES };
	}
	if (!input.verdict) {
		return { selected: "full", reason: "judgment_missing", candidates: ALL_VISIBILITIES };
	}
	if (input.verdict.confidence < CURATION_RELEVANCE_MIN_CONFIDENCE) {
		return input.insideRecentWindow || input.originalChars <= CONTEXT_VISIBILITY_SHORT_CHARS
			? {
					selected: "full",
					reason: "query_uncertain",
					advisory: "brain_uncertain",
					candidates: ALL_VISIBILITIES,
				}
			: {
					selected: "short",
					reason: "query_uncertain",
					advisory: "brain_uncertain",
					candidates: ALL_VISIBILITIES,
				};
	}
	if (!input.verdict.relevant) {
		return {
			selected: "hidden",
			reason: "query_irrelevant",
			advisory: "brain_irrelevant",
			candidates: ALL_VISIBILITIES,
		};
	}
	return input.insideRecentWindow || input.originalChars <= CONTEXT_VISIBILITY_LONG_CHARS
		? {
				selected: "full",
				reason: "query_relevant",
				advisory: "brain_relevant",
				candidates: ALL_VISIBILITIES,
			}
		: {
				selected: "long",
				reason: "query_relevant",
				advisory: "brain_relevant",
				candidates: ALL_VISIBILITIES,
			};
}
