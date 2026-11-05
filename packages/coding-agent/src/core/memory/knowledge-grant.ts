/** Exact owner-approved knowledge identities for one delegated task; never copied fact values. */
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import { type KnowledgeRecord, type KnowledgeScope, knowledgeAppliesTo } from "./knowledge-record.ts";

export const MAX_KNOWLEDGE_GRANT_REFERENCES = 32;

export interface KnowledgeGrantReference {
	readonly id: string;
	readonly revision: number;
}

export interface KnowledgeGrant {
	readonly references: readonly KnowledgeGrantReference[];
	/** Dispatch admission rechecks the owner scope, memory generation and selected record versions. */
	isCurrent(): boolean;
}

/** Current exact revision and original owner scope are mandatory at capture and every later projection. */
export function matchesKnowledgeGrant(
	record: KnowledgeRecord | undefined,
	reference: KnowledgeGrantReference,
	scope: KnowledgeScope,
	at: string,
): record is KnowledgeRecord {
	return (
		record !== undefined &&
		record.id === reference.id &&
		record.revision === reference.revision &&
		knowledgeAppliesTo(record.scope, scope) &&
		record.validFrom <= at &&
		(record.validUntil === undefined || at < record.validUntil)
	);
}

export function parseKnowledgeGrantReferences(value: unknown): readonly KnowledgeGrantReference[] {
	if (!Array.isArray(value) || value.length > MAX_KNOWLEDGE_GRANT_REFERENCES)
		throw new TypeError("Knowledge grant must be a bounded array of exact record references.");
	const ids = new Set<string>();
	const references = value.map((reference): KnowledgeGrantReference => {
		if (
			!isPlainRecord(reference) ||
			!hasOnlyKeys(reference, ["id", "revision"]) ||
			typeof reference.id !== "string" ||
			!/^[a-f0-9]{64}$/.test(reference.id) ||
			typeof reference.revision !== "number" ||
			!Number.isSafeInteger(reference.revision) ||
			reference.revision < 1 ||
			ids.has(reference.id)
		)
			throw new TypeError("Knowledge grant contains an invalid or duplicate record reference.");
		ids.add(reference.id);
		return Object.freeze({ id: reference.id, revision: reference.revision });
	});
	return Object.freeze(references);
}
