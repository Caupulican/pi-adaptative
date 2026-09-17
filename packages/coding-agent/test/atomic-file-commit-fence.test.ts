import { promises as fsPromises, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeFileAtomic, writeFileAtomicSync } from "../src/core/util/atomic-file.ts";
import { nodeFs } from "../src/core/util/faultable-fs.ts";

const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each(["sync", "async"])("%s rejects a failed ownership check without retry and cleans staging", async (mode) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-atomic-commit-fence-"));
	directories.push(directory);
	const path = join(directory, "value");
	writeFileSync(path, "original");
	vi.spyOn(process, "platform", "get").mockReturnValue("win32");
	const failure = Object.assign(new Error("ownership refused"), { code: "EPERM" });
	const beforeCommit = vi.fn(() => {
		throw failure;
	});
	if (mode === "sync") expect(() => writeFileAtomicSync(path, "stale", { beforeCommit })).toThrow(failure);
	else await expect(writeFileAtomic(path, "stale", { beforeCommit })).rejects.toBe(failure);
	expect(beforeCommit).toHaveBeenCalledTimes(1);
	expect(readFileSync(path, "utf8")).toBe("original");
	expect(readdirSync(directory)).toEqual(["value"]);
	// A rejected commit must release the path queue for its next owner.
	await writeFileAtomic(path, "next");
	expect(readFileSync(path, "utf8")).toBe("next");
});

it.each(["sync", "async"])("%s rechecks ownership after a Windows rename retry", async (mode) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-atomic-retry-fence-"));
	directories.push(directory);
	const path = join(directory, "value");
	writeFileSync(path, "original");
	vi.spyOn(process, "platform", "get").mockReturnValue("win32");
	const transient = Object.assign(new Error("rename temporarily refused"), { code: "EPERM" });
	const lostOwnership = new Error("owner superseded");
	let owned = true;
	const beforeCommit = vi.fn(() => {
		if (!owned) throw lostOwnership;
	});
	const failFirstRename = () => {
		owned = false;
		writeFileSync(path, "newer");
		throw transient;
	};
	if (mode === "sync") {
		const renameSync = vi.fn(failFirstRename);
		expect(() => writeFileAtomicSync(path, "stale", { beforeCommit, fs: { ...nodeFs, renameSync } })).toThrow(
			lostOwnership,
		);
		expect(renameSync).toHaveBeenCalledTimes(1);
	} else {
		const rename = vi.spyOn(fsPromises, "rename").mockImplementation(async () => failFirstRename());
		await expect(writeFileAtomic(path, "stale", { beforeCommit })).rejects.toBe(lostOwnership);
		expect(rename).toHaveBeenCalledTimes(1);
	}
	expect(beforeCommit).toHaveBeenCalledTimes(2);
	expect(readFileSync(path, "utf8")).toBe("newer");
	expect(readdirSync(directory)).toEqual(["value"]);
});
