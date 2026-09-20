/**
 * Capability proof obligation compiler.
 *
 * A proof obligation is only a proof when a runner can execute it. Synthesized capability specs
 * therefore declare real commands against the real artifact path, never placeholder test names:
 * an identifier like `test_cap_x_isolated` can only ever be asserted, which is what
 * EXECUTION_FAIL_CLOSED.md forbids.
 *
 * The script body is carried as base64 so one command string parses identically under `/bin/sh`
 * and `cmd.exe`: the base64 alphabet contains no character either shell treats specially.
 */

import type { CapabilityKind, CapabilitySpecProof } from "./types.ts";

/** Where the capability builder writes a synthesized artifact, relative to the session cwd. */
export function capabilityArtifactRelativePath(capabilityId: string): string {
	return `capabilities/${capabilityId}.mjs`;
}

/** One portable `node -e` invocation carrying `source` verbatim. */
export function compileNodeProofCommand(source: string): string {
	const encoded = Buffer.from(source, "utf-8").toString("base64");
	return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}

function artifactBytesProofSource(artifactPath: string): string {
	return [
		"const { statSync } = require('node:fs');",
		`const target = ${JSON.stringify(artifactPath)};`,
		"let stats;",
		"try { stats = statSync(target); } catch (error) {",
		"  console.error('capability artifact is not readable: ' + (error && error.message));",
		"  process.exit(1);",
		"}",
		"if (!stats.isFile() || stats.size === 0) {",
		"  console.error('capability artifact is missing or empty');",
		"  process.exit(1);",
		"}",
	].join("\n");
}

function artifactLoadProofSource(artifactPath: string, requireCallableEntryPoint: boolean): string {
	return [
		"const { pathToFileURL } = require('node:url');",
		"const { resolve } = require('node:path');",
		`const href = pathToFileURL(resolve(${JSON.stringify(artifactPath)})).href;`,
		"import(href).then((loaded) => {",
		requireCallableEntryPoint
			? [
					"  const entry = loaded.default ?? loaded.run;",
					"  if (typeof entry !== 'function') {",
					"    console.error('capability entry point is not callable');",
					"    process.exit(1);",
					"  }",
				].join("\n")
			: "  void loaded;",
		"}, (error) => {",
		"  console.error('capability artifact failed to load: ' + (error && error.message));",
		"  process.exit(1);",
		"});",
	].join("\n");
}

/**
 * Compiles the executable proof obligations for a capability.
 *
 * - deterministic proof: the artifact exists, is non-empty, and evaluates as a module.
 * - task-specific proof: the artifact exposes the callable entry point the activation contract
 *   depends on, so activation cannot succeed against an artifact that cannot be invoked.
 *
 * Kinds without a host-loadable module artifact (runtime patches, compositions) still prove the
 * artifact bytes exist and are readable; that check runs, it is not asserted.
 */
export function compileCapabilityProofObligations(capabilityId: string, kind: CapabilityKind): CapabilitySpecProof {
	const artifactPath = capabilityArtifactRelativePath(capabilityId);
	const bytesProof = compileNodeProofCommand(artifactBytesProofSource(artifactPath));

	if (kind === "runtime_patch" || kind === "composition") {
		return {
			deterministic_tests: [bytesProof],
			task_specific_test: bytesProof,
		};
	}

	return {
		deterministic_tests: [bytesProof, compileNodeProofCommand(artifactLoadProofSource(artifactPath, false))],
		task_specific_test: compileNodeProofCommand(artifactLoadProofSource(artifactPath, true)),
	};
}
