/**
 * Release wiring manifest verification (RCG-030..RCG-036).
 *
 * Secret-free and deterministic: it reads the source tree and asserts that every mandatory feature
 * really has a construction owner, a trigger, a consumer and a negative-path test. A feature that
 * exists only in `src/` fails here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	RELEASE_WIRING_MANIFEST,
	type ReleaseWiringEntry,
	verifyReleaseWiringManifest,
} from "../../src/core/release/release-wiring-manifest.ts";

const REPO_ROOT = join(import.meta.dirname, "../../../..");

function readSource(repoRelativePath: string): string | undefined {
	const absolute = join(REPO_ROOT, repoRelativePath);
	return existsSync(absolute) ? readFileSync(absolute, "utf-8") : undefined;
}

/** The mandatory feature set the release documents name. */
const MANDATORY_FEATURE_IDS: readonly string[] = [
	"system_one_steering",
	"execution_charter",
	"hmoe",
	"specialist_synthesis",
	"specialist_dispatch",
	"capability_synthesis",
	"capability_proof",
	"capability_activation",
	"runtime_adaptation",
	"semantic_dedup_pre",
	"semantic_dedup_post",
	"semantic_dedup_final",
	"evidence_retention",
	"semantic_project_rules_mutation",
	"semantic_project_rules_postflight",
	"semantic_project_rules_completion",
	"worker_supervision",
	"external_acquisition_gate",
	"operator_projection",
	"operator_events",
	"durable_owner_rules",
	"completion_primary",
	"completion_adversarial",
	"delivery_side_effects",
];

describe("Release wiring manifest", () => {
	it("RCG-030: declares every mandatory feature exactly once", () => {
		const declared = RELEASE_WIRING_MANIFEST.map((entry) => entry.featureId);
		expect([...declared].sort()).toEqual([...MANDATORY_FEATURE_IDS].sort());
		expect(new Set(declared).size).toBe(declared.length);
	});

	it("RCG-031..RCG-035: every feature has an owner, a trigger, a consumer and a negative-path test", () => {
		const findings = verifyReleaseWiringManifest(readSource);
		expect(findings.map((finding) => `${finding.featureId}/${finding.check}: ${finding.detail}`)).toEqual([]);
	});

	it("RCG-035: no mandatory feature ships with test-fixture provenance", () => {
		expect(RELEASE_WIRING_MANIFEST.filter((entry) => entry.provenance !== "production-live")).toEqual([]);
	});

	it("RCG-036: any missing edge fails release readiness", () => {
		const unwired: ReleaseWiringEntry = {
			...(RELEASE_WIRING_MANIFEST[0] as ReleaseWiringEntry),
			featureId: "probe_unwired_feature",
			// A real file that genuinely does not construct the feature.
			constructionOwnerFile: "packages/coding-agent/src/core/system-one/semantic-plane-health.ts",
		};
		const findings = verifyReleaseWiringManifest(readSource, [unwired]);
		expect(findings.map((finding) => finding.check)).toContain("production_composition_references_it");

		const missingTest: ReleaseWiringEntry = {
			...(RELEASE_WIRING_MANIFEST[0] as ReleaseWiringEntry),
			featureId: "probe_untested_feature",
			negativePathTestFile: "packages/coding-agent/test/release/does-not-exist.test.ts",
		};
		expect(verifyReleaseWiringManifest(readSource, [missingTest]).map((finding) => finding.check)).toContain(
			"negative_path_test_exists",
		);

		const fixtureProvenance: ReleaseWiringEntry = {
			...(RELEASE_WIRING_MANIFEST[0] as ReleaseWiringEntry),
			featureId: "probe_fixture_feature",
			provenance: "test-fixture",
		};
		expect(verifyReleaseWiringManifest(readSource, [fixtureProvenance]).map((finding) => finding.check)).toContain(
			"production_provenance_not_test_fixture",
		);
	});
});
