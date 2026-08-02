import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveExtensionIndexEntry } from "../src/core/extensions/entry-resolution.ts";

describe("extension entry resolution", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	test("loads precompiled Pi-owned extensions while keeping user extensions source-first", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-extension-entry-"));
		directories.push(root);
		const bundledRoot = join(root, "dist", "bundled-resources", "extensions");
		const bundled = join(bundledRoot, "tmux");
		const external = join(root, "project", ".pi", "extensions", "custom");
		mkdirSync(bundled, { recursive: true });
		mkdirSync(external, { recursive: true });
		for (const directory of [bundled, external]) {
			writeFileSync(join(directory, "index.ts"), "export default 1;");
			writeFileSync(join(directory, "index.js"), "export default 1;");
		}

		expect(resolveExtensionIndexEntry(bundled, bundledRoot)).toBe(join(bundled, "index.js"));
		expect(resolveExtensionIndexEntry(external, bundledRoot)).toBe(join(external, "index.ts"));
	});
});
