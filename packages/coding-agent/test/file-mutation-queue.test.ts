import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { createWriteTool } from "../src/core/tools/write.ts";
import { withPreparedEdit } from "./helpers/file-mutation-tools.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function resolvesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-file-mutation-queue-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("withFileMutationQueue", () => {
	it("serializes operations for the same file", async () => {
		const order: string[] = [];
		const path = "/tmp/file-mutation-queue-same";

		const first = withFileMutationQueue(path, async () => {
			order.push("first:start");
			await delay(30);
			order.push("first:end");
		});
		const second = withFileMutationQueue(path, async () => {
			order.push("second:start");
			order.push("second:end");
		});

		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	it("allows different files to proceed in parallel", async () => {
		const order: string[] = [];

		await Promise.all([
			withFileMutationQueue("/tmp/file-mutation-queue-a", async () => {
				order.push("a:start");
				await delay(30);
				order.push("a:end");
			}),
			withFileMutationQueue("/tmp/file-mutation-queue-b", async () => {
				order.push("b:start");
				await delay(30);
				order.push("b:end");
			}),
		]);

		expect(order.indexOf("a:start")).toBeLessThan(order.indexOf("a:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("b:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
	});

	it("uses the same queue for symlink aliases", async () => {
		const dir = await createTempDir();
		const targetPath = join(dir, "target.txt");
		const symlinkPath = join(dir, "alias.txt");
		await writeFile(targetPath, "hello\n", "utf8");
		await symlink(targetPath, symlinkPath);

		const order: string[] = [];
		await Promise.all([
			withFileMutationQueue(targetPath, async () => {
				order.push("target:start");
				await delay(30);
				order.push("target:end");
			}),
			withFileMutationQueue(symlinkPath, async () => {
				order.push("alias:start");
				order.push("alias:end");
			}),
		]);

		expect(order).toEqual(["target:start", "target:end", "alias:start", "alias:end"]);
	});
});

describe("built-in edit and write tools", () => {
	it("fails closed when two prepared edits race on the same file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "parallel-edit.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");

		const intentController = new FileMutationIntentController();
		const editTool = withPreparedEdit(
			createEditTool(dir, {
				operations: {
					readFile: async (path) => {
						const buffer = await readFile(path);
						await delay(30);
						return buffer;
					},
					writeFile: async (path, content) => {
						await delay(30);
						await writeFile(path, content, "utf8");
					},
				},
				intentController,
			}),
		);

		const outcomes = await Promise.allSettled([
			editTool.execute("call-1", { path: filePath, edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
			editTool.execute("call-2", { path: filePath, edits: [{ oldText: "beta", newText: "BETA" }] }),
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		const content = await readFile(filePath, "utf8");
		expect(["ALPHA\nbeta\ngamma\n", "alpha\nBETA\ngamma\n"]).toContain(content);
	});

	it("shares the queue so write preflight cannot pass while an edit owns an existing file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "mixed.txt");
		await writeFile(filePath, "original\n", "utf8");

		const intentController = new FileMutationIntentController();
		const editTool = withPreparedEdit(
			createEditTool(dir, {
				operations: {
					readFile: async (path) => {
						const buffer = await readFile(path);
						await delay(30);
						return buffer;
					},
					writeFile: async (path, content) => {
						await delay(30);
						await writeFile(path, content, "utf8");
					},
				},
				intentController,
			}),
		);
		const writeTool = createWriteTool(dir, { intentController });

		const editPromise = editTool.execute("call-1", {
			path: filePath,
			edits: [{ oldText: "original", newText: "edited" }],
		});
		await delay(5);
		const writePreparation = writeTool.execute("call-2", { action: "prepare", path: filePath });

		await editPromise;
		await expect(writePreparation).rejects.toThrow(/already exists|collision/i);

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("edited\n");
	});

	it("keeps write queue locked while an aborted write is still in flight", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "abort-write.txt");
		const firstWriteStarted = createDeferred();
		const finishFirstWrite = createDeferred();
		const intentController = new FileMutationIntentController();

		const writeTool = createWriteTool(dir, {
			operations: {
				mkdir: async () => {},
				createFile: async (path, content) => {
					firstWriteStarted.resolve();
					await finishFirstWrite.promise;
					await writeFile(path, content, { encoding: "utf8", flag: "wx" });
				},
			},
			intentController,
		});

		const prepared = await writeTool.execute("prepare-1", { action: "prepare", path: filePath });
		const intentId = prepared.details?.intentId;
		if (!intentId) throw new Error("Expected write preparation to return an intent id.");
		const controller = new AbortController();
		const firstWrite = writeTool.execute(
			"call-1",
			{ action: "commit", path: filePath, intentId, content: "first\n" },
			controller.signal,
		);
		await firstWriteStarted.promise;
		controller.abort();

		const secondPreparation = writeTool.execute("prepare-2", { action: "prepare", path: filePath });
		expect(await resolvesWithin(secondPreparation, 20)).toBe(false);

		finishFirstWrite.resolve();
		await expect(firstWrite).rejects.toThrow("Operation aborted");
		await expect(secondPreparation).rejects.toThrow(/already exists|collision/i);

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("first\n");
	});

	it("keeps edit queue locked while an aborted edit write is still in flight", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "abort-edit.txt");
		await writeFile(filePath, "alpha\nbeta\n", "utf8");
		const firstWriteStarted = createDeferred();
		const finishFirstWrite = createDeferred();
		let firstWriteSettled = false;
		const intentController = new FileMutationIntentController();

		const editTool = createEditTool(dir, {
			operations: {
				readFile,
				writeFile: async (path, content) => {
					if (content === "ALPHA\nbeta\n") {
						firstWriteStarted.resolve();
						await finishFirstWrite.promise;
						await writeFile(path, content, "utf8");
						firstWriteSettled = true;
						return;
					}

					if (content === "ALPHA\nBETA\n") {
						expect(firstWriteSettled).toBe(true);
					}
					await writeFile(path, content, "utf8");
				},
			},
			intentController,
		});

		const firstPreparation = await editTool.execute("prepare-1", { action: "prepare", path: filePath });
		const firstIntentId = firstPreparation.details?.intentId;
		if (!firstIntentId) throw new Error("Expected edit preparation to return an intent id.");
		const controller = new AbortController();
		const firstEdit = editTool.execute(
			"call-1",
			{
				action: "commit",
				path: filePath,
				intentId: firstIntentId,
				edits: [{ oldText: "alpha", newText: "ALPHA" }],
			},
			controller.signal,
		);
		await firstWriteStarted.promise;
		controller.abort();

		const secondPreparation = editTool.execute("prepare-2", { action: "prepare", path: filePath });
		expect(await resolvesWithin(secondPreparation, 20)).toBe(false);

		finishFirstWrite.resolve();
		await expect(firstEdit).rejects.toThrow("Operation aborted");
		const preparedSecond = await secondPreparation;
		const secondIntentId = preparedSecond.details?.intentId;
		if (!secondIntentId) throw new Error("Expected edit preparation to return an intent id.");
		await editTool.execute("call-2", {
			action: "commit",
			path: filePath,
			intentId: secondIntentId,
			edits: [{ oldText: "beta", newText: "BETA" }],
		});

		const content = await readFile(filePath, "utf8");
		expect(content).toBe("ALPHA\nBETA\n");
	});
});
