#!/usr/bin/env node
/**
 * Release architecture audit.
 *
 * Builds the deterministic architecture projection, decides the outcome from mechanical facts, and
 * writes a secret-free artifact to docs/release-audit/<sha>-architecture-audit.json.
 *
 * A semantic review is optional and local: with credentials present it records that the review can
 * run; without them the artifact says `not run` and the command still exits 0. CI never fails for
 * missing credentials, and no credential is ever written into the artifact.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");
const AUDIT_DIR = join(REPO_ROOT, "docs", "release-audit");

function readSource(repoRelativePath) {
	const absolute = join(REPO_ROOT, repoRelativePath);
	return existsSync(absolute) ? readFileSync(absolute, "utf-8") : undefined;
}

function currentRevision() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
	} catch {
		return "unknown";
	}
}

/** The forbidden-fallback scan's own findings, reused so the audit reports one truth. */
function forbiddenFallbackFindings() {
	try {
		execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "check-forbidden-production-fallbacks.mjs")], {
			cwd: REPO_ROOT,
			encoding: "utf-8",
			stdio: "pipe",
		});
		return [];
	} catch (error) {
		return String(error.stdout ?? "")
			.concat(String(error.stderr ?? ""))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.includes(": ") && !line.startsWith("Forbidden"));
	}
}

/** Credentials are looked for, never read into the artifact. */
function semanticReviewAvailability() {
	if (process.env.TYPESAFE_API_KEY) return "available";
	return existsSync(join(homedir(), ".config", "typesafe", ".env")) ? "available" : "unavailable";
}

const { buildArchitectureAuditProjection, architectureAuditQuestions } = await import(
	join(REPO_ROOT, "packages/coding-agent/src/core/release/architecture-audit-projection.ts")
);

const sourceRevision = currentRevision();
const projection = buildArchitectureAuditProjection({
	sourceRevision,
	readSource,
	forbiddenFallbackFindings: forbiddenFallbackFindings(),
});

const availability = semanticReviewAvailability();
const artifact = {
	...projection,
	semantic_review: {
		status: availability === "available" ? "available_not_executed" : "not run",
		question_count: architectureAuditQuestions().length,
		note:
			availability === "available"
				? "Credentials are present locally; run the review in an authorized environment and attach its result."
				: "No credentials in this environment. Absence of a semantic review never blocks the release gate.",
	},
};

mkdirSync(AUDIT_DIR, { recursive: true });
const artifactPath = join(AUDIT_DIR, `${sourceRevision}-architecture-audit.json`);
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, "\t")}\n`, "utf-8");

console.log(`architecture audit: ${projection.outcome} (${relative(REPO_ROOT, artifactPath)})`);
console.log(`  subsystems: ${projection.subsystem_triples.length}`);
console.log(`  negative-path coverage: ${projection.negative_path_coverage.filter((c) => c.covered).length}/${projection.negative_path_coverage.length}`);
console.log(`  semantic review: ${artifact.semantic_review.status}`);
for (const reason of projection.blocking_reasons) console.error(`  BLOCKING: ${reason}`);

// Only a mechanical blocker fails the audit. A missing semantic review never does.
process.exit(projection.outcome === "BLOCKED" ? 1 : 0);
