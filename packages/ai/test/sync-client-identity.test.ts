import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const agyScript = fileURLToPath(new URL("../scripts/sync-agy-identity.mjs", import.meta.url));
const claudeScript = fileURLToPath(new URL("../scripts/sync-claude-identity.mjs", import.meta.url));

function versionExecutable(root: string, name: string, versionLine: string): string {
	const executable = join(root, name);
	writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${versionLine}\n`)});\n`);
	chmodSync(executable, 0o755);
	return executable;
}

function sync(script: string, executable: string, output: string) {
	return spawnSync(process.execPath, [script, executable, output], { encoding: "utf8" });
}

function syncFromPath(script: string, path: string, output: string) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
	return spawnSync(process.execPath, [script, "", output], { encoding: "utf8", env: { ...env, PATH: path } });
}

describe("client identity sync scripts on the host platform", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "client-identity-path-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("runs the CLI found on PATH and rejects a version it does not recognize without touching the config", () => {
		const suffix = process.platform === "win32" ? ".exe" : "";
		const agy = join(root, `agy${suffix}`);
		copyFileSync(process.execPath, agy);
		linkSync(agy, join(root, `claude${suffix}`));
		const output = join(root, "identity.generated.ts");
		writeFileSync(output, "existing\n");
		for (const [script, label] of [
			[agyScript, "AGY"],
			[claudeScript, "Claude"],
		]) {
			const run = syncFromPath(script, root, output);
			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain(`Installed ${label} did not report a supported version`);
			expect(readFileSync(output, "utf8")).toBe("existing\n");
		}
	});

	it("reports a CLI missing from PATH without touching the config", () => {
		const output = join(root, "identity.generated.ts");
		writeFileSync(output, "existing\n");
		for (const [script, label] of [
			[agyScript, "AGY"],
			[claudeScript, "Claude"],
		]) {
			const run = syncFromPath(script, root, output);
			expect(run.status).not.toBe(0);
			expect(run.stderr).toContain(`${label} executable was not found on PATH`);
			expect(readFileSync(output, "utf8")).toBe("existing\n");
		}
	});
});

describe.skipIf(process.platform === "win32")("client identity sync scripts with a script fixture", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "client-identity-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("generates the request identity from a local AGY executable", () => {
		const executable = versionExecutable(root, "agy", "7.8.9");
		const output = join(root, "identity.generated.ts");
		const run = sync(agyScript, executable, output);
		expect(run.status, run.stderr).toBe(0);
		const generated = readFileSync(output, "utf8");
		expect(generated).toMatch(/version: "7\.8\.9"/);
		expect(generated).toMatch(/userAgentPrefix: "antigravity\/cli\/7\.8\.9"/);
		const repeated = sync(agyScript, executable, output);
		expect(repeated.status, repeated.stderr).toBe(0);
		expect(readFileSync(output, "utf8")).toBe(generated);
		versionExecutable(root, "agy", "bad-version");
		expect(sync(agyScript, executable, output).status).not.toBe(0);
		expect(readFileSync(output, "utf8")).toBe(generated);
	});

	it("generates the two verified OAuth request identities from the local Claude CLI", () => {
		const executable = versionExecutable(root, "claude", "7.8.9 (Claude Code)");
		const output = join(root, "identity.generated.ts");
		const run = sync(claudeScript, executable, output);
		expect(run.status, run.stderr).toBe(0);
		const generated = readFileSync(output, "utf8");
		expect(generated).toMatch(/version: "7\.8\.9"/);
		expect(generated).toMatch(/messagesUserAgent: "claude-cli\/7\.8\.9 \(external, cli\)"/);
		expect(generated).toMatch(/usageUserAgent: "claude-code\/7\.8\.9"/);
		const repeated = sync(claudeScript, executable, output);
		expect(repeated.status, repeated.stderr).toBe(0);
		expect(readFileSync(output, "utf8")).toBe(generated);
		versionExecutable(root, "claude", "10.11.12 (Claude Code)");
		const updated = sync(claudeScript, executable, output);
		expect(updated.status, updated.stderr).toBe(0);
		expect(readFileSync(output, "utf8")).toMatch(/version: "10\.11\.12"/);
	});

	it("rejects an unrecognized Claude version without changing the generated config", () => {
		const executable = versionExecutable(root, "claude", "new-version (Claude Code)");
		const output = join(root, "identity.generated.ts");
		writeFileSync(output, "existing\n");
		expect(sync(claudeScript, executable, output).status).not.toBe(0);
		expect(readFileSync(output, "utf8")).toBe("existing\n");
	});
});
