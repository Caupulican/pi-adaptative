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

const SECRET_LIKE_PATTERNS: readonly RegExp[] = [...TOKEN_SHAPE_PATTERNS, ...CONTEXTUAL_SECRET_PATTERNS];

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
	return replaceAllMatches(text, TOKEN_SHAPE_PATTERNS, "[REDACTED_SECRET]");
}

export const MAX_RETAINED_DIAGNOSTIC_CHARS = 240;
const MAX_DIAGNOSTIC_SCAN_CHARS = 4_096;

export function hasSecretLikeText(text: string): boolean {
	return SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

export function redactKnownSecrets(text: string): string {
	return replaceAllMatches(text, SECRET_LIKE_PATTERNS, "[REDACTED]");
}

/** Retain one redacted diagnostic line with bounded regex work and durable output size. */
export function boundedRedactedDiagnosticText(text: string): string | undefined {
	const scanned = text.slice(0, MAX_DIAGNOSTIC_SCAN_CHARS);
	const lineEnd = scanned.search(/[\r\n]/);
	const scanTruncated = lineEnd === -1 && text.length > scanned.length;
	const firstLine = (lineEnd === -1 ? scanned : scanned.slice(0, lineEnd)).trim();
	if (!firstLine) return undefined;
	const redacted = redactKnownSecrets(firstLine);
	if (!scanTruncated && redacted.length <= MAX_RETAINED_DIAGNOSTIC_CHARS) return redacted;
	return `${redacted.slice(0, MAX_RETAINED_DIAGNOSTIC_CHARS - 1)}…`;
}
