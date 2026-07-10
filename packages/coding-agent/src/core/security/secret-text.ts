/** High-confidence credential shapes shared by outbound-query gates and diagnostic redaction. */
const SECRET_LIKE_PATTERNS: readonly RegExp[] = [
	/\bsk-(?:proj-|ant-)?[A-Za-z0-9._-]{8,}\b/i,
	/\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/i,
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
	/\b(?:npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,})\b/i,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
	/[?&](?:x-amz-signature|x-goog-signature|signature|sig|access_token|api[_-]?key|token|secret|password)=[^&\s]+/i,
	/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|account[_-]?key|private[_-]?key|sharedaccesssignature|authorization|credential|secret|password)\b\s*[:=]\s*\S+/i,
];

export function hasSecretLikeText(text: string): boolean {
	return SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

export function redactKnownSecrets(text: string): string {
	let redacted = text;
	for (const pattern of SECRET_LIKE_PATTERNS) {
		redacted = redacted.replace(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`), "[REDACTED]");
	}
	return redacted;
}
