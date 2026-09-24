import assert from "node:assert";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { Component } from "../src/index.ts";
import { InputOnlyTerminal } from "../src/terminal.ts";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Probe implements Component {
	renders = 0;
	inputs: string[] = [];

	render(width: number): string[] {
		this.renders++;
		return ["x".repeat(Math.min(width, 10))];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("InputOnlyTerminal", () => {
	it("delivers keystrokes and pastes to the focused component while drawing nothing", async () => {
		const originalWrite = process.stdout.write.bind(process.stdout);
		const terminalOutput: string[] = [];
		process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
			const text = String(chunk);
			if (text.includes("\x1b[") || text.includes("xxxxxxxxxx")) terminalOutput.push(text);
			return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
		}) as typeof process.stdout.write;
		const input = new PassThrough();
		const probe = new Probe();
		try {
			const tui = new TUI(new InputOnlyTerminal(input as unknown as NodeJS.ReadStream));
			tui.addChild(probe);
			tui.setFocus(probe);
			tui.start();
			tui.requestRender();
			tui.requestRender(true);
			input.write("new task");
			input.write("\r");
			input.write("\x1b[200~pasted\ntext\x1b[201~");
			await settle();
			tui.stop();
			input.write("after stop");
			await settle();
		} finally {
			process.stdout.write = originalWrite;
		}
		assert.ok(probe.inputs.join("").includes("new task"));
		assert.ok(probe.inputs.includes("\r"));
		assert.ok(probe.inputs.some((data) => data.includes("pasted\ntext")));
		assert.ok(!probe.inputs.join("").includes("after stop"));
		assert.strictEqual(probe.renders, 0);
		assert.deepStrictEqual(terminalOutput, []);
	});

	it("renders through a drawing terminal (control)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		let writes = 0;
		const write = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			writes++;
			write(data);
		};
		const tui = new TUI(terminal);
		const probe = new Probe();
		tui.addChild(probe);
		tui.start();
		tui.requestRender();
		await settle();
		tui.stop();
		assert.ok(probe.renders > 0);
		assert.ok(writes > 0);
	});
});
