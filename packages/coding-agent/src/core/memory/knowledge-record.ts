/** Durable owner knowledge, distinct from the conversation that supplied its evidence. */
import { createHash } from "node:crypto";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import type { KnowledgeWorkCache } from "./knowledge-work-journal.ts";

export const KNOWLEDGE_KINDS = ["profile", "behavior", "procedure", "taste", "workstream", "world", "journal"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** Kinds that guide every request until changed, as opposed to facts about work in progress or the past. */
const STANDING_KNOWLEDGE_KINDS: ReadonlySet<KnowledgeKind> = new Set(["profile", "behavior", "procedure", "taste"]);
export const isStandingKnowledgeKind = (kind: KnowledgeKind): boolean => STANDING_KNOWLEDGE_KINDS.has(kind);
export type KnowledgeBasis = "explicit" | "inferred";

/** Empty project/role names mean global applicability, never an implicit wildcard audience. */
export interface KnowledgeScope {
	project: string;
	role: string;
	audience: string;
}

export interface KnowledgeCitation {
	sourceId: string;
	sessionId: string;
	quote: string;
	at: string;
}

export interface KnowledgeRecord {
	id: string;
	revision: number;
	kind: KnowledgeKind;
	scope: KnowledgeScope;
	subject: string;
	key: string;
	text: string;
	basis: KnowledgeBasis;
	firstEvidencedAt: string;
	lastEvidencedAt: string;
	validFrom: string;
	validUntil?: string;
	/** Newly admitted support for this revision only; previous support is retained in version history. */
	citations: KnowledgeCitation[];
}

/** Identity of one live fact, as the semantic identity judgment sees it. Forgotten identities are never listed. */
export type KnowledgeSlot = Pick<KnowledgeRecord, "id" | "revision" | "kind" | "scope" | "subject" | "key">;

/** Ordering fence of one stored identity, live or forgotten. */
export interface KnowledgeEvidenceFence {
	revision: number;
	/** Citations at or before this time cannot change the identity (the live value's evidence, or the forget time). */
	evidenceAfter: string;
	forgotten: boolean;
}

export interface KnowledgeSnapshot {
	revision: number;
	text: string;
}

export interface KnowledgeRecordSnapshot {
	revision: number;
	records: KnowledgeRecord[];
	/** Earliest validity transition, including facts outside the bounded selected pages. */
	refreshAt?: string;
	/** These categories filled their page; callers must disclose that more records may exist. */
	possiblyMore: KnowledgeKind[];
}

/** Host-owned identity of one immutable candidate; never supplied by a model tool. */
export interface KnowledgeOperation {
	readonly id: string;
	readonly digest: string;
}

/** Content-free proof of a committed mutation; retained across corrections and forgetting. */
export interface KnowledgeMutationReceipt {
	readonly action: "remember" | "forget";
	readonly id: string;
	readonly revision: number;
}

/**
 * Source identity of an owner's direct `/knowledge` command. Only the admission's owner-command path mints it;
 * conversation citations always resolve through the owner-evidence ledger as `<session>/<entry>`.
 */
export const OWNER_COMMAND_SOURCE_PREFIX = "owner-command:";

export const MAX_KNOWLEDGE_TEXT_CHARS = 2_000;
export const MAX_KNOWLEDGE_CITATIONS = 16;
export const MAX_KNOWLEDGE_PAGE_SIZE = 100;
const MAX_NAME_CHARS = 200;
const RECORD_KEYS = [
	"id",
	"revision",
	"kind",
	"scope",
	"subject",
	"key",
	"text",
	"basis",
	"firstEvidencedAt",
	"lastEvidencedAt",
	"validFrom",
	"validUntil",
	"citations",
];

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.trim().length > 0) &&
		value.length <= max &&
		!value.includes("\0")
	);
}

export function isKnowledgeTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}

export function isKnowledgeScope(value: unknown): value is KnowledgeScope {
	return (
		isPlainRecord(value) &&
		hasOnlyKeys(value, ["project", "role", "audience"]) &&
		boundedString(value.project, MAX_NAME_CHARS, true) &&
		boundedString(value.role, MAX_NAME_CHARS, true) &&
		boundedString(value.audience, MAX_NAME_CHARS)
	);
}

export function isKnowledgeCitation(value: unknown): value is KnowledgeCitation {
	return (
		isPlainRecord(value) &&
		hasOnlyKeys(value, ["sourceId", "sessionId", "quote", "at"]) &&
		boundedString(value.sourceId, MAX_NAME_CHARS) &&
		boundedString(value.sessionId, MAX_NAME_CHARS) &&
		boundedString(value.quote, MAX_KNOWLEDGE_TEXT_CHARS) &&
		isKnowledgeTimestamp(value.at)
	);
}

/** Semantic matching resolves corrections; this identity deduplicates the resulting exact slot. */
export function knowledgeId(input: Pick<KnowledgeRecord, "kind" | "scope" | "subject" | "key">): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				input.kind,
				input.scope.project,
				input.scope.role,
				input.scope.audience,
				input.subject.normalize("NFKC").toLowerCase().trim(),
				input.key.normalize("NFKC").toLowerCase().trim(),
			]),
		)
		.digest("hex");
}

