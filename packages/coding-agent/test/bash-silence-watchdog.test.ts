import { describe, expect, it } from "vitest";
import { createBashTool, setCommandTimeoutMsForTests } from "../src/core/tools/bash.ts";

describe("bash execution deadlines", () => {
	it("applies the default wall-clock timeout to silent commands", async () => {
		setCommandTimeoutMsForTests(500);
		try {
			const tool = createBashTool(process.cwd());
			await expect(tool.execute("t1", { command: 'node -e "setTimeout(function(){}, 30000)"' })).rejects.toThrow(
				/timed out after 0.5 seconds/i,
			);
		} finally {
			setCommandTimeoutMsForTests(undefined);
		}
	}, 15_000);

	it("applies the default wall-clock timeout even while output continues", async () => {
		setCommandTimeoutMsForTests(700);
		try {
			const tool = createBashTool(process.cwd());
			await expect(
				tool.execute("t2", { command: "node -e \"setInterval(function(){console.log('tick')}, 100)\"" }),
			).rejects.toThrow(/timed out after 0.7 seconds/i);
		} finally {
			setCommandTimeoutMsForTests(undefined);
		}
	}, 15_000);

	it("treats timeout zero as the bounded default rather than disabling the deadline", async () => {
		setCommandTimeoutMsForTests(500);
		try {
			const tool = createBashTool(process.cwd());
			await expect(
				tool.execute("t3", { command: 'node -e "setTimeout(function(){}, 30000)"', timeout: 0 }),
			).rejects.toThrow(/timed out after 0.5 seconds/i);
		} finally {
			setCommandTimeoutMsForTests(undefined);
		}
	}, 15_000);

	it("lets a bounded explicit timeout replace the default", async () => {
		setCommandTimeoutMsForTests(300);
		try {
			const tool = createBashTool(process.cwd());
			const result = await tool.execute("t4", {
				command: "node -e \"setTimeout(function(){console.log('done')}, 1000)\"",
				timeout: 2,
			});
			const text = result.content.map((item) => ("text" in item ? item.text : "")).join("");
			expect(text).toContain("done");
		} finally {
			setCommandTimeoutMsForTests(undefined);
		}
	}, 15_000);
});
