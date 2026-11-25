import { boundedLine, boundedText } from "../util/bounded-line.ts";

/** High-confidence credential shapes shared by outbound-query gates and diagnostic redaction. */
/** Provider-issued token and key formats that are unambiguous in any text, source code included. */
const TOKEN_SHAPE_PATTERNS: readonly RegExp[] = [
	/\bpair1\.[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{44}(?![A-Za-z0-9_-])/,
	/\bsk-(?:proj-|ant-)?[A-Za-z0-9._-]{8,}\b/i,
	/\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/i,
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
	/\b(?:npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,})\b/i,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
	// A Slack app-level token: the prefix and 20+ token characters never occur in prose, so the transcript filter drops it too.
	/\bxapp-[A-Za-z0-9-]{20,}\b/i,
	// A Google OAuth client secret and a Google access token: neither prefix with 20+ token characters occurs in prose.
	/\bGOCSPX-[A-Za-z0-9_-]{20,}/,
	// An access token may hold dots, slashes and the like inside (`ya29.c.…`): all of it is masked, a trailing dot is not.
	/\bya29\.(?=[A-Za-z0-9._~+/-]{20})[A-Za-z0-9_-]*(?:[.~+/]+[A-Za-z0-9_-]+)*=*/,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
	/https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

// Ordinary command output can quote a password in prose. Consume escapes, spaces and a partial
// final value as a unit so that a streamed preview never exposes the unfinished suffix.
const QUOTED_PASSWORD =
	/\b(?:password|passwd|passphrase)\b(?:[ \t]*[:=][ \t]*|[ \t]+(?:is[ \t]+)?)(?:"(?:\\[^\r\n]?|[^"\\\r\n])*"?|'(?:\\[^\r\n]?|[^'\\\r\n])*'?)/i;

const GLOBAL_QUOTED_PASSWORD = globalPatterns([QUOTED_PASSWORD]);

/** Old tool results can reach the provider again after a session is reopened. */
export function redactQuotedPasswords(text: string): string {
	return replaceAllMatches(text, GLOBAL_QUOTED_PASSWORD, "[REDACTED]");
}

/** Shapes that need surrounding words to be a credential; fine for diagnostics, too noisy for source text. */
const CONTEXTUAL_SECRET_PATTERNS: readonly RegExp[] = [
	QUOTED_PASSWORD,
	/[?&](?:x-amz-signature|x-goog-signature|signature|sig|access_token|api[_-]?key|key|token|secret|password)=[^&\s]+/i,
	/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|account[_-]?key|private[_-]?key|sharedaccesssignature|authorization|credential|secret|password)\b\s*[:=]\s*\S+/i,
];

/**
 * Formats masked in text bound for a model but kept by the transcript filter (hasSecretLikeText), so exact history recall
 * still holds the owner's own text while the outgoing request does not carry the key.
 */
const OUTBOUND_ONLY_TOKEN_SHAPES: readonly RegExp[] = [
	/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_])/,
	/\bglpat-[0-9A-Za-z_-]{20,}(?![0-9A-Za-z_])/,
	// A Telegram bot token, bare or inside a Bot API URL path (`/bot<token>/`), where no word boundary precedes it. A bot id has at
	// least eight digits; fewer would also match a seven-digit process id before a UUID (`pi-worker:<pid>:<uuid>`).
	/(?:(?<=\/bot)|(?<![A-Za-z0-9_]))\d{8,12}:[A-Za-z0-9_-]{30,64}(?![A-Za-z0-9_-])/,
	// A Google refresh token. `1//` followed by an identifier also reads as floor division in source text.
	/(?<![A-Za-z0-9_])1\/\/[A-Za-z0-9_-]{40,}/,
];

const SECRET_LIKE_PATTERNS: readonly RegExp[] = [...TOKEN_SHAPE_PATTERNS, ...CONTEXTUAL_SECRET_PATTERNS];
/**
 * Everything masked or refused when text leaves the transcript: the transcript filter's patterns plus the outbound-only
 * shapes. The transcript filter itself ({@link hasSecretLikeText}) stays narrower on purpose, so exact recall keeps the
 * owner's own text; diagnostics, outgoing model text and the memory write/query gates use this wider set.
 */
