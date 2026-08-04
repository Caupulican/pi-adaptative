/**
 * Pure text boundary for context and durable-memory threat screening.
 *
 * Memory providers run during ordinary session construction, so this module must remain independent
 * from resource discovery, themes, package management, Jiti, and extension loading.
 */

export type ThreatScope = "context" | "strict";

const THREAT_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp; scope: ThreatScope }> = [
	{
		label: "instruction override",
		pattern:
			/\b(?:ignore|disregard|override|bypass)\b.{0,80}\b(?:previous|prior|above|system|developer|agent)\b.{0,80}\binstructions?\b/i,
		scope: "context",
	},
	{
		label: "secret exfiltration",
		pattern:
			/\b(?:reveal|print|dump|exfiltrate|send|upload)\b.{0,80}\b(?:secrets?|tokens?|api[_ -]?keys?|credentials?|environment variables?|\.env)\b/i,
		scope: "context",
	},
	{
		label: "hidden instruction",
		pattern: /\b(?:do not tell|don't tell|hide this from)\b.{0,80}\b(?:user|operator|developer)\b/i,
		scope: "context",
	},
	{
		label: "role hijack",
		pattern: /\byou\s+are\s+(?:\w+\s+){0,4}now\s+(?:a|an|the)\s+\w+/i,
		scope: "context",
	},
	{
		label: "system prompt leak",
		pattern: /\b(?:output|print|reveal|repeat|show)\b.{0,40}\b(?:system|initial|developer)\b.{0,20}\bprompt\b/i,
		scope: "context",
	},
	{
		label: "credential exfil command",
		pattern:
			/\b(?:curl|wget|fetch|invoke-webrequest|nc)\b.{0,100}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
		scope: "strict",
	},
	{
		label: "ssh backdoor",
		pattern: /authorized_keys|(?:~|\$HOME)\/\.ssh\b/i,
		scope: "strict",
	},
	{
		label: "secret file read",
		pattern: /\bcat\b.{0,40}(?:\.env\b|\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials)/i,
		scope: "strict",
	},
	{
		label: "data exfil to url",
		pattern: /\b(?:send|post|upload|exfiltrate|transmit|curl|wget)\b.{0,80}https?:\/\//i,
		scope: "strict",
	},
];

/** Excludes ZWNJ, ZWJ, LRM, and RLM because they are load-bearing in international text and emoji. */
const INVISIBLE_UNICODE_RE = /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

export function hasInvisibleUnicode(content: string): boolean {
	INVISIBLE_UNICODE_RE.lastIndex = 0;
	return INVISIBLE_UNICODE_RE.test(content);
}

export function stripInvisibleUnicode(content: string): { cleaned: string; removed: number } {
	let removed = 0;
	const cleaned = content.replace(INVISIBLE_UNICODE_RE, () => {
		removed++;
		return "";
	});
	return { cleaned, removed };
}

export function scanContextFileThreats(content: string, scope: ThreatScope = "context"): string[] {
	return THREAT_PATTERNS.filter(
		(candidate) => (scope === "strict" || candidate.scope === "context") && candidate.pattern.test(content),
	).map(({ label }) => label);
}
