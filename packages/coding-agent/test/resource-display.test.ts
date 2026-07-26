import { describe, expect, it } from "vitest";
import type { SourceInfo } from "../src/core/source-info.ts";
import { getShortPath } from "../src/modes/interactive/resource-display.ts";

function packageSource(baseDir: string): SourceInfo {
	return {
		path: baseDir,
		source: "npm:@scope/host",
		scope: "user",
		origin: "package",
		baseDir,
	};
}

describe("resource display paths", () => {
	it("preserves sibling dependency topology under the same node_modules root", () => {
		const root = "/tmp/pi/npm/node_modules";
		expect(getShortPath(`${root}/@dependency/shared/extensions/index.ts`, packageSource(`${root}/@scope/host`))).toBe(
			"../../@dependency/shared/extensions/index.ts",
		);
	});

	it("normalizes Windows package paths before identifying sibling dependencies", () => {
		const root = "C:\\Users\\dev\\.pi\\agent\\npm\\node_modules";
		expect(getShortPath(`${root}\\dependency\\extensions\\index.ts`, packageSource(`${root}\\@scope\\host`))).toBe(
			"../../dependency/extensions/index.ts",
		);
	});
});
