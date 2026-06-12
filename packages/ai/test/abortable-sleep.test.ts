import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { abortableSleep } from "../src/utils/abort-signals.ts";

describe("abortableSleep", () => {
	it("removes its abort listener after a normal timeout completion", async () => {
		const controller = new AbortController();

		await abortableSleep(1, controller.signal);
		await abortableSleep(1, controller.signal);
		await abortableSleep(1, controller.signal);

		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("rejects and leaves no listener when aborted mid-sleep", async () => {
		const controller = new AbortController();
		const pending = abortableSleep(60_000, controller.signal);
		controller.abort();

		await expect(pending).rejects.toThrow(/abort/i);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(abortableSleep(1, controller.signal)).rejects.toThrow(/abort/i);
	});
});
