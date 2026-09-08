import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverGnuToolsDir, isGnuToolsDir, resolveGnuToolsDir } from "../src/utils/shell.ts";

/**
 * `windowsShell.gnuToolsDir` resolution: the directory the shell engine dispatches GNU tool names
 * to. `"auto"` discovers Git for Windows on Windows and nothing elsewhere, `"off"` disables, and an
 * explicit directory must hold the marker binaries or the setting is reported, never silently
 * downgraded to the engine's builtins.
 */
describe("GNU tools directory resolution", () => {
	let root: string;
	const suffix = process.platform === "win32" ? ".exe" : "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-gnu-dir-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("recognizes a directory by its marker binaries and rejects one missing them", () => {
		const complete = join(root, "usr", "bin");
		mkdirSync(complete, { recursive: true });
		writeFileSync(join(complete, `ls${suffix}`), "");
		writeFileSync(join(complete, `find${suffix}`), "");
		expect(isGnuToolsDir(complete)).toBe(true);
		const partial = join(root, "partial");
		mkdirSync(partial);
		writeFileSync(join(partial, `ls${suffix}`), "");
		expect(isGnuToolsDir(partial)).toBe(false);
		expect(isGnuToolsDir(join(root, "absent"))).toBe(false);
	});

	it("resolves off to nothing, an explicit complete directory to itself, and reports an explicit incomplete one", () => {
		const complete = join(root, "tools");
		mkdirSync(complete);
		writeFileSync(join(complete, `ls${suffix}`), "");
		writeFileSync(join(complete, `find${suffix}`), "");
		expect(resolveGnuToolsDir("off")).toBeNull();
		expect(resolveGnuToolsDir(complete)).toBe(complete);
		const incomplete = join(root, "no-tools");
		mkdirSync(incomplete);
		expect(() => resolveGnuToolsDir(incomplete)).toThrow(
			/windowsShell\.gnuToolsDir .* does not hold GNU tools \(ls, find\)/u,
		);
	});

	it("discovers Git for Windows only on Windows; auto is that discovery", () => {
		const discovered = discoverGnuToolsDir();
		if (process.platform === "win32") {
			// Every Windows host of this repository ships Git for Windows (pi requires git).
			expect(discovered).toMatch(/[\\/]usr[\\/]bin$/u);
		} else {
			expect(discovered).toBeNull();
		}
		expect(resolveGnuToolsDir("auto")).toBe(discovered);
		expect(resolveGnuToolsDir()).toBe(discovered);
	});
});
