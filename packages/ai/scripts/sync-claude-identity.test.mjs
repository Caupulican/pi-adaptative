import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("./sync-claude-identity.mjs", import.meta.url);

function fixture(root, version) {
	const executable = join(root, "claude");
	writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${version} (Claude Code)\n`)});\n`);
	chmodSync(executable, 0o755);
	return executable;
}

test("generates the two verified OAuth request identities from the local CLI", () => {
	const root = mkdtempSync(join(tmpdir(), "claude-identity-"));
	try {
		const executable = fixture(root, "7.8.9");
		const output = join(root, "identity.generated.ts");
		const run = spawnSync(process.execPath, [script.pathname, executable, output], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		const generated = readFileSync(output, "utf8");
		assert.match(generated, /version: "7\.8\.9"/);
		assert.match(generated, /messagesUserAgent: "claude-cli\/7\.8\.9 \(external, cli\)"/);
		assert.match(generated, /usageUserAgent: "claude-code\/7\.8\.9"/);
		const repeated = spawnSync(process.execPath, [script.pathname, executable, output], { encoding: "utf8" });
		assert.equal(repeated.status, 0, repeated.stderr);
		assert.equal(readFileSync(output, "utf8"), generated);
		fixture(root, "10.11.12");
		const updated = spawnSync(process.execPath, [script.pathname, executable, output], { encoding: "utf8" });
		assert.equal(updated.status, 0, updated.stderr);
		assert.match(readFileSync(output, "utf8"), /version: "10\.11\.12"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects an unrecognized local version without changing the generated config", () => {
	const root = mkdtempSync(join(tmpdir(), "claude-identity-"));
	try {
		const executable = fixture(root, "new-version");
		const output = join(root, "identity.generated.ts");
		writeFileSync(output, "existing\n");
		const run = spawnSync(process.execPath, [script.pathname, executable, output], { encoding: "utf8" });
		assert.notEqual(run.status, 0);
		assert.equal(readFileSync(output, "utf8"), "existing\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
