/**
 * Physical project namespace behind specialist reuse.
 *
 * Automatic reuse has to decide whether two requests name the SAME project. The existing
 * `NativeTaskDirectoryBackend` owns that authority end to end: host, platform, canonicalization and
 * physical directory identity are all inside `createAttachmentId`. These controls treat the returned
 * attachment id as OPAQUE and compare COMPLETE ids obtained with the same stable nonce -- no second
 * hashing, parsing or canonicalization policy is introduced here. They pass today; the reuse tests
 * prove the matcher actually consults this authority once it exists.
 *
 * Aliases are created with the platform's own mechanism (POSIX directory symlink, Windows junction)
 * through the same helper shape the existing backend suite uses, so both platforms run the same
 * assertions with no skips. Every scratch directory is removed even when an assertion fails.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeTaskDirectoryBackend } from "../src/core/tasks/native-task-directory-backend.ts";

const STABLE_NONCE = "specialist-namespace-fixture";
const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const directory = roots.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

function scratch(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-project-namespace-"));
	roots.push(directory);
	return directory;
}

/** The platform's own directory alias: a junction on Windows, a directory symlink elsewhere. */
function aliasDirectory(target: string, link: string): string {
	symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
	return link;
}

describe("project specialist namespace", () => {
	it("gives one physical directory one namespace key through every alias that reaches it", async () => {
		const backend = createNativeTaskDirectoryBackend();
		const root = scratch();
		const project = join(root, "project");
		mkdirSync(project);
		const alias = aliasDirectory(project, join(root, "alias"));

		const direct = await backend.createAttachmentId(project, STABLE_NONCE);
		const throughAlias = await backend.createAttachmentId(alias, STABLE_NONCE);

		// Same device/inode, so the same specialist namespace: a path spelling is not an identity.
		expect(throughAlias).toBe(direct);
		expect(await backend.resolveDirectory(alias)).toBe(await backend.resolveDirectory(project));
	});

	it("gives two distinct physical directories distinct namespace keys", async () => {
		const backend = createNativeTaskDirectoryBackend();
		const root = scratch();
		const left = join(root, "left");
		const right = join(root, "right");
		mkdirSync(left);
		mkdirSync(right);

		const leftId = await backend.createAttachmentId(left, STABLE_NONCE);
		const rightId = await backend.createAttachmentId(right, STABLE_NONCE);

		expect(leftId).not.toBe(rightId);
	});

	it("keys one directory the same way every time the same stable nonce is used", async () => {
		const backend = createNativeTaskDirectoryBackend();
		const project = scratch();

		const pinned = await backend.createAttachmentId(project, STABLE_NONCE);
		const pinnedAgain = await backend.createAttachmentId(project, STABLE_NONCE);
		const defaulted = await backend.createAttachmentId(project);
		const defaultedAgain = await backend.createAttachmentId(project);

		// A namespace key is a complete attachment id obtained with a stable nonce; the per-attachment
		// default nonce deliberately makes two ids of one directory differ, so it is never the key.
		expect(pinnedAgain).toBe(pinned);
		expect(defaulted).not.toBe(defaultedAgain);
		expect(defaulted).not.toBe(pinned);
	});

	it("refuses a namespace key for something that is not a directory", async () => {
		const backend = createNativeTaskDirectoryBackend();
		const root = scratch();

		await expect(backend.createAttachmentId(join(root, "missing"), STABLE_NONCE)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
