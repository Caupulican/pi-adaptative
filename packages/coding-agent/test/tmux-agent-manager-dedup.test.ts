import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type CloneReport = {
	statistics?: { total?: { lines?: number; sources?: number } };
	duplicates?: unknown[];
};

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const extensionPath = path.join(
	repositoryRoot,
	"packages/coding-agent/src/bundled-resources/extensions/tmux-agent-manager/index.ts",
);

describe("tmux agent manager ownership", () => {
	it("is fully covered by the strict clone gate and has no internal production clones", () => {
		const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-clone-gate-"));
		try {
			const scan = spawnSync(
				process.execPath,
				[
					path.join(repositoryRoot, "node_modules/jscpd/run-jscpd.js"),
					extensionPath,
					"--config",
					path.join(repositoryRoot, ".jscpd.json"),
					"--output",
					outputDirectory,
					"--cross-formats",
					"js-ts",
					"--threshold",
					"1000000",
					"--no-colors",
					"--no-tips",
				],
				{ cwd: repositoryRoot, encoding: "utf8" },
			);
			expect(scan.error, `${scan.stdout}\n${scan.stderr}`).toBeUndefined();
			expect(scan.status, `${scan.stdout}\n${scan.stderr}`).toBe(0);

			const report = JSON.parse(
				fs.readFileSync(path.join(outputDirectory, "jscpd-report.json"), "utf8"),
			) as CloneReport;
			expect(report.statistics?.total?.sources).toBe(1);
			expect(report.statistics?.total?.lines).toBeGreaterThan(2_000);
			expect(report.duplicates).toEqual([]);
		} finally {
			fs.rmSync(outputDirectory, { recursive: true, force: true });
		}
	});
});
