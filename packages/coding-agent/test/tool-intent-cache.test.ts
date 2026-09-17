import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyToolIntent } from "../src/core/tool-selection/tool-selection-controller.ts";

afterEach(() => vi.restoreAllMocks());

describe("tool intent cache", () => {
	it("bounds retained entries across changing extension descriptions", () => {
		const writes = vi.spyOn(Map.prototype, "set");
		for (let index = 0; index < 600; index++) {
			expect(classifyToolIntent({ name: `cache-fixture-${index}`, description: "read file" })).toBe("read");
		}
		const cacheCall = writes.mock.calls.findIndex(([key]) => key === "cache-fixture-599\0read file");
		expect(cacheCall).toBeGreaterThanOrEqual(0);
		const cache = writes.mock.contexts[cacheCall] as Map<unknown, unknown>;
		expect(cache.size).toBeLessThanOrEqual(512);
		// An eviction changes only memoization, never the semantic answer.
		expect(classifyToolIntent({ name: "cache-fixture-0", description: "read file" })).toBe("read");
		expect(classifyToolIntent({ name: "cache-fixture-0", description: "write file" })).toBe("write");
	});

	it("does not retain an oversized description but still classifies it", () => {
		const writes = vi.spyOn(Map.prototype, "set");
		const description = `${"x".repeat(10_000)} search`;
		expect(classifyToolIntent({ name: "large-cache-fixture", description })).toBe("search");
		expect(writes.mock.calls.some(([key]) => key === `large-cache-fixture\0${description}`)).toBe(false);
	});

	it("reuses an ordinary cached pair without another insertion", () => {
		const tool = { name: "warm-cache-fixture", description: "read file" };
		const writes = vi.spyOn(Map.prototype, "set");
		expect(classifyToolIntent(tool)).toBe("read");
		expect(classifyToolIntent({ ...tool })).toBe("read");
		expect(writes.mock.calls.filter(([key]) => key === "warm-cache-fixture\0read file")).toHaveLength(1);
	});

	it.each([4_095, 4_096, 4_097])("retains keys only within the %s-code-unit boundary", (length) => {
		const name = `boundary-fixture-${length}`;
		const description = `read ${"x".repeat(length - name.length - 6)}`;
		const key = `${name}\0${description}`;
		expect(key.length).toBe(length);
		const writes = vi.spyOn(Map.prototype, "set");
		expect(classifyToolIntent({ name, description })).toBe("read");
		expect(writes.mock.calls.some(([candidate]) => candidate === key)).toBe(length <= 4_096);
	});

	it("bounds every retained key across repeated churn and preserves intent after eviction", () => {
		const intents = ["read", "search", "execute", "write", "retrieve", "explain", "other"] as const;
		const descriptions = ["cat", "grep", "bash", "edit", "fetch", "help", "xyz"];
		const writes = vi.spyOn(Map.prototype, "set");
		for (let index = 0; index < 1_600; index++) {
			const name = `churn-fixture-${index}`;
			const description = `${descriptions[index % 7]} ${"x".repeat(4_000)}`;
			expect(classifyToolIntent({ name, description })).toBe(intents[index % 7]);
		}
		const last = writes.mock.calls.findIndex(
			([key]) => typeof key === "string" && key.startsWith("churn-fixture-1599\0"),
		);
		expect(last).toBeGreaterThanOrEqual(0);
		const cache = writes.mock.contexts[last] as Map<string, unknown>;
		expect(cache.size).toBe(512);
		let retainedCodeUnits = 0;
		for (const key of cache.keys()) {
			expect(key.length).toBeLessThanOrEqual(4_096);
			retainedCodeUnits += key.length;
		}
		expect(retainedCodeUnits).toBeLessThanOrEqual(512 * 4_096);
		for (let index = 0; index < 7; index++) {
			const name = `churn-fixture-${index}`;
			const description = `${descriptions[index]} ${"x".repeat(4_000)}`;
			expect(cache.has(`${name}\0${description}`)).toBe(false);
			expect(classifyToolIntent({ name, description })).toBe(intents[index]);
			// Oversized descriptions bypass memoization and provide the same token set.
			expect(classifyToolIntent({ name, description: `${description}${"x".repeat(200)}` })).toBe(intents[index]);
		}
		expect(cache.size).toBe(512);
	});
});
