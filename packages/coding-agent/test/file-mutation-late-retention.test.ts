import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import {
	FileMutationIntentController,
	type FilePathInspection,
	localFileMutationIntentOperations,
} from "../src/core/tools/file-mutation-intent.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

function fixture(beforeStage?: () => Promise<void>) {
	const files = new Map<string, string>();
	const stage = vi.fn(async (content: string) => {
		await beforeStage?.();
		const file = `late-retention-${randomUUID()}`;
		files.set(file, content);
		return file;
	});
	const remove = vi.fn(async (file: string) => {
		files.delete(file);
	});
	const operations = { ...localFileMutationIntentOperations, stagePayload: stage, removeFile: remove };
	return { files, stage, remove, operations };
}

describe("mutation payload retention at disposal", () => {
	it("declines new retention after disposal without allocating storage", async () => {
		const { operations, stage, files } = fixture();
		const controller = new FileMutationIntentController({ operations });
		try {
			await controller.dispose();
			await expect(controller.retainMutationPayload("write", "late")).resolves.toBeUndefined();
			expect(stage).not.toHaveBeenCalled();
			expect(files.size).toBe(0);
		} finally {
			await controller.dispose();
		}
	});

	it("closes admission synchronously before queued retention starts", async () => {
		const { operations, stage } = fixture();
		const controller = new FileMutationIntentController({ operations });
		try {
			const queued = controller.retainMutationPayload("write", "not yet staged");
			const disposing = controller.dispose();
			await expect(queued).resolves.toBeUndefined();
			await disposing;
			expect(stage).not.toHaveBeenCalled();
		} finally {
			await controller.dispose();
		}
	});

	it("drains already-started staging but declines queued and later retention", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { operations, stage, remove, files } = fixture(async () => {
			entered.resolve();
			await release.promise;
		});
		const controller = new FileMutationIntentController({ operations });
		const active = controller.retainMutationPayload("write", "started");
		try {
			await entered.promise;
			const queued = controller.retainMutationPayload("write", "queued");
			const disposing = controller.dispose();
			const late = controller.retainMutationPayload("edit", "late");
			release.resolve();
			const reference = await active;
			expect(reference).toBeDefined();
			await expect(queued).resolves.toBeUndefined();
			await expect(late).resolves.toBeUndefined();
			await disposing;
			expect(stage).toHaveBeenCalledOnce();
			expect(remove).toHaveBeenCalledOnce();
			expect(files.size).toBe(0);
			await expect(controller.readMutationPayload(reference!.payloadRef, "write")).rejects.toThrow("invalid");
		} finally {
			release.resolve();
			await active;
			await controller.dispose();
		}
	});

	it("keeps retention closed after cleanup failure while permitting cleanup retry", async () => {
		const { operations, stage, remove, files } = fixture();
		const controller = new FileMutationIntentController({ operations });
		try {
			await controller.retainMutationPayload("write", "owned");
			remove.mockRejectedValueOnce(new Error("cleanup unavailable"));
			await expect(controller.dispose()).rejects.toThrow("cleanup unavailable");
			await expect(controller.retainMutationPayload("edit", "late")).resolves.toBeUndefined();
			expect(stage).toHaveBeenCalledOnce();
			expect(files.size).toBe(1);
			await controller.dispose();
			expect(remove).toHaveBeenCalledTimes(2);
			expect(files.size).toBe(0);
		} finally {
			await controller.dispose();
		}
	});

	it.each([
		{ tool: "write", disposeBeforeInspection: false },
		{ tool: "write", disposeBeforeInspection: true },
		{ tool: "edit", disposeBeforeInspection: false },
		{ tool: "edit", disposeBeforeInspection: true },
	] as const)(
		"preserves $tool path failure: disposed=$disposeBeforeInspection",
		async ({ tool, disposeBeforeInspection }) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const { operations, stage, files } = fixture();
			const existing: FilePathInspection = {
				kind: "file",
				identity: { dev: "1", ino: "1", mode: "1", size: "1", mtimeMs: "1", ctimeMs: "1" },
			};
			const controller = new FileMutationIntentController({
				operations: {
					...operations,
					inspect: async () => {
						entered.resolve();
						await release.promise;
						return tool === "write" ? existing : undefined;
					},
				},
			});
			const execute =
				tool === "write"
					? createWriteTool(process.cwd(), { intentController: controller }).execute("late-write", {
							path: "target",
							content: "payload",
						})
					: createEditTool(process.cwd(), { intentController: controller }).execute("late-edit", {
							path: "target",
							edits: [{ oldText: "old", newText: "new" }],
						});
			// Attach a rejection observer before releasing the held inspection.
			const outcome = execute.then(
				() => undefined,
				(error: unknown) => error,
			);
			try {
				await entered.promise;
				if (disposeBeforeInspection) await controller.dispose();
				release.resolve();
				const error = await outcome;
				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				if (disposeBeforeInspection) {
					expect(message).toContain(tool === "write" ? "Write collision" : "ENOENT");
					expect(message).not.toContain("PI_FILE_MUTATION_RETARGET");
					expect(stage).not.toHaveBeenCalled();
					expect(files.size).toBe(0);
				} else {
					expect(message).toContain("PI_FILE_MUTATION_RETARGET");
					expect(stage).toHaveBeenCalledOnce();
					expect(files.size).toBe(1);
				}
			} finally {
				release.resolve();
				await outcome;
				await controller.dispose();
			}
		},
	);
});
