/** High-confidence credential shapes shared by outbound-query gates and diagnostic redaction. */
/** Provider-issued token and key formats that are unambiguous in any text, source code included. */
const TOKEN_SHAPE_PATTERNS: readonly RegExp[] = [
	/\bsk-(?:proj-|ant-)?[A-Za-z0-9._-]{8,}\b/i,
	/\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/i,
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
	/\b(?:npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,})\b/i,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
	/https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

/** Shapes that need surrounding words to be a credential; fine for diagnostics, too noisy for source text. */
const CONTEXTUAL_SECRET_PATTERNS: readonly RegExp[] = [
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
];

const SECRET_LIKE_PATTERNS: readonly RegExp[] = [...TOKEN_SHAPE_PATTERNS, ...CONTEXTUAL_SECRET_PATTERNS];
/**
 * Everything masked or refused when text leaves the transcript: the transcript filter's patterns plus the outbound-only
 * shapes. The transcript filter itself ({@link hasSecretLikeText}) stays narrower on purpose, so exact recall keeps the
 * owner's own text; diagnostics, outgoing model text and the memory write/query gates use this wider set.
 */
const SECRET_MASK_PATTERNS: readonly RegExp[] = [...SECRET_LIKE_PATTERNS, ...OUTBOUND_ONLY_TOKEN_SHAPES];

function replaceAllMatches(text: string, patterns: readonly RegExp[], replacement: string): string {
	let redacted = text;
	for (const pattern of patterns) {
		redacted = redacted.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), replacement);
	}
	return redacted;
}

/**
 * Masks unambiguous provider token formats, including keys the host has never seen. This is the
 * mechanical floor for text bound for a model: it needs no credential inventory and no judgment.
 */
export function redactTokenShapes(text: string): string {
	return replaceAllMatches(text, [...TOKEN_SHAPE_PATTERNS, ...OUTBOUND_ONLY_TOKEN_SHAPES], "[REDACTED_SECRET]");
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
	return replaceAllMatches(text, SECRET_MASK_PATTERNS, "[REDACTED]");
}

/**
 * Retain one redacted diagnostic line. The whole first line is redacted before anything is retained: a secret that
 * begins inside the retained prefix but ends past any scan cut would otherwise survive as its unmatched prefix.
 * Only the redacted text is truncated, so a cut can never reveal a secret.
 */
export function boundedRedactedDiagnosticText(text: string): string | undefined {
	const lineEnd = text.search(/[\r\n]/);
	const firstLine = (lineEnd === -1 ? text : text.slice(0, lineEnd)).trim();
	if (!firstLine) return undefined;
	const redacted = redactKnownSecrets(firstLine);
	if (redacted.length <= MAX_RETAINED_DIAGNOSTIC_CHARS) return redacted;
	return `${redacted.slice(0, MAX_RETAINED_DIAGNOSTIC_CHARS - 1)}…`;
}
