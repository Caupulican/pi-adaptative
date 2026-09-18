import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FileMutationIntentController } from "../src/core/tools/file-mutation-intent.ts";
import { disposeMutationLockScope, getMutationLockScope } from "../src/core/tools/file-mutation-queue.ts";

describe("mutation scope disposal ownership", () => {
	it.each([false, true])("keeps a peer's scope registered when an owner leaves: repeat=%s", async (repeat) => {
		const key = `mutation-disposal-${randomUUID()}`;
		const owner = new FileMutationIntentController({ mutationScope: key });
		const peer = new FileMutationIntentController({ mutationScope: key });
		const scope = getMutationLockScope(key);
		try {
			expect(scope.users).toBe(2);
			await owner.dispose();
			if (repeat) await Promise.all([owner.dispose(), owner.dispose()]);
			expect(getMutationLockScope(key)).toBe(scope);
			expect(scope.users).toBe(1);
			await peer.dispose();
			expect(getMutationLockScope(key)).not.toBe(scope);
		} finally {
			await owner.dispose();
			await peer.dispose();
			disposeMutationLockScope(key);
		}
	});

	it.each([false, true])("keeps a retained scope when an older disposal drains: retain=%s", async (retain) => {
		const key = `mutation-drain-${randomUUID()}`;
		const owner = new FileMutationIntentController({ mutationScope: key });
		const scope = getMutationLockScope(key);
		let successor: FileMutationIntentController | undefined;
		await scope.acquireLock("mutation", undefined);
		try {
			await owner.dispose();
			// In-flight work keeps this zero-user scope registered until its lock drains.
			expect(getMutationLockScope(key)).toBe(scope);
			if (retain) successor = new FileMutationIntentController({ mutationScope: key });
			scope.releaseLock();
			if (retain) {
				expect(scope.users).toBe(1);
				expect(getMutationLockScope(key)).toBe(scope);
				await successor!.dispose();
			}
			expect(getMutationLockScope(key)).not.toBe(scope);
		} finally {
			scope.releaseLock();
			await owner.dispose();
			await successor?.dispose();
			disposeMutationLockScope(key);
		}
	});
});
