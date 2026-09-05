import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("covers every collaboration production file at the pinned clone sensitivity without internal clones", () => {
	const repositoryRoot = resolve(import.meta.dirname, "../../..");
	const source = join(repositoryRoot, "packages/coding-agent/src/core/collaboration");
	const config = JSON.parse(readFileSync(join(repositoryRoot, ".jscpd.json"), "utf8"));
	expect(config).toMatchObject({ maxLines: 20000, maxSize: "2mb", minLines: 5, minTokens: 50, threshold: 0 });
	const files = readdirSync(source).filter((name) => name.endsWith(".ts"));
	const eligible = files.filter((name) => {
		const content = readFileSync(join(source, name), "utf8");
		const lines = content.trimEnd().split("\n").length;
		expect(lines).toBeLessThanOrEqual(config.maxLines);
		expect(Buffer.byteLength(content)).toBeLessThanOrEqual(2 * 1024 * 1024);
		return lines >= config.minLines;
	});
	const root = mkdtempSync(join(tmpdir(), "pi-collaboration-clones-"));
	try {
		const args = [
			join(repositoryRoot, "node_modules/jscpd/run-jscpd.js"),
			source,
			"--config",
			join(repositoryRoot, ".jscpd.json"),
			"--no-colors",
			"--no-tips",
		];
		const coverage = spawnSync(
			process.execPath,
			[...args, "--reporters", "silent", "--min-tokens", "1", "--threshold", "1000000"],
			{ cwd: repositoryRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
		);
		expect(coverage.error).toBeUndefined();
		expect(coverage.status, coverage.stdout + coverage.stderr).toBe(0);
		expect(Number(/in (\d+) \(\d+ formats?\) files\./.exec(coverage.stdout + coverage.stderr)?.[1])).toBe(
			eligible.length,
		);
		const detection = spawnSync(process.execPath, [...args, "--output", root, "--cross-formats", "js-ts"], {
			cwd: repositoryRoot,
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		});
		expect(detection.error).toBeUndefined();
		const report = JSON.parse(readFileSync(join(root, "jscpd-report.json"), "utf8"));
		expect(report.duplicates, JSON.stringify(report.duplicates)).toEqual([]);
		expect(detection.status, detection.stdout + detection.stderr).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
