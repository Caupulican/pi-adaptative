import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../src");
const retiredModulePath = join(sourceRoot, "utils/windows-self-update.ts");
const retiredSourcePattern =
	/windows-self-update|\.pi-native-quarantine|cleanupWindowsSelfUpdateQuarantine|quarantineWindowsNativeDependencies/;

function collectProductionSourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectProductionSourceFiles(path));
		} else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

describe("retired Windows package self-update quarantine", () => {
	it("has no production module, caller, or quarantine path", () => {
		expect(existsSync(retiredModulePath)).toBe(false);

		for (const sourceFile of collectProductionSourceFiles(sourceRoot)) {
			const source = readFileSync(sourceFile, "utf8");
			expect(source, sourceFile).not.toMatch(retiredSourcePattern);
		}
	});
});
