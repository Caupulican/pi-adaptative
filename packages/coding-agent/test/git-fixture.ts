/**
 * A committed git repository for tests, copied from a template instead of built per test.
 *
 * Building one took seven git processes (init, identity and signing config, add, commit). On Windows
 * each git start costs 50-300 ms, and the system-one suites build dozens per file. The template is
 * built once per run in the shared test directory (published by an atomic rename, so concurrent
 * workers never see half a repository) and each caller gets a private copy in a self-removing
 * temp directory.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTreeSync } from "../src/core/util/remove-tree.ts";
import { SHARED_TEST_RUNTIME_ROOT } from "./global-test-runtimes.ts";
import { tempDir } from "./temp-dir.ts";

/** Bump when the template's content changes, so a stale shared template is never copied. */
const TEMPLATE_VERSION = "readme-one-v1";
let template: string | undefined;

function buildTemplate(): string {
	const root = join(SHARED_TEST_RUNTIME_ROOT, "git-templates", TEMPLATE_VERSION);
	if (existsSync(join(root, ".git", "HEAD"))) return root;
	const staging = `${root}.${process.pid}.${Date.now()}`;
	mkdirSync(staging, { recursive: true });
	const git = (args: string[]) => execFileSync("git", args, { cwd: staging, stdio: "ignore" });
	git(["init"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "test"]);
	git(["config", "commit.gpgsign", "false"]);
	git(["config", "tag.gpgsign", "false"]);
	writeFileSync(join(staging, "README.md"), "one\n");
	git(["add", "README.md"]);
	git(["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
	try {
		renameSync(staging, root);
	} catch (error) {
		removeTreeSync(staging);
		// Another worker published the same template first; anything else is a real failure.
		if (!existsSync(join(root, ".git", "HEAD"))) throw error;
	}
	return root;
}

/**
 * A private git repository with local test identity, signing off, and one commit ("init") adding
 * README.md containing "one\n". Removed when the calling test finishes (see temp-dir.ts).
 */
export function committedRepo(prefix: string): string {
	template ??= buildTemplate();
	const root = tempDir(prefix);
	cpSync(template, root, { recursive: true });
	return root;
}
