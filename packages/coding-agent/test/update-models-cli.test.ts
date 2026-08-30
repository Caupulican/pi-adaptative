/**
 * B1/P2m: `pi update --models` / `pi update models` used to print "Updated model catalog" and do
 * nothing -- a sham success message for work never performed. The local codebase has no runtime
 * model-catalog-refresh mechanism to drive (the catalog is a build-time-generated file, not a
 * remote-fetched, throttled runtime cache like upstream's), so the flag and positional target were
 * removed rather than faked. These tests pin that removal: neither form claims a catalog update.
 */
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

describe("P2m: pi update --models is removed, not faked", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(
			realpathSync.native(tmpdir()),
			`pi-update-models-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects '--models' as an unknown option instead of claiming a catalog update", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const handled = await handlePackageCommand(["update", "--models"]);
			expect(handled).toBe(true);

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --models for "update".');
			expect(process.exitCode).toBe(1);

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain("Updated model catalog");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("no longer special-cases the 'models' positional target as a catalog update", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await handlePackageCommand(["update", "models"]);

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain("Updated model catalog");
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("documents removal in --help: no --models flag, no 'update models' example", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await handlePackageCommand(["update", "--help"]);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain("--models");
			expect(stdout).not.toContain(`${APP_NAME} update models`);
		} finally {
			logSpy.mockRestore();
		}
	});
});
