import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { waitForStdinEvent } from "../src/utils/stdin-events.ts";

describe("waitForStdinEvent", () => {
	test.each(["data", "end", "error"] as const)("settles on %s and removes competing listeners", async (event) => {
		const input = new EventEmitter();
		const settled = waitForStdinEvent(input);

		input.emit(event);
		await settled;

		expect(input.listenerCount("data")).toBe(0);
		expect(input.listenerCount("end")).toBe(0);
		expect(input.listenerCount("error")).toBe(0);
	});
});
