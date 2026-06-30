import type { EvidenceBundle, EvidenceRef, Finding, JsonObject, JsonValue } from "../autonomy/contracts.ts";

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return true;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	if (typeof value === "object") {
		return isJsonObject(value);
	}
	return false;
}

function isJsonObject(value: unknown): value is JsonObject {
	if (!isPlainRecord(value)) {
		return false;
	}
	return Object.values(value).every(isJsonValue);
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
	return {
		query: bundle.query,
		sources: bundle.sources.map(cloneEvidenceRef),
		findings: bundle.findings.map(cloneFinding),
		createdAt: bundle.createdAt,
	};
}

export function isEvidenceBundle(value: unknown): value is EvidenceBundle {
	if (!value || typeof value !== "object") return false;
	const bundle = value as Record<string, unknown>;

	if (typeof bundle.query !== "string") return false;
	if (bundle.createdAt !== undefined && typeof bundle.createdAt !== "string") return false;

	if (!Array.isArray(bundle.sources)) return false;
	for (const source of bundle.sources) {
		if (!source || typeof source !== "object") return false;
		const ref = source as Record<string, unknown>;
		if (typeof ref.id !== "string") return false;
		if (
			typeof ref.kind !== "string" ||
			!["workspace", "transcript", "automata", "web", "user", "tool"].includes(ref.kind)
		) {
			return false;
		}
		if (typeof ref.trusted !== "boolean") return false;
		if (ref.title !== undefined && typeof ref.title !== "string") return false;
		if (ref.uri !== undefined && typeof ref.uri !== "string") return false;
		if (ref.excerpt !== undefined && typeof ref.excerpt !== "string") return false;
		if (ref.metadata !== undefined && !isJsonObject(ref.metadata)) return false;
	}

	if (!Array.isArray(bundle.findings)) return false;
	for (const finding of bundle.findings) {
		if (!finding || typeof finding !== "object") return false;
		const f = finding as Record<string, unknown>;
		if (typeof f.id !== "string") return false;
		if (typeof f.summary !== "string") return false;
		if (f.confidence !== undefined && typeof f.confidence !== "number") return false;
		if (!Array.isArray(f.evidenceIds) || !f.evidenceIds.every((id) => typeof id === "string")) return false;
	}

	return true;
}
