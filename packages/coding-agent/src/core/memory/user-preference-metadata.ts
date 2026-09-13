/**
 * The learning metadata a USER.md preference line carries, as one human-readable trailer:
 *
 *     Prefers short status updates. [pref 3f9c1a2b | global | explicit | n=1 | rev=2 | src=a1b2c3d4/entry-7]
 *
 * One line is one fact. The trailer names the fact's stable identity, where it applies (everywhere,
 * or one project by its directory key), whether the owner stated it in their own words or the model
 * inferred it, how many independent owner sources support it, its revision, and the owner source
 * ids that support it (session prefix / session entry id). A line without a trailer is a legacy
 * preference: usable guidance, never presented as evidence-backed. This module only formats and
 * parses; the file-store owns the write transaction and the reflection controller owns admission.
 */

import { createHash } from "node:crypto";

export type UserPreferenceBasis = "explicit" | "inferred" | "unverified";

export type UserPreferenceScope = { kind: "global" } | { kind: "project"; projectKey: string };

export interface UserPreferenceMetadata {
	/** Stable fact identity (8 hex chars), kept across revisions. */
	id: string;
	scope: UserPreferenceScope;
	basis: UserPreferenceBasis;
	/** Distinct owner sources supporting the fact; never a count of repeated proposals. */
	observations: number;
	revision: number;
	/** Bounded owner source ids (`<session8>/<entryId>`), in first-seen order. */
	sources: string[];
	/**
	 * When the newest owner evidence supporting the CURRENT value was said (ISO). The accepted
	 * line is the authority for the freshness fence: evidence not newer than this is a replay of a
	 * superseded instruction. Absent for legacy and unverified lines.
	 */
	evidenceAt?: string;
}

export interface ParsedUserPreferenceLine {
	/** The preference text without its trailer. */
	text: string;
	/** Absent for a legacy (unannotated) line. */
	metadata?: UserPreferenceMetadata;
}

export const MAX_USER_PREFERENCE_SOURCES = 8;
const PROJECT_KEY_RE = /^[a-f0-9]{8,64}$/;
const SOURCE_ID_RE = /^[A-Za-z0-9._:-]{1,16}\/[A-Za-z0-9._:-]{1,64}$/;
const TRAILER_RE =
	/\s\[pref ([a-f0-9]{8}) \| (global|project=[a-f0-9]{8,64}) \| (explicit|inferred|unverified) \| n=(\d{1,3}) \| rev=(\d{1,6})(?: \| at=(\d{4}-\d{2}-\d{2}T[0-9:.]+Z))?(?: \| src=([^\]\s]+))?\]$/;

/**
 * Stable identity for a new fact: a digest of its normalized text, and of its project key when
 * scoped to a project, so identical words in two projects are two facts. A replaced fact keeps
 * its old id.
 */
export function newUserPreferenceId(text: string, scope?: UserPreferenceScope): string {
	const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
	const keyed = scope?.kind === "project" ? `project=${scope.projectKey}\n${normalized}` : normalized;
	return createHash("sha256").update(keyed).digest("hex").slice(0, 8);
}

/** Two scopes name the same applicability set. */
export function sameUserPreferenceScope(left: UserPreferenceScope, right: UserPreferenceScope): boolean {
	return left.kind === "global"
		? right.kind === "global"
		: right.kind === "project" && right.projectKey === left.projectKey;
}

export function isValidOwnerSourceId(value: string): boolean {
	return SOURCE_ID_RE.test(value);
}

export function formatUserPreferenceScope(scope: UserPreferenceScope): string {
	return scope.kind === "global" ? "global" : `project=${scope.projectKey}`;
}

export function parseUserPreferenceScope(value: string, projectKey?: string): UserPreferenceScope | undefined {
	if (value === "global") return { kind: "global" };
	if (value === "project") {
		return projectKey && PROJECT_KEY_RE.test(projectKey) ? { kind: "project", projectKey } : undefined;
	}
	if (value.startsWith("project=")) {
		const key = value.slice("project=".length);
		return PROJECT_KEY_RE.test(key) ? { kind: "project", projectKey: key } : undefined;
	}
	return undefined;
}

export function formatUserPreferenceLine(text: string, metadata: UserPreferenceMetadata): string {
	const sources = metadata.sources.filter(isValidOwnerSourceId).slice(0, MAX_USER_PREFERENCE_SOURCES);
	const trailer = [
		`pref ${metadata.id}`,
		formatUserPreferenceScope(metadata.scope),
		metadata.basis,
		`n=${Math.max(0, Math.min(999, Math.trunc(metadata.observations)))}`,
		`rev=${Math.max(1, Math.min(999_999, Math.trunc(metadata.revision)))}`,
		...(metadata.evidenceAt && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(metadata.evidenceAt)
			? [`at=${metadata.evidenceAt}`]
			: []),
		...(sources.length > 0 ? [`src=${sources.join(",")}`] : []),
	].join(" | ");
	return `${stripUserPreferenceMetadata(text).trim()} [${trailer}]`;
}

