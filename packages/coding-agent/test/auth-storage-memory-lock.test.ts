import { registerOAuthProvider, unregisterOAuthProvider } from "@caupulican/pi-ai/oauth";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage, InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";

describe("in-memory auth transaction ownership", () => {
	it("lets two AuthStorage clients adopt one rotation without reusing the expired refresh token", async () => {
		const providerId = "memory-rotation-test";
		const backend = new InMemoryAuthStorageBackend();
		const expired = { type: "oauth", access: "expired", refresh: "old-refresh", expires: 0 };
		backend.withLock(() => ({ result: undefined, next: JSON.stringify({ [providerId]: expired }) }));
		const first = AuthStorage.fromStorage(backend);
		const second = AuthStorage.fromStorage(backend);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const rotated = { access: "rotated", refresh: "new-refresh", expires: Date.now() + 60_000 };
		const refresh = vi.fn(async () => {
			entered.resolve();
			await finish.promise;
			return rotated;
		});
		registerOAuthProvider({
			id: providerId,
			name: "Test",
			login: async () => rotated,
			refreshToken: refresh,
			getApiKey: (c) => c.access,
		});
		try {
			const one = first.getOAuthApiKey(providerId);
			await entered.promise;
			const two = second.getOAuthApiKey(providerId);
			finish.resolve();
			expect(await Promise.all([one, two])).toEqual(["rotated", "rotated"]);
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(first.get(providerId)).toMatchObject(rotated);
			expect(second.get(providerId)).toMatchObject(rotated);
		} finally {
			finish.resolve();
			unregisterOAuthProvider(providerId);
		}
	});

	it("serializes asynchronous rotations and reads the preceding committed value", async () => {
		const backend = new InMemoryAuthStorageBackend();
		backend.withLock(() => ({ result: undefined, next: "original" }));
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const events: string[] = [];
		const first = backend.withLockAsync(async (current) => {
			events.push(`first:${current}`);
			entered.resolve();
			await finish.promise;
			return { result: "first", next: "rotated" };
		});
		await entered.promise;
		const second = backend.withLockAsync(async (current) => {
			events.push(`second:${current}`);
			return { result: current, next: "final" };
		});
		await Promise.resolve();
		const beforeRelease = [...events];
		finish.resolve();
		await first;
		expect(await second).toBe("rotated");
		expect(beforeRelease).toEqual(["first:original"]);
		expect(backend.withLock((current) => ({ result: current }))).toBe("final");
	});

	it("refuses a synchronous mutation while an asynchronous transaction holds the lock", async () => {
		const backend = new InMemoryAuthStorageBackend();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const pending = backend.withLockAsync(async () => {
			entered.resolve();
			await finish.promise;
			return { result: undefined, next: "rotation" };
		});
		await entered.promise;
		let failure: unknown;
		try {
			backend.withLock(() => ({ result: undefined, next: "replacement" }));
		} catch (error) {
			failure = error;
		}
		finish.resolve();
		await pending;
		expect(failure).toBeInstanceOf(Error);
		backend.withLock(() => ({ result: undefined, next: "after-release" }));
		expect(backend.withLock((current) => ({ result: current }))).toBe("after-release");
	});

	it("releases a rejected transaction without poisoning the next acquisition", async () => {
		const backend = new InMemoryAuthStorageBackend();
		backend.withLock(() => ({ result: undefined, next: "original" }));
		const failure = new Error("refresh refused");
		const rejected = backend.withLockAsync(async () => {
			throw failure;
		});
		const next = backend.withLockAsync(async (current) => ({ result: current, next: "recovered" }));
		await expect(rejected).rejects.toBe(failure);
		expect(await next).toBe("original");
		expect(backend.withLock((current) => ({ result: current }))).toBe("recovered");
	});
});
