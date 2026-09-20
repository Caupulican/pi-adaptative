/**
 * Deterministic architecture audit projection.
 *
 * Mechanical extraction first: the projection is built by reading the tree, never by asking a model
 * to browse it. Every subsystem's producer/hook/consumer triple, its fail-closed behavior and its
 * negative-path test come from the release wiring manifest and are verified against the source.
 *
 * The audit verdict is owned by these mechanical facts. A semantic reviewer can add source-readable
 * confirmations on top, but it cannot overturn a missing wiring edge, a missing construction path,
 * a missing test owner or a forbidden fallback.
 * Conforms to JEV_ARCHITECTURE_AUDIT.md and RCG-060..RCG-066.
 */

import {
	RELEASE_WIRING_MANIFEST,
	type ReleaseWiringEntry,
	type ReleaseWiringFinding,
	type SourceReader,
	verifyReleaseWiringManifest,
} from "./release-wiring-manifest.ts";

export type ArchitectureAuditOutcome = "PASS" | "PASS_WITH_NONBLOCKING_FINDINGS" | "BLOCKED";

export interface SubsystemTriple {
	readonly featureId: string;
	readonly producer: string;
	readonly hook: string;
	readonly consumer: string;
	readonly failClosed: string;
	readonly negativePathTest: string;
	readonly operatorVisibility?: string;
	readonly provenance: string;
}

export interface ArchitectureAuditProjection {
	readonly schema_version: "1.0";
	readonly source_revision: string;
	readonly generated_at: string;
	readonly composition_root: string;
	readonly subsystem_triples: readonly SubsystemTriple[];
	readonly wiring_findings: readonly ReleaseWiringFinding[];
	readonly forbidden_fallback_findings: readonly string[];
	/** Every subsystem whose negative-path test file exists and names its test. */
	readonly negative_path_coverage: readonly { featureId: string; covered: boolean }[];
	readonly outcome: ArchitectureAuditOutcome;
	readonly blocking_reasons: readonly string[];
}

export interface BuildArchitectureAuditProjectionInput {
	readonly sourceRevision: string;
	readonly readSource: SourceReader;
	/** Violations reported by the static forbidden-fallback scan. */
	readonly forbiddenFallbackFindings?: readonly string[];
	readonly manifest?: readonly ReleaseWiringEntry[];
	readonly generatedAt?: string;
	readonly compositionRoot?: string;
}

const DEFAULT_COMPOSITION_ROOT = "packages/coding-agent/src/core/sdk.ts";

/**
 * Builds the projection and decides the outcome from the mechanical facts alone.
 * BLOCKED is reserved for a missing edge or a forbidden fallback, which are facts, not judgments.
 */
export function buildArchitectureAuditProjection(
	input: BuildArchitectureAuditProjectionInput,
): ArchitectureAuditProjection {
	const manifest = input.manifest ?? RELEASE_WIRING_MANIFEST;
	const wiringFindings = verifyReleaseWiringManifest(input.readSource, manifest);
	const fallbackFindings = input.forbiddenFallbackFindings ?? [];

	const triples: SubsystemTriple[] = manifest.map((entry) => ({
		featureId: entry.featureId,
		producer: `${entry.constructionOwnerFile}#${entry.symbol}`,
		hook: `${entry.triggerFile}#${entry.triggerSymbol}`,
		consumer: `${entry.consumerFile}#${entry.consumerSymbol}`,
		failClosed: entry.failClosed,
		negativePathTest: `${entry.negativePathTestFile}#${entry.negativePathTestName}`,
		...(entry.operatorVisibility ? { operatorVisibility: entry.operatorVisibility } : {}),
		provenance: entry.provenance,
	}));

	const uncoveredFeatures = new Set(
		wiringFindings.filter((finding) => finding.check === "negative_path_test_exists").map((f) => f.featureId),
	);
	const negativePathCoverage = manifest.map((entry) => ({
		featureId: entry.featureId,
		covered: !uncoveredFeatures.has(entry.featureId),
	}));

	const blockingReasons = [
		...wiringFindings.map((finding) => `${finding.featureId}/${finding.check}: ${finding.detail}`),
		...fallbackFindings.map((finding) => `forbidden_production_fallback: ${finding}`),
	];

	return {
		schema_version: "1.0",
		source_revision: input.sourceRevision,
		generated_at: input.generatedAt ?? new Date().toISOString(),
		composition_root: input.compositionRoot ?? DEFAULT_COMPOSITION_ROOT,
		subsystem_triples: triples,
		wiring_findings: wiringFindings,
		forbidden_fallback_findings: fallbackFindings,
		negative_path_coverage: negativePathCoverage,
		outcome: blockingReasons.length > 0 ? "BLOCKED" : "PASS",
		blocking_reasons: blockingReasons,
	};
}

/**
 * The source-answerable questions a semantic reviewer can confirm from the supplied files.
 *
 * Each is one atomic fact about one file, answerable by inspection. Judgment questions such as
 * "is the architecture release ready" are deliberately absent: that verdict is decided by the
 * mechanical checks above, and a model asked to reason about it would only be guessing.
 */
export function architectureAuditQuestions(
	manifest: readonly ReleaseWiringEntry[] = RELEASE_WIRING_MANIFEST,
): readonly { id: string; file: string; question: string }[] {
	return manifest.map((entry) => ({
		id: `hook_present::${entry.featureId}`,
		file: entry.triggerFile,
		question: `Does this file call '${entry.triggerSymbol}'?`,
	}));
}
