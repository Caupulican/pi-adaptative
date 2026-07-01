import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { MemoryScope } from "./context-item.ts";
import type {
	MemoryEvidenceRef,
	MemoryItem,
	MemoryItemKind,
	MemoryRef,
	MemoryWriteRequest,
} from "./memory-provider-contract.ts";

export const PI_OKF_PROVIDER_ID = "pi-okf";

export const PI_OKF_AUTHORITY = "durable_memory";

export const PI_OKF_TYPES = [
	"Design Decision",
	"Architecture Concept",
	"Project Rule Candidate",
	"Implementation Note",
	"Debugging Finding",
	"Invalidated Assumption",
	"Tooling Playbook",
	"External Reference",
	"User Preference",
	"Capability Doc",
] as const;

export type PiOkfType = (typeof PI_OKF_TYPES)[number];

export type OkfMemoryDiagnosticCode =
	| "missing_frontmatter"
	| "invalid_frontmatter"
	| "invalid_yaml"
	| "missing_type"
	| "unknown_type"
	| "missing_title"
	| "missing_description"
	| "missing_pi"
	| "invalid_scope"
	| "invalid_authority"
	| "invalid_evidence_refs";

export interface OkfMemoryDiagnostic {
	code: OkfMemoryDiagnosticCode;
	message: string;
}

export interface ParseOkfMemoryOptions {
	providerId?: string;
	uri?: string;
	fallbackId?: string;
}

export interface ParsedOkfMemoryDocument {
	item?: MemoryItem;
	body: string;
	diagnostics: OkfMemoryDiagnostic[];
}

export interface OkfMemoryDocumentInput {
	type: PiOkfType;
	title: string;
	description: string;
	scope: MemoryScope;
	body: string;
	tags?: string[];
	timestamp?: string;
	evidenceRefs?: string[];
}

export interface OkfProjectRulePromotionRequest {
	item: MemoryItem;
	approvalId?: string;
	trustedConfigPath?: string;
}

export type OkfProjectRulePromotionRejection =
	| "not_project_rule_candidate"
	| "missing_explicit_promotion_authority"
	| "stale_or_conflicting_memory";

const OKF_TYPE_TO_MEMORY_KIND = new Map<PiOkfType, MemoryItemKind>([
	["Design Decision", "design_decision"],
	["Architecture Concept", "architecture_concept"],
	["Project Rule Candidate", "project_rule_candidate"],
	["Implementation Note", "fact"],
	["Debugging Finding", "debugging_finding"],
	["Invalidated Assumption", "invalidated_assumption"],
	["Tooling Playbook", "procedure"],
	["External Reference", "reference"],
	["User Preference", "user_preference"],
	["Capability Doc", "reference"],
]);

