import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream burst queue", () => {
	it("drains a large producer burst in order and preserves the terminal result", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === 9_999,
			(event) => event,
		);
		for (let event = 0; event < 10_000; event++) stream.push(event);

		const received: number[] = [];
		for await (const event of stream) received.push(event);

		expect(received).toHaveLength(10_000);
		expect(received[0]).toBe(0);
		expect(received[5_000]).toBe(5_000);
		expect(received[9_999]).toBe(9_999);
		expect(await stream.result()).toBe(9_999);
	});
});
