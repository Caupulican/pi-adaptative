import type {
	EvidenceBundle,
	EvidenceRef,
	EvidenceSourceKind,
	Finding,
	JsonObject,
	JsonValue,
} from "../autonomy/contracts.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** Bounds every durable evidence bundle, including worker-authored evidence. */
export const MAX_EVIDENCE_QUERY_CHARS = 4_096;
export const MAX_EVIDENCE_CREATED_AT_CHARS = 128;
export const MAX_EVIDENCE_SOURCES = 64;
export const MAX_EVIDENCE_FINDINGS = 64;
export const MAX_EVIDENCE_SOURCE_ID_CHARS = 256;
export const MAX_EVIDENCE_FINDING_ID_CHARS = 256;
export const MAX_EVIDENCE_TEXT_CHARS = 8_000;
export const MAX_EVIDENCE_EXCERPT_CHARS = 8_000;
export const MAX_EVIDENCE_IDS_PER_FINDING = 64;
export const MAX_EVIDENCE_METADATA_DEPTH = 8;
export const MAX_EVIDENCE_METADATA_ENTRIES = 64;
export const MAX_EVIDENCE_METADATA_ARRAY_ITEMS = 64;
export const MAX_EVIDENCE_METADATA_KEY_CHARS = 256;
export const MAX_EVIDENCE_METADATA_STRING_CHARS = 4_096;

function invalidEvidence(message: string): never {
	throw new Error(`Invalid evidence bundle: ${message}`);
}

/**
 * Reads only own data properties. This is deliberately not Object.entries()/spread: snapshots
 * and external lane reports are untrusted, and a getter must never execute while validating them.
 */
function ownDataRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isPlainRecord(value)) invalidEvidence(`${label} must be a plain object.`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!("value" in descriptor)) invalidEvidence(`${label}.${key} must not be an accessor.`);
		record[key] = descriptor.value;
	}
	return record;
}

function requiredBoundedString(value: unknown, label: string, maximumChars: number): string {
	if (typeof value !== "string" || value.length === 0) invalidEvidence(`${label} must be a non-empty string.`);
	if (value.length > maximumChars) invalidEvidence(`${label} exceeds ${maximumChars} characters.`);
	return value;
}

function optionalBoundedString(value: unknown, label: string, maximumChars: number): string | undefined {
	if (value === undefined) return undefined;
	return requiredBoundedString(value, label, maximumChars);
}

function boundedArray(value: unknown, label: string, maximumItems: number): readonly unknown[] {
	if (!Array.isArray(value)) invalidEvidence(`${label} must be an array.`);
	if (value.length > maximumItems) invalidEvidence(`${label} exceeds ${maximumItems} entries.`);
	return value;
}

function ownArrayValue(array: readonly unknown[], index: number, label: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
	if (!descriptor || !("value" in descriptor)) invalidEvidence(`${label}[${index}] must be a data value.`);
	return descriptor.value;
}

function normalizeJsonValue(value: unknown, label: string, depth: number): JsonValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value.length > MAX_EVIDENCE_METADATA_STRING_CHARS) {
			invalidEvidence(`${label} exceeds ${MAX_EVIDENCE_METADATA_STRING_CHARS} characters.`);
		}
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalidEvidence(`${label} must be finite.`);
		return value;
	}
	if (depth >= MAX_EVIDENCE_METADATA_DEPTH) {
		invalidEvidence(`${label} exceeds metadata depth ${MAX_EVIDENCE_METADATA_DEPTH}.`);
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_EVIDENCE_METADATA_ARRAY_ITEMS) {
			invalidEvidence(`${label} exceeds ${MAX_EVIDENCE_METADATA_ARRAY_ITEMS} entries.`);
		}
		const copied: JsonValue[] = [];
		for (let index = 0; index < value.length; index++) {
			copied.push(normalizeJsonValue(ownArrayValue(value, index, label), `${label}[${index}]`, depth + 1));
		}
		return copied;
	}
	const record = ownDataRecord(value, label);
	const entries = Object.entries(record);
	if (entries.length > MAX_EVIDENCE_METADATA_ENTRIES) {
		invalidEvidence(`${label} exceeds ${MAX_EVIDENCE_METADATA_ENTRIES} entries.`);
	}
	const copied: JsonObject = {};
	for (const [key, nested] of entries) {
		if (key.length > MAX_EVIDENCE_METADATA_KEY_CHARS) {
			invalidEvidence(`${label} contains a key exceeding ${MAX_EVIDENCE_METADATA_KEY_CHARS} characters.`);
		}
		copied[key] = normalizeJsonValue(nested, `${label}.${key}`, depth + 1);
	}
	return copied;
}

function normalizeMetadata(value: unknown, label: string): JsonObject {
	const normalized = normalizeJsonValue(value, label, 0);
	if (Array.isArray(normalized) || normalized === null || typeof normalized !== "object") {
		invalidEvidence(`${label} must be an object.`);
	}
	return normalized;
}

/**
 * Validates and copies an evidence bundle without invoking accessors or preserving unbounded
 * foreign object graphs. This is the sole boundary used for durable worker-claim evidence.
 */
