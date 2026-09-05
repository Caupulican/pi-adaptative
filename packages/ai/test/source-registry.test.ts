import { describe, expect, it, vi } from "vitest";
import { SourceRegistry } from "../src/utils/source-registry.ts";

describe("source registry retention and hot paths", () => {
	it("retains at most one registration per key and owner across repeated updates", () => {
		const registry = new SourceRegistry<number>();
		registry.set("api", -1);
		for (let revision = 0; revision < 10_000; revision++) registry.set("api", revision, "extension");
		// White-box retention assertion: output correctness alone cannot detect a leaking override stack.
		const entries = Reflect.get(registry, "entries") as Map<string, unknown[]>;
		expect(entries.get("api")).toHaveLength(2);
		expect(registry.get("api")).toBe(9_999);
		registry.removeSource("extension");
		expect(registry.get("api")).toBe(-1);
	});

	it("does not scan unrelated registrations on lookup or owner retirement", () => {
		const registry = new SourceRegistry<number>();
		for (let key = 0; key < 10_000; key++) registry.set(String(key), key, `owner-${key}`);
		const entries = Reflect.get(registry, "entries") as Map<string, unknown[]>;
		const iteration = vi.spyOn(entries, Symbol.iterator);
		expect(registry.get("9999")).toBe(9_999);
		registry.removeSource("owner-9999");
		expect(iteration).not.toHaveBeenCalled();
		expect(registry.get("9999")).toBeUndefined();
		expect(registry.get("9998")).toBe(9_998);
	});

	it("cleans ownership indexes on explicit deletion and clear", () => {
		const registry = new SourceRegistry<number>();
		registry.set("key", 1, "old");
		registry.delete("key");
		registry.set("key", 2, "new");
		registry.removeSource("old");
		expect(registry.values()).toEqual([2]);
		registry.clear();
		registry.set("key", 3, "other");
		registry.removeSource("new");
		expect(registry.values()).toEqual([3]);
	});
});
