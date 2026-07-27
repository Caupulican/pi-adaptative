import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	credentialToolBlockReason,
	wrapToolWithCredentialExposureGuard,
} from "../src/core/secrets/credential-exposure-guard.ts";
import { SecretVault } from "../src/core/secrets/secret-vault.ts";

const testSchema = Type.Object({ path: Type.Optional(Type.String()), command: Type.Optional(Type.String()) });

describe("credential exposure guard", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("blocks direct dotenv reads and shell inspection while allowing consuming commands", () => {
		const cwd = "/workspace";
		expect(credentialToolBlockReason("read", { path: ".env" }, cwd)).toContain("model-blind");
		expect(credentialToolBlockReason("grep", { pattern: "x", glob: ".env*" }, cwd)).toContain("excluded");
		expect(credentialToolBlockReason("grep", { pattern: "x", path: "src" }, cwd)).toContain("explicit regular file");
		expect(credentialToolBlockReason("grep", { pattern: "x", path: "src", glob: "*.ts" }, cwd)).toBeUndefined();
		expect(credentialToolBlockReason("bash", { command: "cat .env.local" }, cwd)).toContain("blocked");
		expect(credentialToolBlockReason("bash", { command: "rg TOKEN ." }, cwd)).toContain("narrow non-dotenv");
		expect(credentialToolBlockReason("bash", { command: "rg TOKEN src -g '*.ts'" }, cwd)).toBeUndefined();
		expect(credentialToolBlockReason("bash", { command: "npm run deploy" }, cwd)).toBeUndefined();
	});

	it("resolves symlink aliases before read, shell, or Python inspection", () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "pi-secret-alias-"));
		tempDirs.push(root);
		writeFileSync(join(root, ".env"), "TOKEN=hidden\n");
		symlinkSync(join(root, ".env"), join(root, "credentials.txt"));

		expect(credentialToolBlockReason("read", { path: "credentials.txt" }, root)).toContain("model-blind");
		expect(credentialToolBlockReason("bash", { command: "cat credentials.txt" }, root)).toContain("blocked");
		expect(credentialToolBlockReason("python", { code: "open('credentials.txt').read()" }, root)).toContain(
			"blocked",
		);
	});

	it("redacts exact unlocked values from partial, final, and thrown tool output", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-secret-guard-"));
		tempDirs.push(root);
		const vault = new SecretVault({ agentDir: join(root, "agent"), scryptN: 1_024 });
		const secret = "opaque-exact-output-marker";
		await vault.initialize("credential guard passphrase");
		await vault.replaceProfileDocument("project", undefined, `TOKEN=${secret}\n`, {
			workspace: root,
			envFile: ".env",
		});
		await vault.materializeEnv("project", join(root, ".env"));
		const onUpdate = vi.fn();
		const tool: AgentTool<typeof testSchema> = {
			name: "example",
			label: "example",
			description: "test tool",
			parameters: testSchema,
			async execute(_id, _params, _signal, update) {
				update?.({
					content: [{ type: "text", text: `partial ${secret}` }],
					details: { nested: { secret } },
				});
				return {
					content: [{ type: "text", text: `final ${secret}` }],
					details: { nested: { secret } },
				};
			},
		};
		const guarded = wrapToolWithCredentialExposureGuard(tool, root, vault);
		const result = await guarded.execute("call", {}, undefined, onUpdate);
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(JSON.stringify(onUpdate.mock.calls)).not.toContain(secret);

		const failing = wrapToolWithCredentialExposureGuard(
			{
				...tool,
				async execute() {
					throw new Error(`failure ${secret}`);
				},
			},
			root,
			vault,
		);
		await expect(failing.execute("call", {})).rejects.not.toThrow(secret);
	});
});
