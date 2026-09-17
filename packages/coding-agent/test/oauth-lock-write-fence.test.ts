import { promises as fsPromises, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, expect, it, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.ts";

const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([false, true])("fences a prepared auth write when compromise=%s before rename", async (compromised) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-auth-write-fence-"));
	directories.push(directory);
	const path = join(directory, "auth.json");
	const backend = new FileAuthStorageBackend(path);
	AuthStorage.fromStorage(backend).set("provider", { type: "api_key", key: "original" });
	const originalLock = lockfile.lock.bind(lockfile);
	let compromise: ((error: Error) => void) | undefined;
	let release: (() => Promise<void>) | undefined;
	vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
		compromise = options?.onCompromised;
		release = await originalLock(file, options);
		return release;
	});
	const originalWrite = fsPromises.writeFile.bind(fsPromises);
	vi.spyOn(fsPromises, "writeFile").mockImplementation(async (...args) => {
		await originalWrite(...args);
		if (compromised) {
			// The temporary file is complete, but replacement has not happened yet.
			// Model actual lost ownership by releasing the OS lock and letting a
			// separate storage client commit newer state before the old writer resumes.
			compromise?.(new Error("simulated ownership loss while writing"));
			await release?.();
			AuthStorage.create(path).set("provider", { type: "api_key", key: "newer" });
		}
	});
	const outcome = await backend
		.withLockAsync(async () => ({
			result: "saved",
			next: JSON.stringify({ provider: { type: "api_key", key: "stale" } }),
		}))
		.catch((error: unknown) => error);
	if (compromised) expect(outcome).toBeInstanceOf(Error);
	else expect(outcome).toBe("saved");
	expect(JSON.parse(readFileSync(path, "utf8")).provider.key).toBe(compromised ? "newer" : "stale");
	expect(readdirSync(directory)).toEqual(["auth.json"]);
});