export function normalizeEvidenceBundleForStorage(value: unknown): EvidenceBundle {
	const bundle = ownDataRecord(value, "bundle");
	const query = requiredBoundedString(bundle.query, "bundle.query", MAX_EVIDENCE_QUERY_CHARS);
	const createdAt = optionalBoundedString(bundle.createdAt, "bundle.createdAt", MAX_EVIDENCE_CREATED_AT_CHARS);
	const sourceValues = boundedArray(bundle.sources, "bundle.sources", MAX_EVIDENCE_SOURCES);
	const findingValues = boundedArray(bundle.findings, "bundle.findings", MAX_EVIDENCE_FINDINGS);
	const sources: EvidenceRef[] = [];
	for (let index = 0; index < sourceValues.length; index++) {
		const source = ownDataRecord(ownArrayValue(sourceValues, index, "bundle.sources"), `bundle.sources[${index}]`);
		const sourceKind = source.kind;
		if (
			typeof sourceKind !== "string" ||
			!["workspace", "transcript", "automata", "web", "user", "tool"].includes(sourceKind)
		) {
			invalidEvidence(`bundle.sources[${index}].kind is invalid.`);
		}
		const kind = sourceKind as EvidenceSourceKind;
		if (typeof source.trusted !== "boolean") invalidEvidence(`bundle.sources[${index}].trusted must be boolean.`);
		sources.push({
			id: requiredBoundedString(source.id, `bundle.sources[${index}].id`, MAX_EVIDENCE_SOURCE_ID_CHARS),
			kind,
			trusted: source.trusted,
			...(source.title !== undefined
				? { title: optionalBoundedString(source.title, `bundle.sources[${index}].title`, MAX_EVIDENCE_TEXT_CHARS) }
				: {}),
			...(source.uri !== undefined
				? { uri: optionalBoundedString(source.uri, `bundle.sources[${index}].uri`, MAX_EVIDENCE_TEXT_CHARS) }
				: {}),
			...(source.excerpt !== undefined
				? {
						excerpt: optionalBoundedString(
							source.excerpt,
							`bundle.sources[${index}].excerpt`,
							MAX_EVIDENCE_EXCERPT_CHARS,
						),
					}
				: {}),
			...(source.metadata !== undefined
				? { metadata: normalizeMetadata(source.metadata, `bundle.sources[${index}].metadata`) }
				: {}),
		});
	}
	const findings: Finding[] = [];
	for (let index = 0; index < findingValues.length; index++) {
		const finding = ownDataRecord(
			ownArrayValue(findingValues, index, "bundle.findings"),
			`bundle.findings[${index}]`,
		);
		const evidenceIdValues = boundedArray(
			finding.evidenceIds,
			`bundle.findings[${index}].evidenceIds`,
			MAX_EVIDENCE_IDS_PER_FINDING,
		);
		const evidenceIds: string[] = [];
		for (let evidenceIndex = 0; evidenceIndex < evidenceIdValues.length; evidenceIndex++) {
			evidenceIds.push(
				requiredBoundedString(
					ownArrayValue(evidenceIdValues, evidenceIndex, `bundle.findings[${index}].evidenceIds`),
					`bundle.findings[${index}].evidenceIds[${evidenceIndex}]`,
					MAX_EVIDENCE_SOURCE_ID_CHARS,
				),
			);
		}
		if (
			finding.confidence !== undefined &&
			(typeof finding.confidence !== "number" || !Number.isFinite(finding.confidence))
		) {
			invalidEvidence(`bundle.findings[${index}].confidence must be finite.`);
		}
		findings.push({
			id: requiredBoundedString(finding.id, `bundle.findings[${index}].id`, MAX_EVIDENCE_FINDING_ID_CHARS),
			summary: requiredBoundedString(finding.summary, `bundle.findings[${index}].summary`, MAX_EVIDENCE_TEXT_CHARS),
			evidenceIds,
			...(finding.confidence !== undefined ? { confidence: finding.confidence } : {}),
		});
	}
	return { query, sources, findings, ...(createdAt !== undefined ? { createdAt } : {}) };
}

function cloneJsonValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map(cloneJsonValue);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneJsonValue(nested)]));
	}
	return value;
}

function cloneJsonObject(value: JsonObject): JsonObject {
	return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneJsonValue(nested)]));
}

function cloneEvidenceRef(source: EvidenceRef): EvidenceRef {
	return {
		...source,
		metadata: source.metadata ? cloneJsonObject(source.metadata) : undefined,
	};
}

function cloneFinding(finding: Finding): Finding {
	return {
		...finding,
		evidenceIds: [...finding.evidenceIds],
	};
}

export function createEvidenceBundle(args: {
	query: string;
	sources: readonly EvidenceRef[];
	findings: readonly Finding[];
	now?: string;
}): EvidenceBundle {
	return {
		query: args.query,
		sources: args.sources.map(cloneEvidenceRef),
		findings: args.findings.map(cloneFinding),
		createdAt: args.now,
	};
}

export function cloneEvidenceBundleForStorage(bundle: EvidenceBundle): EvidenceBundle {
	return normalizeEvidenceBundleForStorage(bundle);
}

export function isEvidenceBundle(value: unknown): value is EvidenceBundle {
	try {
		normalizeEvidenceBundleForStorage(value);
		return true;
	} catch {
		return false;
	}
}
