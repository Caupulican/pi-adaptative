import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("release workflow quality gate", () => {
	it("can verify tagged artifacts on Windows without publishing a release", () => {
		const release = readFileSync(join(REPOSITORY_ROOT, ".github/workflows/build-binaries.yml"), "utf8");

		expect(release).toContain("verify_only:");
		expect(release).toContain(
			"if: github.event_name == 'push' || inputs.verify_only == true || inputs.skip_windows_verify != true",
		);
		expect(release).toContain("if: github.event_name == 'push' || inputs.verify_only != true");
	});

	it("measures the same compiled-binary RPC and shell paths on Linux and Windows", () => {
		const release = readFileSync(join(REPOSITORY_ROOT, ".github/workflows/build-binaries.yml"), "utf8");

		expect(release).toContain("benchmark-linux-binary:");
		expect(release).toContain("pi-linux-x64-benchmark.json");
		expect(release).toContain(`tar -xzf artifacts/pi-linux-x64.tar.gz -C "\${extract_dir}" --strip-components=1`);
		expect(release).toContain(`pi-windows-\${{ matrix.arch }}-benchmark.json`);
		expect(release.match(/release-binary-rpc-benchmark\.mjs/gu)).toHaveLength(2);
	});

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
