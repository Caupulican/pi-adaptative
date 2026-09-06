import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("contract gate rejects duplicate registrations and accepts unique registrations", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-contract-gate-"));
	try {
		mkdirSync(join(root, "scripts"));
		const script = join(root, "scripts/check-contract-doctrine.mjs");
		copyFileSync(new URL("./check-contract-doctrine.mjs", import.meta.url), script);
		execFileSync("git", ["init", "--quiet"], { cwd: root });
		writeFileSync(join(root, "contract.test.ts"), "// fixture\n");
		for (const duplicated of [false, true]) {
			writeFileSync(join(root, "contracts.json"), JSON.stringify({
				doctrine: "doctrine.md",
				contracts: duplicated ? ["contract.test.ts", "contract.test.ts"] : ["contract.test.ts"],
			}));
			const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
			assert.equal(result.status, duplicated ? 1 : 0, result.stdout + result.stderr);
			if (duplicated) assert.match(result.stderr, /duplicate.*contract\.test\.ts/su);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
