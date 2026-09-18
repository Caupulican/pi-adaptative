import { unlinkSync } from "node:fs";
import type * as fsPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localFileMutationIntentOperations } from "../src/core/tools/file-mutation-intent.ts";
import { isMissingPathError } from "../src/core/util/filesystem-errors.ts";

const failures = vi.hoisted(() => ({ paths: new Set<string>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fsPromises>();
	return {
		...actual,
		unlink: async (...args: Parameters<typeof actual.unlink>) => {
			if (failures.paths.has(String(args[0]))) throw Object.assign(new Error("fixture EACCES"), { code: "EACCES" });
			return actual.unlink(...args);
		},
	};
});

afterEach(() => {
	failures.paths.clear();
	vi.restoreAllMocks();
});

async function removeCreatedFiles(created: readonly string[]): Promise<void> {
	await Promise.all(
		created.map((file) =>
			localFileMutationIntentOperations.removeFile(file).catch((error: unknown) => {
				if (!isMissingPathError(error)) throw error;
			}),
		),
	);
}

describe("local mutation payload cleanup accounting", () => {
	it.each(["explicit", "expiry"] as const)("retains the process file quota after failed %s deletion", async (mode) => {
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const created: string[] = [];
		const stage = async (ttl = 100_000) => {
			const file = await localFileMutationIntentOperations.stagePayload("fixture", ttl);
			created.push(file);
			return file;
		};
		try {
			const first = await stage(mode === "expiry" ? 1 : 100_000);
			for (let index = 1; index < 64; index++) await stage();
			await expect(stage()).rejects.toThrow("cache is full");
			failures.paths.add(first);
			if (mode === "explicit") {
				await expect(localFileMutationIntentOperations.removeFile(first)).rejects.toThrow("fixture EACCES");
				await expect(stage()).rejects.toThrow("cache is full");
			} else {
				now = 1_002;
				await expect(stage()).rejects.toThrow("fixture EACCES");
				await expect(stage()).rejects.toThrow("fixture EACCES");
			}
			expect(created).toHaveLength(64);
			failures.paths.delete(first);
			if (mode === "explicit") await localFileMutationIntentOperations.removeFile(first);
			await expect(stage()).resolves.toEqual(expect.any(String));
			await expect(stage()).rejects.toThrow("cache is full");
		} finally {
			failures.paths.clear();
			await removeCreatedFiles(created);
		}
	});

	it("releases a tracked file's quota when another owner already removed the file", async () => {
		const created: string[] = [];
		try {
			for (let index = 0; index < 64; index++) {
				created.push(await localFileMutationIntentOperations.stagePayload("fixture", 100_000));
			}
			// First-party removal forgets tracking, so use the real filesystem for the external deletion.
			unlinkSync(created[0]!);
			await expect(localFileMutationIntentOperations.removeFile(created[0]!)).rejects.toMatchObject({
				code: "ENOENT",
			});
			created.push(await localFileMutationIntentOperations.stagePayload("replacement", 100_000));
		} finally {
			await removeCreatedFiles(created);
		}
	});
});
