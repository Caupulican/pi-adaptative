import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BashExecutionController } from "../src/core/bash-execution-controller.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import {
	prepareManagedShellEnvironment,
	shellCommandRequiresManagedRipgrep,
} from "../src/core/tools/managed-shell-preparation.ts";
import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";
import { getShellEnv } from "../src/utils/shell.ts";
import type { ManagedToolResolver } from "../src/utils/tools-manager.ts";

function availableResolver(path = "/managed/bin/rg.exe"): ManagedToolResolver {
	return vi.fn(async () => ({ status: "available" as const, path }));
}

function writeFakeRipgrep(directory: string): string {
	const nodeScriptPath = join(directory, "rg.js");
	const nodeScript = `
		const fs = require("node:fs");
		const args = process.argv.slice(2);
		const patternIndex = args.findIndex((arg) => !arg.startsWith("-"));
		const pattern = patternIndex === -1 ? "" : args[patternIndex];
		const files = patternIndex === -1 ? [] : args.slice(patternIndex + 1);
		const input = files.length > 0 ? files.map((file) => fs.readFileSync(file, "utf8")).join("") : fs.readFileSync(0, "utf8");
		const matches = input.split(/\\r?\\n/).filter((line) => line.includes(pattern) && line.length > 0);
		if (matches.length > 0) process.stdout.write(matches.join("\\n") + "\\n");
		process.exitCode = matches.length > 0 ? 0 : 1;
	`;
	writeFileSync(nodeScriptPath, nodeScript, { mode: 0o755 });
	if (process.platform === "win32") {
		const commandPath = join(directory, "rg.cmd");
		writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "%~dp0rg.js" %*\r\n`);
		return commandPath;
	}
	const executablePath = join(directory, "rg");
	writeFileSync(executablePath, `#!${process.execPath}\n${nodeScript}`, { mode: 0o755 });
	chmodSync(executablePath, 0o755);
	return executablePath;
}

function makeController(cwd: string): BashExecutionController {
	return new BashExecutionController({
		getAgent: () => ({ state: { messages: [] } }) as never,
		getSessionManager: () => ({ getCwd: () => cwd, appendMessage: () => undefined }) as never,
		getSettingsManager: () => ({ getShellCommandPrefix: () => undefined, getShellPath: () => undefined }) as never,
		isStreaming: () => false,
		getEnvironment: () => ({ PATH: join(tmpdir(), "clean-shell-path") }),
	});
}

describe("managed shell preparation", () => {
	it("detects rg at normal command boundaries and prefixes, but not arguments", () => {
		expect(shellCommandRequiresManagedRipgrep("rg needle file.txt | rg needle")).toBe(true);
		expect(shellCommandRequiresManagedRipgrep("FOO=bar command rg needle file.txt")).toBe(true);
		expect(shellCommandRequiresManagedRipgrep("command -- rg needle file.txt")).toBe(true);
		expect(shellCommandRequiresManagedRipgrep("command -v rg")).toBe(false);
		expect(shellCommandRequiresManagedRipgrep("command -V rg")).toBe(false);
		expect(shellCommandRequiresManagedRipgrep("env FOO=bar rg needle file.txt")).toBe(true);
		expect(shellCommandRequiresManagedRipgrep("env -- rg needle file.txt")).toBe(true);
		expect(shellCommandRequiresManagedRipgrep("printf 'rg needle'")).toBe(false);
		expect(shellCommandRequiresManagedRipgrep("echo ripgrep")).toBe(false);
		expect(shellCommandRequiresManagedRipgrep("> output.txt rg needle file.txt")).toBe(true);
		expect(shellCommandRequiresManagedRipgrep("/usr/bin/rg needle file.txt")).toBe(false);
		expect(shellCommandRequiresManagedRipgrep("sudo rg needle file.txt")).toBe(false);
	});

	it("resolves once per operation and prepends the managed executable directory", async () => {
		const resolvedPath = join(tmpdir(), "managed-shell", "rg.exe");
		const resolver = availableResolver(resolvedPath);
		const existingPath = join(tmpdir(), "system-bin");
		const environment = { PATH: existingPath, KEEP: "yes" };
		const prepared = await prepareManagedShellEnvironment("rg needle file.txt | rg needle", environment, resolver);

		expect(resolver).toHaveBeenCalledTimes(1);
		expect(resolver).toHaveBeenCalledWith("rg", true);
		expect(prepared.PATH?.split(delimiter)).toEqual([dirname(resolvedPath), existingPath]);
		expect(prepared.KEEP).toBe("yes");
		expect(environment.PATH).toBe(existingPath);
	});

	it("preserves a case-insensitive Windows Path key and does not inject bare resolver paths", async () => {
		const resolver = availableResolver("rg.exe");
		const environment = { Path: join(tmpdir(), "system-bin") };
		const prepared = await prepareManagedShellEnvironment("rg needle file.txt", environment, resolver);

		expect(prepared).toEqual(environment);
		expect(prepared).not.toHaveProperty("PATH");
	});

	it("normalizes duplicate PATH casing using the caller's override and prepends managed bin", () => {
		const originalEnvironment = { ...process.env };
		const agentDir = mkdtempSync(join(tmpdir(), "pi-shell-env-"));
		const systemPath = join(agentDir, "system-bin");
		const credentialEntries = [join(agentDir, "credential-bin"), join(agentDir, "credential-tools")];
		const credentialPath = credentialEntries.join(delimiter);
		const input = { Path: systemPath, PATH: credentialPath, KEEP: "yes" };
		process.env.PI_ADAPTATIVE_CODING_AGENT_DIR = agentDir;
		try {
			const prepared = getShellEnv(input, "win32");
			const pathKeys = Object.keys(prepared).filter((key) => key.toLowerCase() === "path");
			expect(pathKeys).toEqual(["PATH"]);
			expect(prepared.PATH?.split(delimiter)).toEqual([join(agentDir, "bin"), ...credentialEntries]);
			expect(input).toEqual({ Path: systemPath, PATH: credentialPath, KEEP: "yes" });
		} finally {
			for (const key of Object.keys(process.env)) {
				if (!(key in originalEnvironment)) delete process.env[key];
			}
			Object.assign(process.env, originalEnvironment);
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("keeps POSIX PATH casing distinct while injecting only the canonical PATH", () => {
		const originalEnvironment = { ...process.env };
		const agentDir = mkdtempSync(join(tmpdir(), "pi-shell-posix-env-"));
		const executablePath = join(agentDir, "system-bin");
		const credentialValue = join(agentDir, "credential-bin");
		const input = { PATH: executablePath, Path: credentialValue, KEEP: "yes" };
		process.env.PI_ADAPTATIVE_CODING_AGENT_DIR = agentDir;
		try {
			const prepared = getShellEnv(input, "linux");
			expect(prepared.PATH?.split(delimiter)).toEqual([join(agentDir, "bin"), executablePath]);
			expect(prepared.Path).toBe(credentialValue);
			expect(input).toEqual({ PATH: executablePath, Path: credentialValue, KEEP: "yes" });
		} finally {
			for (const key of Object.keys(process.env)) {
				if (!(key in originalEnvironment)) delete process.env[key];
			}
			Object.assign(process.env, originalEnvironment);
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("does not provision unrelated commands", async () => {
		const resolver = availableResolver();
		const environment = { PATH: "/usr/bin" };

		expect(await prepareManagedShellEnvironment("printf '%s\\n' needle", environment, resolver)).toBe(environment);
		expect(resolver).not.toHaveBeenCalled();
	});

	it("keeps concurrent operations independent when one resolver call fails", async () => {
		let calls = 0;
		const resolver: ManagedToolResolver = vi.fn(async () => {
			calls++;
			if (calls === 1) {
				return {
					status: "unavailable" as const,
					failureCode: "installation_failed" as const,
					message: "network down",
				};
			}
			return { status: "available" as const, path: join(tmpdir(), "managed-shell", "rg") };
		});

		const results = await Promise.allSettled([
			prepareManagedShellEnvironment("rg needle file.txt", { PATH: "/usr/bin" }, resolver),
			prepareManagedShellEnvironment("rg needle other.txt", { PATH: "/usr/bin" }, resolver),
		]);

		expect(results[0]?.status).toBe("rejected");
		expect(results[1]?.status).toBe("fulfilled");
		expect(resolver).toHaveBeenCalledTimes(2);
	});

	it("surfaces the diagnostic-preserving provisioning failure", async () => {
		const resolver: ManagedToolResolver = async () => ({
			status: "unavailable",
			failureCode: "offline",
			message: "offline mode is enabled",
		});

		await expect(
			prepareManagedShellEnvironment("rg needle file.txt", { PATH: "/usr/bin" }, resolver),
		).rejects.toThrow("PI_TOOL_PROVISIONING_FAILED [offline] rg: offline mode is enabled");
	});

	it("provisions the direct controller path for a clean-PATH pipeline and preserves no-match exit 1", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-managed-rg-controller-"));
		try {
			const rgPath = writeFakeRipgrep(directory);
			writeFileSync(join(directory, "needle.txt"), "needle\nother\n");
			const resolver = availableResolver(rgPath);
			const controller = makeController(directory);

			const matched = await controller.executeBash("rg 'needle' needle.txt | rg 'needle'", undefined, {
				platform: "win32",
				managedToolResolver: resolver,
			});
			expect(matched.exitCode).toBe(0);
			expect(matched.output).toContain("needle");
			expect(resolver).toHaveBeenCalledTimes(1);

			const noMatch = await controller.executeBash("rg 'absent' needle.txt | rg 'absent'", undefined, {
				platform: "win32",
				managedToolResolver: resolver,
			});
			expect(noMatch.exitCode).toBe(1);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("provisions the bash-tool path while leaving custom operations remote", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-managed-rg-tool-"));
		const sessionKey = `managed-rg-tool:${Math.random().toString(36).slice(2)}`;
		try {
			const rgPath = writeFakeRipgrep(directory);
			writeFileSync(join(directory, "needle.txt"), "needle\n");
			const resolver = availableResolver(rgPath);
			const cleanPath = join(tmpdir(), "clean-shell-path");
			const tool = createBashToolDefinition(directory, {
				platform: "win32",
				sessionKey,
				managedToolResolver: resolver,
				spawnHook: (context) => ({ ...context, env: { ...context.env, PATH: cleanPath } }),
			});
			const result = await tool.execute(
				"managed-rg-tool",
				{ command: "rg 'needle' needle.txt | rg 'needle'", broadSearch: "route-to-file" },
				undefined,
				undefined,
				undefined as never,
			);
			const content = result.content[0];
			if (content?.type !== "text") throw new Error("expected text output");
			expect(content.text).toContain("needle");
			expect(resolver).toHaveBeenCalledTimes(1);

			const remoteCalls: string[] = [];
			const remote: BashOperations = {
				exec: async (command) => {
					remoteCalls.push(command);
					return { exitCode: 0 };
				},
			};
			const remoteTool = createBashToolDefinition(directory, {
				platform: "win32",
				operations: remote,
				managedToolResolver: resolver,
			});
			await remoteTool.execute(
				"remote-rg",
				{ command: "rg needle", broadSearch: "route-to-file" },
				undefined,
				undefined,
				undefined as never,
			);
			expect(remoteCalls).toHaveLength(1);
			expect(remoteCalls[0]).toContain("'rg'");
			expect(resolver).toHaveBeenCalledTimes(1);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
