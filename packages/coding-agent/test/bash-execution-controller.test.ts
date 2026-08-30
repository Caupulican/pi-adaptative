import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BashExecutionController } from "../src/core/bash-execution-controller.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";

const originalBitwardenSession = process.env.BW_SESSION;

afterEach(() => {
	if (originalBitwardenSession === undefined) delete process.env.BW_SESSION;
	else process.env.BW_SESSION = originalBitwardenSession;
});

// Same probe pattern as the engine tests: PI_TEST_PYTHON -> python3 -> python, else no interpreter.
function resolvePython(): string | null {
	const fromEnv = process.env.PI_TEST_PYTHON;
	const candidates = fromEnv ? [fromEnv, "python3", "python"] : ["python3", "python"];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

function makeController(): BashExecutionController {
	return new BashExecutionController({
		getAgent: () =>
			({ state: { messages: [], model: { provider: "test", id: "test-model" }, thinkingLevel: "off" } }) as never,
		getSessionManager: () =>
			({
				getCwd: () => process.cwd(),
				appendMessage: () => undefined,
				getSessionId: () => "test-session-id",
				getSessionFile: () => undefined,
			}) as never,
		getSettingsManager: () =>
			({
				getShellCommandPrefix: () => undefined,
				getShellPath: () => undefined,
				getExposeSessionEnvironment: () => true,
			}) as never,
		isStreaming: () => false,
	});
}

describe("BashExecutionController", () => {
	it("shares active project credentials with owner shell commands but withholds BW_SESSION", async () => {
		process.env.BW_SESSION = "owner-control-plane-key";
		const controller = new BashExecutionController({
			getAgent: () =>
				({ state: { messages: [], model: { provider: "test", id: "test-model" }, thinkingLevel: "off" } }) as never,
			getSessionManager: () =>
				({
					getCwd: () => process.cwd(),
					appendMessage: () => undefined,
					getSessionId: () => "test-session-id",
					getSessionFile: () => undefined,
				}) as never,
			getSettingsManager: () =>
				({
					getShellCommandPrefix: () => undefined,
					getShellPath: () => undefined,
					getExposeSessionEnvironment: () => true,
				}) as never,
			isStreaming: () => false,
			getEnvironment: () => ({ API_TOKEN: "active-project-token", BW_SESSION: "must-not-win" }),
		});
		let environment: NodeJS.ProcessEnv | undefined;
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				environment = options.env;
				return { exitCode: 0 };
			},
		};

		await controller.executeBash("consumer", undefined, { operations, platform: "linux" });

		expect(environment).toMatchObject({ API_TOKEN: "active-project-token" });
		expect(environment).not.toHaveProperty("BW_SESSION");
	});

	it("keeps raw owner output in the TUI result but redacts it from the model transcript", async () => {
		const messages: Array<{ command: string; output: string; fullOutputPath?: string }> = [];
		const persisted: Array<{ command: string; output: string; fullOutputPath?: string }> = [];
		const controller = new BashExecutionController({
			getAgent: () =>
				({ state: { messages, model: { provider: "test", id: "test-model" }, thinkingLevel: "off" } }) as never,
			getSessionManager: () =>
				({
					getCwd: () => process.cwd(),
					appendMessage: (message: never) => persisted.push(message),
					getSessionId: () => "test-session-id",
					getSessionFile: () => undefined,
				}) as never,
			getSettingsManager: () =>
				({
					getShellCommandPrefix: () => undefined,
					getShellPath: () => undefined,
					getExposeSessionEnvironment: () => true,
				}) as never,
			isStreaming: () => false,
			redactSensitiveText: (text) => text.replaceAll("active-project-token", "[REDACTED_SECRET]"),
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("active-project-token"));
				return { exitCode: 0 };
			},
		};

		const result = await controller.executeBash("consumer active-project-token", undefined, {
			operations,
			platform: "linux",
		});

		expect(result.output).toBe("active-project-token");
		expect(messages).toMatchObject([{ command: "consumer [REDACTED_SECRET]", output: "[REDACTED_SECRET]" }]);
		expect(persisted).toEqual(messages);
	});

	it("applies a bounded default and the same Windows shell contract as the agent tool (engine disabled)", async () => {
		const controller = makeController();
		let executedCommand = "";
		let executedTimeout: number | undefined;
		const operations: BashOperations = {
			exec: async (command, _cwd, options) => {
				executedCommand = command;
				executedTimeout = options.timeout;
				return { stdout: "ok", stderr: "", exitCode: 0, killed: false };
			},
		};

		await controller.executeBash("node --version", undefined, { operations, platform: "win32", pythonEngine: false });
		expect(executedCommand).not.toContain("OutputEncoding");
		expect(executedCommand).toContain("& 'node' '--version'");
		expect(executedTimeout).toBe(120);

		// Off-switch contract stays verbatim: with the engine explicitly disabled, a pipeline is
		// still an unsupported Bash construct on the PowerShell floor.
		await expect(
			controller.executeBash("node --version | more", undefined, {
				operations,
				platform: "win32",
				pythonEngine: false,
			}),
		).rejects.toThrow(/Unsupported Bash construct on Windows/i);
	});

	it("decodes UTF-8 and Windows-1252 output in the owner Windows shell", async () => {
		const controller = makeController();
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("ação 日本 €\n", "utf8"));
				options.onData(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
				return { exitCode: 0 };
			},
		};

		const result = await controller.executeBash("legacy-output.exe", undefined, {
			operations,
			platform: "win32",
			pythonEngine: false,
		});

		expect(result.output).toBe("ação 日本 €\ncafé\n");
	});

	if (!resolvePython()) {
		// No interpreter available in this environment — the off-switch case above still covers
		// the contract everywhere; only this engine-ON case self-skips.
		it.skip("resolves a pipeline through the Python engine when the engine is enabled (default)", () => {});
	} else {
		it("resolves a pipeline through the Python engine when the engine is enabled (default)", async () => {
			const controller = makeController();
			const operations: BashOperations = {
				exec: async (_command, _cwd, _options) => {
					throw new Error("engine route must not fall through to the raw shell operations");
				},
			};

			const result = await controller.executeBash("node --version | more", undefined, {
				operations,
				platform: "win32",
				pythonEngine: true,
			});

			expect(result.exitCode).toBe(0);
			expect(result.output).toMatch(/^v?\d+\.\d+\.\d+/);
		});
	}

	it.skipIf(process.platform === "win32")(
		"persists an in-session cd across owner commands without adding cwd lines to output",
		async () => {
			const sessionKey = `controller-cwd-${Math.random().toString(36).slice(2)}`;
			const controller = new BashExecutionController({
				getAgent: () =>
					({
						state: { messages: [], model: { provider: "test", id: "test-model" }, thinkingLevel: "off" },
					}) as never,
				getSessionManager: () =>
					({
						getCwd: () => process.cwd(),
						appendMessage: () => undefined,
						getSessionId: () => "test-session-id",
						getSessionFile: () => undefined,
					}) as never,
				getSettingsManager: () =>
					({
						getShellCommandPrefix: () => undefined,
						getShellPath: () => undefined,
						getExposeSessionEnvironment: () => true,
					}) as never,
				isStreaming: () => false,
				getShellSessionKey: () => sessionKey,
			});
			const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-controller-cwd-")));
			try {
				const failed = await controller.executeBash(`cd '${tempDir}' && false`, undefined, { platform: "linux" });
				expect(failed.exitCode).toBe(1);
				expect(failed.output).not.toContain("cwd:");
				const persisted = await controller.executeBash("pwd", undefined, { platform: "linux" });
				expect(persisted.output.trim()).toBe(tempDir);
			} finally {
				await disposeShellExecutionSessionAndWait(sessionKey);
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"keeps POSIX session cwd and exports across managed rg preparation",
		async () => {
			const originalEnvironment = { ...process.env };
			const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-controller-managed-agent-")));
			const binDir = join(agentDir, "bin");
			const credentialBinDir = join(agentDir, "credential-bin");
			const subDir = join(agentDir, "project");
			const sessionKey = `controller-managed-rg-${Math.random().toString(36).slice(2)}`;
			mkdirSync(binDir);
			mkdirSync(credentialBinDir);
			mkdirSync(subDir);
			writeFileSync(join(subDir, "needle.txt"), "needle\n");
			const credentialToolPath = join(credentialBinDir, "credential-tool");
			writeFileSync(credentialToolPath, "#!/bin/sh\nprintf '%s' credential-path\n", { mode: 0o755 });
			chmodSync(credentialToolPath, 0o755);
			const rgPath = join(binDir, "rg");
			writeFileSync(
				rgPath,
				'#!/bin/sh\npattern=$1\nshift\nif [ $# -gt 0 ]; then cat "$1"; else cat; fi | grep "$pattern"\n',
				{ mode: 0o755 },
			);
			chmodSync(rgPath, 0o755);
			process.env.PI_ADAPTATIVE_CODING_AGENT_DIR = agentDir;
			try {
				const controller = new BashExecutionController({
					getAgent: () =>
						({
							state: { messages: [], model: { provider: "test", id: "test-model" }, thinkingLevel: "off" },
						}) as never,
					getSessionManager: () =>
						({
							getCwd: () => agentDir,
							appendMessage: () => undefined,
							getSessionId: () => "test-session-id",
							getSessionFile: () => undefined,
						}) as never,
					getSettingsManager: () =>
						({
							getShellCommandPrefix: () => undefined,
							getShellPath: () => undefined,
							getExposeSessionEnvironment: () => true,
						}) as never,
					isStreaming: () => false,
					getShellSessionKey: () => sessionKey,
					getEnvironment: () => ({
						PATH: [credentialBinDir, originalEnvironment.PATH].filter(Boolean).join(delimiter),
						PI_CONTROLLER_CREDENTIAL: "present",
					}),
				});
				const resolver = async () => ({ status: "available" as const, path: rgPath });

				const setup = await controller.executeBash(
					`cd '${subDir}' && export PI_MANAGED_SESSION_MARKER=survives`,
					undefined,
					{ platform: "linux", managedToolResolver: resolver },
				);
				expect(setup.exitCode).toBe(0);
				const search = await controller.executeBash("rg 'needle' needle.txt | rg 'needle'", undefined, {
					platform: "linux",
					managedToolResolver: resolver,
				});
				expect(search.exitCode).toBe(0);
				expect(search.output).toContain("needle");
				const credentialPath = await controller.executeBash("credential-tool", undefined, {
					platform: "linux",
					managedToolResolver: resolver,
				});
				expect(credentialPath.output).toBe("credential-path");
				const cwd = await controller.executeBash("pwd", undefined, {
					platform: "linux",
					managedToolResolver: resolver,
				});
				expect(realpathSync(cwd.output.trim())).toBe(subDir);
				const marker = await controller.executeBash("printf '%s' \"$PI_MANAGED_SESSION_MARKER\"", undefined, {
					platform: "linux",
					managedToolResolver: resolver,
				});
				expect(marker.output).toBe("survives");
			} finally {
				await disposeShellExecutionSessionAndWait(sessionKey);
				for (const key of Object.keys(process.env)) {
					if (!(key in originalEnvironment)) delete process.env[key];
				}
				Object.assign(process.env, originalEnvironment);
				rmSync(agentDir, { recursive: true, force: true });
			}
		},
	);

	it("aborts all overlapping bash executions", async () => {
		const controller = makeController();
		const aborted: string[] = [];
		const operations: BashOperations = {
			exec: async (command, _cwd, options) => {
				await new Promise<void>((resolve) => {
					options.signal?.addEventListener(
						"abort",
						() => {
							aborted.push(command);
							resolve();
						},
						{ once: true },
					);
				});
				return { stdout: "", stderr: "", exitCode: 130, killed: true };
			},
		};

		const first = controller.executeBash("first", undefined, { operations, platform: "linux" });
		const second = controller.executeBash("second", undefined, { operations, platform: "linux" });
		controller.abortBash();
		await Promise.all([first, second]);

		expect(aborted.sort()).toEqual(["first", "second"]);
		expect(controller.isBashRunning).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"injects the live session identity into owner (!command) shell processes too (C4/P2k)",
		async () => {
			// bash-execution-controller only builds its own session-aware env when no `operations`
			// override is supplied (an explicit override is assumed to own its own environment), so
			// this must exercise the real default shell backend rather than a capturing fake.
			const sessionKey = `test-owner-identity-${Date.now()}`;
			const controller = new BashExecutionController({
				getAgent: () =>
					({
						state: { messages: [], model: { provider: "test", id: "test-model" }, thinkingLevel: "off" },
					}) as never,
				getSessionManager: () =>
					({
						getCwd: () => process.cwd(),
						appendMessage: () => undefined,
						getSessionId: () => "test-session-id",
						getSessionFile: () => undefined,
					}) as never,
				getSettingsManager: () =>
					({
						getShellCommandPrefix: () => undefined,
						getShellPath: () => undefined,
						getExposeSessionEnvironment: () => true,
					}) as never,
				isStreaming: () => false,
				getShellSessionKey: () => sessionKey,
			});
			try {
				const result = await controller.executeBash(
					'printf \'ID=%s|PROVIDER=%s|MODEL=%s|LEVEL=%s\' "$PI_SESSION_ID" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"',
				);

				expect(result.output).toContain("ID=test-session-id");
				expect(result.output).toContain("PROVIDER=test");
				expect(result.output).toContain("MODEL=test-model");
				expect(result.output).toContain("LEVEL=off");
			} finally {
				await disposeShellExecutionSessionAndWait(sessionKey);
			}
		},
	);
});
