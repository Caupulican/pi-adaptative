import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import type { ManagedToolResolution } from "../src/utils/tools-manager.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-search-provisioning-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("search tool provisioning failures", () => {
	const failedResolution: ManagedToolResolution = {
		status: "unavailable",
		failureCode: "installation_failed",
		message: "Failed to extract fd.zip: powershell.exe access denied",
	};

	it("preserves the exact fd provisioning cause for the agent", async () => {
		const root = tempDir();
		const tool = createFindToolDefinition(root, {
			fff: false,
			managedToolResolver: async () => failedResolution,
		});

		await expect(
			tool.execute("find-call", { pattern: "*.ts", path: root }, undefined, undefined, undefined as never),
		).rejects.toThrow(
			"PI_TOOL_PROVISIONING_FAILED [installation_failed] fd: Failed to extract fd.zip: powershell.exe access denied",
		);
	});

	it("preserves the exact ripgrep provisioning cause for the agent", async () => {
		const root = tempDir();
		const tool = createGrepToolDefinition(root, {
			fff: false,
			managedToolResolver: async () => ({
				...failedResolution,
				message: "SHA-256 verification failed for ripgrep.zip",
			}),
		});

		await expect(
			tool.execute("grep-call", { pattern: "needle", path: root }, undefined, undefined, undefined as never),
		).rejects.toThrow(
			"PI_TOOL_PROVISIONING_FAILED [installation_failed] rg: SHA-256 verification failed for ripgrep.zip",
		);
	});
});
