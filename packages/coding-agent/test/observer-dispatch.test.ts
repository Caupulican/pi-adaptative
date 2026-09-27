import { describe, expect, it } from "vitest";
import { IndependentObserverSet } from "../src/core/observer-dispatch.ts";

describe("independent observer dispatch", () => {
	it("owns subscription removal and explicit lifecycle clearing", () => {
		const observers = new IndependentObserverSet<() => void>();
		const first = observers.subscribe(() => {});
		expect(observers.size).toBe(1);
		first();
		expect(observers.size).toBe(0);
		observers.subscribe(() => {});
		observers.subscribe(() => {});
		expect(observers.size).toBe(2);
		observers.clear();
		expect(observers.size).toBe(0);
	});

	it("bounds one generation, retains late observers, and isolates callback failures", () => {
		const observers = new IndependentObserverSet<(value: string) => void>();
		const deliveries: string[] = [];
		const failures: string[] = [];
		const late = (value: string) => deliveries.push(`late:${value}`);
		observers.subscribe((value) => {
			deliveries.push(`first:${value}`);
			observers.subscribe(late);
			throw new Error(`failed:${value}`);
		});
		observers.subscribe((value) => deliveries.push(`existing:${value}`));

		observers.notify(
			(listener) => listener("one"),
			(error) => failures.push(error instanceof Error ? error.message : "unknown"),
		);
		expect(deliveries).toEqual(["first:one", "existing:one"]);
		expect(failures).toEqual(["failed:one"]);

		observers.notify(
			(listener) => listener("two"),
			(error) => failures.push(error instanceof Error ? error.message : "unknown"),
		);
		expect(deliveries).toEqual(["first:one", "existing:one", "first:two", "existing:two", "late:two"]);
		expect(failures).toEqual(["failed:one", "failed:two"]);
	});
});
