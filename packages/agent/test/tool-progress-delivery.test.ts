import { describe, expect, it } from "vitest";
import { ToolProgressDelivery } from "../src/tool-progress-delivery.ts";

describe("tool progress delivery lifecycle", () => {
	it("awaits every admitted observer and closes against late callbacks", async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const seen: number[] = [];
		const delivery = new ToolProgressDelivery<number>((value) => {
			seen.push(value);
			return value === 1 ? first.promise : second.promise;
		});
		delivery.publish(1);
		delivery.publish(2);
		let settled = false;
		const finishing = delivery.finish().then((failed) => {
			settled = true;
			return failed;
		});
		second.reject(new Error("fixture observer failure"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		delivery.publish(3);
		first.resolve();
		expect(await finishing).toBe(true);
		expect(await delivery.finish()).toBe(true);
		expect(seen).toEqual([1, 2]);
	});

	it("does not accumulate delivered updates or require a yielding producer", async () => {
		let sum = 0;
		const delivery = new ToolProgressDelivery<number>((value) => {
			sum += value;
		});
		for (let index = 0; index < 20_000; index++) delivery.publish(1);
		expect(await delivery.finish()).toBe(false);
		expect(sum).toBe(20_000);
		expect(
			Object.values(delivery).some((value) => Array.isArray(value) || value instanceof Set || value instanceof Map),
		).toBe(false);
	});

	it("records synchronous throws and asynchronous rejections before finish without leaking them", async () => {
		const seen: number[] = [];
		const delivery = new ToolProgressDelivery<number>((value) => {
			seen.push(value);
			if (value === 0) throw new Error("synchronous fixture");
			return Promise.reject(new Error("async fixture"));
		});
		expect(() => delivery.publish(0)).not.toThrow();
		delivery.publish(1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(await delivery.finish()).toBe(true);
		expect(seen).toEqual([0, 1]);
	});
});
