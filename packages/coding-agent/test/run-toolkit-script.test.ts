import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ArtifactStore, createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import type { ToolkitScript } from "../src/core/toolkit/script-registry.ts";
import { buildScriptArgv, executeToolkitScript, type ScriptExecution } from "../src/core/toolkit/script-runner.ts";
import {
	createRunToolkitScriptToolDefinition,
	type ToolkitScriptAuthorizer,
} from "../src/core/tools/run-toolkit-script.ts";

const SCRIPTS: ToolkitScript[] = [
	{ name: "prepare-db", description: "Prepare the dev database schema", runner: "uv", path: "toolkit/prepare_db.py" },
	{ name: "update-db", description: "Update the dev database migrations", runner: "uv", path: "toolkit/update_db.py" },
	{
		name: "restore-db",
		description: "Restore the dev database from backup",
		runner: "powershell",
		path: "toolkit/restore-db.ps1",
		danger: true,
	},
];

function ok(stdout = "hello"): ScriptExecution {
	return { exitCode: 0, stdout, stderr: "", durationMs: 12, timedOut: false };
}

async function runTool(
	input: Record<string, unknown>,
	execute: (script: ToolkitScript, args: readonly string[], signal?: AbortSignal) => Promise<ScriptExecution> = vi.fn(
		async () => ok(),
	),
	artifactStore?: ArtifactStore,
	authorize?: ToolkitScriptAuthorizer,
) {
	const tool = createRunToolkitScriptToolDefinition({ getScripts: () => SCRIPTS, execute, artifactStore, authorize });
	const result = (await tool.execute(
		"call-1",
		input as never,
		undefined as never,
		undefined as never,
		undefined as never,
	)) as {
		content: Array<{ type: "text"; text: string }>;
		details: { outcome: string; shortlist?: string[]; exitCode?: number | null };
		isError?: boolean;
	};
	return { result, execute };
}

describe("buildScriptArgv", () => {
	it("builds fixed argv per runner, never a shell string", () => {
		expect(buildScriptArgv(SCRIPTS[0], ["--fast"])).toEqual({
			command: "uv",
			argv: ["run", "toolkit/prepare_db.py", "--fast"],
		});
		expect(buildScriptArgv(SCRIPTS[2], [])).toEqual({
			command: "powershell.exe",
			argv: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "toolkit/restore-db.ps1"],
		});
	});
});

