import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPortableGitProjectKey, resolveCredentialProject } from "../src/core/secrets/credential-project.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("credential project identity", () => {
	it("maps common SSH and HTTPS forms of the same remote to one opaque portable key", () => {
		const ssh = createPortableGitProjectKey("git@github.com:Example/Project.git");
		const https = createPortableGitProjectKey("https://github.com/Example/Project.git");

		expect(ssh).toBe(https);
		expect(ssh).toMatch(/^git:[a-f0-9]{64}$/);
		expect(ssh).not.toContain("github.com");
		expect(createPortableGitProjectKey("https://github.com/Example/Other.git")).not.toBe(ssh);
	});

	it("detects the git root from a nested cwd and never exposes the remote in its label", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-credential-project-"));
		tempDirectories.push(root);
		await mkdir(join(root, ".git"));
		await mkdir(join(root, "packages", "app"), { recursive: true });
		await writeFile(
			join(root, ".git", "config"),
			'[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:Private/Remote.git\n',
		);

		const identity = await resolveCredentialProject(join(root, "packages", "app"));
		const canonicalRoot = await realpath(root);

		expect(identity).toMatchObject({ root: canonicalRoot, label: basename(canonicalRoot), portable: true });
		expect(identity.key).toBe(createPortableGitProjectKey("https://github.com/Private/Remote.git"));
		expect(JSON.stringify(identity)).not.toContain("Private/Remote");
	});

	it("uses a machine-local opaque identity when no portable remote exists", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-credential-local-"));
		tempDirectories.push(root);

		const first = await resolveCredentialProject(root);
		const second = await resolveCredentialProject(root);
		const canonicalRoot = await realpath(root);

		expect(first).toEqual(second);
		expect(first).toMatchObject({ root: canonicalRoot, portable: false });
		expect(first.key).toMatch(/^local:[a-f0-9]{64}$/);
	});

	it("resolves a linked worktree through its commondir-owned Git config", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-credential-worktree-"));
		tempDirectories.push(root);
		const gitMetadata = join(root, "git-metadata");
		const worktreeMetadata = join(gitMetadata, "worktrees", "feature");
		await mkdir(worktreeMetadata, { recursive: true });
		await writeFile(join(root, ".git"), "gitdir: git-metadata/worktrees/feature\n");
		await writeFile(join(worktreeMetadata, "commondir"), "../..\n");
		await writeFile(
			join(gitMetadata, "config"),
			'[remote "origin"]\n\turl = https://github.com/Example/Portable.git\n',
		);

		const identity = await resolveCredentialProject(root);
		const canonicalRoot = await realpath(root);

		expect(identity).toMatchObject({ root: canonicalRoot, portable: true });
		expect(identity.key).toBe(createPortableGitProjectKey("git@github.com:Example/Portable.git"));
	});
});
