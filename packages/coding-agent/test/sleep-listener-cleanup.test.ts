import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { sleep } from "../src/utils/sleep.ts";

describe("sleep abort listener cleanup", () => {
	it("removes its abort listener after a normal timeout completion", async () => {
		const controller = new AbortController();

		await sleep(1, controller.signal);
		await sleep(1, controller.signal);
		await sleep(1, controller.signal);

		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("rejects and leaves no listener when aborted mid-sleep", async () => {
		const controller = new AbortController();
		const pending = sleep(60_000, controller.signal);
		controller.abort();

		await expect(pending).rejects.toThrow(/abort/i);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});
