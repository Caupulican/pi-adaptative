import { describe, expect, it } from "vitest";
import { runExclusiveToolDownload } from "../src/utils/tools-manager.ts";

describe("runExclusiveToolDownload", () => {
	it("shares one in-flight download per tool", async () => {
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = runExclusiveToolDownload("rg", async () => {
			calls += 1;
			await gate;
			return "/tmp/rg";
		});
		const second = runExclusiveToolDownload("rg", async () => {
			calls += 1;
			return "/tmp/rg-second";
		});

		release();

		await expect(Promise.all([first, second])).resolves.toEqual(["/tmp/rg", "/tmp/rg"]);
		expect(calls).toBe(1);
	});
});
