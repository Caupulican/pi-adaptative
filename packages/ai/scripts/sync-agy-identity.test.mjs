import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("./sync-agy-identity.mjs", import.meta.url);

test("generates the request identity from a local AGY executable", () => {
	const root = mkdtempSync(join(tmpdir(), "agy-identity-"));
	try {
		const executable = join(root, "agy");
		writeFileSync(executable, '#!/usr/bin/env node\nprocess.stdout.write("7.8.9\\n");\n');
		chmodSync(executable, 0o755);
		const output = join(root, "identity.generated.ts");
		const run = spawnSync(process.execPath, [script.pathname, executable, output], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		const generated = readFileSync(output, "utf8");
		assert.match(generated, /version: "7\.8\.9"/);
		assert.match(generated, /userAgentPrefix: "antigravity\/cli\/7\.8\.9"/);
		const repeated = spawnSync(process.execPath, [script.pathname, executable, output], { encoding: "utf8" });
		assert.equal(repeated.status, 0, repeated.stderr);
		assert.equal(readFileSync(output, "utf8"), generated);
		writeFileSync(executable, '#!/usr/bin/env node\nprocess.stdout.write("bad-version\\n");\n');
		const rejected = spawnSync(process.execPath, [script.pathname, executable, output], { encoding: "utf8" });
		assert.notEqual(rejected.status, 0);
		assert.equal(readFileSync(output, "utf8"), generated);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
