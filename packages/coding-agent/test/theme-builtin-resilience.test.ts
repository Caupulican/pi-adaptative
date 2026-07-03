import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

describe("built-in theme loading", () => {
	let tempRoot: string | undefined;

	afterEach(() => {
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
			tempRoot = undefined;
		}
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("does not crash startup when the optional matrix-machine asset is missing", async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-builtin-theme-"));
		const packageDir = join(tempRoot, "package");
		const themesDir = join(packageDir, "src", "modes", "interactive", "theme");
		mkdirSync(themesDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@caupulican/pi-adaptative",
				version: "0.0.0-test",
				piConfig: {
					name: "pi-adaptative",
					configDir: ".pi",
				},
			}),
		);

		const sourceThemesDir = new URL("../src/modes/interactive/theme/", import.meta.url);
		for (const fileName of ["dark.json", "light.json"]) {
			writeFileSync(join(themesDir, fileName), readFileSync(new URL(fileName, sourceThemesDir), "utf-8"));
		}

		vi.stubEnv("PI_PACKAGE_DIR", packageDir);
		vi.stubEnv(ENV_AGENT_DIR, join(tempRoot, "agent"));
		vi.resetModules();

		const themeModule = await import("../src/modes/interactive/theme/theme.ts");

		expect(themeModule.getAvailableThemes()).toEqual(["dark", "light"]);
		expect(() => themeModule.initTheme("matrix-machine", false)).not.toThrow();
		expect(themeModule.theme.name).toBe("dark");
	});

	it("uses an embedded dark fallback when built-in theme files are unavailable", async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-builtin-theme-"));
		const packageDir = join(tempRoot, "package");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@caupulican/pi-adaptative",
				version: "0.0.0-test",
				piConfig: {
					name: "pi-adaptative",
					configDir: ".pi",
				},
			}),
		);

		vi.stubEnv("PI_PACKAGE_DIR", packageDir);
		vi.stubEnv(ENV_AGENT_DIR, join(tempRoot, "agent"));
		vi.resetModules();

		const themeModule = await import("../src/modes/interactive/theme/theme.ts");

		expect(themeModule.getAvailableThemes()).toEqual(["dark"]);
		expect(() => themeModule.initTheme("matrix-machine", false)).not.toThrow();
		expect(themeModule.theme.name).toBe("dark");
		expect(themeModule.theme.fg("text", "ok")).toContain("ok");
	});
});
