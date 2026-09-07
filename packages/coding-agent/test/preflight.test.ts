import { describe, expect, it, vi } from "vitest";
import { awaitPreflight, requireSynchronousPreflight } from "../src/core/preflight.ts";

describe("read-only preflight cancellation", () => {
	it("preserves synchronous facts and observes refused promises through settlement", async () => {
		for (const value of [undefined, false, true, "synthetic/path"]) {
			expect(requireSynchronousPreflight(value)).toBe(value);
		}
		expect(() => requireSynchronousPreflight(Promise.resolve("late value"))).toThrow("asynchronous authority");
		const late = Promise.withResolvers<string>();
		expect(() => requireSynchronousPreflight(late.promise)).toThrow("asynchronous authority");
		late.reject(new Error("Synthetic late rejection"));
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it("does not start preflight for an already canceled caller", () => {
		const controller = new AbortController();
		const reason = new Error("fixture cancellation");
		controller.abort(reason);
		const operation = vi.fn(async () => "unreachable");
		expect(() => awaitPreflight(operation, controller.signal)).toThrow(reason);
		expect(operation).not.toHaveBeenCalled();
	});

	it("detaches one caller without canceling shared provisioning or losing later rejection handling", async () => {
		const pending = Promise.withResolvers<string>();
		const first = new AbortController();
		const second = new AbortController();
		const firstResult = awaitPreflight(() => pending.promise, first.signal);
		const secondResult = awaitPreflight(() => pending.promise, second.signal);
		first.abort();
		await expect(firstResult).rejects.toThrow(/abort/i);
		pending.resolve("ready");
		await expect(secondResult).resolves.toBe("ready");

		const failed = Promise.withResolvers<string>();
		const controller = new AbortController();
		const result = awaitPreflight(() => failed.promise, controller.signal);
		controller.abort();
		await expect(result).rejects.toThrow(/abort/i);
		failed.reject(new Error("late fixture failure"));
		await Promise.resolve();
	});

	it("handles cancellation synchronously inside the preflight factory", async () => {
		const controller = new AbortController();
		const result = awaitPreflight(() => {
			controller.abort();
			return Promise.resolve("late success");
		}, controller.signal);
		await expect(result).rejects.toThrow(/abort/i);
	});

	it("preserves successful values and exact failures and releases abort listeners", async () => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		await expect(awaitPreflight(async () => "ready", controller.signal)).resolves.toBe("ready");
		const failure = new Error("preflight failed");
		await expect(
			awaitPreflight(async () => {
				throw failure;
			}, controller.signal),
		).rejects.toBe(failure);
		expect(remove).toHaveBeenCalledTimes(2);
		await expect(awaitPreflight(async () => "no signal")).resolves.toBe("no signal");
	});
});
