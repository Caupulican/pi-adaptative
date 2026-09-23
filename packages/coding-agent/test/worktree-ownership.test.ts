import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enforceSessionEdge, type SessionEdgeDeps } from "../src/core/agent-session-edge.ts";
import { mayHoldUnownedWorktreeChanges } from "../src/core/objective-execution/worktree-ownership.ts";

function gitRepo(): string {
	const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "pi-own-")));
	const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	run("init");
	run("config", "user.email", "it@example.invalid");
	run("config", "user.name", "it");
	writeFileSync(join(root, "README.md"), "one\n");
	run("add", "README.md");
	run("commit", "-m", "base");
	return root;
}

function edgeDeps(root: string, unowned: () => Promise<boolean>): SessionEdgeDeps {
	return {
		getBranch: () => [],
		getSettingsAllow: () => [],
		appendCustomEntry: () => {},
		getCwd: () => root,
		isChildSession: () => true,
		getConfirmation: () => undefined,
		mayHoldUnownedWorktreeChanges: unowned,
	};
}

describe("worktree ownership", () => {
	it("is false for a clean tree and for a tree holding only this session's writes", async () => {
		const root = gitRepo();
		expect(await mayHoldUnownedWorktreeChanges(root, [])).toBe(false);
		writeFileSync(join(root, "README.md"), "two\n");
		writeFileSync(join(root, "new.ts"), "export const a = 1;\n");
		expect(await mayHoldUnownedWorktreeChanges(root, ["README.md", "new.ts"])).toBe(false);
	});

	it("is true as soon as one dirty path was never written by this session", async () => {
		const root = gitRepo();
		writeFileSync(join(root, "README.md"), "mine\n");
		writeFileSync(join(root, "theirs.ts"), "other session\n");
		expect(await mayHoldUnownedWorktreeChanges(root, ["README.md"])).toBe(true);
	});

	it("is false outside a repository, where there is no worktree to discard", async () => {
		const outside = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "pi-nogit-")));
		expect(await mayHoldUnownedWorktreeChanges(outside, [])).toBe(false);
	});

	it("is true when the status of a repository cannot be read, so an irreversible discard asks", async () => {
		const root = gitRepo();
		writeFileSync(join(root, ".git", "index"), "not an index");
		expect(await mayHoldUnownedWorktreeChanges(root, [])).toBe(true);
	});
});

describe("the worktree-discard edge in a session", () => {
	const discard = { command: "git reset --hard" };

	it("runs a discard that can only destroy this session's own work", async () => {
		const root = gitRepo();
		const result = await enforceSessionEdge(
			edgeDeps(root, async () => false),
			"bash",
			discard,
			root,
			undefined,
		);
		expect(result).toBeUndefined();
	});

	it("stops a discard while another session's uncommitted work is in the same tree", async () => {
		const root = gitRepo();
		const result = await enforceSessionEdge(
			edgeDeps(root, async () => true),
			"bash",
			discard,
			root,
			undefined,
		);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("destructive.fs");
	});

	it("stops a discard when the ownership check itself fails", async () => {
		const root = gitRepo();
		const result = await enforceSessionEdge(
			edgeDeps(root, async () => {
				throw new Error("status probe crashed");
			}),
			"bash",
			discard,
			root,
			undefined,
		);
		expect(result?.block).toBe(true);
	});

	it("leaves ordinary git alone without ever reading the worktree", async () => {
		const root = gitRepo();
		let probed = 0;
		const result = await enforceSessionEdge(
			edgeDeps(root, async () => {
				probed++;
				return true;
			}),
			"bash",
			{ command: "git commit -m wip && git push origin main" },
			root,
			undefined,
		);
		expect(result).toBeUndefined();
		expect(probed).toBe(0);
	});
});
