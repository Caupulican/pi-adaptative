/**
 * The forbidden-fallback scan must actually detect the fallbacks the release closure deleted.
 * A scan that passes because its patterns match nothing proves nothing, so each pattern is
 * exercised against a sample of the exact shape it exists to reject.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-forbidden-production-fallbacks.mjs");

const SAMPLES = {
	fallback_capability_return_true_source: `const code = \`// Synthesized \${spec.kind} capability: x\\nexport default async function run(input) { return true; }\\n\`;`,
	fabricated_capability_worker_result: `if (!workerResult) {\n\tworkerResult = createWorkerResultContract({ handle: {}, cwd, accepted: true });\n}`,
	fabricated_specialist_result: `if (outcome?.result) {\n\t\treturn outcome.result;\n\t}\n\n\treturn createWorkerResultContract({ handle: {} });`,
	dispatcher_empty_delegate: `this.session = { runWorkerDelegationOnce: async () => ({}) };`,
	fallback_expert_model_profile: `const binding = (expertBinding) ?? {\n\tproviderId: "anthropic",\n\tmodelId: "claude-3-7-sonnet",\n};`,
	fallback_profile_id: 'const profileId = profileResult.profileId ?? `prof-cap-${spec.capability_id}`;',
	asserted_task_proof: `const proof = {\n\tverified: true,\n\ttaskTest: spec.proof.task_specific_test,\n};`,
	permissive_acquisition_authority_default: `allowShellExecution: deps.charterAuthority?.allowShellExecution ?? true,`,
	hard_coded_operator_execution_state: `return {\n\tphase: "understand",\n\tphase_index: 1,\n\tcurrent_action: "Ready for operator instructions",\n};`,
};

test("the scan is clean on the current tree", () => {
	const output = execFileSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
	assert.match(output, /clean/);
});

test("every forbidden pattern rejects the shape it exists to reject", () => {
	for (const [id, sample] of Object.entries(SAMPLES)) {
		const scratch = mkdtempSync(join(tmpdir(), "pi-fallback-scan-"));
		try {
			const target = join(scratch, "packages", "coding-agent", "src", "core");
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "probe.ts"), sample, "utf-8");
			let failed = false;
			let stderr = "";
			try {
				execFileSync(process.execPath, [SCRIPT], { cwd: scratch, encoding: "utf8", stdio: "pipe" });
			} catch (error) {
				failed = true;
				stderr = String(error.stderr ?? "");
			}
			assert.equal(failed, true, `${id} was not detected`);
			assert.match(stderr, new RegExp(id), `${id} was not the reported violation`);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
});
