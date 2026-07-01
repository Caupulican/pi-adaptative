import {
	type ContextEvidenceRef,
	type ContextItem,
	type ContextMemoryRef,
	estimateByteLength,
	estimateTokensFromText,
	type MemoryScope,
} from "./context-item.ts";

export type MemoryProviderSource = "pi_native" | "custom_local" | "external_provider" | "transcript_recall";

export type MemoryDurability = "ephemeral" | "working" | "durable";

export type MemoryItemKind =
	| "user_preference"
	| "project_rule_candidate"
	| "design_decision"
	| "architecture_concept"
	| "procedure"
	| "fact"
	| "debugging_finding"
	| "invalidated_assumption"
	| "reference";

export interface MemoryProviderCapabilities {
	search: boolean;
	fetch: boolean;
	write: boolean;
	delete: boolean;
	shortTerm: boolean;
	longTerm: boolean;
	graph: boolean;
	citations: boolean;
	scopes: MemoryScope[];
	/** True when queries stay on the local machine and do not leave Pi/user-controlled storage. */
	localOnly: boolean;
}

export interface MemoryRef extends ContextMemoryRef {}

export type MemoryEvidenceRef =
	| ContextEvidenceRef
	| { type: "external"; id: string; providerId?: string; uri?: string; description?: string };

export interface MemorySearchRequest {
	query: string;
	scope?: MemoryScope;
	kinds?: MemoryItemKind[];
	maxResults: number;
	activeGoalId?: string;
	pathScope?: string[];
}

export interface MemoryItem {
	id: string;
	providerId: string;
	source: MemoryProviderSource;
	kind: MemoryItemKind;
	scope: MemoryScope;
	durability: MemoryDurability;
	title?: string;
	summary: string;
	/** Optional full content. It is not prompt-included by default; callers must fetch/budget explicitly. */
	content?: string;
	refs: MemoryRef[];
	evidenceRefs: MemoryEvidenceRef[];
	confidence?: "low" | "medium" | "high";
	timestamp?: string;
	expiresAt?: string;
	conflict?: string;
	stale?: boolean;
}

export interface MemorySearchResult {
	item: MemoryItem;
	score: number;
	reason: string;
}

export interface MemoryProvider {
	id: string;
	label: string;
	source: MemoryProviderSource;
	capabilities: MemoryProviderCapabilities;
	search(request: MemorySearchRequest): Promise<MemorySearchResult[]>;
	fetch(ref: MemoryRef): Promise<MemoryItem | undefined>;
	proposeWrite?(request: MemoryWriteRequest): Promise<MemoryWritePreview>;
	write?(approved: ApprovedMemoryWrite): Promise<MemoryWriteResult>;
}

export interface MemoryWriteRequest {
	providerId: string;
	scope: MemoryScope;
	kind: MemoryItemKind;
	title?: string;
	summary: string;
	content?: string;
	evidenceRefs: MemoryEvidenceRef[];
	sensitivity: "normal" | "private" | "secret";
	reason: string;
}

export interface MemoryWritePreview {
	request: MemoryWriteRequest;
	wouldCreateRef?: MemoryRef;
	requiresApproval: boolean;
	rejectionReasons: MemoryPolicyRejectionReason[];
}

export interface ApprovedMemoryWrite {
	request: MemoryWriteRequest;
	approvalId: string;
	approvedAt: string;
	approvedBy: "user" | "policy";
}

export interface MemoryWriteResult {
	ref: MemoryRef;
	created: boolean;
	message: string;
}

export type MemoryPolicyRejectionReason =
	| "provider_disabled"
	| "provider_not_searchable"
	| "provider_not_fetchable"
	| "provider_not_writable"
	| "provider_scope_unsupported"
	| "policy_scope_blocked"
	| "external_egress_blocked"
	| "query_payload_disabled"
	| "query_too_large"
	| "secret_like_query"
	| "secret_write_rejected"
	| "missing_evidence"
	| "durable_write_requires_approval"
	| "external_write_requires_approval"
	| "missing_approval";

export interface MemoryEgressPolicy {
	enabled: boolean;
	allowedScopes: MemoryScope[];
	allowExternalEgress: boolean;
	allowQueryText: boolean;
	maxOutboundChars: number;
	redactSecretLikeText: boolean;
}

export const DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY: MemoryEgressPolicy = {
	enabled: false,
	allowedScopes: [],
	allowExternalEgress: false,
	allowQueryText: true,
	maxOutboundChars: 2_000,
	redactSecretLikeText: true,
};

export const DEFAULT_LOCAL_MEMORY_EGRESS_POLICY: MemoryEgressPolicy = {
	enabled: true,
	allowedScopes: ["session", "project", "user", "global"],
	allowExternalEgress: false,
	allowQueryText: true,
	maxOutboundChars: 4_000,
	redactSecretLikeText: true,
};