export function parseKnowledgeRecord(value: unknown): KnowledgeRecord {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, RECORD_KEYS) ||
		!KNOWLEDGE_KINDS.some((kind) => kind === value.kind) ||
		!isKnowledgeScope(value.scope) ||
		!boundedString(value.subject, MAX_NAME_CHARS) ||
		!boundedString(value.key, MAX_NAME_CHARS) ||
		!boundedString(value.text, MAX_KNOWLEDGE_TEXT_CHARS) ||
		(value.basis !== "explicit" && value.basis !== "inferred") ||
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 1 ||
		!isKnowledgeTimestamp(value.firstEvidencedAt) ||
		!isKnowledgeTimestamp(value.lastEvidencedAt) ||
		value.firstEvidencedAt > value.lastEvidencedAt ||
		!isKnowledgeTimestamp(value.validFrom) ||
		(value.validUntil !== undefined &&
			(!isKnowledgeTimestamp(value.validUntil) || value.validUntil <= value.validFrom)) ||
		!Array.isArray(value.citations) ||
		value.citations.length < 1 ||
		value.citations.length > MAX_KNOWLEDGE_CITATIONS ||
		!value.citations.every(isKnowledgeCitation)
	) {
		throw new TypeError("Invalid durable knowledge record");
	}
	const record: KnowledgeRecord = {
		id: String(value.id),
		revision: value.revision,
		kind: value.kind as KnowledgeKind,
		scope: { ...value.scope },
		subject: value.subject,
		key: value.key,
		text: value.text,
		basis: value.basis,
		firstEvidencedAt: value.firstEvidencedAt,
		lastEvidencedAt: value.lastEvidencedAt,
		validFrom: value.validFrom,
		...(value.validUntil === undefined ? {} : { validUntil: value.validUntil }),
		citations: value.citations.map((citation) => ({ ...citation })),
	};
	if (record.id !== knowledgeId(record) || record.citations.some((citation) => citation.at > record.lastEvidencedAt)) {
		throw new TypeError("Knowledge identity or evidence interval does not match its record");
	}
	return record;
}

export function parseKnowledgeSlot(value: unknown): KnowledgeSlot {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["id", "revision", "kind", "scope", "subject", "key"]) ||
		!KNOWLEDGE_KINDS.some((kind) => kind === value.kind) ||
		!isKnowledgeScope(value.scope) ||
		!boundedString(value.subject, MAX_NAME_CHARS) ||
		!boundedString(value.key, MAX_NAME_CHARS) ||
		typeof value.revision !== "number" ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 1
	)
		throw new TypeError("Invalid knowledge slot identity");
	const slot: KnowledgeSlot = {
		id: String(value.id),
		revision: value.revision,
		kind: value.kind as KnowledgeKind,
		scope: { ...value.scope },
		subject: value.subject,
		key: value.key,
	};
	if (slot.id !== knowledgeId(slot)) throw new TypeError("Knowledge slot identity changed");
	return slot;
}

/** Only scope dimensions may widen; an audience must always match exactly. */
export function knowledgeAppliesTo(record: KnowledgeScope, scope: KnowledgeScope): boolean {
	return (
		record.audience === scope.audience &&
		(!record.project || record.project === scope.project) &&
		(!record.role || record.role === scope.role)
	);
}

export interface KnowledgeListOptions {
	query?: string;
	kind?: KnowledgeKind;
	/** Only records that apply everywhere (`global`) or only to the current project (`project`). */
	reach?: "global" | "project";
	after?: string;
	limit?: number;
}

/** Mutation effects and evidence receipts commit together at this storage boundary. */
export interface KnowledgeStorePort {
	readonly work: KnowledgeWorkCache;
	operationReceipt(operation: KnowledgeOperation): KnowledgeMutationReceipt | undefined;
	revision(): number;
	version(id: string): number;
	snapshot(scope: KnowledgeScope, at: string): KnowledgeRecordSnapshot;
	get(id: string): KnowledgeRecord | undefined;
	/** Live identities of this exact scope only. The caller must follow full pages before declaring no match. */
	slots(scope: KnowledgeScope, kind: KnowledgeKind, after?: string): KnowledgeSlot[];
	/** The ordering fence of one stored identity; forgotten identities keep only their digest and this fence. */
	evidenceFence(id: string): KnowledgeEvidenceFence | undefined;
	/** Owner time of the latest request to forget; evidence strictly older than it never teaches knowledge again. */
	forgetFence(): string | undefined;
	list(scope: KnowledgeScope, options?: KnowledgeListOptions): KnowledgeRecord[];
	/** Live records in scope whose identity starts with `prefix` (at least 8 hex), at most two so ambiguity shows. */
	resolve(scope: KnowledgeScope, prefix: string): KnowledgeRecord[];
	history(id: string, beforeRevision?: number): KnowledgeRecord[];
	/** Distinct original owner sources behind a live record, counted across all its revisions. */
	sourceCount(id: string): number;
	isSourceForgotten(id: string, sessionId: string, sourceId: string): boolean;
	put(
		record: KnowledgeRecord,
		expectedRevision: number,
		assertCurrent: () => void,
		signal?: AbortSignal,
		operation?: KnowledgeOperation,
	): KnowledgeMutationReceipt;
	forget(
		id: string,
		expectedRevision: number,
		citations: readonly KnowledgeCitation[],
		assertCurrent: () => void,
		signal?: AbortSignal,
		operation?: KnowledgeOperation,
	): KnowledgeMutationReceipt;
	close(): void;
}
