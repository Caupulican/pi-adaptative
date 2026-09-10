import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credentialToolBlockReason } from "../src/core/secrets/credential-exposure-guard.ts";
import { classifyToolTrust } from "../src/core/security/untrusted-boundary.ts";
import {
	compileRepoReadOptions,
	createRepoReadToolDefinition,
	repoReadObjectPath,
	validateRepoReadRevisions,
} from "../src/core/tools/repo-read.ts";
import { spawnProcessSync } from "../src/utils/child-process.ts";

function git(cwd: string, ...args: string[]): string {
	const result = spawnProcessSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
			GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		},
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout;
}

const NO_CONTEXT = undefined as never;

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("");
}

describe("repo_read", () => {
	let repo: string;
	let outside: string;
	beforeAll(() => {
		repo = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-repo-read-")));
		outside = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-repo-read-outside-")));
		git(repo, "init", "-q", "-b", "main");
		mkdirSync(join(repo, "src"));
		writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
		writeFileSync(join(repo, ".env"), "SECRET=1\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "first");
		writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
		git(repo, "commit", "-q", "-am", "second");
		writeFileSync(join(repo, "src", "b.ts"), "export const b = 3;\n");
	});
	afterAll(() => {
		rmSync(repo, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("reads history, diffs, blobs and status without a shell", async () => {
		const tool = createRepoReadToolDefinition(repo);
		const log = await tool.execute(
			"log",
			{ action: "log", options: ["--oneline", "-n", "5"] },
			undefined,
			undefined,
			NO_CONTEXT,
		);
		expect(text(log)).toMatch(/second\n.*first/);
		expect(log.details).toMatchObject({ action: "log", exitCode: 0 });

		const diff = await tool.execute(
			"diff",
			{ action: "diff", revisions: ["HEAD~1", "HEAD"], paths: ["src"], options: ["--stat"] },
			undefined,
			undefined,
			NO_CONTEXT,
		);
		expect(text(diff)).toContain("src/a.ts");

		const blob = await tool.execute(
			"show",
			{ action: "show", revisions: ["HEAD~1:src/a.ts"] },
			undefined,
			undefined,
			NO_CONTEXT,
		);
		expect(text(blob)).toContain("export const a = 1;");

		const status = await tool.execute(
			"status",
			{ action: "status", options: ["--porcelain"] },
			undefined,
			undefined,
			NO_CONTEXT,
		);
		expect(text(status)).toContain("?? src/b.ts");

		const inSubdirectory = await tool.execute(
			"rev-parse",
			{ action: "rev-parse", options: ["--show-prefix"], path: "src" },
			undefined,
			undefined,
			NO_CONTEXT,
		);
		expect(text(inSubdirectory).trim()).toBe("src/");
	});

	it("reports git's own failure as the tool result instead of a harness error", async () => {
		const tool = createRepoReadToolDefinition(repo);
		const result = await tool.execute(
			"bad-rev",
			{ action: "show", revisions: ["no-such-revision"] },
			undefined,
			undefined,
			NO_CONTEXT,
		);
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/unknown revision|bad revision|ambiguous argument/i);
	});

	it("refuses options that write, run programs, read outside the repository or are global", () => {
		for (const [action, options, reason] of [
			["diff", ["--output=/tmp/x"], "allow-list"],
			["diff", ["--ext-diff"], "allow-list"],
			["show", ["--show-signature"], "allow-list"],
			["log", ["-c", "core.pager=sh"], "not accepted for git log"],
			["diff", ["--no-index"], "allow-list"],
			["blame", ["--ignore-revs-file=x"], "allow-list"],
			["log", ["--git-dir=/elsewhere"], "not accepted for git log"],
			["status", ["--oneline"], "not accepted for git status"],
			["log", ["--oneline=yes"], "takes no value"],
			["log", ["-n"], "needs a value"],
			["log", ["HEAD"], "not an option"],
			["log", ["--"], "placed by the tool"],
		] as const) {
			expect(() => compileRepoReadOptions(action, [...options])).toThrow(reason);
		}
		expect(compileRepoReadOptions("log", ["-n", "3", "--stat=80", "-U2", "--since=2.weeks", "-L10,20"])).toEqual([
			"-n3",
			"--stat=80",
			"-U2",
			"--since=2.weeks",
			"-L10,20",
		]);
	});

	it("keeps revisions, pathspecs and object paths inside the run directory", async () => {
		const tool = createRepoReadToolDefinition(repo);
		expect(() => validateRepoReadRevisions(["-p"])).toThrow("starts with '-'");
		expect(() => validateRepoReadRevisions([":src/a.ts"])).toThrow("addresses the index");
		expect(repoReadObjectPath("HEAD:src/a.ts")).toBe("src/a.ts");
		expect(repoReadObjectPath("HEAD~2")).toBeUndefined();
		await expect(
			tool.execute("escape", { action: "log", paths: ["../outside"] }, undefined, undefined, NO_CONTEXT),
		).rejects.toThrow("leaves");
		await expect(
			tool.execute("magic", { action: "log", paths: [":/src"] }, undefined, undefined, NO_CONTEXT),
		).rejects.toThrow("pathspec magic");
		// A subdirectory run may not read the repository root through a root-relative object path.
		await expect(
			tool.execute(
				"object-escape",
				{ action: "show", revisions: ["HEAD:.env"], path: "src" },
				undefined,
				undefined,
				NO_CONTEXT,
			),
		).rejects.toThrow("leaves");
		const inside = await tool.execute(
			"object-inside",
			{ action: "show", revisions: ["HEAD:src/a.ts"], path: "src" },
			undefined,
			undefined,
			NO_CONTEXT,
		);
		expect(text(inside)).toContain("export const a = 2;");
	});

	it("ignores GIT_* re-pointing from the parent environment and never prompts or pages", async () => {
		const tool = createRepoReadToolDefinition(repo, {
			environment: () => ({
				...process.env,
				GIT_DIR: join(outside, "not-a-repo"),
				GIT_WORK_TREE: outside,
				GIT_INDEX_FILE: join(outside, "index"),
				GIT_EXTERNAL_DIFF: "/bin/false",
				GIT_PAGER: "less",
			}),
		});
		const result = await tool.execute(
			"env",
			{ action: "rev-parse", options: ["--show-toplevel"] },
			undefined,
			undefined,
			NO_CONTEXT,
		);
		expect(resolve(text(result).trim())).toBe(repo);
	});

	it("is a trusted built-in whose credential-file reads are model-blind like read's", () => {
		expect(classifyToolTrust("repo_read")).toBe("trusted");
		expect(credentialToolBlockReason("repo_read", { action: "log", paths: [".env"] }, repo)).toBeDefined();
		expect(credentialToolBlockReason("repo_read", { action: "show", revisions: ["HEAD:.env"] }, repo)).toBeDefined();
		expect(
			credentialToolBlockReason("repo_read", { action: "show", revisions: ["HEAD:src/a.ts"] }, repo),
		).toBeUndefined();
		expect(credentialToolBlockReason("repo_read", { action: "log", options: ["--oneline"] }, repo)).toBeUndefined();
	});

	it("bounds output by the line limit and names the way out", async () => {
		const tool = createRepoReadToolDefinition(repo);
		const result = await tool.execute(
			"limit",
			{ action: "log", options: ["-p"], limit: 3 },
			undefined,
			undefined,
			NO_CONTEXT,
		);
		const output = text(result);
		expect(output.split("\n").length).toBeLessThan(12);
		expect(output).toContain("3 line limit reached");
		expect(result.details?.truncation).toMatchObject({ truncated: true, truncatedBy: "lines" });
	});
});
