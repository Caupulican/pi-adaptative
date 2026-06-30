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
