/**
 * Architecture audit projection (RCG-060..RCG-066).
 *
 * The projection is deterministic and its outcome is owned by mechanical facts: a missing wiring
 * edge or a forbidden fallback is BLOCKED, and nothing semantic can overturn that.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	architectureAuditQuestions,
	buildArchitectureAuditProjection,
} from "../../src/core/release/architecture-audit-projection.ts";
import { RELEASE_WIRING_MANIFEST } from "../../src/core/release/release-wiring-manifest.ts";

const REPO_ROOT = join(import.meta.dirname, "../../../..");

function readSource(repoRelativePath: string): string | undefined {
	const absolute = join(REPO_ROOT, repoRelativePath);
	return existsSync(absolute) ? readFileSync(absolute, "utf-8") : undefined;
}

describe("Architecture audit projection", () => {
	it("RCG-060: the projection is deterministic and carries the commit and every subsystem", () => {
		const first = buildArchitectureAuditProjection({
			sourceRevision: "abc123",
			readSource,
			generatedAt: "2026-09-19T00:00:00.000Z",
		});
		const second = buildArchitectureAuditProjection({
			sourceRevision: "abc123",
			readSource,
			generatedAt: "2026-09-19T00:00:00.000Z",
		});

		expect(first).toEqual(second);
		expect(first.source_revision).toBe("abc123");
		expect(first.subsystem_triples).toHaveLength(RELEASE_WIRING_MANIFEST.length);
		expect(first.composition_root).toContain("sdk.ts");
	});

	it("RCG-061..RCG-063: the current tree passes with full negative-path coverage", () => {
		const projection = buildArchitectureAuditProjection({ sourceRevision: "head", readSource });
		expect(projection.blocking_reasons).toEqual([]);
		expect(projection.outcome).toBe("PASS");
		expect(projection.negative_path_coverage.every((entry) => entry.covered)).toBe(true);
	});

	it("RCG-066: a missing wiring edge or a forbidden fallback blocks", () => {
		const unwired = buildArchitectureAuditProjection({
			sourceRevision: "head",
			readSource,
			manifest: [
				{
					...RELEASE_WIRING_MANIFEST[0]!,
					featureId: "probe_unwired",
					triggerFile: "packages/coding-agent/src/core/system-one/semantic-plane-health.ts",
				},
			],
		});
		expect(unwired.outcome).toBe("BLOCKED");
		expect(unwired.blocking_reasons.join("\n")).toContain("trigger_calls_it");

		const fallback = buildArchitectureAuditProjection({
			sourceRevision: "head",
			readSource,
			forbiddenFallbackFindings: ["src/core/x.ts: asserted_task_proof — a task proof asserted"],
		});
		expect(fallback.outcome).toBe("BLOCKED");
		expect(fallback.blocking_reasons.join("\n")).toContain("forbidden_production_fallback");
	});

	it("RCG-063: every audit question is answerable from one named file by inspection", () => {
		const questions = architectureAuditQuestions();
		expect(questions).toHaveLength(RELEASE_WIRING_MANIFEST.length);
		for (const question of questions) {
			expect(readSource(question.file)).toBeDefined();
			// Source-readable facts only: no judgment or reasoning questions.
			expect(question.question).toMatch(/^Does this file call '.+'\?$/);
		}
	});

	it("RCG-053: the audit artifact carries no credential material", () => {
		const projection = buildArchitectureAuditProjection({ sourceRevision: "head", readSource });
		const serialized = JSON.stringify(projection);
		expect(serialized).not.toMatch(/apikey_/i);
		expect(serialized).not.toMatch(/TYPESAFE_API_KEY/);
		expect(serialized).not.toMatch(/-----BEGIN/);
	});
});