const SECRET_LIKE_PATTERNS: readonly RegExp[] = [
	/\b(?:api[_-]?key|access[_-]?token|secret|password)\b\s*[:=]\s*\S+/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function hasSecretLikeMemoryText(text: string): boolean {
	return SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

export function validateMemorySearchRequest(
	provider: Pick<MemoryProvider, "source" | "capabilities">,
	policy: MemoryEgressPolicy,
	request: MemorySearchRequest,
): MemoryPolicyRejectionReason[] {
	const reasons: MemoryPolicyRejectionReason[] = [];
	if (!policy.enabled) reasons.push("provider_disabled");
	if (!provider.capabilities.search) reasons.push("provider_not_searchable");
	if (!policy.allowQueryText) reasons.push("query_payload_disabled");
	if (request.query.length > policy.maxOutboundChars) reasons.push("query_too_large");
	if (policy.redactSecretLikeText && hasSecretLikeMemoryText(request.query)) reasons.push("secret_like_query");
	if (provider.source === "external_provider" && !provider.capabilities.localOnly && !policy.allowExternalEgress) {
		reasons.push("external_egress_blocked");
	}
	if (request.scope !== undefined) {
		if (!provider.capabilities.scopes.includes(request.scope)) reasons.push("provider_scope_unsupported");
		if (!policy.allowedScopes.includes(request.scope)) reasons.push("policy_scope_blocked");
	}
	return reasons;
}

export function previewMemoryWrite(
	provider: Pick<MemoryProvider, "source" | "capabilities" | "id">,
	policy: MemoryEgressPolicy,
	request: MemoryWriteRequest,
): MemoryWritePreview {
	const rejectionReasons: MemoryPolicyRejectionReason[] = [];
	if (!policy.enabled) rejectionReasons.push("provider_disabled");
	if (!provider.capabilities.write) rejectionReasons.push("provider_not_writable");
	if (!provider.capabilities.scopes.includes(request.scope)) rejectionReasons.push("provider_scope_unsupported");
	if (!policy.allowedScopes.includes(request.scope)) rejectionReasons.push("policy_scope_blocked");
	if (provider.source === "external_provider" && !policy.allowExternalEgress) {
		rejectionReasons.push("external_egress_blocked");
	}
	if (request.sensitivity === "secret" || hasSecretLikeMemoryText(`${request.summary}\n${request.content ?? ""}`)) {
		rejectionReasons.push("secret_write_rejected");
	}
	if (request.evidenceRefs.length === 0) rejectionReasons.push("missing_evidence");

	const requiresApproval =
		request.scope === "project" ||
		request.scope === "user" ||
		request.sensitivity !== "normal" ||
		provider.source === "external_provider";
	if (requiresApproval && (request.scope === "project" || request.scope === "user")) {
		rejectionReasons.push("durable_write_requires_approval");
	}
	if (requiresApproval && provider.source === "external_provider") {
		rejectionReasons.push("external_write_requires_approval");
	}

	return { request, requiresApproval, rejectionReasons };
}

export function validateApprovedMemoryWrite(
	provider: Pick<MemoryProvider, "source" | "capabilities" | "id">,
	policy: MemoryEgressPolicy,
	approved: ApprovedMemoryWrite,
): MemoryPolicyRejectionReason[] {
	const preview = previewMemoryWrite(provider, policy, approved.request);
	const reasons = preview.rejectionReasons.filter(
		(reason) => reason !== "durable_write_requires_approval" && reason !== "external_write_requires_approval",
	);
	if (preview.requiresApproval && approved.approvalId.trim().length === 0) reasons.push("missing_approval");
	return reasons;
}

export function sourceLabelForMemoryItem(item: MemoryItem): string {
	const freshness = item.stale ? "/stale" : item.conflict ? "/conflict" : "";
	return `${item.providerId}/${item.scope}/${item.kind}${freshness}`;
}

function memorySourceToContextSource(source: MemoryProviderSource): ContextItem["source"] {
	return source === "external_provider" ? "external_provider" : "memory";
}

function contextEvidenceRefs(evidenceRefs: readonly MemoryEvidenceRef[]): ContextEvidenceRef[] {
	return evidenceRefs.filter((ref): ref is ContextEvidenceRef => ref.type !== "external");
}

export function memorySearchResultToContextItem(result: MemorySearchResult, createdAtTurn: number): ContextItem {
	const item = result.item;
	const label = sourceLabelForMemoryItem(item);
	const flags = [item.stale ? "stale" : undefined, item.conflict ? `conflict: ${item.conflict}` : undefined]
		.filter((flag): flag is string => flag !== undefined)
		.join("; ");
	const summary = flags.length > 0 ? `[${label}] ${item.summary} (${flags})` : `[${label}] ${item.summary}`;
	const primaryRef: ContextMemoryRef = item.refs[0] ?? {
		providerId: item.providerId,
		itemId: item.id,
		scope: item.scope,
		kind: item.kind,
	};

	return {
		id: `memory:${item.providerId}:${item.id}`,
		kind: "memory_item",
		retentionClass: "useful",
		source: memorySourceToContextSource(item.source),
		createdAtTurn,
		summary,
		primaryRef: { type: "memory", ref: primaryRef },
		evidenceRefs: contextEvidenceRefs(item.evidenceRefs),
		tokenEstimate: estimateTokensFromText(summary),
		byteEstimate: estimateByteLength(summary),
	};
}
