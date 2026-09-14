import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("test launch bootstrap", () => {
	it("sanitizes launch metadata before importing config while preserving explicit runtime overrides outside tests", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-bootstrap-regression-"));
		try {
			writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "poisoned-runtime", version: "0.0.0" }));
			for (const sanitize of [false, true]) {
				const entry = join(directory, "probe.mjs");
				writeFileSync(
					entry,
					[
						sanitize
							? `import ${JSON.stringify(new URL("./test-launch-env-setup.ts", import.meta.url).href)};`
							: "",
						`import { PACKAGE_NAME, getPackageDependencyVersion } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};`,
						"console.log(PACKAGE_NAME);",
						"console.log(getPackageDependencyVersion('jscpd'));",
					].join("\n"),
				);
				const result = spawnSync(process.execPath, ["--conditions=pi-source", entry], {
					encoding: "utf8",
					timeout: 10_000,
					env: { ...process.env, PI_PACKAGE_DIR: directory },
				});
				expect(result.error).toBeUndefined();
				if (sanitize) {
					expect(result.status, result.stderr).toBe(0);
					expect(result.stdout).not.toContain("poisoned-runtime");
				} else {
					expect(result.status).not.toBe(0);
					expect(result.stdout).toContain("poisoned-runtime");
					expect(result.stderr).toContain("must pin 'jscpd'");
				}
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
