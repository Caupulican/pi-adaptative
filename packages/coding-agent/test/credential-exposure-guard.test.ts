import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { AgentToolExecutionError } from "@caupulican/pi-agent-core/types";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	credentialToolBlockReason,
	wrapToolWithCredentialExposureGuard,
} from "../src/core/secrets/credential-exposure-guard.ts";

const testSchema = Type.Object({ path: Type.Optional(Type.String()), command: Type.Optional(Type.String()) });

describe("credential exposure guard", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("blocks direct dotenv reads and shell inspection while allowing consuming commands", () => {
		const cwd = "/workspace";
		expect(credentialToolBlockReason("read", { path: ".env" }, cwd)).toContain("secret_store migrate");
		expect(credentialToolBlockReason("grep", { pattern: "x", glob: ".env*" }, cwd)).toContain(
			"secret_store discover",
		);
		expect(credentialToolBlockReason("grep", { pattern: "x", path: "src" }, cwd)).toContain("explicit regular file");
		expect(credentialToolBlockReason("grep", { pattern: "x", path: "src", glob: "*.ts" }, cwd)).toBeUndefined();
		expect(credentialToolBlockReason("bash", { command: "cat .env.local" }, cwd)).toContain("secret_store migrate");
		expect(credentialToolBlockReason("find", { pattern: ".env*" }, cwd)).toContain("secret_store discover");
		expect(credentialToolBlockReason("bash", { command: "rg TOKEN ." }, cwd)).toContain("narrow non-dotenv");
		expect(credentialToolBlockReason("bash", { command: "rg TOKEN src -g '*.ts'" }, cwd)).toBeUndefined();
		expect(credentialToolBlockReason("bash", { command: "npm run deploy" }, cwd)).toBeUndefined();
	});

	it("blocks recognizable process reads under a worker private-path boundary", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worker-private-process-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const authPath = join(agentDir, "auth.json");
		const memoryPath = join(agentDir, "MEMORY.md");
		const sessionsDir = join(agentDir, "sessions");
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(authPath, "{}\n");
		writeFileSync(memoryPath, "private\n");
		writeFileSync(join(sessionsDir, "session.jsonl"), "private\n");
		const boundary = {
			redactSensitiveText: (text: string) => text,
			protectedDirectories: [agentDir, sessionsDir],
		};

		expect(credentialToolBlockReason("read", { path: authPath }, projectDir, boundary)).toContain("model-blind");
		expect(credentialToolBlockReason("read", { path: memoryPath }, projectDir, boundary)).toContain("model-blind");
		expect(credentialToolBlockReason("bash", { command: `cat ${authPath}` }, projectDir, boundary)).toContain(
			"blocked",
		);
		expect(
			credentialToolBlockReason(
				"python",
				{ code: `open(${JSON.stringify(memoryPath)}).read()` },
				projectDir,
				boundary,
			),
		).toContain("blocked");
		expect(
			credentialToolBlockReason(
				"bash",
				{ command: `cat ${join(sessionsDir, "session.jsonl")}` },
				projectDir,
				boundary,
			),
		).toContain("blocked");
		expect(
			credentialToolBlockReason(
				"bash",
				{ command: `cat ${join(root, "sibling", "source.ts")}` },
				projectDir,
				boundary,
			),
		).toBeUndefined();
	});

	it("blocks run_process argv reads under a worker private-path boundary", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-worker-private-run-process-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const memoryPath = join(agentDir, "MEMORY.md");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(memoryPath, "private\n");
		const boundary = {
			redactSensitiveText: (text: string) => text,
			protectedDirectories: [agentDir],
		};

		expect(
			credentialToolBlockReason(
				"run_process",
				{ executable: process.execPath, args: ["-e", "read", memoryPath] },
				projectDir,
				boundary,
			),
		).toContain("blocked");
		expect(
			credentialToolBlockReason(
				"run_process",
				{ executable: process.execPath, args: ["-e", "read", join(root, "sibling", "source.ts")] },
				projectDir,
				boundary,
			),
		).toBeUndefined();
	});

	it("blocks jq process-environment projection without blocking ordinary env fields", () => {
		const cwd = "/workspace";
		expect(credentialToolBlockReason("bash", { command: "jq -n 'env'" }, cwd)).toContain("secret_store discover");
		expect(credentialToolBlockReason("bash", { command: "jq -n '$ENV.API_TOKEN'" }, cwd)).toContain("environment");
		expect(credentialToolBlockReason("bash", { command: "jq -n '[env]'" }, cwd)).toContain("environment");
		expect(credentialToolBlockReason("bash", { command: "jq -n '{token: $ENV.API_TOKEN}'" }, cwd)).toContain(
			"environment",
		);
		expect(credentialToolBlockReason("powershell", { command: 'jq ".env" config.json' }, cwd)).toBeUndefined();
		expect(
			credentialToolBlockReason("bash", { command: 'jq ".label == \\"env\\"" config.json' }, cwd),
		).toBeUndefined();
	});

	it("keeps quoted search alternation intact while proving an explicit file scope", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-secret-search-scope-"));
		tempDirs.push(root);
		const sourcePath = join(root, "module.psm1");
		const secondSourcePath = join(root, "common.psm1");
		const dotenvPath = join(root, ".env");
		writeFileSync(sourcePath, "function Invoke-HBTool {}\n");
		writeFileSync(secondSourcePath, "Start-Process tool\n");
		writeFileSync(dotenvPath, "TOKEN=hidden\n");

		expect(
			credentialToolBlockReason(
				"bash",
				{ command: `rg -n "function Invoke-HBTool|Start-Process|ExitCode" ${sourcePath}` },
				root,
			),
		).toBeUndefined();
		expect(
			credentialToolBlockReason(
				"bash",
				{
					command: `rg -n "function Invoke-HBTool|Start-Process|ExitCode" ${sourcePath} ${secondSourcePath}`,
				},
				root,
			),
		).toBeUndefined();
		expect(
			credentialToolBlockReason(
				"bash",
				{ command: `cd ${root} && rg -n "Invoke-HBTool|Start-Process" ${sourcePath} | head -20` },
				root,
			),
		).toBeUndefined();
		expect(
			credentialToolBlockReason("bash", { command: `cat ${sourcePath} | rg "Invoke-HBTool|Start-Process"` }, root),
		).toBeUndefined();
		expect(
			credentialToolBlockReason(
				"bash",
				{ command: `cat ${sourcePath} | rg -A 3 "Invoke-HBTool|Start-Process"` },
				root,
			),
		).toBeUndefined();
		expect(
			credentialToolBlockReason(
				"bash",
				{ command: `cat ${sourcePath} | grep -E "Invoke-HBTool|Start-Process"` },
				root,
			),
		).toBeUndefined();
		expect(credentialToolBlockReason("bash", { command: 'rg -n "Invoke-HBTool|Start-Process"' }, root)).toContain(
			"narrow non-dotenv",
		);
		expect(
			credentialToolBlockReason("bash", { command: 'rg -n "Invoke-HBTool|Start-Process" . | head -20' }, root),
		).toContain("narrow non-dotenv");
		expect(credentialToolBlockReason("bash", { command: `rg -n "TOKEN|SECRET" ${dotenvPath}` }, root)).toContain(
			"blocked",
		);
	});

	it("allows source-only brace globs and explicit source paths even when one path is stale", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-secret-source-scope-"));
		tempDirs.push(root);
		const rustPath = join(root, "commands.rs");
		const pythonPath = join(root, "probe.py");
		const staleRustPath = join(root, "moved-context-menu.rs");
		const sourceNamedDirectory = join(root, "generated.rs");
		writeFileSync(rustPath, "pub fn format_drive() {}\n");
		writeFileSync(pythonPath, "def probe(): pass\n");
		mkdirSync(sourceNamedDirectory);
		writeFileSync(join(sourceNamedDirectory, ".env"), "TOKEN=hidden\n");

		expect(
			credentialToolBlockReason(
				"bash",
				{ command: `rg -n "format_drive|probe" ${root} --glob '*.{rs,py}' | head -80` },
				root,
			),
		).toBeUndefined();
		expect(
			credentialToolBlockReason("bash", { command: `rg -n "format_drive" ${rustPath} ${staleRustPath}` }, root),
		).toBeUndefined();
		expect(
			credentialToolBlockReason("bash", { command: `rg -n "TOKEN" ${root} --glob '*.{rs,env}'` }, root),
		).toContain("narrow non-dotenv");
		expect(credentialToolBlockReason("bash", { command: `rg -n "TOKEN" ${sourceNamedDirectory}` }, root)).toContain(
			"narrow non-dotenv",
		);
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
		const secret = "opaque-exact-output-marker";
		const boundary = {
			redactSensitiveText: (text: string) => text.split(secret).join("[REDACTED_SECRET]"),
			protectedFiles: [join(root, "agent", "state", "secrets", "vault.json")],
			protectedDirectories: [join(root, "agent", "state", "secrets", "materialized")],
		};
		expect(credentialToolBlockReason("read", { path: boundary.protectedFiles[0] }, root, boundary)).toContain(
			"model-blind",
		);
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
		const guarded = wrapToolWithCredentialExposureGuard(tool, root, boundary);
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
			boundary,
		);
		await expect(failing.execute("call", {})).rejects.not.toThrow(secret);
	});

	it("enforces the path decision at the wrapped execution boundary", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-secret-execution-boundary-"));
		tempDirs.push(root);
		const protectedFile = join(root, "machine", "bws.env");
		mkdirSync(join(root, "machine"));
		writeFileSync(protectedFile, "BWS_ACCESS_TOKEN=hidden\n");
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "must not run" }], details: {} }));
		const tool: AgentTool<typeof testSchema> = {
			name: "read",
			label: "read",
			description: "test read",
			parameters: testSchema,
			execute,
		};
		const guarded = wrapToolWithCredentialExposureGuard(tool, root, {
			redactSensitiveText: (text) => text,
			protectedFiles: [protectedFile],
		});

		const error = await guarded.execute("call", { path: protectedFile }).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toBeInstanceOf(AgentToolExecutionError);
		expect(error).toMatchObject({ failureCode: "credential_access_blocked" });
		expect(execute).not.toHaveBeenCalled();
	});

	it("preserves classified tool errors while redacting their messages", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-secret-classified-error-"));
		tempDirs.push(root);
		const secret = "classified-secret-marker";
		const boundary = {
			redactSensitiveText: (text: string) => text.split(secret).join("[REDACTED_SECRET]"),
			protectedFiles: [],
			protectedDirectories: [],
		};
		const tool: AgentTool<typeof testSchema> = {
			name: "example",
			label: "example",
			description: "test tool",
			parameters: testSchema,
			async execute() {
				throw new AgentToolExecutionError(
					`failure ${secret}`,
					"exit_3",
					"stable-output-signature",
					"operation_outcome",
				);
			},
		};
		const guarded = wrapToolWithCredentialExposureGuard(tool, root, boundary);

		const thrown = await guarded.execute("call", {}).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(thrown).toBeInstanceOf(AgentToolExecutionError);
		expect(thrown).toMatchObject({
			message: "failure [REDACTED_SECRET]",
			failureCode: "exit_3",
			outputSignature: "stable-output-signature",
			errorKind: "operation_outcome",
		});

		const generic = wrapToolWithCredentialExposureGuard(
			{
				...tool,
				async execute() {
					throw new Error(`generic ${secret}`);
				},
			},
			root,
			boundary,
		);
		const genericThrown = await generic.execute("call", {}).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(genericThrown).toBeInstanceOf(Error);
		expect(genericThrown).not.toBeInstanceOf(AgentToolExecutionError);
		expect(genericThrown).toMatchObject({ message: "generic [REDACTED_SECRET]" });
	});
});
