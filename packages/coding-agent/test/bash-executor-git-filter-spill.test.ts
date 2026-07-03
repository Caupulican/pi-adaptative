import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A path whose final segment is a real file, not a directory: opening anything underneath it
// fails with ENOTDIR -- a real, deterministic fs error, without needing actual disk-full or
// permission conditions.
const blockedSpill = vi.hoisted(() => {
	// No `node:path` here: vi.hoisted runs before this file's own imports are linked.
	const base = process.env.TMPDIR || process.env.TEMP || "/tmp";
	const dir = `${base}/pi-bash-spill-error-test-${Date.now()}`;
	return { dir, notADirectory: `${dir}/not-a-directory` };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		// Only bash-executor's own git-filter spill file (named `pi-bash-*.log`) is redirected;
		// git-filter's own overflow spill and everything else pass through untouched.
		createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
			const path = args[0];
			if (typeof path === "string" && path.includes(`${sep}pi-bash-`)) {
				return actual.createWriteStream(join(blockedSpill.notADirectory, "spill.log"));
			}
			return actual.createWriteStream(...args);
		},
	};
});

const { executeBashWithOperations } = await import("../src/core/bash-executor.ts");
const { createLocalBashOperations } = await import("../src/core/tools/bash.ts");

describe("bash-executor git-filter spill write failure", () => {
	let testRepoDir: string;

	beforeAll(() => {
		mkdirSync(blockedSpill.dir, { recursive: true });
		writeFileSync(blockedSpill.notADirectory, "");
	});

	afterAll(() => {
		rmSync(blockedSpill.dir, { recursive: true, force: true });
	});

	beforeEach(() => {
		testRepoDir = join(tmpdir(), `pi-bash-executor-spill-error-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testRepoDir, { recursive: true });
		execSync("git init -b main -q", { cwd: testRepoDir });
		execSync('git config user.name "Test User"', { cwd: testRepoDir });
		execSync('git config user.email "test@example.com"', { cwd: testRepoDir });
		execSync("git config commit.gpgsign false", { cwd: testRepoDir });

		// A tracked blob whose raw `git show` output exceeds the bash tool's 50KB inline cap but
		// stays far under git-filter's own 48MB retention budget: git-filter keeps it fully in
		// memory (rawBytes, no overflow of its own) and hands it to bash-executor to spill.
		const lines = Array.from({ length: 3000 }, (_, i) => `line-${String(i).padStart(6, "0")}-payload`);
		writeFileSync(join(testRepoDir, "big.txt"), `${lines.join("\n")}\n`);
		execSync("git add big.txt", { cwd: testRepoDir });
		execSync('git commit -q -m "big"', { cwd: testRepoDir });
	});

	afterEach(() => {
		rmSync(testRepoDir, { recursive: true, force: true });
	});

	it("drops the advertised fullOutputPath instead of pointing at an unwritten spill file", async () => {
		const result = await executeBashWithOperations(
			"git show HEAD:big.txt",
			testRepoDir,
			createLocalBashOperations(),
			{
				enableGitFilter: true,
			},
		);

		expect(result.fullOutputPath).toBeUndefined();
		// The output genuinely exceeded the inline cap; only the persisted-copy path was lost.
		expect(result.truncated).toBe(true);
	});
});