const VALID_SCOPES: readonly MemoryScope[] = ["session", "project", "user", "global"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function memoryItemKindForOkfType(type: string): MemoryItemKind | undefined {
	return OKF_TYPE_TO_MEMORY_KIND.get(type as PiOkfType);
}

function memoryIdForDocument(
	providerId: string,
	uri: string | undefined,
	title: string,
	timestamp: string | undefined,
): string {
	return createHash("sha256")
		.update([providerId, uri ?? "", title, timestamp ?? ""].join("\0"))
		.digest("hex")
		.slice(0, 24);
}

function evidenceRefsFromOkf(providerId: string, refs: string[] | undefined): MemoryEvidenceRef[] {
	return (refs ?? []).map((ref) => ({ type: "external", id: ref, providerId, description: "OKF evidence_ref" }));
}

function buildMemoryRef(
	providerId: string,
	id: string,
	scope: MemoryScope,
	kind: MemoryItemKind,
	uri?: string,
): MemoryRef {
	return { providerId, itemId: id, scope, kind, uri };
}

function validScope(value: string | undefined): MemoryScope | undefined {
	return value !== undefined && VALID_SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : undefined;
}

export function parseOkfMemoryDocument(content: string, options: ParseOkfMemoryOptions = {}): ParsedOkfMemoryDocument {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		const parsed = parseFrontmatter(content);
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		return {
			body: content,
			diagnostics: [{ code: "invalid_yaml", message: error instanceof Error ? error.message : String(error) }],
		};
	}

	const diagnostics: OkfMemoryDiagnostic[] = [];
	if (!isRecord(frontmatter) || Object.keys(frontmatter).length === 0) {
		return { body, diagnostics: [{ code: "missing_frontmatter", message: "OKF memory requires YAML frontmatter." }] };
	}

	const type = stringField(frontmatter, "type");
	if (type === undefined) diagnostics.push({ code: "missing_type", message: "OKF memory requires a type." });
	const kind = type === undefined ? undefined : memoryItemKindForOkfType(type);
	if (type !== undefined && kind === undefined)
		diagnostics.push({ code: "unknown_type", message: `Unknown Pi OKF type: ${type}` });

	const title = stringField(frontmatter, "title");
	if (title === undefined) diagnostics.push({ code: "missing_title", message: "OKF memory requires a title." });
	const description = stringField(frontmatter, "description");
	if (description === undefined)
		diagnostics.push({ code: "missing_description", message: "OKF memory requires a description." });

	const pi = frontmatter.pi;
	if (!isRecord(pi)) diagnostics.push({ code: "missing_pi", message: "OKF memory requires a pi block." });
	const scope = isRecord(pi) ? validScope(stringField(pi, "scope")) : undefined;
	if (isRecord(pi) && scope === undefined)
		diagnostics.push({ code: "invalid_scope", message: "pi.scope must be session, project, user, or global." });
	const authority = isRecord(pi) ? stringField(pi, "authority") : undefined;
	if (isRecord(pi) && authority !== PI_OKF_AUTHORITY) {
		diagnostics.push({ code: "invalid_authority", message: `pi.authority must be ${PI_OKF_AUTHORITY}.` });
	}
	const evidenceRefs = isRecord(pi) ? stringArrayField(pi, "evidence_refs") : undefined;
	if (isRecord(pi) && pi.evidence_refs !== undefined && evidenceRefs === undefined) {
		diagnostics.push({ code: "invalid_evidence_refs", message: "pi.evidence_refs must be a string array." });
	}

	if (
		diagnostics.length > 0 ||
		kind === undefined ||
		title === undefined ||
		description === undefined ||
		scope === undefined
	) {
		return { body, diagnostics };
	}

	const providerId = options.providerId ?? PI_OKF_PROVIDER_ID;
	const timestamp = stringField(frontmatter, "timestamp");
	const id = options.fallbackId ?? memoryIdForDocument(providerId, options.uri, title, timestamp);
	const ref = buildMemoryRef(providerId, id, scope, kind, options.uri);
	return {
		body,
		diagnostics,
		item: {
			id,
			providerId,
			source: "pi_native",
			kind,
			scope,
			durability: "durable",
			title,
			summary: description,
			content: body.length > 0 ? body : undefined,
			refs: [ref],
			evidenceRefs: evidenceRefsFromOkf(providerId, evidenceRefs),
			timestamp,
		},
	};
}

export function formatOkfMemoryDocument(input: OkfMemoryDocumentInput): string {
	const frontmatter = {
		type: input.type,
		title: input.title,
		description: input.description,
		tags: input.tags,
		timestamp: input.timestamp,
		pi: {
			scope: input.scope,
			authority: PI_OKF_AUTHORITY,
			evidence_refs: input.evidenceRefs ?? [],
		},
	};
	return `---\n${stringify(frontmatter).trim()}\n---\n\n${input.body.trim()}\n`;
}

export function okfMemoryItemToWriteRequest(item: MemoryItem, reason: string): MemoryWriteRequest {
	return {
		providerId: item.providerId,
		scope: item.scope,
		kind: item.kind,
		title: item.title,
		summary: item.summary,
		content: item.content,
		evidenceRefs: item.evidenceRefs,
		sensitivity: "normal",
		reason,
	};
}

export function validateOkfProjectRulePromotion(
	request: OkfProjectRulePromotionRequest,
): OkfProjectRulePromotionRejection[] {
	const rejections: OkfProjectRulePromotionRejection[] = [];
	if (request.item.kind !== "project_rule_candidate") rejections.push("not_project_rule_candidate");
	if (request.approvalId === undefined && request.trustedConfigPath === undefined) {
		rejections.push("missing_explicit_promotion_authority");
	}
	if (request.item.stale || request.item.conflict !== undefined) rejections.push("stale_or_conflicting_memory");
	return rejections;
}
