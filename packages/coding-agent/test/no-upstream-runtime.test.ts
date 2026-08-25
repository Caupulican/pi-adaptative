import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getShareViewerUrl } from "../src/config.ts";

const sourceFiles = [
	"src/cli/args.ts",
	"src/config.ts",
	"src/core/sdk.ts",
	"src/core/settings-manager.ts",
	"src/modes/interactive/components/settings-selector.ts",
	"src/modes/interactive/settings-selector-flow.ts",
	"src/modes/interactive/startup-checks.ts",
];

describe("standalone runtime ownership", () => {
	it("does not retain the retired pi.dev install/update surface", () => {
		const packageRoot = new URL("..", import.meta.url);
		for (const relativePath of sourceFiles) {
			const source = readFileSync(new URL(relativePath, packageRoot), "utf8");
			expect(source, relativePath).not.toContain("pi.dev");
			expect(source, relativePath).not.toContain("PI_TELEMETRY");
			expect(source, relativePath).not.toContain("enableInstallTelemetry");
		}
		expect(existsSync(new URL("src/core/install-telemetry.ts", packageRoot))).toBe(false);
	});

	it("uses GitHub Gist links by default while preserving the viewer override", () => {
		const original = process.env.PI_SHARE_VIEWER_URL;
		try {
			delete process.env.PI_SHARE_VIEWER_URL;
			expect(getShareViewerUrl("gist-id")).toBe("https://gist.github.com/gist-id");
			process.env.PI_SHARE_VIEWER_URL = "https://viewer.example/session/";
			expect(getShareViewerUrl("gist-id")).toBe("https://viewer.example/session/gist-id");
		} finally {
			if (original === undefined) delete process.env.PI_SHARE_VIEWER_URL;
			else process.env.PI_SHARE_VIEWER_URL = original;
		}
	});
});
