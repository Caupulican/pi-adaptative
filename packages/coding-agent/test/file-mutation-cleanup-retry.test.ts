import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	FileMutationIntentController,
	localFileMutationIntentOperations,
} from "../src/core/tools/file-mutation-intent.ts";
import { disposeMutationLockScope, getMutationLockScope } from "../src/core/tools/file-mutation-queue.ts";

function fixture() {
	const files = new Map<string, string>();
	const remove = vi.fn(async (file: string) => {
		files.delete(file);
	});
	const stage = vi.fn(async (content: string) => {
		const file = `fixture-payload-${randomUUID()}`;
		files.set(file, content);
		return file;
	});
	const read = vi.fn(async (file: string) => files.get(file)!);
	return {
		files,
		remove,
		stage,
		read,
		operations: { ...localFileMutationIntentOperations, stagePayload: stage, removeFile: remove, readPayload: read },
	};
}

describe("mutation payload cleanup recovery", () => {
	it.each([new Error("storage unavailable"), undefined, null, false, 0, ""])(
		"retains failed cleanup for retry and preserves the first rejection: %s",
		async (failure) => {
			const { operations, files, remove } = fixture();
			const key = `cleanup-retry-${randomUUID()}`;
			const controller = new FileMutationIntentController({ operations, mutationScope: key });
			const scope = getMutationLockScope(key);
			try {
				await controller.retainMutationPayload("write", "first");
				await controller.retainMutationPayload("write", "second");
				const [first, second] = [...files.keys()];
				remove.mockRejectedValueOnce(failure).mockRejectedValueOnce(new Error("later failure"));
				await expect(controller.dispose()).rejects.toBe(failure);
				expect(remove.mock.calls.map(([file]) => file)).toEqual([first, second]);
				expect(scope.users).toBe(1);
				expect(files.size).toBe(2);
				await controller.dispose();
				expect(remove.mock.calls.map(([file]) => file)).toEqual([first, second, first, second]);
				expect(files.size).toBe(0);
				expect(scope.users).toBe(0);
				await controller.dispose();
				expect(remove).toHaveBeenCalledTimes(4);
			} finally {
				await controller.dispose();
				disposeMutationLockScope(key);
			}
		},
	);

	it.each([false, true])("revokes a discarded reference while retaining any cleanup debt: fail=%s", async (fail) => {
		const { operations, files, remove, read } = fixture();
		const controller = new FileMutationIntentController({ operations });
		try {
			const reference = await controller.retainMutationPayload("write", "consumed payload");
			expect(reference).toBeDefined();
			const [file] = [...files.keys()];
			if (fail) remove.mockRejectedValueOnce(new Error("busy payload file"));
			// Discard must not turn a completed write into a retryable write error.
			await expect(controller.discardMutationPayload(reference!.payloadRef)).resolves.toBeUndefined();
			await expect(controller.readMutationPayload(reference!.payloadRef, "write")).rejects.toThrow("invalid");
			expect(read).not.toHaveBeenCalled();
			expect(files.size).toBe(fail ? 1 : 0);
			await controller.dispose();
			expect(files.size).toBe(0);
			expect(remove.mock.calls.map(([path]) => path)).toEqual(fail ? [file, file] : [file]);
		} finally {
			await controller.dispose();
		}
	});

	it("keeps failed cleanup charged against capacity and does not allocate past it", async () => {
		const { operations, files, remove, stage } = fixture();
		const controller = new FileMutationIntentController({ operations, mutationPayloadLimit: 1 });
		try {
			const reference = await controller.retainMutationPayload("write", "first");
			remove.mockRejectedValueOnce(new Error("busy")).mockRejectedValueOnce(new Error("still busy"));
			await controller.discardMutationPayload(reference!.payloadRef);
			await expect(controller.retainMutationPayload("write", "second")).rejects.toThrow("still busy");
			expect(stage).toHaveBeenCalledOnce();
			expect(files.size).toBe(1);
			await expect(controller.retainMutationPayload("write", "second")).resolves.toBeDefined();
			expect(stage).toHaveBeenCalledTimes(2);
			expect([...files.values()]).toEqual(["second"]);
		} finally {
			await controller.dispose();
		}
	});
});