export function parseUserPreferenceLine(line: string): ParsedUserPreferenceLine {
	const trimmed = line.trim();
	const match = TRAILER_RE.exec(trimmed);
	if (!match) return { text: trimmed };
	const scope = parseUserPreferenceScope(match[2]);
	if (!scope) return { text: trimmed };
	const sources = (match[7] ?? "")
		.split(",")
		.filter((source) => source.length > 0 && isValidOwnerSourceId(source))
		.slice(0, MAX_USER_PREFERENCE_SOURCES);
	return {
		text: trimmed.slice(0, trimmed.length - match[0].length).trim(),
		metadata: {
			id: match[1],
			scope,
			basis: match[3] as UserPreferenceBasis,
			observations: Number.parseInt(match[4], 10),
			revision: Number.parseInt(match[5], 10),
			sources,
			...(match[6] ? { evidenceAt: match[6] } : {}),
		},
	};
}

/** The preference text of a line, trailer removed; a legacy line is returned trimmed. */
export function stripUserPreferenceMetadata(line: string): string {
	return parseUserPreferenceLine(line).text;
}

/** Host-checked applicability: a project-scoped fact applies only inside the project it names. */
export function isUserPreferenceApplicable(metadata: UserPreferenceMetadata | undefined, projectKey: string): boolean {
	if (!metadata || metadata.scope.kind === "global") return true;
	return metadata.scope.projectKey === projectKey;
}

/**
 * Honest strength label for prompts: what the fact rests on, never a probability. A legacy line
 * has no label; an unverified line says so.
 */
export function describeUserPreferenceStrength(metadata: UserPreferenceMetadata | undefined): string {
	if (!metadata) return "";
	if (metadata.basis === "explicit") return "explicit";
	if (metadata.basis === "inferred") {
		return `inferred, ${metadata.observations} independent observation${metadata.observations === 1 ? "" : "s"}`;
	}
	return "unverified";
}

/**
 * One prompt line for a preference: text plus its strength label, trailer omitted. A legacy line
 * keeps the USER.md section it was written under (`section`, the nearest heading path) as
 * rendered context, because that heading is the only scope its author gave it; an annotated line
 * carries machine-verified scope and never borrows a heading.
 */
export function renderUserPreferenceForPrompt(parsed: ParsedUserPreferenceLine, section?: string): string {
	const strength = describeUserPreferenceStrength(parsed.metadata);
	const text = parsed.text.replace(/^[-*+]\s+/, "");
	if (parsed.metadata) return strength ? `- ${text} (${strength})` : `- ${text}`;
	return section ? `- ${section}: ${text}` : `- ${text}`;
}

/** Maximum rendered length of a legacy line's section context. */
export const MAX_USER_PREFERENCE_SECTION_CHARS = 80;

/**
 * Preference lines of a USER.md body with the nearest heading path each sits under. Headings are
 * context for legacy lines only; the file's own title ("User profile", the archive pointer's
 * heading) is not a section. Blank lines and the archive pointer line are skipped. Lines are
 * returned verbatim: matching and mutation keep working on the literal text.
 */
export function collectUserPreferenceEntries(body: string): Array<{ line: string; section?: string }> {
	const entries: Array<{ line: string; section?: string }> = [];
	const stack: Array<{ level: number; title: string }> = [];
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("Archived preferences:")) continue;
		const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) stack.pop();
			const title = heading[2].replace(/\s+/g, " ");
			if (!(level === 1 && title.toLowerCase() === "user profile")) stack.push({ level, title });
			continue;
		}
		if (line.startsWith("#")) continue;
		const section = stack.map((entry) => entry.title).join(" › ");
		entries.push(
			section.length > 0
				? {
						line,
						section:
							section.length > MAX_USER_PREFERENCE_SECTION_CHARS
								? `${section.slice(0, MAX_USER_PREFERENCE_SECTION_CHARS - 1)}…`
								: section,
					}
				: { line },
		);
	}
	return entries;
}

/** One owner-source citation a preference write carries: a source id the host knows, and optionally the words. */
export interface UserPreferenceEvidenceCitation {
	source: string;
	quote?: string;
}

/** What the memory tool asks the admission owner (the reflection controller) before a USER.md write. */
export interface UserPreferenceAdmissionRequest {
	action: "add" | "replace" | "remove";
	/** The new preference text (empty for remove). */
	text: string;
	/** The line the write supersedes or removes, when one matched. */
	existing?: ParsedUserPreferenceLine;
	scope: UserPreferenceScope;
	/** The basis the writer claims; the host verifies it against the cited owner words. */
	basis: "explicit" | "inferred";
	evidence: UserPreferenceEvidenceCitation[];
}

/** What the storage owner reports back once the admitted write reached its terminal outcome. */
export type UserPreferenceCommitReport = { persisted: true } | { persisted: false; error: string };

export type UserPreferenceAdmissionResult =
	| {
			outcome: "apply";
			metadata: UserPreferenceMetadata;
			reasonCode: string;
			/**
			 * Publication boundary: the storage owner calls it exactly once with the actual result of the
			 * commit. The audit record ("apply" with a rollback plan, or "apply_failed") is written here,
			 * never before persistence; a second call is ignored.
			 */
			commit?: (report: UserPreferenceCommitReport) => void;
	  }
	| { outcome: "candidate"; reasonCode: string; message: string };
