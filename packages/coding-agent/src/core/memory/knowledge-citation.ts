/**
 * Deterministic tie between a knowledge change and the owner's own words, checked before any judgment is paid for.
 * The host proves the cited quote is stated (not shown) text that itself carries the change; the judge only decides
 * meaning inside that bound. Shared by explicit admission and whole-original grounding.
 */
import { locateOwnerQuote, ownerShownRegions } from "../learning/owner-evidence-ledger.ts";

/** The fact a citation must state: the proposal for remember, the target for forget or correction. */
export interface CitationFact {
	readonly subject: string;
	readonly key?: string;
	readonly text: string;
}

export interface CitedOwnerWords {
	/** The complete original owner source. */
	readonly source: string;
	readonly quote: string;
}

/** A cited quote must carry at least this many stated letters or digits of the owner's own words. */
export const MIN_STATED_QUOTE_CHARS = 4;

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
/** Scripts written without spaces: one segmented word is meaningful at any length. */
const NO_SPACE_SCRIPT =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/**
 * Words that carry no fact: function words and the vocabulary every proposal uses to describe the owner. Without
 * them a quote could tie itself to a fact through "the" or "prefers" alone.
 */
const STOP_WORDS = new Set([
	"about",
	"after",
	"again",
	"also",
	"and",
	"any",
	"are",
	"been",
	"before",
	"but",
	"can",
	"does",
	"for",
	"from",
	"has",
	"have",
	"her",
	"his",
	"into",
	"its",
	"not",
	"now",
	"one",
	"only",
	"our",
	"owner",
	"owners",
	"prefer",
	"preference",
	"preferences",
	"prefers",
	"she",
	"should",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"they",
	"this",
	"use",
	"used",
	"user",
	"uses",
	"using",
	"was",
	"were",
	"what",
	"when",
	"which",
	"who",
	"will",
	"with",
	"would",
	"you",
	"your",
	"como",
	"para",
	"por",
	"que",
	"uma",
	"com",
	"dans",
	"des",
	"les",
	"pour",
	"une",
	"avec",
	"das",
	"der",
	"die",
	"und",
	"eine",
	"nicht",
]);

interface Term {
	readonly term: string;
	readonly index: number;
}

function terms(text: string): Term[] {
	const result: Term[] = [];
	for (const segment of WORDS.segment(text)) {
		if (!segment.isWordLike) continue;
		const term = segment.segment.normalize("NFKC").toLowerCase();
		if (STOP_WORDS.has(term)) continue;
		if ([...term].length >= 3 || /\p{N}/u.test(term) || NO_SPACE_SCRIPT.test(term))
			result.push({ term, index: segment.index });
	}
	return result;
}

/** Inflections of one word: "live"/"lives", "indent"/"indentation", "prefer"/"preferred". */
function sameTerm(left: string, right: string): boolean {
	if (left === right) return true;
	if (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left))) return true;
	let common = 0;
	while (common < left.length && common < right.length && left[common] === right[common]) common++;
	return common >= 5;
}

function shares(words: readonly string[], factTerms: readonly string[]): boolean {
	return factTerms.some((fact) => words.some((word) => sameTerm(fact, word)));
}

/**
 * Why the citations cannot carry `fact`, or undefined when they can. Every quote must be found in its source as the
 * owner's stated words (not inside a quotation, code block, blockquote or quote element) with at least
 * {@link MIN_STATED_QUOTE_CHARS} stated letters. When `fact` is known: no fact term may appear in the cited sources
 * only inside shown text (a pasted "I live in Paris" never yields Paris), and a quote whose source states any fact
 * term must itself state one, so a nearby unrelated sentence cannot vouch for the change. Inline code counts as the
 * owner's own words for terms, since that is how identifiers are written. Residual: an unmarked attribution
 * ("my friend says ...") and a fact sharing no terms with its source are left to the semantic judgment.
 */
export function ownerCitationRefusal(
	fact: CitationFact | undefined,
	citations: readonly CitedOwnerWords[],
): string | undefined {
	const factTerms = fact ? terms([fact.subject, fact.key ?? "", fact.text].join(" ")).map(({ term }) => term) : [];
	const stated: string[] = [];
	const shown: string[] = [];
	const quoted: Array<{ source: readonly string[]; quote: readonly string[] }> = [];
	for (const citation of citations) {
		const location = locateOwnerQuote(citation.source, citation.quote);
		if (!location.found || location.shown)
			return "A citation is absent or quotes text the owner showed, rather than stated";
		if ((location.stated.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < MIN_STATED_QUOTE_CHARS)
			return "A citation quotes too little of the owner's own words to state a change";
		const quotation = new Uint8Array(citation.source.length);
		for (const region of ownerShownRegions(citation.source))
			if (!region.inlineCode) quotation.fill(1, region.start, region.end);
		const sourceStated: string[] = [];
		const quoteStated: string[] = [];
		for (const { term, index } of terms(citation.source)) {
			if (quotation[index] === 1) {
				shown.push(term);
				continue;
			}
			sourceStated.push(term);
			if (index >= location.start && index < location.end) quoteStated.push(term);
		}
		stated.push(...sourceStated);
		quoted.push({ source: sourceStated, quote: quoteStated });
	}
	if (factTerms.some((term) => shares(shown, [term]) && !shares(stated, [term])))
		return "The change rests on words the owner only showed or quoted, not on what they stated";
	if (quoted.some(({ source, quote }) => shares(source, factTerms) && !shares(quote, factTerms)))
		return "A citation does not itself state the change: its quote names none of the fact's terms";
	return undefined;
}
