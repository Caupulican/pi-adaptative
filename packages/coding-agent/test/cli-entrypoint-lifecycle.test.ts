import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cliEntrypoint = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

describe("CLI entrypoint lifecycle", () => {
	it("awaits main so a compiled RPC process retains ownership of its lifetime", () => {
		expect(cliEntrypoint).toMatch(/const \{ main \} = await import\("\.\/main\.ts"\);\s*await main\(cliArgs\);/);
		expect(cliEntrypoint).not.toMatch(/\nmain\(cliArgs\);/);
	});

	it("keeps finite version and help fast paths ahead of main startup", () => {
		const mainImport = cliEntrypoint.indexOf('await import("./main.ts")');
		const powerShellWarmStart = cliEntrypoint.indexOf("startCliPowerShellWarmStart({");
		expect(mainImport).toBeGreaterThan(0);
		expect(cliEntrypoint.indexOf('firstArg === "--version"')).toBeLessThan(mainImport);
		expect(cliEntrypoint.indexOf('cliArgs.includes("--help")')).toBeLessThan(mainImport);
		expect(powerShellWarmStart).toBeGreaterThan(cliEntrypoint.indexOf('cliArgs.includes("--help")'));
		expect(powerShellWarmStart).toBeLessThan(mainImport);
	});
});
