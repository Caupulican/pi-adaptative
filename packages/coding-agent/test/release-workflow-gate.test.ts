import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("release workflow quality gate", () => {
	it("gates npm publish on the tagged quality-gate and binary build, not Windows RPC smoke", () => {
		const ci = readFileSync(join(REPOSITORY_ROOT, ".github/workflows/ci.yml"), "utf8");
		const release = readFileSync(join(REPOSITORY_ROOT, ".github/workflows/build-binaries.yml"), "utf8");

		expect(ci).toContain("workflow_call:");
		expect(ci).toContain(`ref: \${{ inputs.ref || github.sha }}`);
		expect(release).toContain(
			"quality-gate:\n    permissions:\n      contents: read\n    uses: ./.github/workflows/ci.yml",
		);
		expect(release).toContain(`ref: \${{ github.event.inputs.tag || github.ref_name }}`);
		expect(release).toContain("skip_tests: true");
		expect(release).toContain("needs: [quality-gate, build]");
		expect(release).not.toContain("needs: [quality-gate, build, verify-windows-binary]");
	});
});
