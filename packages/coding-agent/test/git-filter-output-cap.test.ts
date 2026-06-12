import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeFilteredGit, runGitQuery } from "../src/core/tools/git-filter.ts";

describe("git filter output retention cap", () => {
	let testRepoDir: string;
	const overflowFiles: string[] = [];

	beforeEach(() => {
		testRepoDir = join(tmpdir(), `pi-git-cap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testRepoDir, { recursive: true });
		execSync("git init -q", { cwd: testRepoDir });
		execSync("git config user.email test@example.com", { cwd: testRepoDir });
		execSync("git config user.name Test", { cwd: testRepoDir });
		const lines: string[] = [];
		for (let i = 0; i < 20_000; i++) lines.push(`line-${String(i).padStart(6, "0")}-payload`);
		lines.push("END-OF-PAYLOAD");
		writeFileSync(join(testRepoDir, "big.txt"), `${lines.join("\n")}\n`);
		execSync("git add big.txt", { cwd: testRepoDir });
		execSync("git commit -q -m big", { cwd: testRepoDir });
	});

	afterEach(() => {
		delete process.env.PI_GIT_FILTER_MAX_RETAINED_BYTES;
		rmSync(testRepoDir, { recursive: true, force: true });
		while (overflowFiles.length > 0) {
			const file = overflowFiles.pop();
			if (file) rmSync(file, { force: true });
		}
	});

	it("spills oversized stdout to a temp file and keeps a bounded head in memory", async () => {
		process.env.PI_GIT_FILTER_MAX_RETAINED_BYTES = String(64 * 1024);

		const res = await runGitQuery(testRepoDir, [], ["show", "HEAD:big.txt"]);

		expect(res.status).toBe(0);
		expect(res.overflow).toBeDefined();
		if (!res.overflow) throw new Error("expected overflow");
		overflowFiles.push(res.overflow.fullOutputPath);
		// In-memory head stays near the budget instead of the full ~500KB payload.
		expect(res.stdout.length).toBeLessThan(192 * 1024);
		expect(res.rawBytes).toBeUndefined();
		expect(existsSync(res.overflow.fullOutputPath)).toBe(true);
		const spilled = readFileSync(res.overflow.fullOutputPath, "utf-8");
		expect(spilled).toContain("line-000000-payload");
		expect(spilled).toContain("END-OF-PAYLOAD");
	});

	it("keeps full output in memory with rawBytes when under the budget", async () => {
		const res = await runGitQuery(testRepoDir, [], ["show", "HEAD:big.txt"]);

		expect(res.status).toBe(0);
		expect(res.overflow).toBeUndefined();
		expect(res.rawBytes).toBeDefined();
		expect(res.stdout).toContain("END-OF-PAYLOAD");
	});

	it("discloses the retention cap and full output path in filtered results", async () => {
		process.env.PI_GIT_FILTER_MAX_RETAINED_BYTES = String(64 * 1024);

		const res = await executeFilteredGit(testRepoDir, "show", [], ["HEAD:big.txt"]);

		expect(res.exitCode).toBe(0);
		expect(res.fullOutputPath).toBeDefined();
		if (res.fullOutputPath) overflowFiles.push(res.fullOutputPath);
		expect(res.output).toContain("Full output:");
	});
});