const SECRET_MASK_PATTERNS: readonly RegExp[] = [...SECRET_LIKE_PATTERNS, ...OUTBOUND_ONLY_TOKEN_SHAPES];
const GLOBAL_SECRET_MASKS = globalPatterns(SECRET_MASK_PATTERNS);
const GLOBAL_TOKEN_SHAPES = globalPatterns([...TOKEN_SHAPE_PATTERNS, ...OUTBOUND_ONLY_TOKEN_SHAPES]);

function globalPatterns(patterns: readonly RegExp[]): RegExp[] {
	return patterns.map((pattern) => new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
}

function replaceAllMatches(text: string, patterns: readonly RegExp[], replacement: string): string {
	let redacted = text;
	for (const pattern of patterns) {
		redacted = redacted.replace(pattern, replacement);
	}
	return redacted;
}

/**
 * Masks unambiguous provider token formats, including keys the host has never seen. This is the
 * mechanical floor for text bound for a model: it needs no credential inventory and no judgment.
 */
export function redactTokenShapes(text: string): string {
	return replaceAllMatches(text, GLOBAL_TOKEN_SHAPES, "[REDACTED_SECRET]");
}

/** Reuse clean token-shape checks within one session after the current credential inventory has been applied. */
export function createTokenShapeRedactor(): (text: string) => string {
	const checked = new Set<string>();
	let remaining = 256 * 1024;
	return (text) => {
		const cacheable = text.length >= 128;
		if (cacheable && checked.has(text)) return text;
		const redacted = redactTokenShapes(text);
		if (cacheable && redacted === text && checked.size < 1024 && text.length <= remaining) {
			checked.add(text);
			remaining -= text.length;
		}
		return redacted;
	};
}

export const MAX_RETAINED_DIAGNOSTIC_CHARS = 240;

export function hasSecretLikeText(text: string): boolean {
	return SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Whether text carries a shape that must not be stored by a memory write or sent in a memory query (the wider set). */
export function hasMaskableSecretText(text: string): boolean {
	return SECRET_MASK_PATTERNS.some((pattern) => pattern.test(text));
}

export function redactKnownSecrets(text: string): string {
	return replaceAllMatches(text, GLOBAL_SECRET_MASKS, "[REDACTED]");
}

/**
 * Text a record or a notice keeps: cleaned, then redacted, then bounded, in that order, so a cut never leaves the prefix of
 * a masked token and a token split by a character is matched whole. Invisible control and format characters and lone
 * surrogates are deleted (a space would split the token); a line break or tab is one space, or with `lines` a break is kept
 * and a carriage return becomes a line feed. Idempotent: clean text comes back unchanged. Empty when nothing is left.
 */
export function cleanRedactBound(text: string, maxChars: number, options?: { readonly lines?: boolean }): string {
	const cleaned = options?.lines
		? text
				.replace(/\r\n?/gu, "\n")
				.replace(/[\t\v\f]/gu, " ")
				.replace(/(?!\n)[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
		: text.replace(/[\t\n\v\f\r]/gu, " ").replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "");
	const redacted = redactKnownSecrets(redactTokenShapes(cleaned));
	return options?.lines ? boundedText(redacted.trim(), maxChars) : boundedLine(redacted, maxChars);
}

/**
 * Retain one redacted diagnostic line: the first line only, cleaned (the control and format characters that split a
 * secret are deleted, so the redaction matches it whole), then redacted, then bounded, in that order. The rest of the text
 * after the first line is never retained. Undefined when nothing is left. The masks are the diagnostic ones
 * (`redactKnownSecrets` holds every token shape), and a long line keeps its head.
 */
export function boundedRedactedDiagnosticText(text: string): string | undefined {
	const lineEnd = text.search(/[\r\n]/);
	const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd);
	const cleaned = firstLine
		.replace(/[\t\v\f]/gu, " ")
		.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
		.trim();
	if (!cleaned) return undefined;
	const redacted = redactKnownSecrets(cleaned);
	if (redacted.length <= MAX_RETAINED_DIAGNOSTIC_CHARS) return redacted;
	return `${redacted.slice(0, MAX_RETAINED_DIAGNOSTIC_CHARS - 1)}…`;
}
