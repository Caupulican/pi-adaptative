import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface PackageManagerInternals {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
}

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const tempDir of tempDirs.splice(0)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

function createManager(npmCommand?: string[]): {
	manager: DefaultPackageManager;
	agentDir: string;
} {
	const tempDir = join(tmpdir(), `pi-package-uninstall-${process.pid}-${Date.now()}-${tempDirs.length}`);
	tempDirs.push(tempDir);
	const agentDir = join(tempDir, "agent");
	mkdirSync(join(agentDir, "npm"), { recursive: true });
	return {
		agentDir,
		manager: new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(npmCommand ? { npmCommand } : undefined),
		}),
	};
}

describe("package uninstall peer dependency handling", () => {
	it("uses legacy peer dependency resolution for npm", async () => {
		const { manager, agentDir } = createManager();
		const runCommand = vi
			.spyOn(manager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);

		await manager.remove("npm:@scope/pkg");

		expect(runCommand).toHaveBeenCalledWith(
			"npm",
			["uninstall", "@scope/pkg", "--prefix", join(agentDir, "npm"), "--legacy-peer-deps"],
			undefined,
		);
	});

	it("does not pass npm-only flags to pnpm", async () => {
		const { manager, agentDir } = createManager(["pnpm"]);
		const runCommand = vi
			.spyOn(manager as unknown as PackageManagerInternals, "runCommand")
			.mockResolvedValue(undefined);

		await manager.remove("npm:@scope/pkg");

		expect(runCommand).toHaveBeenCalledWith(
			"pnpm",
			["uninstall", "@scope/pkg", "--prefix", join(agentDir, "npm")],
			undefined,
		);
	});
});
