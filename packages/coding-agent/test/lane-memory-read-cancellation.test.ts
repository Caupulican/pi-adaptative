import { describe, expect, it } from "vitest";
import { createLaneToolSurface } from "../src/core/autonomy/lane-tool-surface.ts";
import { tempDir } from "./temp-dir.ts";

describe("lane memory read cancellation", () => {
	it("does not deliver a memory snapshot after its worker tool call is cancelled", async () => {
		let releaseRead: () => void = () => {};
		const readReleased = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const surface = createLaneToolSurface({
			cwd: tempDir("pi-lane-memory-cancel-"),
			readMemory: async () => {
				await readReleased;
				return "late memory";
			},
		});
		const memoryRead = surface.tools.find((tool) => tool.name === "memory_read");
		if (!memoryRead) throw new Error("Expected the bounded memory_read adapter.");
		const controller = new AbortController();

		const pending = memoryRead.execute("cancelled-memory", { query: "durable goal" }, controller.signal);
		controller.abort(new Error("worker cancelled"));
		releaseRead();

		await expect(pending).rejects.toThrow("worker cancelled");
		await surface.dispose();
	});
});
