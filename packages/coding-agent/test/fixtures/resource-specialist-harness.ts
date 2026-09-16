/**
 * A reuse harness whose worker profile admits one owner-authored skill file.
 *
 * The pointer reaches the worker the ordinary way: a named resource profile grants the path, the
 * metadata-only catalog discovers it, and the existing materializer reads and pins its content. No
 * test here hashes or parses the file, and no production read path is moved.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../../src/core/orchestration/contracts.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createReuseHarness, type ReuseHarness } from "./specialist-reuse-harness.ts";

export const RESOURCE_PROFILE_NAME = "worker-skill-resources";
export const RESOURCE_WORKER_PROFILE_ID = "resource-worker";

/** One owner-authored skill file in its own scratch root; the caller removes the root. */
export function writeAdmittedSkill(body: string): { root: string; skillPath: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-specialist-resource-"));
	const skillPath = join(root, "lease-fences.md");
	writeAdmittedSkillContent(skillPath, body);
	return { root, skillPath };
}

/** Rewrite the same admitted file: same URI, different content. */
export function writeAdmittedSkillContent(skillPath: string, body: string): void {
	writeFileSync(skillPath, `---\nname: lease-fences\ndescription: lease fence doctrine\n---\n${body}\n`, "utf-8");
}

export function resourceWorkerProfile(): OrchestrationProfile {
	const now = new Date().toISOString();
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: RESOURCE_WORKER_PROFILE_ID,
		description: "Worker whose profile admits one owner-authored skill",
		role: "implementer",
		modelPolicy: { mode: "fixed", candidates: [{ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }] },
		capabilityCeiling: ["filesystem.read"],
		toolNames: ["read", "grep"],
		resourceProfileNames: [RESOURCE_PROFILE_NAME],
		dispatchProfileIds: [],
		budget: { maxCostUsd: 5, maxWallClockMs: 3_600_000, maxTokens: 16_384, maxToolCalls: 20 },
		maxConcurrent: 3,
		leaseTtlMs: 3_660_000,
		requireIndependentVerification: false,
		createdAt: now,
		updatedAt: now,
	};
}

/** A session whose worker profile admits exactly this skill file. */
export async function createResourceReuseHarness(skillPath: string): Promise<ReuseHarness> {
	return createReuseHarness({
		workerOrchestrationProfile: resourceWorkerProfile(),
		settings: { resourceProfiles: { [RESOURCE_PROFILE_NAME]: { resources: { skills: { allow: [skillPath] } } } } },
		resourceLoader: { ...createTestResourceLoader(), getDiscoverableSkillPaths: () => [skillPath] },
	});
}
