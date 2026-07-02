import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolkitScript } from "../src/core/toolkit/script-registry.ts";
import { buildScriptArgv, executeToolkitScript, type ScriptExecution } from "../src/core/toolkit/script-runner.ts";
import { createRunToolkitScriptToolDefinition } from "../src/core/tools/run-toolkit-script.ts";

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

async function runTool(input: Record<string, unknown>, execute = vi.fn(async () => ok())) {
	const tool = createRunToolkitScriptToolDefinition({ getScripts: () => SCRIPTS, execute });
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

	it("never runs dangerous scripts without confirm: true", async () => {
		const { result, execute } = await runTool({ script: "restore-db" });
		expect(execute).not.toHaveBeenCalled();
		expect(result.details.outcome).toBe("confirmation_required");

		const { result: confirmed, execute: execute2 } = await runTool({ script: "restore-db", confirm: true });
		expect(execute2).toHaveBeenCalledOnce();
		expect(confirmed.details.outcome).toBe("executed");
	});

	it("reports unknown scripts as not_found errors with candidates", async () => {
		const { result, execute } = await runTool({ script: "deploy to mars" });
		expect(execute).not.toHaveBeenCalled();
		expect(result.details.outcome).toBe("not_found");
		expect(result.isError).toBe(true);
	});
});

describe("executeToolkitScript (real spawn)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-toolkit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("captures real exit codes and output from a real process", async () => {
		writeFileSync(join(tempDir, "ok.sh"), 'echo "real hello"\n');
		const success = await executeToolkitScript({
			script: { name: "ok", description: "d", runner: "bash", path: "ok.sh" },
			scriptArgs: [],
			cwd: tempDir,
		});
		expect(success.exitCode).toBe(0);
		expect(success.stdout).toContain("real hello");

		writeFileSync(join(tempDir, "fail.sh"), 'echo "boom" >&2\nexit 3\n');
		const failure = await executeToolkitScript({
			script: { name: "fail", description: "d", runner: "bash", path: "fail.sh" },
			scriptArgs: [],
			cwd: tempDir,
		});
		expect(failure.exitCode).toBe(3);
		expect(failure.stderr).toContain("boom");
	});
});