describe("run_toolkit_script tool", () => {
	it("executes an exact match and relays real output", async () => {
		const { result, execute } = await runTool({ script: "prepare-db" });
		expect(execute).toHaveBeenCalledOnce();
		expect(result.details.outcome).toBe("executed");
		expect(result.isError).toBeUndefined();
		expect(result.content[0]?.text).toContain("hello");
	});

	it("returns a shortlist for ambiguous requests and does NOT execute", async () => {
		const { result, execute } = await runTool({ script: "the db one" });
		expect(execute).not.toHaveBeenCalled();
		expect(result.details.outcome).toBe("ambiguous");
		expect(result.details.shortlist).toContain("prepare-db");
		expect(result.details.shortlist).toContain("update-db");
	});

	it("reports failure structurally: non-zero exit is an error carrying stderr", async () => {
		const failing = vi.fn(
			async (): Promise<ScriptExecution> => ({
				exitCode: 1,
				stdout: "",
				stderr: "restore failed: backup missing",
				durationMs: 30,
				timedOut: false,
			}),
		);
		const { result } = await runTool({ script: "prepare-db" }, failing);
		expect(result.isError).toBe(true);
		expect(result.details.outcome).toBe("failed");
		expect(result.content[0]?.text).toContain("FAILED");
		expect(result.content[0]?.text).toContain("backup missing");
	});

	it("dangerous script without host authorizer remains unexecuted even if confirm: true is provided", async () => {
		const { result, execute } = await runTool({ script: "restore-db" });
		expect(execute).not.toHaveBeenCalled();
		expect(result.details.outcome).toBe("confirmation_required");
		expect(result.isError).toBe(true);

		const { result: confirmed, execute: execute2 } = await runTool({ script: "restore-db", confirm: true });
		expect(execute2).not.toHaveBeenCalled();
		expect(confirmed.details.outcome).toBe("confirmation_required");
		expect(confirmed.isError).toBe(true);
		expect(confirmed.content[0]?.text).toContain("requires host authorization");
	});

	it("authorized toolkit operation executes without duplicate confirmation question", async () => {
		const authorize = vi.fn(async () => ({ authorized: true }));
		const execute = vi.fn(async () => ok());
		const { result } = await runTool({ script: "restore-db" }, execute, undefined, authorize);
		expect(authorize).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		expect(result.details.outcome).toBe("executed");
	});

	it("absence or denial by host authorizer leaves script unexecuted", async () => {
		const authorize = vi.fn(async () => ({ authorized: false, reason: "Operator denied restore-db." }));
		const execute = vi.fn(async () => ok());
		const { result } = await runTool({ script: "restore-db" }, execute, undefined, authorize);
		expect(authorize).toHaveBeenCalledOnce();
		expect(execute).not.toHaveBeenCalled();
		expect(result.details.outcome).toBe("confirmation_required");
		expect(result.content[0]?.text).toContain("Operator denied restore-db.");
	});

	it("caller cannot forge grant when host authorizer denies", async () => {
		const authorize = vi.fn(async () => ({ authorized: false, reason: "No standing grant for dangerous script." }));
		const execute = vi.fn(async () => ok());
		const { result } = await runTool({ script: "restore-db", confirm: true }, execute, undefined, authorize);
		expect(authorize).toHaveBeenCalledWith(
			{
				script: expect.objectContaining({ name: "restore-db" }),
				args: [],
			},
			undefined,
		);
		expect(execute).not.toHaveBeenCalled();
		expect(result.details.outcome).toBe("confirmation_required");
		expect(result.content[0]?.text).toContain("No standing grant for dangerous script.");
	});

	it("freezes immutable script and argv snapshot before awaiting authorization and executes that exact snapshot", async () => {
		let capturedReq: { script: ToolkitScript; args: readonly string[] } | undefined;
		const authorize = vi.fn(async (req) => {
			capturedReq = req;
			return { authorized: true };
		});
		let executedScript: ToolkitScript | undefined;
		let executedArgs: readonly string[] | undefined;
		const execute = vi.fn(async (s: ToolkitScript, a: readonly string[]) => {
			executedScript = s;
			executedArgs = a;
			return ok();
		});

		const args = ["--initial-flag"];
		const { result } = await runTool({ script: "restore-db", args }, execute, undefined, authorize);
		expect(result.details.outcome).toBe("executed");
		expect(capturedReq).toBeDefined();
		expect(Object.isFrozen(capturedReq!.script)).toBe(true);
		expect(Object.isFrozen(capturedReq!.args)).toBe(true);
		expect(executedScript).toBe(capturedReq!.script);
		expect(executedArgs).toBe(capturedReq!.args);
		expect(executedArgs).toEqual(["--initial-flag"]);
	});

	it("cancellation during authorization prevents execution even if authorizer returns yes", async () => {
		const controller = new AbortController();
		let resolveAuthorizer: (decision: { authorized: boolean }) => void;
		const authorizePromise = new Promise<{ authorized: boolean }>((resolve) => {
			resolveAuthorizer = resolve;
		});
		const authorize = vi.fn(async () => authorizePromise);
		const execute = vi.fn(async () => ok());

		const tool = createRunToolkitScriptToolDefinition({
			getScripts: () => SCRIPTS,
			execute,
			authorize,
		});

		const executionPromise = tool.execute(
			"call-1",
			{ script: "restore-db" },
			controller.signal,
			undefined as never,
			undefined as never,
		);

		// Signal is aborted while authorize is pending
		controller.abort();
		// Authorizer completes with authorized: true
		resolveAuthorizer!({ authorized: true });

		await expect(executionPromise).rejects.toThrow();
		expect(authorize).toHaveBeenCalledOnce();
		expect(execute).not.toHaveBeenCalled();
	});

	it("authorizer validates exact script identity and argv without silently covering changes", async () => {
		const authorize = vi.fn(async (req) => {
			if (req.args.includes("--dangerous-unauthorized-flag")) {
				return { authorized: false, reason: "Flag --dangerous-unauthorized-flag is prohibited." };
			}
			return { authorized: true };
		});
		const execute = vi.fn(async () => ok());
		const { result } = await runTool(
			{ script: "restore-db", args: ["--dangerous-unauthorized-flag"] },
			execute,
			undefined,
			authorize,
		);
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				script: expect.objectContaining({ name: "restore-db" }),
				args: ["--dangerous-unauthorized-flag"],
			}),
			undefined,
		);
		expect(execute).not.toHaveBeenCalled();
		expect(result.details.outcome).toBe("confirmation_required");
		expect(result.content[0]?.text).toContain("Flag --dangerous-unauthorized-flag is prohibited.");
	});

	it("ambiguous match preserves ambiguity and does not consult authorizer or execute", async () => {
		const authorize = vi.fn(async () => ({ authorized: true }));
		const execute = vi.fn(async () => ok());
		const { result } = await runTool({ script: "the db one" }, execute, undefined, authorize);
		expect(authorize).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(result.details.outcome).toBe("ambiguous");
		expect(result.details.shortlist).toContain("prepare-db");
		expect(result.details.shortlist).toContain("update-db");
	});

	it("reports unknown scripts as not_found errors with candidates", async () => {
		const { result, execute } = await runTool({ script: "deploy to mars" });
		expect(execute).not.toHaveBeenCalled();
		expect(result.details.outcome).toBe("not_found");
		expect(result.isError).toBe(true);
	});

	it("stores exact oversized output and returns a bounded retrievable preview", async () => {
		const store = createInMemoryArtifactStore();
		const stdout = `${"large-output-line\n".repeat(1_000)}final-sentinel`;
		const { result } = await runTool(
			{ script: "prepare-db" },
			vi.fn(async () => ok(stdout)),
			store,
		);

		expect(result.content[0]?.text.length).toBeLessThan(stdout.length);
		expect(result.content[0]?.text).toContain("Full output: artifact tool-output:");
		const artifactId = (result.details as { artifactId?: string }).artifactId;
		expect(artifactId).toBeDefined();
		const artifact = store.read(artifactId!);
		expect("content" in artifact ? artifact.content : "").toContain("final-sentinel");
	});
});

