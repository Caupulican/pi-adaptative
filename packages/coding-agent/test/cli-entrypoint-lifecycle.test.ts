import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cliEntrypoint = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
const bunEntrypoint = readFileSync(new URL("../src/bun/cli.ts", import.meta.url), "utf8");
const mainEntrypoint = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

describe("CLI entrypoint lifecycle", () => {
	it("awaits main so a compiled RPC process retains ownership of its lifetime", () => {
		expect(cliEntrypoint).toMatch(/const \{ main \} = await import\("\.\/main\.ts"\);\s*await main\(cliArgs\);/);
		expect(cliEntrypoint).not.toMatch(/\nmain\(cliArgs\);/);
	});

	it("keeps finite version and help fast paths ahead of main startup", () => {
		const mainImport = cliEntrypoint.indexOf('await import("./main.ts")');
		const httpDispatcherImport = cliEntrypoint.indexOf('await import("./core/http-dispatcher.ts")');
		expect(mainImport).toBeGreaterThan(0);
		expect(cliEntrypoint.indexOf('firstArg === "--version"')).toBeLessThan(mainImport);
		expect(cliEntrypoint.indexOf('firstArg === "--version"')).toBeLessThan(httpDispatcherImport);
		expect(cliEntrypoint.indexOf('cliArgs.includes("--help")')).toBeLessThan(mainImport);
		expect(cliEntrypoint).not.toContain("startCliPowerShellWarmStart(");
	});

	it("warms PowerShell only after supervisor delegation and before session construction", () => {
		// The supervisor must not retain an unused shell while the terminal-owning child runs.
		const supervisor = mainEntrypoint.indexOf("if (await superviseInteractiveRuntime(args)) return;");
		const warmStart = mainEntrypoint.indexOf("startCliPowerShellWarmStart({");
		const sessionConstruction = mainEntrypoint.indexOf("await createSessionManager(parsed,");
		expect(supervisor).toBeGreaterThan(0);
		expect(warmStart).toBeGreaterThan(supervisor);
		expect(sessionConstruction).toBeGreaterThan(warmStart);
		expect(mainEntrypoint).toMatch(
			/if \(!parsed\.help && parsed\.listModels === undefined && !parsed\.export && !parsed\.version\) \{\s*startCliPowerShellWarmStart\(/,
		);
	});

	it("prints compiled --version before bundled modules, Bedrock, or the full CLI graph", () => {
		const versionIdx = bunEntrypoint.indexOf('firstArg === "--version"');
		const bundledIdx = bunEntrypoint.indexOf("bundled-virtual-modules");
		const bedrockIdx = bunEntrypoint.indexOf('await import("./register-bedrock.ts")');
		const cliIdx = bunEntrypoint.indexOf('await import("../cli.ts")');
		expect(versionIdx).toBeGreaterThan(0);
		expect(versionIdx).toBeLessThan(bundledIdx);
		expect(versionIdx).toBeLessThan(bedrockIdx);
		expect(versionIdx).toBeLessThan(cliIdx);
	});
});
