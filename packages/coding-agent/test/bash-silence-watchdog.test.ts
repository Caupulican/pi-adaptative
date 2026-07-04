import { describe, expect, it } from "vitest";
import { createBashTool, setCommandSilenceMsForTests } from "../src/core/tools/bash.ts";

describe("bash silence watchdog", () => {
	it("kills a silent foreground command and reports a structured silence error", async () => {
		setCommandSilenceMsForTests(500);
		try {
			const tool = createBashTool(process.cwd());
			await expect(tool.execute("t1", { command: "sleep 30" })).rejects.toThrow(
				/silence|killed after .*of silence/i,
			);
		} finally {
			setCommandSilenceMsForTests(undefined);
		}
	}, 15_000);

	it("does not kill a command that keeps producing output", async () => {
		setCommandSilenceMsForTests(500);
		try {
			const tool = createBashTool(process.cwd());
			const result = await tool.execute("t2", {
				command: "for i in 1 2 3 4; do echo tick$i; sleep 0.3; done",
			});
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
			expect(text).toContain("tick4");
		} finally {
			setCommandSilenceMsForTests(undefined);
		}
	}, 15_000);

	it("explicit timeout disables the silence watchdog (wall-clock governs)", async () => {
		setCommandSilenceMsForTests(300);
		try {
			const tool = createBashTool(process.cwd());
			// Silent for 1s (>> 300ms silence) but within the 5s wall-clock timeout: must succeed.
			const result = await tool.execute("t3", { command: "sleep 1 && echo done", timeout: 5 });
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
			expect(text).toContain("done");
		} finally {
			setCommandSilenceMsForTests(undefined);
		}
	}, 15_000);

	it("backgrounded commands are exempt: shell exits immediately, no kill", async () => {
		setCommandSilenceMsForTests(300);
		try {
			const tool = createBashTool(process.cwd());
			const result = await tool.execute("t4", { command: "(sleep 2 &) ; echo started" });
			const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
			expect(text).toContain("started");
		} finally {
			setCommandSilenceMsForTests(undefined);
		}
	}, 15_000);
});