describe("executeToolkitScript (real spawn)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-toolkit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	it("captures real exit codes and output from a real process", async () => {
		const runner = process.platform === "win32" ? "powershell" : "bash";
		const okScript = process.platform === "win32" ? "ok.ps1" : "ok.sh";
		const failScript = process.platform === "win32" ? "fail.ps1" : "fail.sh";
		writeFileSync(
			join(tempDir, okScript),
			process.platform === "win32" ? 'Write-Output "real hello"\n' : 'echo "real hello"\n',
		);
		const success = await executeToolkitScript({
			script: { name: "ok", description: "d", runner, path: okScript },
			scriptArgs: [],
			cwd: tempDir,
		});
		expect(success.exitCode).toBe(0);
		expect(success.stdout).toContain("real hello");

		writeFileSync(
			join(tempDir, failScript),
			process.platform === "win32" ? '[Console]::Error.WriteLine("boom")\nexit 3\n' : 'echo "boom" >&2\nexit 3\n',
		);
		const failure = await executeToolkitScript({
			script: { name: "fail", description: "d", runner, path: failScript },
			scriptArgs: [],
			cwd: tempDir,
		});
		expect(failure.exitCode).toBe(3);
		expect(failure.stderr).toContain("boom");
	});

	it("forwards cancellation through the bounded executor", async () => {
		const controller = new AbortController();
		let receivedSignal: AbortSignal | undefined;
		const result = await executeToolkitScript({
			script: { name: "cancel", description: "d", runner: "bash", path: "cancel.sh" },
			scriptArgs: [],
			cwd: tempDir,
			signal: controller.signal,
			executor: async (_command, _argv, _cwd, _timeoutMs, signal) => {
				receivedSignal = signal;
				return { exitCode: null, stdout: "", stderr: "aborted", durationMs: 1, timedOut: false };
			},
		});
		expect(receivedSignal).toBe(controller.signal);
		expect(result.exitCode).toBeNull();
		expect(result.stderr).toBe("aborted");
	});
});
